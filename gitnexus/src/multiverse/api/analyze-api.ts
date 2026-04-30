/**
 * Analyze Trigger API — with auto git clone/pull
 *
 * POST /api/mv/services/:id/analyze  — clone/pull + full pipeline
 * POST /api/mv/services/:id/relink   — re-run cross-linking only
 * GET  /api/mv/services/:id/status   — analyze status
 * POST /api/mv/ops/analyze-all       — analyze all services (concurrency limited)
 * POST /api/mv/ops/relink-all        — re-link all services
 * POST /api/mv/ops/cleanup           — cleanup orphans
 */

import { Router } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import {
  getService,
  updateService,
  listServices,
  type ServiceNode,
} from '../admin/service-registry.js';
import { runMultiversePipeline, relinkService, relinkAll } from '../engine/orchestrator.js';
import { cleanupOrphans } from '../engine/cross-linker.js';
import { loadConfig } from '../config/loader.js';
import { mvLog } from '../util/logger.js';
import { AnalyzeJob } from './types.js';

const LOG = 'analyze-api';
const execFileAsync = promisify(execFile);

// Removed local AnalyzeJob interface (now in types.ts)

const jobs = new Map<string, AnalyzeJob>();
const locks = new Set<string>();
/** SSE subscribers per jobId */
const sseClients = new Map<string, Set<import('express').Response>>();

/** Emit SSE event to all subscribers of a job */
function emitJobEvent(jobId: string, event: string, data: unknown) {
  const clients = sseClients.get(jobId);
  if (!clients?.size) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

/** Update job step and emit SSE */
function updateJobStep(
  job: AnalyzeJob,
  step: string,
  status: 'running' | 'done' | 'failed',
  detail?: string,
) {
  const existing = job.steps.find((s) => s.step === step);
  if (existing) {
    existing.status = status;
    existing.detail = detail;
    existing.ts = new Date().toISOString();
  } else {
    job.steps.push({ step, status, detail, ts: new Date().toISOString() });
  }
  emitJobEvent(job.id, 'progress', { step, status, detail, steps: job.steps });
}

/** Simple concurrency limiter */
class ConcurrencyLimiter {
  private running = 0;
  private queue: Array<() => void> = [];

  constructor(private maxConcurrency: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.maxConcurrency) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}

let limiter: ConcurrencyLimiter | null = null;
const getLimiter = async () => {
  if (!limiter) {
    const config = await loadConfig();
    limiter = new ConcurrencyLimiter(config.analyze.maxConcurrency);
  }
  return limiter;
};

/** Resolve repo path from workspace config */
const getRepoPath = async (serviceId: string, slug: string): Promise<string> => {
  const config = await loadConfig();
  return path.join(config.workspace.dir, slug);
};

/** Build clone URL: gitBase + /project_lowercase/slug.git */
const buildCloneUrl = (gitBase: string, project: string, slug: string): string => {
  return `${gitBase}/${project.toLowerCase()}/${slug}.git`;
};

/** Sanitize branch name to prevent command injection */
const sanitizeBranch = (branch: string): string => {
  return branch.replace(/[^a-zA-Z0-9._\-/]/g, '');
};

/** Retry helper */
const retry = async <T>(
  fn: () => Promise<T>,
  attempts: number = 2,
  delayMs: number = 2000,
): Promise<T> => {
  for (let i = 0; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === attempts) throw e;
      mvLog.warn(LOG, `Retry ${i + 1}/${attempts} after error`, e);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('unreachable');
};

/** Clone or pull repo using async execFile (no shell injection risk) */
const ensureRepo = async (
  repoPath: string,
  cloneUrl: string,
  branch: string,
  job: AnalyzeJob,
): Promise<void> => {
  const config = await loadConfig();
  const safeBranch = sanitizeBranch(branch);

  fs.mkdirSync(config.workspace.dir, { recursive: true });

  if (fs.existsSync(path.join(repoPath, '.git'))) {
    job.status = 'cloning';
    mvLog.info(LOG, `Pulling ${repoPath} (branch: ${safeBranch})`);
    try {
      await retry(() =>
        execFileAsync('git', ['-C', repoPath, 'fetch', 'origin'], {
          timeout: config.analyze.gitTimeoutMs,
        }),
      );
      await execFileAsync('git', ['-C', repoPath, 'checkout', safeBranch], {
        timeout: config.analyze.gitTimeoutMs,
      });
      await retry(() =>
        execFileAsync('git', ['-C', repoPath, 'pull', 'origin', safeBranch], {
          timeout: config.analyze.gitTimeoutMs,
        }),
      );
    } catch (e: unknown) {
      mvLog.warn(LOG, `Pull failed for ${repoPath}, continuing with existing code`, e);
    }
  } else {
    job.status = 'cloning';
    mvLog.info(LOG, `Cloning ${cloneUrl} → ${repoPath} (branch: ${safeBranch})`);
    await retry(() =>
      execFileAsync('git', ['clone', '--branch', safeBranch, '--depth', '1', cloneUrl, repoPath], {
        timeout: config.analyze.cloneTimeoutMs,
      }),
    );
  }
};

export const createAnalyzeRouter = (): Router => {
  const router = Router();

  // POST /api/mv/services/:id/analyze
  router.post('/:id/analyze', async (req, res) => {
    try {
      const svc = await getService(req.params.id);
      if (!svc) {
        res.status(404).json({ error: `Service "${req.params.id}" not found` });
        return;
      }

      if (locks.has(svc.id)) {
        const existing = [...jobs.values()].find(
          (j) => j.serviceId === svc.id && ['cloning', 'analyzing'].includes(j.status),
        );
        res.status(409).json({ error: `Already in progress for ${svc.id}`, jobId: existing?.id });
        return;
      }

      const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const job: AnalyzeJob = {
        id: jobId,
        serviceId: svc.id,
        status: 'queued',
        startedAt: new Date().toISOString(),
        steps: [],
      };
      jobs.set(jobId, job);
      locks.add(svc.id);

      runFullAnalyze(svc, jobId).catch((err) => {
        mvLog.error(LOG, `Unhandled error in analyze for ${svc.id}`, err);
      });
      res.status(202).json({ jobId, status: 'queued', message: `Analyze queued for ${svc.id}` });
    } catch (err: unknown) {
      mvLog.error(LOG, 'Analyze trigger failed', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/mv/services/:id/analyze-stream?jobId=xxx — SSE progress stream
  router.get('/:id/analyze-stream', async (req, res) => {
    const jobId = req.query.jobId as string;
    const job = jobId
      ? jobs.get(jobId)
      : [...jobs.values()]
          .filter((j) => j.serviceId === req.params.id)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    if (!job) {
      res.status(404).json({ error: 'No active job' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send current state
    res.write(
      `event: init\ndata: ${JSON.stringify({ jobId: job.id, status: job.status, steps: job.steps })}\n\n`,
    );

    if (job.status === 'completed' || job.status === 'failed') {
      res.write(
        `event: done\ndata: ${JSON.stringify({ status: job.status, stats: job.stats, error: job.error })}\n\n`,
      );
      res.end();
      return;
    }

    // Subscribe
    if (!sseClients.has(job.id)) sseClients.set(job.id, new Set());
    sseClients.get(job.id)!.add(res);
    req.on('close', () => {
      sseClients.get(job.id)?.delete(res);
    });
  });

  // POST /api/mv/services/:id/relink
  router.post('/:id/relink', async (req, res) => {
    try {
      const svc = await getService(req.params.id);
      if (!svc) {
        res.status(404).json({ error: `Service "${req.params.id}" not found` });
        return;
      }
      if (locks.has(svc.id)) {
        res.status(409).json({ error: `In progress for ${svc.id}` });
        return;
      }

      const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const job: AnalyzeJob = {
        id: jobId,
        serviceId: svc.id,
        status: 'analyzing',
        startedAt: new Date().toISOString(),
        steps: [],
      };
      jobs.set(jobId, job);
      locks.add(svc.id);

      runRelink(svc, jobId, req.query.skipDetect === 'true').catch((err) => {
        mvLog.error(LOG, `Unhandled error in relink for ${svc.id}`, err);
      });
      res.status(202).json({ jobId, status: 'queued', message: `Relink queued for ${svc.id}` });
    } catch (err: unknown) {
      mvLog.error(LOG, 'Relink trigger failed', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/mv/services/:id/match-endpoint — LLM match single transport to route
  router.post('/:id/match-endpoint', async (req, res) => {
    try {
      const svc = await getService(req.params.id);
      if (!svc) {
        res.status(404).json({ error: `Service "${req.params.id}" not found` });
        return;
      }
      const { transportId } = req.body;
      if (!transportId) {
        res.status(400).json({ error: 'transportId is required' });
        return;
      }

      const config = await loadConfig();
      const repoPath = await getRepoPath(svc.id, svc.repoSlug);
      const { resolveWikiLLMConfig } = await import('../wiki/llm-wiki-client.js');
      const llmConfig = resolveWikiLLMConfig(config.wiki?.llm);
      const { llmMatchSingleEndpoint } = await import('../engine/llm-endpoint-matcher.js');
      const result = await llmMatchSingleEndpoint(svc.id, repoPath, transportId, llmConfig);
      res.json(result);
    } catch (err: unknown) {
      mvLog.error(LOG, `Match-endpoint failed for ${req.params.id}`, err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/mv/services/:id/resolve-sinks — LLM auto-resolve unresolved sinks
  router.post('/:id/resolve-sinks', async (req, res) => {
    try {
      const svc = await getService(req.params.id);
      if (!svc) {
        res.status(404).json({ error: `Service "${req.params.id}" not found` });
        return;
      }

      const config = await loadConfig();
      const { resolveWikiLLMConfig } = await import('../wiki/llm-wiki-client.js');
      const llmConfig = resolveWikiLLMConfig(config.wiki?.llm);
      if (!llmConfig) {
        res
          .status(503)
          .json({ error: 'No LLM configured. Set ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN.' });
        return;
      }

      const repoPath = await getRepoPath(svc.id, svc.repoSlug);
      const { resolveConfig, clearConfigCache } = await import('../engine/config-resolver.js');
      clearConfigCache(svc.id);
      const configMap = await resolveConfig(svc.id, repoPath);

      const { llmResolveSinks } = await import('../engine/llm-sink-resolver.js');
      const result = await llmResolveSinks(svc.id, repoPath, configMap, llmConfig, {
        mode: req.body?.mode,
        limit: req.body?.limit,
        batchSize: req.body?.batchSize,
        onlyUnresolved: req.body?.onlyUnresolved,
      });

      // Re-link if any sinks were resolved
      if (result.resolved > 0) {
        const { relinkService } = await import('../engine/orchestrator.js');
        await relinkService(svc.id, repoPath).catch(() => {});
      }

      res.json(result);
    } catch (err: unknown) {
      mvLog.error(LOG, `Resolve-sinks failed for ${req.params.id}`, err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/mv/services/:id/resolve-report — unresolved stats and reasons
  router.get('/:id/resolve-report', async (req, res) => {
    try {
      const svc = await getService(req.params.id);
      if (!svc) {
        res.status(404).json({ error: `Service "${req.params.id}" not found` });
        return;
      }
      const { getGraphBackend } = await import('../../core/graph-backend/index.js');
      const backend = await getGraphBackend();
      const rows = (await backend.executeQuery(
        `MATCH (d:DetectedSink {repoId: $serviceId})
         RETURN
           count(d) AS total,
           sum(CASE WHEN coalesce(d.resolutionStatus,'unresolved') = 'resolved' THEN 1 ELSE 0 END) AS resolved,
           sum(CASE WHEN coalesce(d.resolutionStatus,'unresolved') <> 'resolved' THEN 1 ELSE 0 END) AS unresolved,
           avg(coalesce(d.resolutionConfidence, 0)) AS avgConfidence`,
        { serviceId: svc.id },
      )) as Array<{
        total?: number;
        resolved?: number;
        unresolved?: number;
        avgConfidence?: number;
      }>;
      const reasonRows = (await backend.executeQuery(
        `MATCH (d:DetectedSink {repoId: $serviceId})
         WHERE coalesce(d.resolutionStatus,'unresolved') <> 'resolved'
         RETURN coalesce(d.resolutionReason, 'insufficient_context') AS reason, count(*) AS count
         ORDER BY count DESC`,
        { serviceId: svc.id },
      )) as Array<{ reason: string; count: number }>;
      const patternRows = (await backend.executeQuery(
        `MATCH (d:DetectedSink {repoId: $serviceId})
         WHERE coalesce(d.resolutionStatus,'unresolved') <> 'resolved'
         RETURN coalesce(d.patternId, 'unknown') AS patternId, count(*) AS count
         ORDER BY count DESC
         LIMIT 10`,
        { serviceId: svc.id },
      )) as Array<{ patternId: string; count: number }>;

      const summary = rows[0] || {};
      res.json({
        serviceId: svc.id,
        total: summary.total || 0,
        resolved: summary.resolved || 0,
        unresolved: summary.unresolved || 0,
        avgConfidence: Number(summary.avgConfidence || 0),
        reasons: reasonRows,
        topUnresolvedPatterns: patternRows,
      });
    } catch (err: unknown) {
      mvLog.error(LOG, `Resolve-report failed for ${req.params.id}`, err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/mv/services/:id/resolve-sink — resolve a single sink by ID
  router.post('/:id/resolve-sink', async (req, res) => {
    try {
      const { sinkId, value } = req.body;
      if (!sinkId) {
        res.status(400).json({ error: 'sinkId required' });
        return;
      }

      const svc = await getService(req.params.id);
      if (!svc) {
        res.status(404).json({ error: 'Service not found' });
        return;
      }

      const { getGraphBackend } = await import('../../core/graph-backend/index.js');
      const backend = await getGraphBackend();

      // If value provided, save as manual resolution directly
      if (value) {
        const sink = await backend
          .executeQuery(`MATCH (d:DetectedSink {id: $id}) RETURN d { .* } AS props`, { id: sinkId })
          .then((r) => r[0]?.props);
        if (!sink) {
          res.status(404).json({ error: 'Sink not found' });
          return;
        }

        const isHttp = sink.sinkType === 'http';
        await backend.executeQuery(
          `MATCH (d:DetectedSink {id: $id})
           SET d.resolvedUrl = $url, d.resolvedTopic = $topic,
               d.confidence = 0.9, d.resolvedVia = 'manual'`,
          { id: sinkId, url: isHttp ? value : '', topic: isHttp ? '' : value },
        );

        const { saveManualResolution } = await import('../engine/manual-resolutions.js');
        await saveManualResolution({
          serviceId: svc.id,
          patternId: sink.patternId || '',
          filePath: sink.filePath,
          lineNumber: sink.lineNumber || 0,
          resolvedValue: value,
          sinkType: sink.sinkType,
          confidence: 0.9,
          note: 'manual via UI',
        });

        res.json({ resolved: true, value, via: 'manual' });
        return;
      }

      // No value → use LLM to resolve this single sink
      const config = await loadConfig();
      const { resolveWikiLLMConfig } = await import('../wiki/llm-wiki-client.js');
      const llmConfig = resolveWikiLLMConfig(config.wiki?.llm);
      if (!llmConfig) {
        res.status(503).json({ error: 'No LLM configured' });
        return;
      }

      const repoPath = await getRepoPath(svc.id, svc.repoSlug);
      const { resolveConfig, clearConfigCache } = await import('../engine/config-resolver.js');
      clearConfigCache(svc.id);
      const configMap = await resolveConfig(svc.id, repoPath);

      const sink = await backend.executeQuery(
        `MATCH (d:DetectedSink {id: $id}) RETURN d.id AS id`,
        {
          id: sinkId,
        },
      );
      if (!sink.length) {
        res.status(404).json({ error: 'Sink not found' });
        return;
      }

      const { llmResolveSinks } = await import('../engine/llm-sink-resolver.js');
      const result = await llmResolveSinks(svc.id, repoPath, configMap, llmConfig, {
        sinkIds: [sinkId],
      });
      const detail = result.details.find((d) => d.sinkId === sinkId);
      res.json({
        resolved: !!detail?.value,
        value: detail?.value,
        via: 'llm',
        error: detail?.error,
      });
    } catch (err: unknown) {
      mvLog.error(LOG, `Resolve-sink failed`, err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/mv/services/:id/status
  router.get('/:id/status', async (req, res) => {
    try {
      const svc = await getService(req.params.id);
      if (!svc) {
        res.status(404).json({ error: `Service "${req.params.id}" not found` });
        return;
      }

      const job = [...jobs.values()]
        .filter((j) => j.serviceId === svc.id)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

      res.json({
        id: svc.id,
        analyzeStatus: job?.status || svc.analyzeStatus || 'idle',
        lastAnalyzedAt: svc.indexedAt,
        jobId: job?.id,
        stats: job?.stats,
        error: job?.error || svc.analyzeError,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
};

export const createOpsRouter = (): Router => {
  const router = Router();

  // POST /api/mv/ops/analyze-all — concurrency limited
  router.post('/analyze-all', async (_req, res) => {
    const services = await listServices();
    const queued: string[] = [];
    for (const svc of services) {
      if (!locks.has(svc.id)) {
        const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const job: AnalyzeJob = {
          id: jobId,
          serviceId: svc.id,
          status: 'queued',
          startedAt: new Date().toISOString(),
          steps: [],
        };
        jobs.set(jobId, job);
        locks.add(svc.id);
        runFullAnalyze(svc, jobId).catch((err) => {
          mvLog.error(LOG, `Unhandled error in analyze-all for ${svc.id}`, err);
        });
        queued.push(svc.id);
      }
    }
    res.status(202).json({ queued, total: queued.length });
  });

  router.post('/relink-all', async (_req, res) => {
    try {
      const services = await listServices();
      const config = await loadConfig();
      const results = await relinkAll((id) => {
        const svc = services.find((s) => s.id === id);
        return path.join(config.workspace.dir, svc?.repoSlug || id);
      });
      res.json({ results, total: results.length });
    } catch (err: unknown) {
      mvLog.error(LOG, 'Relink-all failed', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/cleanup', async (_req, res) => {
    try {
      const result = await cleanupOrphans();
      res.json(result);
    } catch (err: unknown) {
      mvLog.error(LOG, 'Cleanup failed', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
};

async function runFullAnalyze(svc: ServiceNode, jobId: string) {
  const lim = await getLimiter();
  await lim.acquire();
  const job = jobs.get(jobId)!;
  const analyzeStart = Date.now();
  try {
    const repoPath = svc.localPath || (await getRepoPath(svc.id, svc.repoSlug));
    const config = await loadConfig();
    const cloneUrl =
      svc.gitUrl || buildCloneUrl(config.workspace.gitBase, svc.repoProject, svc.repoSlug);

    // Step 1: Clone or pull
    const gitStart = Date.now();
    if (!svc.localPath) {
      updateJobStep(job, 'git', 'running', 'Cloning/pulling repository...');
      await ensureRepo(repoPath, cloneUrl, svc.repoBranch || 'master', job);
      updateJobStep(job, 'git', 'done');
    } else {
      updateJobStep(job, 'git', 'done', 'Using local path (skipped clone)');
    }
    mvLog.timed(LOG, `[analyze:timing] svc=${svc.id} step=git`, gitStart);

    // Step 2: GitNexus core pipeline (in-memory graph)
    const parseStart = Date.now();
    job.status = 'analyzing';
    updateJobStep(job, 'parse', 'running', 'Parsing source code...');
    mvLog.info(LOG, `Analyzing ${svc.id} from ${repoPath}`);
    const { runPipelineFromRepo } = await import('../../core/ingestion/pipeline.js');
    const result = await runPipelineFromRepo(repoPath, () => {});
    const nodeCount = result.graph.nodeCount;
    const edgeCount = result.graph.relationshipCount;
    updateJobStep(job, 'parse', 'done', `${nodeCount} nodes, ${edgeCount} edges`);
    mvLog.timed(
      LOG,
      `[analyze:timing] svc=${svc.id} step=parse nodes=${nodeCount} edges=${edgeCount}`,
      parseStart,
    );

    // Step 2.5: Persist graph to Neo4j (scoped to this service)
    const persistStart = Date.now();
    updateJobStep(job, 'persist', 'running', 'Writing to Neo4j...');
    const { getGraphBackend } = await import('../../core/graph-backend/index.js');
    const backend = await getGraphBackend();

    // Clear old data for this service only
    await backend.executeQuery('MATCH (n {repoId: $id}) DETACH DELETE n', { id: svc.id });
    await backend.executeQuery('MATCH (n:DetectedSink {repoId: $id}) DETACH DELETE n', {
      id: svc.id,
    });
    await backend.executeQuery('MATCH (n:BusinessGroup {serviceId: $id}) DETACH DELETE n', {
      id: svc.id,
    });

    // Insert nodes with repoId tag
    const BATCH = 500;
    const nodesByLabel = new Map<
      string,
      Array<{ id: string; properties: Record<string, unknown> }>
    >();
    for (const node of result.graph.nodes) {
      const label = node.label;
      if (!nodesByLabel.has(label)) nodesByLabel.set(label, []);
      nodesByLabel
        .get(label)!
        .push(node as { id: string; properties: Record<string, unknown>; label: string });
    }
    for (const [label, nodes] of nodesByLabel) {
      for (let i = 0; i < nodes.length; i += BATCH) {
        const batch = nodes.slice(i, i + BATCH).map((n) => ({
          ...n.properties,
          id: n.id,
          repoId: svc.id,
        }));
        await backend.executeQuery(
          `UNWIND $batch AS props MERGE (n:\`${label}\` {id: props.id}) SET n += props`,
          { batch },
        );
      }
    }

    // Insert relationships — use node id→label map for fast index lookup
    const nodeIdToLabel = new Map<string, string>();
    for (const node of result.graph.nodes) {
      nodeIdToLabel.set(node.id, node.label);
    }

    const rels = result.graph.relationships;
    // Group edges by source_label + target_label for label-aware MERGE
    const edgeGroups = new Map<string, any[]>();
    for (const r of rels) {
      const sLabel = nodeIdToLabel.get(r.sourceId) || 'CodeElement';
      const tLabel = nodeIdToLabel.get(r.targetId) || 'CodeElement';
      const key = `${sLabel}|${tLabel}`;
      if (!edgeGroups.has(key)) edgeGroups.set(key, []);
      edgeGroups.get(key)!.push({
        fromId: r.sourceId,
        toId: r.targetId,
        type: r.type,
        confidence: r.confidence ?? 1.0,
        reason: r.reason ?? '',
      });
    }

    for (const [key, group] of edgeGroups) {
      const [sLabel, tLabel] = key.split('|');
      for (let i = 0; i < group.length; i += BATCH) {
        const batch = group.slice(i, i + BATCH);
        await backend.executeQuery(
          `UNWIND $batch AS rel
           MATCH (a:\`${sLabel}\` {id: rel.fromId})
           MATCH (b:\`${tLabel}\` {id: rel.toId})
           MERGE (a)-[r:CodeRelation {type: rel.type}]->(b)
           SET r.confidence = rel.confidence, r.reason = rel.reason`,
          { batch },
        );
      }
    }
    console.log(`⚡ Persisted ${nodeCount} nodes, ${edgeCount} edges to Neo4j for ${svc.id}`);
    updateJobStep(job, 'persist', 'done', `${nodeCount} nodes, ${edgeCount} edges`);
    mvLog.timed(
      LOG,
      `[analyze:timing] svc=${svc.id} step=persist nodes=${nodeCount} edges=${edgeCount}`,
      persistStart,
    );

    // Step 3: Multiverse pipeline (with cloud config if enabled)
    const multiverseStart = Date.now();
    updateJobStep(job, 'multiverse', 'running', 'Cross-service analysis...');
    const cloudConfigUrl = config.cloudConfig?.enabled ? config.cloudConfig.baseUrl : undefined;
    const cloudConfigProfile = config.cloudConfig?.defaultProfile;
    const mvResult = await runMultiversePipeline(
      svc.id,
      repoPath,
      undefined,
      undefined,
      cloudConfigUrl,
      cloudConfigProfile,
    );

    const entryPointCount = mvResult.entryPointCount;
    updateJobStep(
      job,
      'multiverse',
      'done',
      `${mvResult.sinksResolved}/${mvResult.sinksDetected} sinks, ${entryPointCount} entry points`,
    );
    mvLog.timed(
      LOG,
      `[analyze:timing] svc=${svc.id} step=multiverse sinks=${mvResult.sinksDetected}`,
      multiverseStart,
    );
    mvLog.timed(LOG, `[analyze:timing] svc=${svc.id} step=TOTAL`, analyzeStart);

    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.stats = {
      nodes: nodeCount,
      edges: edgeCount,
      files: result.totalFileCount,
      sinksDetected: mvResult.sinksDetected,
      sinksResolved: mvResult.sinksResolved,
      crossLinks: mvResult.linking.transports,
      entryPoints: entryPointCount,
      businessGroups: mvResult.businessGroupCount,
    };

    await updateService(svc.id, {
      indexedAt: job.completedAt,
      nodeCount,
      edgeCount,
      entryPointCount,
      analyzeStatus: 'completed',
    });
    mvLog.info(
      LOG,
      `✅ ${svc.id} analyzed: ${nodeCount} nodes, ${edgeCount} edges, ${entryPointCount} entry points, ${mvResult.sinksDetected} sinks`,
    );
    emitJobEvent(jobId, 'done', { status: 'completed', stats: job.stats });
  } catch (err: any) {
    job.status = 'failed';
    job.completedAt = new Date().toISOString();
    job.error = err.message;
    await updateService(svc.id, { analyzeStatus: 'failed', analyzeError: err.message }).catch(
      () => {},
    );
    mvLog.error(LOG, `❌ ${svc.id} analyze failed`, err);
    emitJobEvent(jobId, 'done', { status: 'failed', error: err.message });
  } finally {
    locks.delete(svc.id);
    lim.release();
    // Cleanup SSE clients
    const clients = sseClients.get(jobId);
    if (clients) {
      for (const r of clients) {
        try {
          r.end();
        } catch {}
      }
      sseClients.delete(jobId);
    }
  }
}

async function runRelink(svc: ServiceNode, jobId: string, skipDetect?: boolean) {
  const job = jobs.get(jobId)!;
  try {
    const repoPath = svc.localPath || (await getRepoPath(svc.id, svc.repoSlug));
    const result = await relinkService(svc.id, repoPath, undefined, skipDetect);
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.stats = {
      sinksDetected: result.sinksDetected,
      sinksResolved: result.sinksResolved,
      crossLinks: result.linking.transports,
    };
  } catch (err: any) {
    job.status = 'failed';
    job.completedAt = new Date().toISOString();
    job.error = err.message;
    mvLog.error(LOG, `Relink failed for ${svc.id}`, err);
  } finally {
    locks.delete(svc.id);
  }
}

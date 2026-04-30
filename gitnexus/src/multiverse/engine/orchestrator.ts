/**
 * Multiverse Orchestrator — wires the full cross-service analysis pipeline
 *
 * Pipeline per service:
 *   1. Detect sinks (sink-detector)
 *   2. Resolve config (config-resolver)
 *   3. Bubble-up resolution (bubble-up)
 *   4. Cross-service linking (cross-linker)
 *
 * After all services:
 *   5. Match consumers
 *   6. Cleanup orphans
 */

import { detectSinks, persistSinks } from './sink-detector.js';
import { resolveConfig, clearConfigCache, lookupConfig } from './config-resolver.js';
import { resolveAllSinks, persistResolutions, type ResolvedSink } from './bubble-up.js';
import { linkCrossService, cleanupOrphans, type LinkingResult } from './cross-linker.js';
import { applyManualResolutions } from './manual-resolutions.js';
import { resolveSinkPatterns, getPatternsForService, type SinkPattern } from './sink-patterns.js';
import { loadConfig } from '../config/loader.js';
import { groupEntrypoints, persistBusinessGroups } from './business-grouper.js';
import { listServices, updateService } from '../admin/service-registry.js';
import { detectLibDependencies } from './lib-detector.js';
import { getGraphBackend } from '../../core/graph-backend/index.js';
import { mvLog } from '../util/logger.js';
import fs from 'fs';
import path from 'path';

const LOG = 'orchestrator';

/** Resolve Listener topic placeholders (${config.key}) using config map */
async function resolveListenerTopics(serviceId: string, configMap: Map<string, string>) {
  const backend = await getGraphBackend();
  const DOLLAR_BRACE = '${';
  const listeners = (await backend
    .executeQuery(
      `
    MATCH (l:Listener {repoId: $repoId})
    WHERE l.topic IS NOT NULL AND l.topic CONTAINS $placeholder
    RETURN l.id AS id, l.topic AS topic
  `,
      { repoId: serviceId, placeholder: DOLLAR_BRACE },
    )
    .catch(() => [])) as Array<{ id: string; topic: string }>;

  const updates: Array<{ id: string; val: string }> = [];
  for (const l of listeners) {
    const keys = [...(l.topic as string).matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
    for (const key of keys) {
      const val = lookupConfig(configMap, key);
      if (val) {
        updates.push({ id: l.id, val });
        break;
      }
    }
  }

  if (updates.length) {
    await backend
      .executeQuery(
        `
      UNWIND $batch AS b
      MATCH (l:Listener {id: b.id}) SET l.resolvedTopic = b.val
    `,
        { batch: updates },
      )
      .catch(() => {});
    mvLog.info(LOG, `${serviceId}: ${updates.length} listener topics resolved from config`);
  }
}

/**
 * Resolve Listener topics from source code patterns:
 * 1. Redis: ChannelTopic("channel") / PatternTopic("pattern") in @Configuration classes
 * 2. Rabbit: @RabbitListener(queues = "#{beanName.name}") SpEL → scan @Bean Queue definitions
 * 3. Redis MessageListener with null topic → scan RedisMessageListenerContainer config
 */
async function resolveListenerTopicsFromSource(
  serviceId: string,
  repoPath: string,
  configMap: Map<string, string>,
) {
  const backend = await getGraphBackend();
  const srcDir = path.join(repoPath, 'src', 'main');
  if (!fs.existsSync(srcDir)) return;

  // Scan all Java files for config patterns
  const topicsByBean = new Map<string, string>(); // beanMethodName → topic/queue value
  const redisTopics: string[] = []; // topics registered in RedisMessageListenerContainer

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !['test', 'node_modules', '.git', 'target'].includes(entry.name))
        walk(full);
      else if (entry.name.endsWith('.java')) {
        let content: string;
        try {
          content = fs.readFileSync(full, 'utf-8');
        } catch {
          continue;
        }

        // Only scan config/configuration files for bean definitions
        if (!content.includes('@Configuration') && !content.includes('@Bean')) continue;

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];

          // Pattern: new ChannelTopic("topic-name") or new PatternTopic("pattern")
          const topicMatch = line.match(/new\s+(ChannelTopic|PatternTopic)\s*\(\s*"([^"]+)"/);
          if (topicMatch) redisTopics.push(topicMatch[2]);

          // Pattern: new ChannelTopic(configValue) where configValue is a @Value field
          const topicVarMatch = line.match(/new\s+(ChannelTopic|PatternTopic)\s*\(\s*(\w+)\s*\)/);
          if (topicVarMatch) {
            const varName = topicVarMatch[2];
            // Look backward for @Value annotation on this variable
            for (let j = Math.max(0, i - 5); j < i; j++) {
              const valMatch = lines[j].match(/@Value\s*\(\s*"\$\{([^}]+)\}"\s*\)/);
              if (valMatch) {
                const resolved = lookupConfig(configMap, valMatch[1]);
                if (resolved) redisTopics.push(resolved);
              }
            }
          }

          // Pattern: new Queue("queue-name") → @Bean method name maps to queue
          const queueMatch = line.match(/new\s+Queue\s*\(\s*"([^"]+)"/);
          if (queueMatch) {
            // Find the @Bean method name above this line
            for (let j = Math.max(0, i - 3); j <= i; j++) {
              const methodMatch = lines[j].match(
                /(?:public|private|protected)?\s*Queue\s+(\w+)\s*\(/,
              );
              if (methodMatch) {
                topicsByBean.set(methodMatch[1], queueMatch[1]);
                break;
              }
            }
          }

          // Pattern: new Queue(properties.getXxx().getQueue()) → resolve from config
          const queuePropMatch = line.match(
            /new\s+Queue\s*\(\s*\w+\.get(\w+)\(\)\.get(\w+)\(\)\s*\)/,
          );
          if (queuePropMatch) {
            for (let j = Math.max(0, i - 3); j <= i; j++) {
              const methodMatch = lines[j].match(
                /(?:public|private|protected)?\s*Queue\s+(\w+)\s*\(/,
              );
              if (methodMatch) {
                // Try to resolve from config: e.g. getVsdgwQueue().getQueue() → app.rabbitmq.vsdgw-queue.queue
                const propName = queuePropMatch[1]
                  .replace(/([a-z])([A-Z])/g, '$1-$2')
                  .toLowerCase();
                const attrName = queuePropMatch[2]
                  .replace(/([a-z])([A-Z])/g, '$1-$2')
                  .toLowerCase();
                for (const [key, val] of configMap) {
                  if (key.includes(propName) && key.endsWith(attrName)) {
                    topicsByBean.set(methodMatch[1], val);
                    break;
                  }
                }
                break;
              }
            }
          }
        }
      }
    }
  };
  walk(srcDir);

  const updates: Array<{ id: string; val: string }> = [];

  // Update Redis listeners with null topic
  if (redisTopics.length) {
    const nullTopicListeners = (await backend
      .executeQuery(
        `
      MATCH (l:Listener {repoId: $repoId})
      WHERE l.listenerType = 'redis' AND (l.topic IS NULL OR l.topic = '')
      RETURN l.id AS id
    `,
        { repoId: serviceId },
      )
      .catch(() => [])) as Array<{ id: string }>;

    // Assign topics round-robin (usually 1:1 in practice)
    for (let i = 0; i < nullTopicListeners.length && i < redisTopics.length; i++) {
      updates.push({ id: nullTopicListeners[i].id, val: redisTopics[i] });
    }
  }

  // Resolve @RabbitListener(queues = "#{beanName.name}") SpEL expressions
  if (topicsByBean.size) {
    const spelListeners = (await backend
      .executeQuery(
        `
      MATCH (l:Listener {repoId: $repoId})
      WHERE l.listenerType = 'rabbit' AND l.topic IS NOT NULL AND l.topic CONTAINS '#{'
      RETURN l.id AS id, l.topic AS topic
    `,
        { repoId: serviceId },
      )
      .catch(() => [])) as Array<{ id: string; topic: string }>;

    for (const l of spelListeners) {
      // Extract #{beanName.name} → beanName
      const spelMatch = (l.topic as string).match(/#\{(\w+)\.(\w+)\}/);
      if (!spelMatch) continue;
      const beanName = spelMatch[1];
      const queue = topicsByBean.get(beanName);
      if (queue) updates.push({ id: l.id, val: queue });
    }
  }

  if (updates.length) {
    await backend
      .executeQuery(
        `
      UNWIND $batch AS b
      MATCH (l:Listener {id: b.id}) SET l.topic = b.val, l.resolvedTopic = b.val
    `,
        { batch: updates },
      )
      .catch(() => {});
    mvLog.info(
      LOG,
      `${serviceId}: ${updates.length} listener topics resolved from source (Redis/Rabbit config)`,
    );
  }
}

export interface AnalyzeResult {
  serviceId: string;
  sinksDetected: number;
  sinksResolved: number;
  sinksUnresolved: number;
  linking: LinkingResult;
  entryPointCount: number;
  businessGroupCount: number;
  duration: number;
}

export interface RelinkResult extends AnalyzeResult {}

/**
 * Run the full multiverse pipeline for a single service.
 * Called after gitnexus core pipeline completes.
 */
export const runMultiversePipeline = async (
  serviceId: string,
  repoPath: string,
  patterns?: SinkPattern[],
  profile?: string,
  cloudConfigBaseUrl?: string,
  cloudConfigProfile?: string,
): Promise<AnalyzeResult> => {
  const start = Date.now();

  // Pre-check: verify Neo4j is reachable
  const backend = await getGraphBackend();
  if (!backend.isReady()) {
    throw new Error(`Neo4j not ready — cannot run pipeline for ${serviceId}`);
  }

  const config = await loadConfig();
  // Merge built-in + YAML + DB custom patterns
  const yamlPatterns = resolveSinkPatterns(config.sinkPatterns);
  let sinkPatterns: SinkPattern[];
  if (patterns) {
    sinkPatterns = patterns;
  } else {
    const dbRows = (await backend
      .executeQuery(
        'MATCH (p:SinkPattern) WHERE p.enabled = true AND NOT coalesce(p.deleted, false) RETURN properties(p) AS props',
      )
      .catch(() => [])) as Array<{ props: Record<string, unknown> }>;
    const dbMap = new Map(dbRows.map((r) => [r.props.id as string, r.props]));
    // DB overrides YAML/built-in by id, and adds custom patterns
    const merged = yamlPatterns.map((p) => (dbMap.has(p.id) ? { ...p, ...dbMap.get(p.id) } : p));
    for (const [id, p] of dbMap) {
      if (!merged.find((m) => m.id === id)) merged.push(p as unknown as SinkPattern);
    }
    sinkPatterns = merged.filter((p) => p.enabled);
  }

  // Step 1: Resolve config FIRST (needed by graph rules + listener resolution)
  let t = Date.now();
  clearConfigCache(serviceId);
  const configMap = await resolveConfig(
    serviceId,
    repoPath,
    profile,
    cloudConfigBaseUrl,
    cloudConfigProfile,
  );
  mvLog.timed(LOG, `${serviceId}: ${configMap.size} config keys`, t);

  // Step 2: Detect entry points (Routes, Listeners, Scheduled)
  t = Date.now();
  {
    const { resolveEntryPointAnnotations, resolveListenerAnnotations } =
      await import('./sink-patterns.js');
    const { detectAndPersistEntryPoints } = await import('./entrypoint-detector.js');
    const epResult = await detectAndPersistEntryPoints(
      serviceId,
      repoPath,
      resolveListenerAnnotations(config.listenerAnnotations),
      resolveEntryPointAnnotations(config.entryPointAnnotations),
    );
    mvLog.timed(
      LOG,
      `${serviceId}: ${epResult.routes} routes, ${epResult.listeners} listeners, ${epResult.scheduled} scheduled`,
      t,
    );
  }

  // Step 2.5: Resolve Listener topics from config
  await resolveListenerTopics(serviceId, configMap);

  // Step 2.6: Resolve Listener topics from source (Redis ChannelTopic, Rabbit SpEL)
  await resolveListenerTopicsFromSource(serviceId, repoPath, configMap);

  // Step 3: Graph pattern rules — language-agnostic entry point detection (with config resolution)
  {
    const { resolveGraphRulesWithDB, executeEntryPointRules, persistGraphRuleMatches } =
      await import('./graph-rules.js');
    const graphRules = await resolveGraphRulesWithDB(config.graphRules);
    const ruleMatches = await executeEntryPointRules(serviceId, graphRules, configMap);
    if (ruleMatches.length) {
      await persistGraphRuleMatches(serviceId, ruleMatches);
      mvLog.timed(LOG, `${serviceId}: ${ruleMatches.length} entry points from graph rules`, t);
    }
  }

  // Step 4: Detect sinks (scan source files)
  t = Date.now();
  const scopedSinkPatterns = await getPatternsForService(sinkPatterns, serviceId);
  const sinks = await detectSinks(serviceId, repoPath, scopedSinkPatterns);
  await persistSinks(serviceId, sinks);
  mvLog.timed(LOG, `${serviceId}: ${sinks.length} sinks detected`, t);

  // Step 5: Bubble-up resolution
  t = Date.now();
  const resolved = await resolveAllSinks(sinks, configMap);
  await persistResolutions(resolved);
  let sinksResolved = resolved.filter((r) => r.resolvedValue !== null).length;
  mvLog.timed(LOG, `${serviceId}: ${sinksResolved}/${sinks.length} sinks resolved`, t);

  // Step 5.5: LLM auto-resolve unresolved sinks
  const unresolvedCount = sinks.length - sinksResolved;
  if (unresolvedCount > 0) {
    t = Date.now();
    const { llmResolveSinks } = await import('./llm-sink-resolver.js');
    const { resolveWikiLLMConfig } = await import('../wiki/llm-wiki-client.js');
    const llmConfig = resolveWikiLLMConfig(config.wiki?.llm);
    if (llmConfig) {
      const llmResult = await llmResolveSinks(serviceId, repoPath, configMap, llmConfig);
      if (llmResult.resolved > 0) {
        sinksResolved += llmResult.resolved;
        // Reload resolved values from Neo4j so cross-linker sees LLM results
        for (const r of resolved) {
          if (r.resolvedValue) continue;
          const detail = llmResult.details.find(
            (d: { sinkId: string; value?: string }) => d.sinkId === r.id,
          );
          if (detail?.value) {
            r.resolvedValue = detail.value;
            r.confidence = 0.7;
            r.resolvedVia = 'llm-auto';
          }
        }
        mvLog.timed(
          LOG,
          `${serviceId}: LLM resolved ${llmResult.resolved}/${unresolvedCount} → total ${sinksResolved}/${sinks.length}`,
          t,
        );
      }
    }
  }

  // Step 5.9: Apply cached manual resolutions (survive re-analyze)
  const manualApplied = await applyManualResolutions(serviceId, resolved);
  if (manualApplied > 0) {
    sinksResolved += manualApplied;
    await persistResolutions(resolved);
  }

  // Step 6: Cross-service linking
  t = Date.now();
  const linking = await linkCrossService(serviceId, resolved);
  mvLog.timed(
    LOG,
    `${serviceId}: gateways=${linking.gateways} transports=${linking.transports} serves=${linking.serves}`,
    t,
  );

  // Step 6.5: LLM-assisted endpoint matching for unmatched transports
  {
    const { llmMatchEndpoints } = await import('./llm-endpoint-matcher.js');
    const { resolveWikiLLMConfig } = await import('../wiki/llm-wiki-client.js');
    const llmConfig = resolveWikiLLMConfig(config.wiki?.llm);
    const matchResult = await llmMatchEndpoints(serviceId, repoPath, llmConfig);
    if (matchResult.matched > 0) {
      linking.serves += matchResult.matched;
      mvLog.info(
        LOG,
        `${serviceId}: LLM matched ${matchResult.matched}/${matchResult.total} endpoints`,
      );
    }
  }

  // Step 7: Business grouping
  t = Date.now();
  const groups = await groupEntrypoints(serviceId);
  await persistBusinessGroups(serviceId, groups);
  const entryPointCount = groups.reduce((s, g) => s + g.entryPointCount, 0);
  mvLog.timed(LOG, `${serviceId}: ${groups.length} groups, ${entryPointCount} entry points`, t);

  // Step 8: Detect library dependencies (pom.xml)
  const libDeps = await detectLibDependencies(serviceId, repoPath);
  if (libDeps > 0) mvLog.info(LOG, `${serviceId}: ${libDeps} library dependencies linked`);

  // Update service stats
  await updateService(serviceId, { entryPointCount }).catch((err) => {
    mvLog.warn(LOG, `Failed to update service stats for ${serviceId}`, err);
  });

  // Step 9: Auto-generate wiki (if configured)
  if (config.wiki?.outputDir && config.wiki?.autoGenerate) {
    try {
      const { generateServiceWiki } = await import('../wiki/markdown-wiki-generator.js');
      await generateServiceWiki(serviceId, config.wiki.outputDir);
      mvLog.info(LOG, `${serviceId}: wiki generated → ${config.wiki.outputDir}/${serviceId}/`);
    } catch (err) {
      mvLog.warn(
        LOG,
        `${serviceId}: wiki generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    serviceId,
    sinksDetected: sinks.length,
    sinksResolved,
    sinksUnresolved: sinks.length - sinksResolved,
    linking,
    entryPointCount,
    businessGroupCount: groups.length,
    duration: Date.now() - start,
  };
};

/**
 * Re-link only (skip gitnexus core pipeline).
 * Uses existing DetectedSink nodes + fresh config resolution.
 */
export const relinkService = async (
  serviceId: string,
  repoPath: string,
  profile?: string,
  skipDetect?: boolean,
): Promise<RelinkResult> => {
  const start = Date.now();

  let resolved: ResolvedSink[];
  let manualApplied = 0;

  if (skipDetect) {
    // Read ALL existing sinks from graph, then re-apply manual resolutions
    const backend = await getGraphBackend();
    const rows = (await backend.executeQuery(
      `MATCH (d:DetectedSink {repoId: $svc}) RETURN d { .* } AS props`,
      { svc: serviceId },
    )) as Array<{ props: Record<string, unknown> }>;
    resolved = rows.map((r) => ({
      ...r.props,
      resolvedValue: (r.props.resolvedUrl as string) || (r.props.resolvedTopic as string) || null,
    })) as unknown as ResolvedSink[];
    manualApplied = await applyManualResolutions(serviceId, resolved);
    if (manualApplied > 0) {
      await persistResolutions(resolved);
    }
  } else {
    const sinks = await detectSinks(serviceId, repoPath);
    await persistSinks(serviceId, sinks);
    clearConfigCache(serviceId);
    const configMap = await resolveConfig(serviceId, repoPath, profile);
    resolved = await resolveAllSinks(sinks, configMap);
    await persistResolutions(resolved);
    // Re-apply cached manual resolutions so they survive re-detect
    manualApplied = await applyManualResolutions(serviceId, resolved);
    if (manualApplied > 0) {
      await persistResolutions(resolved);
    }
  }

  const linking = await linkCrossService(serviceId, resolved);

  // LLM-assisted endpoint matching for unmatched transports
  {
    const config = await loadConfig();
    const { llmMatchEndpoints } = await import('./llm-endpoint-matcher.js');
    const { resolveWikiLLMConfig } = await import('../wiki/llm-wiki-client.js');
    const llmConfig = resolveWikiLLMConfig(config.wiki?.llm);
    const matchResult = await llmMatchEndpoints(serviceId, repoPath, llmConfig);
    if (matchResult.matched > 0) {
      linking.serves += matchResult.matched;
    }
  }

  const sinksResolved = resolved.filter((r) => r.resolvedValue !== null).length;

  return {
    serviceId,
    sinksDetected: resolved.length,
    sinksResolved,
    sinksUnresolved: resolved.length - sinksResolved,
    linking,
    entryPointCount: 0,
    businessGroupCount: 0,
    duration: Date.now() - start,
  };
};

/**
 * Analyze all services in order (libs first, then services in parallel).
 */
export const analyzeAll = async (
  getRepoPath: (serviceId: string) => string,
  maxConcurrency: number = 3,
): Promise<AnalyzeResult[]> => {
  const services = await listServices();

  // Split: libs first (sequential — may be dependencies), then services (parallel)
  const libs = services.filter((s) => s.type === 'lib');
  const svcs = services.filter((s) => s.type !== 'lib');

  const results: AnalyzeResult[] = [];
  const failResult = (id: string): AnalyzeResult => ({
    serviceId: id,
    sinksDetected: 0,
    sinksResolved: 0,
    sinksUnresolved: 0,
    linking: { gateways: 0, transports: 0, transportsTo: 0, serves: 0, unresolved: 0 },
    entryPointCount: 0,
    businessGroupCount: 0,
    duration: 0,
  });

  // Phase 1: libs sequential (order matters for DEPENDS_ON)
  for (const lib of libs) {
    try {
      results.push(await runMultiversePipeline(lib.id, getRepoPath(lib.id)));
    } catch {
      results.push(failResult(lib.id));
    }
  }

  // Phase 2: services parallel with concurrency limit
  const queue = [...svcs];
  const running = new Map<string, Promise<AnalyzeResult>>();

  while (queue.length > 0 || running.size > 0) {
    // Fill up to maxConcurrency
    while (queue.length > 0 && running.size < maxConcurrency) {
      const svc = queue.shift()!;
      const p = runMultiversePipeline(svc.id, getRepoPath(svc.id))
        .catch((): AnalyzeResult => failResult(svc.id))
        .then((r) => {
          running.delete(svc.id);
          return r;
        });
      running.set(svc.id, p);
    }
    // Wait for any one to finish
    if (running.size > 0) {
      const result = await Promise.race(running.values());
      results.push(result);
    }
  }

  // Final cleanup
  await cleanupOrphans();

  return results;
};

/**
 * Re-link all services (no re-analyze, just re-run cross-linking).
 */
export const relinkAll = async (
  getRepoPath: (serviceId: string) => string,
  skipDetect?: boolean,
): Promise<RelinkResult[]> => {
  const services = await listServices();
  const results: RelinkResult[] = [];

  for (const svc of services) {
    try {
      const result = await relinkService(svc.id, getRepoPath(svc.id), undefined, skipDetect);
      results.push(result);
    } catch {
      results.push({
        serviceId: svc.id,
        sinksDetected: 0,
        sinksResolved: 0,
        sinksUnresolved: 0,
        linking: { gateways: 0, transports: 0, transportsTo: 0, serves: 0, unresolved: 0 },
        entryPointCount: 0,
        businessGroupCount: 0,
        duration: 0,
      });
    }
  }

  await cleanupOrphans();
  return results;
};

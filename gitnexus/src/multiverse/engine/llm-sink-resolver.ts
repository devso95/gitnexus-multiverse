/**
 * LLM Sink Resolver
 *
 * Strategy:
 *   1) Deterministic pre-resolve (literal, ${key}, concat, known constants)
 *   2) LLM fallback for unresolved sinks with compact contextual prompts
 *   3) Persist enriched resolution metadata for reporting/review
 */

import fs from 'fs';
import path from 'path';
import { getGraphBackend } from '../../core/graph-backend/index.js';
import { resolveWikiLLMConfig, callWikiLLM, isCircuitOpen } from '../wiki/llm-wiki-client.js';
import { saveManualResolution } from './manual-resolutions.js';
import { mvLog } from '../util/logger.js';
import type { LLMConfig } from '../../core/wiki/llm-client.js';

const LOG = 'llm-sink-resolver';

const SYSTEM_PROMPT = `You are a Java/Spring Boot code analyzer.
Return strict JSON only:
{"results":[{"sinkId":"...","resolvedValue":"...","confidence":0.0,"evidence":"...","reason":"..."}]}

Rules:
- If unresolved, set resolvedValue to "UNKNOWN"
- confidence range: 0.0 to 1.0
- reason one of: resolved, missing_config_key, dynamic_runtime_value, unsupported_wrapper, insufficient_context, llm_timeout, llm_invalid_output
- No markdown, no extra keys.`;

export type ResolutionReason =
  | 'missing_config_key'
  | 'dynamic_runtime_value'
  | 'unsupported_wrapper'
  | 'insufficient_context'
  | 'llm_timeout'
  | 'llm_invalid_output'
  | 'resolved';

export interface LLMResolveOptions {
  sinkIds?: string[];
  mode?: 'fast' | 'balanced' | 'deep';
  limit?: number;
  batchSize?: number;
  onlyUnresolved?: boolean;
}

export interface LLMResolveDetail {
  sinkId: string;
  value: string | null;
  confidence?: number;
  method?: 'deterministic' | 'llm-batch' | 'manual' | 'manual-cached' | 'llm-auto';
  reason?: ResolutionReason;
  evidence?: string;
  error?: string;
}

export interface LLMResolveResult {
  total: number;
  resolved: number;
  failed: number;
  deterministicResolved: number;
  llmResolved: number;
  details: LLMResolveDetail[];
}

interface SinkRow {
  id: string;
  patternId?: string;
  sinkType: string;
  calleeMethod: string;
  targetExpression: string;
  filePath: string;
  lineNumber: number;
  callSiteMethod: string;
}

function normalizeResolvedValue(raw: string): string | null {
  const v = raw.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!v || v === 'UNKNOWN') return null;
  return v;
}

function pickConfigCandidates(sink: SinkRow, configMap: Map<string, string>, max = 20): string[] {
  const expr = `${sink.targetExpression} ${sink.calleeMethod} ${sink.callSiteMethod}`.toLowerCase();
  const tokens = expr
    .split(/[^a-z0-9_.-]+/)
    .filter((t) => t.length >= 3)
    .slice(0, 30);
  const ranked: Array<{ key: string; value: string; score: number }> = [];

  for (const [key, value] of configMap) {
    let score = 0;
    for (const t of tokens) {
      if (key.toLowerCase().includes(t)) score += 2;
      if (value.toLowerCase().includes(t)) score += 1;
    }
    if (sink.sinkType === 'http' && /(url|base|host|path|endpoint)/i.test(key)) score += 1;
    if (sink.sinkType === 'kafka' && /(topic)/i.test(key)) score += 1;
    if (sink.sinkType === 'rabbit' && /(queue|exchange|routing)/i.test(key)) score += 1;
    if (sink.sinkType === 'redis' && /(channel|topic|stream)/i.test(key)) score += 1;
    if (score > 0) ranked.push({ key, value, score });
  }

  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, max).map((x) => `${x.key} = ${x.value}`);
}

function deterministicResolve(
  sink: SinkRow,
  configMap: Map<string, string>,
): { value: string | null; reason: ResolutionReason; evidence: string } {
  const expr = (sink.targetExpression || '').trim();
  if (!expr) return { value: null, reason: 'insufficient_context', evidence: 'empty expression' };

  // Direct literal
  const literal = expr.match(/^["']([^"']+)["']$/);
  if (literal) return { value: literal[1], reason: 'resolved', evidence: 'literal target' };

  // Single placeholder ${key}
  const singleKey = expr.match(/^\$\{([^}]+)\}$/);
  if (singleKey) {
    const val = configMap.get(singleKey[1]);
    if (val) return { value: val, reason: 'resolved', evidence: `config key ${singleKey[1]}` };
    return {
      value: null,
      reason: 'missing_config_key',
      evidence: `missing config key ${singleKey[1]}`,
    };
  }

  // Composite ${a}+${b}
  const keys = [...expr.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
  if (keys.length > 0) {
    const parts: string[] = [];
    for (const k of keys) {
      const v = configMap.get(k);
      if (!v)
        return { value: null, reason: 'missing_config_key', evidence: `missing config key ${k}` };
      parts.push(v);
    }
    const joined = parts.join('');
    return { value: joined, reason: 'resolved', evidence: `joined ${keys.length} config keys` };
  }

  // URL-ish raw
  if (/^(https?:\/\/|\/)/i.test(expr)) {
    return { value: expr, reason: 'resolved', evidence: 'url-like expression' };
  }

  // Dynamic variable fallback
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(expr)) {
    return { value: null, reason: 'dynamic_runtime_value', evidence: `runtime variable ${expr}` };
  }

  return { value: null, reason: 'insufficient_context', evidence: 'non-deterministic expression' };
}

function buildBatchPrompt(
  sinks: SinkRow[],
  contextBySink: Map<string, string>,
  configCandidatesBySink: Map<string, string[]>,
): string {
  const sections = sinks.map((s) => {
    const candidates = configCandidatesBySink.get(s.id) || [];
    const ctx = contextBySink.get(s.id) || '(no context)';
    return `### sinkId: ${s.id}
type: ${s.sinkType}
callee: ${s.calleeMethod}
targetExpression: ${s.targetExpression}
file: ${s.filePath}:${s.lineNumber}

sourceContext:
\`\`\`java
${ctx}
\`\`\`

configCandidates:
${candidates.length ? candidates.join('\n') : '(none)'}`;
  });

  return `Resolve each sink target.

${sections.join('\n\n')}

Return strict JSON object as specified in system prompt.`;
}

function parseBatchResponse(raw: string): Map<string, LLMResolveDetail> {
  try {
    const parsed = JSON.parse(raw) as {
      results?: Array<{
        sinkId?: string;
        resolvedValue?: string;
        confidence?: number;
        evidence?: string;
        reason?: ResolutionReason;
      }>;
    };
    const out = new Map<string, LLMResolveDetail>();
    for (const r of parsed.results || []) {
      if (!r.sinkId) continue;
      const value = normalizeResolvedValue(String(r.resolvedValue || 'UNKNOWN'));
      out.set(r.sinkId, {
        sinkId: r.sinkId,
        value,
        confidence: typeof r.confidence === 'number' ? r.confidence : value ? 0.65 : 0.0,
        method: 'llm-batch',
        reason: r.reason || (value ? 'resolved' : 'llm_invalid_output'),
        evidence: r.evidence || '',
      });
    }
    return out;
  } catch {
    return new Map();
  }
}

async function readSinkContext(repoPath: string, sink: SinkRow): Promise<string> {
  const fullPath = path.join(repoPath, sink.filePath);
  if (!fs.existsSync(fullPath)) return '(file not found)';
  const content = fs.readFileSync(fullPath, 'utf-8');
  const lines = content.split('\n');
  const sinkLine = sink.lineNumber || 1;
  const start = Math.max(0, sinkLine - 20);
  const end = Math.min(lines.length, sinkLine + 8);
  return lines
    .slice(start, end)
    .map((line, i) => {
      const n = start + i + 1;
      const marker = n === sinkLine ? '>>>' : '   ';
      return `${marker} ${n}: ${line}`;
    })
    .join('\n');
}

async function persistResolution(
  sink: SinkRow,
  resolvedValue: string | null,
  method: 'deterministic' | 'llm-batch' | 'llm-auto',
  confidence: number,
  reason: ResolutionReason,
  evidence: string,
) {
  const backend = await getGraphBackend();
  const isHttp = sink.sinkType === 'http';
  await backend.executeQuery(
    `MATCH (d:DetectedSink {id: $id})
     SET d.resolvedUrl = $resolvedUrl,
         d.resolvedTopic = $resolvedTopic,
         d.confidence = $confidence,
         d.resolvedVia = $resolvedVia,
         d.resolutionStatus = $resolutionStatus,
         d.resolutionConfidence = $resolutionConfidence,
         d.resolutionMethod = $resolutionMethod,
         d.resolutionReason = $resolutionReason,
         d.resolutionEvidence = $resolutionEvidence,
         d.resolutionUpdatedAt = datetime().toString()`,
    {
      id: sink.id,
      resolvedUrl: isHttp && resolvedValue ? resolvedValue : '',
      resolvedTopic: !isHttp && resolvedValue ? resolvedValue : '',
      confidence: resolvedValue ? confidence : 0,
      resolvedVia: resolvedValue ? method : '',
      resolutionStatus: resolvedValue ? 'resolved' : 'needs_review',
      resolutionConfidence: resolvedValue ? confidence : 0,
      resolutionMethod: resolvedValue ? method : '',
      resolutionReason: reason,
      resolutionEvidence: evidence,
    },
  );
}

export async function llmResolveSinks(
  serviceId: string,
  repoPath: string,
  configMap: Map<string, string>,
  llmConfig?: LLMConfig | null,
  options: LLMResolveOptions = {},
): Promise<LLMResolveResult> {
  const result: LLMResolveResult = {
    total: 0,
    resolved: 0,
    failed: 0,
    deterministicResolved: 0,
    llmResolved: 0,
    details: [],
  };

  const config = llmConfig ?? resolveWikiLLMConfig();
  const mode = options.mode || 'balanced';
  const limit = options.limit ?? (mode === 'fast' ? 60 : mode === 'deep' ? 500 : 200);
  const batchSize = Math.max(1, options.batchSize ?? (mode === 'fast' ? 10 : 6));
  const onlyUnresolved = options.onlyUnresolved ?? true;

  const backend = await getGraphBackend();
  const unresolved = (await backend
    .executeQuery(
      `MATCH (d:DetectedSink {repoId: $serviceId})
       WHERE (${onlyUnresolved ? "coalesce(d.resolutionStatus, 'unresolved') = 'unresolved'" : '1=1'})
         AND d.confidence < 0.9
         ${options.sinkIds?.length ? 'AND d.id IN $sinkIds' : ''}
       RETURN d.id AS id, d.patternId AS patternId, d.sinkType AS sinkType,
              d.calleeMethod AS calleeMethod, d.targetExpression AS targetExpression,
              d.filePath AS filePath, d.lineNumber AS lineNumber,
              d.callSiteMethod AS callSiteMethod
       ORDER BY d.filePath, d.lineNumber
       LIMIT $limit`,
      {
        serviceId,
        limit,
        ...(options.sinkIds?.length ? { sinkIds: options.sinkIds } : {}),
      },
    )
    .catch(() => [])) as SinkRow[];

  if (!unresolved.length) return result;
  result.total = unresolved.length;

  const remaining: SinkRow[] = [];
  for (const sink of unresolved) {
    const det = deterministicResolve(sink, configMap);
    if (det.value) {
      await persistResolution(sink, det.value, 'deterministic', 0.92, det.reason, det.evidence);
      await saveManualResolution({
        serviceId,
        patternId: sink.patternId || '',
        filePath: sink.filePath,
        lineNumber: sink.lineNumber || 0,
        resolvedValue: det.value,
        sinkType: sink.sinkType,
        confidence: 0.92,
        note: `deterministic resolve: ${det.evidence}`,
      }).catch(() => {});
      result.resolved++;
      result.deterministicResolved++;
      result.details.push({
        sinkId: sink.id,
        value: det.value,
        confidence: 0.92,
        method: 'deterministic',
        reason: det.reason,
        evidence: det.evidence,
      });
    } else {
      remaining.push(sink);
    }
  }

  if (!remaining.length) {
    mvLog.info(
      LOG,
      `${serviceId}: deterministic resolved ${result.deterministicResolved}/${result.total}`,
    );
    return result;
  }

  if (!config || isCircuitOpen()) {
    for (const sink of remaining) {
      const d = deterministicResolve(sink, configMap);
      await persistResolution(sink, null, 'llm-auto', 0, d.reason, d.evidence);
      result.failed++;
      result.details.push({
        sinkId: sink.id,
        value: null,
        method: 'llm-auto',
        reason: d.reason,
        evidence: d.evidence,
        error: 'LLM unavailable or circuit open',
      });
    }
    return result;
  }

  for (let i = 0; i < remaining.length; i += batchSize) {
    const batch = remaining.slice(i, i + batchSize);
    const contextBySink = new Map<string, string>();
    const cfgBySink = new Map<string, string[]>();
    for (const sink of batch) {
      contextBySink.set(sink.id, await readSinkContext(repoPath, sink));
      cfgBySink.set(sink.id, pickConfigCandidates(sink, configMap, mode === 'fast' ? 12 : 20));
    }

    const prompt = buildBatchPrompt(batch, contextBySink, cfgBySink);
    const raw = await callWikiLLM(prompt, SYSTEM_PROMPT, config);
    const parsed = raw ? parseBatchResponse(raw) : new Map<string, LLMResolveDetail>();

    for (const sink of batch) {
      const hit = parsed.get(sink.id);
      if (!hit) {
        const reason: ResolutionReason = raw ? 'llm_invalid_output' : 'llm_timeout';
        await persistResolution(sink, null, 'llm-auto', 0, reason, 'no valid JSON result for sink');
        result.failed++;
        result.details.push({
          sinkId: sink.id,
          value: null,
          method: 'llm-auto',
          reason,
          evidence: 'missing sink in LLM response',
          error: raw ? 'invalid output' : 'llm unavailable',
        });
        continue;
      }

      const val = hit.value;
      if (!val) {
        await persistResolution(
          sink,
          null,
          'llm-batch',
          0,
          hit.reason || 'insufficient_context',
          hit.evidence || '',
        );
        result.failed++;
        result.details.push({
          sinkId: sink.id,
          value: null,
          method: 'llm-batch',
          reason: hit.reason || 'insufficient_context',
          confidence: 0,
          evidence: hit.evidence,
        });
        continue;
      }

      const conf = Math.max(0.55, Math.min(0.9, hit.confidence ?? 0.7));
      await persistResolution(
        sink,
        val,
        'llm-batch',
        conf,
        hit.reason || 'resolved',
        hit.evidence || '',
      );
      await saveManualResolution({
        serviceId,
        patternId: sink.patternId || '',
        filePath: sink.filePath,
        lineNumber: sink.lineNumber || 0,
        resolvedValue: val,
        sinkType: sink.sinkType,
        confidence: conf,
        note: `llm-batch resolve: ${hit.evidence || 'n/a'}`,
      }).catch(() => {});

      result.resolved++;
      result.llmResolved++;
      result.details.push({
        sinkId: sink.id,
        value: val,
        confidence: conf,
        method: 'llm-batch',
        reason: hit.reason || 'resolved',
        evidence: hit.evidence,
      });
    }
  }

  mvLog.info(
    LOG,
    `${serviceId}: resolved ${result.resolved}/${result.total} (deterministic=${result.deterministicResolved}, llm=${result.llmResolved})`,
  );
  return result;
}

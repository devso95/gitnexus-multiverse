/**
 * LLM Sink Resolver — auto-resolve unresolved sinks using LLM
 *
 * For each unresolved sink:
 *   1. Read source context (class fields, surrounding code)
 *   2. Gather relevant config keys
 *   3. Ask LLM: "What URL/topic does this sink call?"
 *   4. Persist the resolution + auto-save as ManualResolution for future runs
 *
 * Circuit breaker: stops after 2 consecutive LLM failures (via llm-wiki-client).
 */

import fs from 'fs';
import path from 'path';
import { getGraphBackend } from '../../core/graph-backend/index.js';
import { resolveWikiLLMConfig, callWikiLLM, isCircuitOpen } from '../wiki/llm-wiki-client.js';
import { saveManualResolution } from './manual-resolutions.js';
import { mvLog } from '../util/logger.js';
import type { LLMConfig } from '../../core/wiki/llm-client.js';

const LOG = 'llm-sink-resolver';

const SYSTEM_PROMPT = `You are a Java/Spring Boot code analyzer. Given source code context and config keys,
determine the actual URL or topic that an outbound call targets.

RULES:
- Return ONLY the resolved value (URL or topic string). No explanation.
- If it's an HTTP call, return the full URL (e.g. https://api.example.com/v1/path)
- If it's a Kafka/Rabbit/Redis call, return the topic/queue name
- If you can determine base URL + path separately, concatenate them
- If you truly cannot determine the value, return exactly: UNKNOWN
- Do NOT guess or hallucinate values not supported by the code/config`;

function buildPrompt(
  sink: {
    sinkType: string;
    calleeMethod: string;
    targetExpression: string;
    filePath: string;
    lineNumber: number;
  },
  sourceContext: string,
  classFields: string[],
  configKeys: string[],
): string {
  return `Resolve the target of this outbound call:

## Sink Info
- Type: ${sink.sinkType}
- Method call: ${sink.calleeMethod}
- Target expression: ${sink.targetExpression}
- File: ${sink.filePath}:${sink.lineNumber}

## Source Context
\`\`\`java
${sourceContext}
\`\`\`

## Class Fields (annotations, injected values)
${classFields.length ? classFields.join('\n') : '(none found)'}

## Available Config Keys
${configKeys.length ? configKeys.join('\n') : '(none relevant)'}

What is the actual URL or topic this call targets? Return ONLY the value.`;
}

export interface LLMResolveResult {
  total: number;
  resolved: number;
  failed: number;
  details: Array<{ sinkId: string; value: string | null; error?: string }>;
}

/**
 * Auto-resolve unresolved sinks using LLM.
 * Called after bubble-up in the orchestrator pipeline.
 */
export async function llmResolveSinks(
  serviceId: string,
  repoPath: string,
  configMap: Map<string, string>,
  llmConfig?: LLMConfig | null,
  options: { sinkIds?: string[] } = {},
): Promise<LLMResolveResult> {
  const result: LLMResolveResult = { total: 0, resolved: 0, failed: 0, details: [] };

  const config = llmConfig ?? resolveWikiLLMConfig();
  if (!config) {
    mvLog.info(LOG, `${serviceId}: no LLM configured — skipping auto-resolve`);
    return result;
  }

  const backend = await getGraphBackend();

  // Find unresolved sinks
  const unresolved = (await backend
    .executeQuery(
      `MATCH (d:DetectedSink {repoId: $serviceId})
     WHERE d.confidence < 0.5${options.sinkIds?.length ? ' AND d.id IN $sinkIds' : ''}
     RETURN d.id AS id, d.patternId AS patternId, d.sinkType AS sinkType,
            d.calleeMethod AS calleeMethod, d.targetExpression AS targetExpression,
            d.filePath AS filePath, d.lineNumber AS lineNumber,
            d.callSiteMethod AS callSiteMethod
     ORDER BY d.filePath`,
      options.sinkIds?.length ? { serviceId, sinkIds: options.sinkIds } : { serviceId },
    )
    .catch(() => [])) as Array<{
    id: string;
    patternId?: string;
    sinkType: string;
    calleeMethod: string;
    targetExpression: string;
    filePath: string;
    lineNumber: number;
    callSiteMethod: string;
  }>;

  if (!unresolved.length) return result;
  result.total = unresolved.length;
  mvLog.info(LOG, `${serviceId}: ${unresolved.length} unresolved sinks — attempting LLM resolve`);

  for (const sink of unresolved) {
    // Circuit breaker: stop early if LLM is down
    if (isCircuitOpen()) {
      mvLog.info(
        LOG,
        `${serviceId}: circuit open — skipping remaining ${unresolved.length - result.resolved - result.failed} sinks`,
      );
      result.failed += unresolved.length - result.resolved - result.failed;
      break;
    }

    try {
      // Read source context
      const fullPath = path.join(repoPath, sink.filePath);
      if (!fs.existsSync(fullPath)) {
        result.failed++;
        result.details.push({ sinkId: sink.id, value: null, error: 'file not found' });
        continue;
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');
      const sinkLine = sink.lineNumber || 1;
      const start = Math.max(0, sinkLine - 25);
      const end = Math.min(lines.length, sinkLine + 5);
      const sourceContext = lines
        .slice(start, end)
        .map((l, i) => {
          const num = start + i + 1;
          const marker = num === sinkLine ? '>>>' : '   ';
          return `${marker} ${num}: ${l}`;
        })
        .join('\n');

      // Extract class fields
      const classFields: string[] = [];
      for (let i = 0; i < Math.min(lines.length, sinkLine); i++) {
        const l = lines[i].trim();
        if (
          l.includes('@Value') ||
          l.includes('@ConfigurationProperties') ||
          (l.includes('private') && (l.includes('String') || l.includes('Properties')))
        ) {
          classFields.push(`${i + 1}: ${l}`);
        }
      }

      // Gather relevant config keys
      const relevantKeys: string[] = [];
      for (const [key, val] of configMap) {
        const isRelevant =
          (sink.sinkType === 'http' &&
            (key.includes('url') ||
              key.includes('base') ||
              key.includes('host') ||
              key.includes('path'))) ||
          (sink.sinkType === 'kafka' && key.includes('topic')) ||
          (sink.sinkType === 'rabbit' && (key.includes('queue') || key.includes('exchange'))) ||
          (sink.sinkType === 'redis' && (key.includes('channel') || key.includes('topic')));
        if (isRelevant) relevantKeys.push(`${key} = ${val}`);
        if (relevantKeys.length >= 40) break;
      }

      // Call LLM
      const prompt = buildPrompt(sink, sourceContext, classFields, relevantKeys);
      const llmResult = await callWikiLLM(prompt, SYSTEM_PROMPT, config);

      if (!llmResult || llmResult.trim() === 'UNKNOWN' || llmResult.trim().length < 3) {
        result.failed++;
        result.details.push({
          sinkId: sink.id,
          value: null,
          error: llmResult ? 'LLM returned UNKNOWN' : 'LLM unavailable',
        });
        continue;
      }

      const resolvedValue = llmResult.trim().replace(/^["'`]+|["'`]+$/g, '');

      // Persist resolution to DetectedSink
      const isHttp = sink.sinkType === 'http';
      await backend.executeQuery(
        `MATCH (d:DetectedSink {id: $id})
         SET d.resolvedUrl = $resolvedUrl, d.resolvedTopic = $resolvedTopic,
             d.confidence = 0.7, d.resolvedVia = 'llm-auto',
             d.targetExpression = $target`,
        {
          id: sink.id,
          resolvedUrl: isHttp ? resolvedValue : '',
          resolvedTopic: isHttp ? '' : resolvedValue,
          target: sink.targetExpression || '',
        },
      );

      // Auto-save as ManualResolution so it survives re-analyze
      await saveManualResolution({
        serviceId,
        patternId: sink.patternId || '',
        filePath: sink.filePath,
        lineNumber: sink.lineNumber || 0,
        resolvedValue,
        sinkType: sink.sinkType,
        confidence: 0.7,
        note: 'auto-resolved by LLM',
      }).catch((err) => {
        mvLog.warn(LOG, `Failed to cache LLM resolution: ${err.message}`);
      });

      result.resolved++;
      result.details.push({ sinkId: sink.id, value: resolvedValue });
      mvLog.info(LOG, `  ✓ ${sink.callSiteMethod}: ${resolvedValue}`);
    } catch (err: unknown) {
      result.failed++;
      result.details.push({
        sinkId: sink.id,
        value: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  mvLog.info(LOG, `${serviceId}: LLM resolved ${result.resolved}/${result.total} sinks`);
  return result;
}

/**
 * Sink Detector v2 — scan source files directly
 *
 * Instead of relying on CALLS graph edges (which use simplified method names),
 * grep source files for sink patterns like kafkaTemplate.send(), callApi(), etc.
 * Then map file+line back to the nearest Method node in the graph.
 */

import fs from 'fs';
import path from 'path';
import { getGraphBackend } from '../../core/graph-backend/index.js';
import { DEFAULT_SINK_PATTERNS, matchesPatternApplicability } from './sink-patterns.js';
import type { SinkPattern } from './sink-patterns.js';
import { mvLog } from '../util/logger.js';
import { findMultiverseSourceFiles, sanitizeSourceLines } from './source-file-utils.js';
import { DetectedSink } from '../api/types.js';

const LOG = 'sink-detector';

// export interface DetectedSink { ... } // Removed, using central types.ts

/** Extract the first argument from a method call at a given position */
const extractArg = (line: string, matchIdx: number): string => {
  const after = line.slice(matchIdx);
  const parenStart = after.indexOf('(');
  if (parenStart < 0) return '';
  let depth = 0;
  const argStart = parenStart + 1;
  for (let i = argStart; i < after.length; i++) {
    if (after[i] === '(') depth++;
    else if (after[i] === ')') {
      if (depth === 0) return after.slice(argStart, i).split(',')[0].trim();
      depth--;
    }
  }
  return after
    .slice(argStart, argStart + 80)
    .split(',')[0]
    .trim();
};

/**
 * Detect sinks by scanning source files for patterns.
 */
export const detectSinks = async (
  repoId: string,
  repoPath: string,
  patterns: SinkPattern[] = DEFAULT_SINK_PATTERNS,
): Promise<DetectedSink[]> => {
  const enabled = patterns.filter((p) => p.enabled);
  if (!enabled.length) return [];

  const compiled = enabled.map((p) => ({
    ...p,
    regex: new RegExp(p.methodPattern, 'g'),
  }));

  const files = findMultiverseSourceFiles(repoPath);
  const sinks: DetectedSink[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const relPath = path.relative(repoPath, file).split(path.sep).join('/');
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }

    const applicablePatterns = compiled.filter((pattern) =>
      matchesPatternApplicability(pattern, relPath),
    );
    if (!applicablePatterns.length) continue;

    // Pre-scan: extract constants and @Value fields from this file
    const constants = new Map<string, string>();
    const valueFields = new Map<string, string>(); // fieldName → config key
    const lines = content.split('\n');
    const sanitizedLines = sanitizeSourceLines(lines);
    for (const fl of lines) {
      // static final String KAFKA_TOPIC = "ordering-trigger";
      const constMatch = fl.match(
        /(?:static\s+)?(?:final\s+)?String\s+([A-Z_][A-Z0-9_]*)\s*=\s*"([^"]+)"/,
      );
      if (constMatch) constants.set(constMatch[1], constMatch[2]);
      // @Value("${app.kafka.topic}")  private String topicName;
      const valMatch = fl.match(/@Value\s*\(\s*"\$\{([^}]+)\}"\s*\)/);
      if (valMatch) {
        const nextLines = lines.slice(lines.indexOf(fl), lines.indexOf(fl) + 3).join(' ');
        const fieldMatch = nextLines.match(/(?:private|protected|public)?\s*String\s+(\w+)/);
        if (fieldMatch) valueFields.set(fieldMatch[1], valMatch[1]);
      }
    }

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const sanitizedLine = sanitizedLines[lineIdx];
      // Also try joining with previous line for multi-line method calls (e.g. jmsTemplate\n  .execute)
      const sanitizedJoinedLine =
        lineIdx > 0
          ? sanitizedLines[lineIdx - 1].trimEnd() + ' ' + sanitizedLine.trimStart()
          : sanitizedLine;
      for (const pattern of applicablePatterns) {
        pattern.regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        const testLine = pattern.regex.test(sanitizedLine)
          ? sanitizedLine
          : ((pattern.regex.lastIndex = 0),
            pattern.regex.test(sanitizedJoinedLine) ? sanitizedJoinedLine : null);
        if (!testLine) continue;
        pattern.regex.lastIndex = 0;
        while ((match = pattern.regex.exec(testLine)) !== null) {
          const sinkId = `sink:${repoId}:${relPath}:${lineIdx + 1}:${pattern.id}`;
          if (seen.has(sinkId)) continue;
          seen.add(sinkId);

          let targetExpr =
            pattern.targetArgIndex >= 0
              ? extractArg(line, match.index) ||
                extractArg(lines.slice(lineIdx, lineIdx + 4).join(' '), match.index)
              : pattern.defaultTarget || '';

          // When no target extracted, capture surrounding context as hint for LLM
          if (!targetExpr) {
            targetExpr = lines
              .slice(Math.max(0, lineIdx - 1), Math.min(lineIdx + 3, lines.length))
              .map((l) => l.trim())
              .filter(Boolean)
              .join(' ')
              .slice(0, 200);
          }

          // Resolve targetExpression: constant → literal, field → @Value config key
          const cleaned = targetExpr.replace(/^["']|["']$/g, '');
          if (constants.has(cleaned)) {
            targetExpr = `"${constants.get(cleaned)}"`;
          } else if (valueFields.has(cleaned)) {
            targetExpr = `\${${valueFields.get(cleaned)}}`;
          } else if (pattern.category === 'http' && /^\w+$/.test(cleaned)) {
            // HTTP sink with variable arg — scan backward for URL construction
            // Pattern: String url = serviceProperties.getXxx().getBaseUrl() + serviceProperties.getXxx().getYyy()
            // May span multiple lines
            for (let back = lineIdx; back >= Math.max(0, lineIdx - 20); back--) {
              const bl = lines[back];
              if (!bl.includes(cleaned)) continue;
              // Join this line + next few lines to handle multi-line expressions
              const block = lines.slice(back, Math.min(back + 5, lines.length)).join(' ');
              const propMatch = block.match(/serviceProperties\.get(\w+)\(\)\.getBaseUrl\(\)/);
              if (propMatch) {
                const svcName = propMatch[1].replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
                targetExpr = `\${app.services.${svcName}.base-url}`;
                // Find ALL getter calls in the block to get the path part
                const allGetters = [
                  ...block.matchAll(/serviceProperties\.get\w+\(\)\.get(\w+)\(\)/g),
                ];
                const pathGetter = allGetters.find((m) => m[1] !== 'BaseUrl' && m[1] !== 'XApiKey');
                if (pathGetter) {
                  const pathKey = pathGetter[1].replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
                  targetExpr = `\${app.services.${svcName}.base-url}+\${app.services.${svcName}.${pathKey}}`;
                }
                break;
              }
            }
          }

          sinks.push({
            id: sinkId,
            repoId,
            callSiteNodeId: '', // resolved below
            callSiteMethod: '',
            calleeMethod: match[0],
            sinkType: pattern.category,
            patternId: pattern.id,
            targetExpression: targetExpr,
            filePath: relPath,
            lineNumber: lineIdx + 1,
            sinkCategory: 'direct', // default for detector
          } as DetectedSink);
        }
      }
    }
  }

  // Map sinks to nearest Method node in graph by filePath + lineNumber
  if (sinks.length > 0) {
    const backend = await getGraphBackend();
    const fileGroups = new Map<string, DetectedSink[]>();
    for (const s of sinks) {
      if (!fileGroups.has(s.filePath)) fileGroups.set(s.filePath, []);
      fileGroups.get(s.filePath)!.push(s);
    }

    for (const [filePath, fileSinks] of fileGroups) {
      const methods = (await backend
        .executeQuery(
          `
        MATCH (m:Method {repoId: $repoId})
        WHERE m.filePath = $filePath
        RETURN m.id AS id, m.name AS name, m.startLine AS startLine, m.endLine AS endLine
        ORDER BY m.startLine
      `,
          { repoId, filePath },
        )
        .catch((err: unknown) => {
          mvLog.warn(LOG, `Failed to fetch methods for ${filePath}`, err);
          return [] as Array<{ id: string; name: string; startLine: number; endLine: number }>;
        })) as Array<{ id: string; name: string; startLine: number; endLine: number }>;

      for (const sink of fileSinks) {
        // Find the method that contains this line
        const containing =
          methods.find(
            (m) =>
              m.startLine &&
              m.endLine &&
              sink.lineNumber! >= m.startLine &&
              sink.lineNumber! <= m.endLine,
          ) ||
          methods.reduce(
            (best: { id: string; name: string; startLine: number; endLine: number } | null, m) => {
              if (!m.startLine) return best;
              if (
                !best ||
                Math.abs(m.startLine - sink.lineNumber!) <
                  Math.abs(best.startLine - sink.lineNumber!)
              )
                return m;
              return best;
            },
            null,
          );

        if (containing) {
          sink.callSiteNodeId = containing.id;
          sink.callSiteMethod = containing.name;
        }
      }
    }
  }

  // Deduplicate: if a method has both `new ProducerRecord(topic)` and `kafkaTemplate.send(record)`,
  // the ProducerRecord sink has the real topic — remove the kafkaTemplate.send duplicate
  const methodsWithProducerRecord = new Set(
    sinks
      .filter((s) => s.patternId === 'spring-kafka-producer-record' && s.callSiteMethod)
      .map((s) => `${s.filePath}:${s.callSiteMethod}`),
  );
  let deduped = sinks.filter((s) => {
    if (s.patternId === 'spring-kafka-template' && s.callSiteMethod) {
      const key = `${s.filePath}:${s.callSiteMethod}`;
      if (methodsWithProducerRecord.has(key)) return false;
    }
    return true;
  });

  // Multi-line join dedup: same method + same pattern on consecutive lines → keep first
  {
    const seen = new Map<string, number>();
    deduped = deduped.filter((s) => {
      if (!s.callSiteNodeId) return true;
      const key = `${s.callSiteNodeId}:${s.patternId}:${s.targetExpression}`;
      const prev = seen.get(key);
      if (prev !== undefined && Math.abs(s.lineNumber - prev) <= 2) return false;
      seen.set(key, s.lineNumber);
      return true;
    });
  }

  // Wrapper dedup: if method X is a wrapper (other patterns detect calls to X at caller level),
  // remove unresolvable sinks INSIDE X (they have variable args like "url", "topic").
  // A sink inside a wrapper has targetExpression that is a bare identifier (no quotes, no ${}, no dots).
  if (deduped.length > 1) {
    // Collect method names that ARE wrapper targets (other sinks call them)
    const wrapperMethodFiles = new Set<string>();
    for (const s of deduped) {
      // If calleeMethod matches "restClient.post" → "post" is a wrapper method
      const dotIdx = s.calleeMethod.lastIndexOf('.');
      if (dotIdx >= 0) {
        const methodName = s.calleeMethod.slice(dotIdx + 1).replace(/\(.*/, '');
        // Find which file defines this method — check if any sink is INSIDE that method
        for (const other of deduped) {
          if (other.callSiteMethod === methodName && other !== s) {
            wrapperMethodFiles.add(`${other.filePath}:${other.callSiteMethod}`);
          }
        }
      }
    }
    // Remove sinks inside wrapper methods that have unresolvable targets
    if (wrapperMethodFiles.size > 0) {
      const beforeCount = deduped.length;
      const filtered = deduped.filter((s) => {
        const key = `${s.filePath}:${s.callSiteMethod}`;
        if (!wrapperMethodFiles.has(key)) return true;
        // Keep if target is already resolved (literal, config key)
        const t = s.targetExpression;
        if (t.startsWith('"') || t.startsWith("'") || t.includes('${') || t.includes('.'))
          return true;
        // Bare variable name inside wrapper → remove (caller-level sink is better)
        return false;
      });
      if (filtered.length < beforeCount) {
        console.log(
          `⚡ Sink detector: removed ${beforeCount - filtered.length} wrapper-internal sinks`,
        );
        deduped.length = 0;
        deduped.push(...filtered);
      }
    }
  }

  // Detect @FeignClient interfaces — these are HTTP sinks with URL in annotation
  const feignPattern = compiled.find((pattern) => pattern.id === 'spring-feign-client');
  for (const file of files) {
    const relPath = path.relative(repoPath, file).replace(/\\/g, '/');
    if (feignPattern && !matchesPatternApplicability(feignPattern, relPath)) continue;
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const sanitizedContent = sanitizeSourceLines(content.split('\n')).join('\n');
    if (!sanitizedContent.includes('@FeignClient')) continue;

    const feignMatch = content.match(
      /@FeignClient\s*\([^)]*(?:url\s*=\s*["']?\$?\{?([^"',})]+)|name\s*=\s*["']([^"']+)["'])[^)]*\)/,
    );
    if (!feignMatch) continue;
    const urlExpr = feignMatch[1] || '';
    const feignName = feignMatch[2] || '';
    const targetExpr = urlExpr ? `\${${urlExpr.replace(/^\$?\{?|\}?$/g, '')}}` : feignName;
    if (!targetExpr) continue;

    const sinkId = `sink:${repoId}:${relPath}:feign:${feignName || urlExpr}`;
    if (!seen.has(sinkId)) {
      seen.add(sinkId);
      deduped.push({
        id: sinkId,
        repoId,
        callSiteNodeId: '',
        callSiteMethod: '',
        calleeMethod: '@FeignClient',
        sinkType: 'http',
        patternId: 'spring-feign-client',
        targetExpression: targetExpr,
        filePath: relPath,
        lineNumber: content.substring(0, content.indexOf('@FeignClient')).split('\n').length,
      });
    }
  }

  console.log(
    `⚡ Sink detector: found ${deduped.length} sinks in ${files.length} files for ${repoId}`,
  );
  return deduped;
};

/** Persist DetectedSink nodes to Neo4j */
export const persistSinks = async (repoId: string, sinks: DetectedSink[]): Promise<number> => {
  const backend = await getGraphBackend();
  await backend.executeQuery(`MATCH (n:DetectedSink {repoId: $repoId}) DETACH DELETE n`, {
    repoId,
  });
  if (!sinks.length) return 0;

  const BATCH = 200;
  let inserted = 0;
  for (let i = 0; i < sinks.length; i += BATCH) {
    const batch = sinks.slice(i, i + BATCH).map((s) => ({
      ...s,
      resolvedUrl: '',
      resolvedTopic: '',
      confidence: 0,
      resolvedVia: '',
      resolutionStatus: 'unresolved',
      resolutionConfidence: 0,
      resolutionMethod: '',
      resolutionEvidence: '',
      resolutionReason: 'insufficient_context',
      resolutionUpdatedAt: '',
    }));
    await backend.executeQuery(
      `
      UNWIND $batch AS props
      MERGE (n:DetectedSink {id: props.id})
      SET n += props
    `,
      { batch },
    );

    const detectedInBatch = batch.filter((sink) => sink.callSiteNodeId);
    if (detectedInBatch.length > 0) {
      await backend.executeQuery(
        `
        UNWIND $batch AS props
        MATCH (sink:DetectedSink {id: props.id}), (callSite {id: props.callSiteNodeId})
        MERGE (sink)-[:DETECTED_IN]->(callSite)
      `,
        { batch: detectedInBatch },
      );
    }

    inserted += batch.length;
  }
  return inserted;
};

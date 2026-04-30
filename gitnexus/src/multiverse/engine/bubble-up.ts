/**
 * Bubble-Up Engine — resolves DetectedSink targets by tracing through callers
 *
 * Algorithm:
 * 1. For each sink, find the caller method
 * 2. Check if the target argument is:
 *    a. Literal string → resolve directly (confidence 0.95)
 *    b. Field with @Value annotation → config lookup (confidence 0.90)
 *    c. String concatenation → resolve parts (confidence 0.85)
 *    d. Method parameter → find callers via CALLS edges, recurse (max depth 5)
 * 3. Output: resolved value + confidence score
 */

import { getGraphBackend } from '../../core/graph-backend/index.js';
import { lookupConfig, extractValueKey } from './config-resolver.js';
import { DetectedSink } from '../api/types.js';
import { mvLog } from '../util/logger.js';

const LOG = 'bubble-up';
const MAX_DEPTH = 5;

export interface ResolvedSink extends DetectedSink {
  resolvedValue: string | null;
  confidence: number;
  resolvedVia: string; // "literal" | "value-annotation" | "config-properties" | "bubble-up-N" | "unresolvable"
  /** Node ID where the value was actually determined (may differ from callSiteNodeId) */
  resolvedAtNodeId: string;
}

/** Pre-fetched data for a repo to avoid N+1 queries */
interface PrefetchedData {
  /** Map of class node ID → @Value fields */
  valueFieldsByClass: Map<string, Array<{ nodeId: string; name: string; annotations: string }>>;
  /** Map of method node ID → containing class node ID */
  methodToClass: Map<string, string>;
  /** Map of callee node ID → caller nodes */
  callersByCallee: Map<
    string,
    Array<{ id: string; name: string; filePath: string; startLine: number }>
  >;
  /** Map of node ID → annotations string */
  annotationsByNode: Map<string, string>;
  /** Map of config properties prefix → bound fields from @ConfigurationProperties */
  configPropertiesFields: Map<string, Array<{ fieldName: string; configKey: string }>>;
  /** Map of class node ID → @ConfigurationProperties prefix */
  configPropertiesPrefix: Map<string, string>;
}

/** Pre-fetch all @Value fields, callers, and annotations for a repo */
async function prefetchRepoData(repoId: string): Promise<PrefetchedData> {
  const backend = await getGraphBackend();

  // Fetch all 3 datasets in parallel (independent queries)
  const [containment, callEdges, annotationRows] = await Promise.all([
    backend
      .executeQuery(
        `
      MATCH (cls)-[:CodeRelation {type: 'CONTAINS'}]->(member)
      WHERE cls.repoId = $repoId OR member.repoId = $repoId
      RETURN cls.id AS classId, member.id AS memberId, member.name AS memberName,
             member.annotations AS annotations
    `,
        { repoId },
      )
      .catch((err) => {
        mvLog.warn(LOG, `Failed to fetch containment for ${repoId}`, err);
        return [] as Array<Record<string, unknown>>;
      }),
    backend
      .executeQuery(
        `
      MATCH (caller)-[:CodeRelation {type: 'CALLS'}]->(callee)
      WHERE caller.repoId = $repoId OR callee.repoId = $repoId
      RETURN caller.id AS callerId, caller.name AS callerName,
             caller.filePath AS callerFile, caller.startLine AS callerLine,
             callee.id AS calleeId
    `,
        { repoId },
      )
      .catch((err) => {
        mvLog.warn(LOG, `Failed to fetch call edges for ${repoId}`, err);
        return [] as Array<Record<string, unknown>>;
      }),
    backend
      .executeQuery(
        `
      MATCH (n) WHERE n.repoId = $repoId AND n.annotations IS NOT NULL
      RETURN n.id AS id, n.annotations AS annotations
    `,
        { repoId },
      )
      .catch((err) => {
        mvLog.warn(LOG, `Failed to fetch annotations for ${repoId}`, err);
        return [] as Array<Record<string, unknown>>;
      }),
  ]);

  const valueFieldsByClass = new Map<
    string,
    Array<{ nodeId: string; name: string; annotations: string }>
  >();
  const methodToClass = new Map<string, string>();

  for (const row of containment as Array<Record<string, unknown>>) {
    methodToClass.set(row.memberId as string, row.classId as string);
    const annotations = (row.annotations as string | undefined) || '';
    if (annotations.includes('@Value')) {
      if (!valueFieldsByClass.has(row.classId as string))
        valueFieldsByClass.set(row.classId as string, []);
      valueFieldsByClass.get(row.classId as string)!.push({
        nodeId: row.memberId as string,
        name: (row.memberName as string) || '',
        annotations,
      });
    }
  }

  // Build callers-by-callee index
  const callersByCallee = new Map<
    string,
    Array<{ id: string; name: string; filePath: string; startLine: number }>
  >();
  for (const row of callEdges as Array<Record<string, unknown>>) {
    if (!callersByCallee.has(row.calleeId as string))
      callersByCallee.set(row.calleeId as string, []);
    callersByCallee.get(row.calleeId as string)!.push({
      id: row.callerId as string,
      name: (row.callerName as string) || '',
      filePath: (row.callerFile as string) || '',
      startLine: (row.callerLine as number) ?? 0,
    });
  }

  // Build annotations index
  const annotationsByNode = new Map<string, string>();
  for (const row of annotationRows as Array<Record<string, unknown>>) {
    annotationsByNode.set(row.id as string, row.annotations as string);
  }

  // Build @ConfigurationProperties index: scan classes with that annotation
  const configPropertiesFields = new Map<string, Array<{ fieldName: string; configKey: string }>>();
  const configPropertiesPrefix = new Map<string, string>();
  for (const row of annotationRows as Array<Record<string, unknown>>) {
    const rawAnn = row.annotations as string | string[];
    const ann: string = Array.isArray(rawAnn) ? rawAnn.join(' ') : rawAnn || '';
    const cpMatch = ann.match(/@ConfigurationProperties\s*\(\s*(?:prefix\s*=\s*)?["']([^"']+)["']/);
    if (!cpMatch) continue;
    const prefix = cpMatch[1];
    configPropertiesPrefix.set(row.id as string, prefix);
  }
  // For each @ConfigurationProperties class, find its fields → config keys
  for (const [classId, prefix] of configPropertiesPrefix) {
    const fields: Array<{ fieldName: string; configKey: string }> = [];
    for (const row of containment as Array<Record<string, unknown>>) {
      if (row.classId !== classId) continue;
      const name = (row.memberName as string) || '';
      if (!name || name.includes('(')) continue; // skip methods
      // camelCase → kebab-case for Spring config binding
      const kebab = name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
      fields.push({ fieldName: name, configKey: `${prefix}.${kebab}` });
    }
    if (fields.length) configPropertiesFields.set(classId, fields);
  }

  return {
    valueFieldsByClass,
    methodToClass,
    callersByCallee,
    annotationsByNode,
    configPropertiesFields,
    configPropertiesPrefix,
  };
}

/**
 * Resolve all sinks for a service using bubble-up algorithm.
 * Pre-fetches repo data to avoid N+1 queries.
 */
export const resolveAllSinks = async (
  sinks: DetectedSink[],
  configMap: Map<string, string>,
): Promise<ResolvedSink[]> => {
  if (!sinks.length) return [];

  // Pre-fetch all data for the repo
  const repoId = sinks[0].repoId;
  const prefetched = await prefetchRepoData(repoId);
  const backend = await getGraphBackend();

  const results: ResolvedSink[] = [];
  for (const sink of sinks) {
    // Strategy 0: literal string in targetExpression (e.g. "disbursement-result")
    const expr = sink.targetExpression || '';
    const literalMatch = expr.match(/^"([^"]+)"$/);
    if (literalMatch) {
      const key = literalMatch[1];
      // Check if literal is a config key alias (e.g. "disbursement-result" → app.kafka.producer.disbursement-result.topic)
      const topicFromConfig =
        configMap.get(`app.kafka.producer.${key}.topic`) ||
        configMap.get(`app.kafka.message-props.${key}.topic`);
      const resolvedValue = topicFromConfig || key;
      results.push({
        ...sink,
        resolvedValue,
        confidence: topicFromConfig ? 0.95 : 0.85,
        resolvedVia: topicFromConfig ? 'config-lookup' : 'literal',
        resolvedAtNodeId: sink.callSiteNodeId,
      });
      continue;
    }
    // Strategy 0b: constant name (e.g. DISBURSEMENT_KAFKA_TOPIC) → lookup in graph
    if (expr && /^[A-Z_][A-Z0-9_]*$/.test(expr)) {
      const val = await resolveConstant(backend, repoId, expr);
      if (val) {
        results.push({
          ...sink,
          resolvedValue: val,
          confidence: 0.9,
          resolvedVia: 'constant',
          resolvedAtNodeId: sink.callSiteNodeId,
        });
        continue;
      }
    }
    // Strategy 0c: config key in targetExpression (e.g. ${app.kafka.topic} or ${base}+${path})
    const cfgMatch = expr.match(/^\$\{([^}]+)\}$/);
    if (cfgMatch) {
      const val = lookupConfig(configMap, cfgMatch[1]);
      if (val) {
        results.push({
          ...sink,
          resolvedValue: val,
          confidence: 0.9,
          resolvedVia: 'config-key',
          resolvedAtNodeId: sink.callSiteNodeId,
        });
        continue;
      }
    }
    // Composite config: ${key1}+${key2} → resolve both and concatenate
    const compositeMatch = expr.match(/^\$\{([^}]+)\}\+\$\{([^}]+)\}$/);
    if (compositeMatch) {
      const base = lookupConfig(configMap, compositeMatch[1]) || '';
      const path = lookupConfig(configMap, compositeMatch[2]) || '';
      if (base) {
        results.push({
          ...sink,
          resolvedValue: base + path,
          confidence: 0.9,
          resolvedVia: 'config-composite',
          resolvedAtNodeId: sink.callSiteNodeId,
        });
        continue;
      }
    }
    const resolved = resolveSinkWithCache(sink, configMap, 0, prefetched);
    results.push(resolved);
  }

  return results;
};

/** Resolve a constant name to its string value */
async function resolveConstant(backend: any, repoId: string, name: string): Promise<string | null> {
  const rows = (await backend
    .executeQuery(
      `MATCH (c) WHERE (c:Const OR c:Property) AND c.repoId = $repoId AND c.name = $name RETURN c.value AS value LIMIT 1`,
      { repoId, name },
    )
    .catch(() => [])) as Array<{ value?: string }>;
  return rows.length && rows[0].value ? rows[0].value : null;
}

function resolveSinkWithCache(
  sink: DetectedSink,
  configMap: Map<string, string>,
  depth: number,
  data: PrefetchedData,
): ResolvedSink {
  const base: ResolvedSink = {
    ...sink,
    resolvedValue: null,
    confidence: 0.2,
    resolvedVia: 'unresolvable',
    resolvedAtNodeId: sink.callSiteNodeId,
  };

  if (depth > MAX_DEPTH) return base;

  // Strategy 1: Check if caller method's class has @Value fields matching sink type
  const classId = data.methodToClass.get(sink.callSiteNodeId);
  if (classId) {
    // Strategy 1a: @ConfigurationProperties — check if class injects a properties bean
    // Look for fields whose type is a @ConfigurationProperties class
    for (const [cpClassId, fields] of data.configPropertiesFields) {
      const prefix = data.configPropertiesPrefix.get(cpClassId) || '';
      for (const field of fields) {
        const fieldName = field.fieldName.toLowerCase();
        const isRelevant =
          (sink.sinkType === 'kafka' &&
            (fieldName.includes('topic') || fieldName.includes('queue'))) ||
          (sink.sinkType === 'http' &&
            (fieldName.includes('url') ||
              fieldName.includes('base') ||
              fieldName.includes('host'))) ||
          (sink.sinkType === 'rabbit' &&
            (fieldName.includes('queue') ||
              fieldName.includes('exchange') ||
              fieldName.includes('routing'))) ||
          (sink.sinkType === 'redis' &&
            (fieldName.includes('channel') || fieldName.includes('topic')));
        if (!isRelevant) continue;

        const val = lookupConfig(configMap, field.configKey);
        if (val) {
          base.resolvedValue = val;
          base.confidence = 0.88;
          base.resolvedVia = 'config-properties';
          base.resolvedAtNodeId = cpClassId;
          base.targetExpression = `@ConfigurationProperties("${prefix}").${field.fieldName}`;
          return base;
        }
      }
    }

    // Strategy 1b: @Value fields matching sink type
    const fields = data.valueFieldsByClass.get(classId) || [];
    for (const field of fields) {
      const valueMatch = field.annotations.match(/@Value\("([^"]+)"\)/);
      if (!valueMatch) continue;

      const fieldName = field.name.toLowerCase();
      const valueExpr = valueMatch[1].toLowerCase();
      const isRelevant =
        (sink.sinkType === 'kafka' &&
          (fieldName.includes('topic') || valueExpr.includes('topic'))) ||
        (sink.sinkType === 'http' &&
          (fieldName.includes('url') ||
            fieldName.includes('base') ||
            valueExpr.includes('url') ||
            valueExpr.includes('base'))) ||
        (sink.sinkType === 'rabbit' &&
          (fieldName.includes('queue') ||
            fieldName.includes('exchange') ||
            valueExpr.includes('queue'))) ||
        (sink.sinkType === 'redis' &&
          (fieldName.includes('channel') || fieldName.includes('topic')));

      if (!isRelevant) continue;

      const parsed = extractValueKey(valueMatch[0]);
      if (!parsed) continue;

      const resolved = lookupConfig(configMap, parsed.key);
      const value = resolved ?? parsed.defaultValue ?? null;

      if (value) {
        base.resolvedValue = value;
        base.confidence = 0.9;
        base.resolvedVia = depth === 0 ? 'value-annotation' : `bubble-up-${depth}`;
        base.resolvedAtNodeId = field.nodeId;
        base.targetExpression = `@Value("\${${parsed.key}}")`;
        return base;
      }
    }
  }

  // Strategy 2: Trace up to callers
  if (depth < MAX_DEPTH) {
    const callers = (data.callersByCallee.get(sink.callSiteNodeId) || []).slice(0, 20);
    for (const caller of callers) {
      const callerSink: DetectedSink = {
        ...sink,
        callSiteNodeId: caller.id,
        callSiteMethod: caller.name,
        filePath: caller.filePath,
        lineNumber: caller.startLine,
      };

      const result = resolveSinkWithCache(callerSink, configMap, depth + 1, data);
      if (result.confidence > base.confidence) {
        return {
          ...result,
          id: sink.id,
          callSiteNodeId: sink.callSiteNodeId,
          callSiteMethod: sink.callSiteMethod,
          resolvedVia: `bubble-up-${depth + 1}`,
        };
      }
    }
  }

  // Strategy 3: Check annotations on the caller method itself
  const methodAnnotations = data.annotationsByNode.get(sink.callSiteNodeId);
  if (methodAnnotations && typeof methodAnnotations === 'string') {
    const parts = methodAnnotations.split(/(?=@)/).filter(Boolean);
    for (const ann of parts) {
      if (ann.includes('@Value')) {
        const parsed = extractValueKey(ann);
        if (parsed) {
          const value = lookupConfig(configMap, parsed.key) ?? parsed.defaultValue ?? null;
          if (value) {
            base.resolvedValue = value;
            base.confidence = 0.85;
            base.resolvedVia = 'value-annotation';
            base.targetExpression = ann;
            return base;
          }
        }
      }
    }
  }

  return base;
}

/** Update DetectedSink nodes in Neo4j with resolution results */
export const persistResolutions = async (resolved: ResolvedSink[]): Promise<void> => {
  if (!resolved.length) return;
  const backend = await getGraphBackend();

  // Batch update using UNWIND
  const BATCH = 200;
  for (let i = 0; i < resolved.length; i += BATCH) {
    const batch = resolved.slice(i, i + BATCH).map((r) => ({
      id: r.id,
      resolvedUrl: (r.sinkType === 'http' ? r.resolvedValue : '') || '',
      resolvedTopic: (r.sinkType !== 'http' ? r.resolvedValue : '') || '',
      confidence: r.confidence,
      resolvedVia: r.resolvedVia,
      targetExpression: r.targetExpression || '',
    }));

    await backend
      .executeQuery(
        `
      UNWIND $batch AS b
      MATCH (n:DetectedSink {id: b.id})
      SET n.resolvedUrl = b.resolvedUrl,
          n.resolvedTopic = b.resolvedTopic,
          n.confidence = b.confidence,
          n.resolvedVia = b.resolvedVia,
          n.targetExpression = b.targetExpression
    `,
        { batch },
      )
      .catch((err) => {
        mvLog.warn(LOG, `Failed to persist resolution batch at offset ${i}`, err);
      });
  }
};

/**
 * Graph Pattern Rule Engine — language-agnostic entry point & sink detection
 *
 * Instead of hardcoded regex per language, rules define graph patterns:
 *   match: node labels + edge traversals + property filters
 *   emit:  create Listener/DetectedSink nodes from matched results
 *
 * Rules compile to Cypher queries executed against Neo4j.
 *
 * Example rule (YAML):
 *   - id: jobrunr-handler
 *     type: job
 *     match:
 *       - node: cls
 *         label: Class
 *         where:
 *           ancestors: { edge: EXTENDS, label: Class, name: AbstractJob, maxDepth: 3 }
 *       - node: method
 *         label: Method
 *         from: cls
 *         edge: HAS_METHOD
 *         where:
 *           name: doWork
 *     emit:
 *       name: "${cls.name}"
 *       topic: "${method.name}"
 */

import { getGraphBackend } from '../../core/graph-backend/index.js';
import { mvLog } from '../util/logger.js';
import type { PatternApplicabilityConfig, SupportedSourceLanguage } from '../config/types.js';
import { matchesFileApplicability, normalizePatternApplicability } from './source-file-utils.js';

const LOG = 'graph-rules';

// ── Rule Types ──

export interface GraphRule {
  id: string;
  name: string;
  /** Entry point type: job, scheduled, cron, listener, etc. */
  type: string;
  enabled: boolean;
  match: MatchStep[];
  emit: EmitConfig;
  languages?: SupportedSourceLanguage[];
  fileExtensions?: string[];
  excludePathPatterns?: string[];
}

export interface MatchStep {
  /** Variable name for this node (used in emit templates) */
  node: string;
  /** Node label(s) to match */
  label: string | string[];
  /** Traverse from a previously matched node variable */
  from?: string;
  /** Edge type to traverse from `from` */
  edge?: string;
  /** Traverse direction: outgoing (default) or incoming */
  direction?: 'outgoing' | 'incoming';
  /** Property filters */
  where?: Record<string, WhereClause>;
}

export type WhereClause =
  | string // exact match
  | { regex: string } // regex match
  | { contains: string } // array/string contains
  | { ancestors: AncestorMatch }; // graph traversal up inheritance

export interface AncestorMatch {
  edge: string; // e.g. "EXTENDS"
  label?: string; // target label filter
  name?: string; // exact target name to find
  nameRegex?: string; // regex target name to find
  maxDepth: number; // max hops
}

export interface EmitConfig {
  /** Listener type label */
  type?: string;
  /** Template: "${cls.name}" */
  name: string;
  /** Template for topic/schedule */
  topic?: string;
}

// ── Compile Rule → Cypher ──

interface CompiledRule {
  rule: GraphRule;
  cypher: string;
  returnVars: string[];
}

const JAVA_LIKE: PatternApplicabilityConfig = {
  languages: ['java', 'kotlin'],
  fileExtensions: ['.java', '.kt', '.kts'],
};

const NODE_LIKE: PatternApplicabilityConfig = {
  languages: ['javascript', 'typescript'],
  fileExtensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'],
};

const PYTHON_ONLY: PatternApplicabilityConfig = {
  languages: ['python'],
  fileExtensions: ['.py'],
};

const CSHARP_ONLY: PatternApplicabilityConfig = {
  languages: ['csharp'],
  fileExtensions: ['.cs'],
};

const BUILT_IN_RULE_APPLICABILITY: Record<string, PatternApplicabilityConfig> = {
  'jobrunr-abstract-job': JAVA_LIKE,
  'spring-scheduled-method': JAVA_LIKE,
  'python-celery-task': PYTHON_ONLY,
  'node-cron-job': NODE_LIKE,
  'kafka-listener': JAVA_LIKE,
  'rabbit-listener': JAVA_LIKE,
  'event-listener': JAVA_LIKE,
  'nestjs-controller': NODE_LIKE,
  'python-fastapi-route': PYTHON_ONLY,
  'python-django-view': PYTHON_ONLY,
  'dotnet-controller': CSHARP_ONLY,
  'quarkus-scheduled': JAVA_LIKE,
};

export function normalizeGraphRule<T extends object>(rule: T): T {
  return normalizePatternApplicability({ ...rule }) as T;
}

export function matchesGraphRuleApplicability(rule: GraphRule, filePath: string): boolean {
  return matchesFileApplicability(filePath, rule);
}

function compileRule(rule: GraphRule, _serviceId: string): CompiledRule {
  const matchClauses: string[] = [];
  const whereClauses: string[] = [];
  const returnVars: string[] = [];

  for (const step of rule.match) {
    const v = step.node;
    const labels = Array.isArray(step.label) ? step.label : [step.label];

    if (step.from && step.edge) {
      // Edges stored as :CodeRelation {type: 'EXTENDS'} in Neo4j
      // Variable-length paths can't filter on properties, so use separate approach
      const edgeVar = `${v}_r`;
      const dir = step.direction === 'incoming' ? '<-' : '->';
      const arrow =
        dir === '<-'
          ? `(${step.from})<-[${edgeVar}:CodeRelation]-(${v})`
          : `(${step.from})-[${edgeVar}:CodeRelation]->(${v})`;
      matchClauses.push(`MATCH ${arrow}`);
      whereClauses.push(`${edgeVar}.type = '${escapeCypher(step.edge)}'`);
      if (labels.length === 1) {
        whereClauses.push(`${v}:${labels[0]}`);
      } else {
        whereClauses.push(`(${labels.map((l) => `${v}:${l}`).join(' OR ')})`);
      }
    } else {
      // Root node match
      if (labels.length === 1) {
        matchClauses.push(`MATCH (${v}:${labels[0]} {repoId: $serviceId})`);
      } else {
        matchClauses.push(`MATCH (${v} {repoId: $serviceId})`);
        whereClauses.push(`(${labels.map((l) => `${v}:${l}`).join(' OR ')})`);
      }
    }

    // Process where clauses
    if (step.where) {
      for (const [prop, clause] of Object.entries(step.where)) {
        if (prop === 'ancestors') {
          // Ancestor traversal via variable-length CodeRelation path
          // Neo4j can't filter rel properties in variable-length, so use
          // shortestPath + post-filter on relationship types
          const anc = (clause as { ancestors: AncestorMatch }).ancestors;
          const ancVar = `${v}_anc`;
          const pathVar = `${v}_path`;
          const labelFilter = anc.label ? `:${anc.label}` : '';
          matchClauses.push(
            `MATCH ${pathVar} = shortestPath((${v})-[:CodeRelation*1..${anc.maxDepth}]->(${ancVar}${labelFilter}))`,
          );
          if (anc.name) {
            whereClauses.push(`${ancVar}.name = '${escapeCypher(anc.name)}'`);
          } else if (anc.nameRegex) {
            whereClauses.push(`${ancVar}.name =~ '${escapeCypher(anc.nameRegex)}'`);
          }
          whereClauses.push(
            `ALL(r IN relationships(${pathVar}) WHERE r.type = '${escapeCypher(anc.edge)}')`,
          );
        } else if (typeof clause === 'string') {
          whereClauses.push(`${v}.${prop} = '${escapeCypher(clause)}'`);
        } else if (typeof clause === 'object' && clause !== null && 'regex' in clause) {
          whereClauses.push(
            `${v}.${prop} =~ '${escapeCypher((clause as { regex: string }).regex)}'`,
          );
        } else if (typeof clause === 'object' && clause !== null && 'contains' in clause) {
          const val = escapeCypher((clause as { contains: string }).contains);
          whereClauses.push(`ANY(${v}_a IN ${v}.${prop} WHERE ${v}_a CONTAINS '${val}')`);
        }
      }
    }

    returnVars.push(v);
  }

  const returnClause = returnVars
    .map(
      (v) =>
        `${v}.id AS ${v}_id, ${v}.name AS ${v}_name, ${v}.filePath AS ${v}_filePath, ${v}.startLine AS ${v}_startLine, ${v}.annotations AS ${v}_annotations`,
    )
    .join(', ');

  const cypher = [
    ...matchClauses,
    whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '',
    `RETURN DISTINCT ${returnClause}`,
  ]
    .filter(Boolean)
    .join('\n');

  return { rule, cypher, returnVars };
}

function escapeCypher(s: string): string {
  return s.replace(/'/g, "\\'").replace(/\\/g, '\\\\');
}

// ── Template Resolution ──

/** Resolve ${config.key} Spring-style placeholders using a config map */
function resolveConfigPlaceholders(text: string, configMap: Map<string, string>): string {
  return text.replace(/\$\{([^}]+)\}/g, (match, expr: string) => {
    const [key, fallback] = expr.split(':');
    const val = configMap.get(key.trim());
    if (val !== undefined) return val;
    // Case-insensitive fallback
    const keyLower = key.trim().toLowerCase();
    for (const [k, v] of configMap) {
      if (k.toLowerCase() === keyLower) return v;
    }
    return fallback?.trim() ?? match;
  });
}

/**
 * Extract attribute value from annotation text.
 * Examples:
 *   extractAnnotationAttr('@KafkaListener(topics = "${app.kafka.topic}")', 'topics')
 *     → '${app.kafka.topic}'
 *   extractAnnotationAttr('@GetMapping("/path")', null)
 *     → '/path'
 *   extractAnnotationAttr('@KafkaListener(topics = { "${t1}", "${t2}" })', 'topics')
 *     → '${t1},${t2}'
 */
function extractAnnotationAttr(
  annotations: string | string[],
  annotationName: string,
  attrName?: string,
): string {
  const list = Array.isArray(annotations) ? annotations : [annotations];
  const ann = list.find((a) => a.includes(annotationName));
  if (!ann) return '';

  // Find the parenthesized content
  const parenStart = ann.indexOf('(');
  if (parenStart < 0) return '';
  const content = ann.slice(parenStart + 1, ann.lastIndexOf(')'));

  if (attrName) {
    // Named attribute: topics = "..." or topics = { "...", "..." }
    const attrIdx = content.indexOf(attrName);
    if (attrIdx < 0) return '';
    const afterEq = content.slice(attrIdx + attrName.length).replace(/^\s*=\s*/, '');
    // Scope: stop at next named attribute (word followed by =) or end
    const nextAttr = afterEq.match(/,\s*\w+\s*=/);
    const scoped = nextAttr ? afterEq.slice(0, nextAttr.index) : afterEq;
    // For array values { "a", "b" }, scope to the outermost braces (handle nested ${...})
    const braceStart = scoped.indexOf('{');
    let target = scoped;
    if (braceStart >= 0) {
      let depth = 0;
      let braceEnd = -1;
      for (let i = braceStart; i < scoped.length; i++) {
        if (scoped[i] === '{') depth++;
        else if (scoped[i] === '}') {
          depth--;
          if (depth === 0) {
            braceEnd = i;
            break;
          }
        }
      }
      if (braceEnd > braceStart) target = scoped.slice(braceStart + 1, braceEnd);
    }
    const strings = [...target.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    return strings.join(',');
  }

  // Unnamed: @GetMapping("/path") — first quoted string
  const match = content.match(/"([^"]+)"/);
  return match ? match[1] : content.trim().replace(/^["']|["']$/g, '');
}

function resolveTemplate(template: string, row: Record<string, unknown>): string {
  return template.replace(
    /\$\{(\w+)\.(\w+)(?:\s*\|\s*([^}]+))?\}/g,
    (_m, varName, prop, transform) => {
      const key = `${varName}_${prop}`;
      let val = row[key] ?? '';

      if (transform) {
        const trimmed = transform.trim();
        if (trimmed === 'kebab') {
          if (Array.isArray(val)) val = val.join(', ');
          val = String(val)
            .replace(/([a-z])([A-Z])/g, '$1-$2')
            .toLowerCase();
        } else if (trimmed.startsWith('annotationAttr(')) {
          // annotationAttr("KafkaListener","topics") or annotationAttr("GetMapping")
          const args = [...trimmed.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
          val = extractAnnotationAttr(val as string | string[], args[0] || '', args[1]);
        }
      } else {
        if (Array.isArray(val)) val = val.join(', ');
      }

      return String(val);
    },
  );
}

// ── Execute Rules ──

export interface GraphRuleMatch {
  ruleId: string;
  type: string;
  name: string;
  topic: string;
  filePath: string;
  startLine: number;
  /** Raw matched node IDs for linking */
  nodeIds: Record<string, string>;
}

/**
 * Execute graph pattern rules against a service's graph.
 * Returns matched entry points ready to persist as Listener nodes.
 * If configMap is provided, resolves ${config.key} placeholders in emitted topic/name.
 */
export async function executeEntryPointRules(
  serviceId: string,
  rules: GraphRule[],
  configMap?: Map<string, string>,
): Promise<GraphRuleMatch[]> {
  const enabled = rules.filter((r) => r.enabled);
  if (!enabled.length) return [];

  const backend = await getGraphBackend();
  const results: GraphRuleMatch[] = [];
  const seen = new Set<string>();

  for (const rule of enabled) {
    const compiled = compileRule(rule, serviceId);
    mvLog.debug(LOG, `Rule ${rule.id}:\n${compiled.cypher}`);

    let rows: Array<Record<string, unknown>>;
    try {
      rows = (await backend.executeQuery(compiled.cypher, { serviceId })) as Array<
        Record<string, unknown>
      >;
    } catch (err: unknown) {
      mvLog.warn(
        LOG,
        `Rule ${rule.id} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    for (const row of rows) {
      let name = resolveTemplate(rule.emit.name, row);
      let topic = rule.emit.topic ? resolveTemplate(rule.emit.topic, row) : '';

      // Resolve ${config.key} placeholders via configMap
      if (configMap) {
        name = resolveConfigPlaceholders(name, configMap);
        topic = resolveConfigPlaceholders(topic, configMap);
      }

      // Deduplicate by name within same rule
      const dedup = `${rule.id}:${name}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);

      // Pick filePath/startLine from the first node that has them
      let filePath = '';
      let startLine = 0;
      const nodeIds: Record<string, string> = {};
      for (const v of compiled.returnVars) {
        nodeIds[v] = (row[`${v}_id`] as string) || '';
        if (!filePath && row[`${v}_filePath`]) {
          filePath = row[`${v}_filePath`] as string;
          startLine = (row[`${v}_startLine`] as number) || 0;
        }
      }

      if (!filePath || !matchesGraphRuleApplicability(rule, filePath)) continue;

      results.push({
        ruleId: rule.id,
        type: rule.emit.type || rule.type,
        name,
        topic,
        filePath,
        startLine,
        nodeIds,
      });
    }

    if (rows.length) {
      mvLog.info(
        LOG,
        `Rule ${rule.id}: ${rows.length} raw matches → ${results.filter((r) => r.ruleId === rule.id).length} entry points`,
      );
    }
  }

  return results;
}

/**
 * Persist graph rule matches as Listener nodes + link to Method/Class nodes.
 */
export async function persistGraphRuleMatches(
  serviceId: string,
  matches: GraphRuleMatch[],
): Promise<number> {
  if (!matches.length) return 0;

  const backend = await getGraphBackend();
  const BATCH = 200;

  // Clean old graph-rule listeners for this service
  await backend
    .executeQuery(
      `MATCH (l:Listener) WHERE l.repoId = $serviceId AND l.detectedBy STARTS WITH 'graph-rule:' DETACH DELETE l`,
      { serviceId },
    )
    .catch(() => {});

  const batch = matches.map((m) => ({
    id: `Listener:graph-rule:${serviceId}:${m.ruleId}:${m.name}`,
    repoId: serviceId,
    name: m.name,
    listenerType: m.type,
    topic: m.topic,
    filePath: m.filePath,
    startLine: m.startLine,
    className: '',
    detectedBy: `graph-rule:${m.ruleId}`,
  }));

  for (let i = 0; i < batch.length; i += BATCH) {
    const chunk = batch.slice(i, i + BATCH);
    await backend
      .executeQuery(
        `UNWIND $batch AS props
       MERGE (l:Listener {id: props.id})
       SET l += props`,
        { batch: chunk },
      )
      .catch((err) => mvLog.warn(LOG, `Failed to persist graph rule listeners`, err));
  }

  // Link Listener → Method/Class nodes from matches
  const edges = matches.flatMap((m) => {
    const listenerId = `Listener:graph-rule:${serviceId}:${m.ruleId}:${m.name}`;
    return Object.values(m.nodeIds)
      .filter(Boolean)
      .map((nodeId) => ({ listenerId, nodeId }));
  });

  if (edges.length) {
    for (let i = 0; i < edges.length; i += BATCH) {
      const chunk = edges.slice(i, i + BATCH);
      await backend
        .executeQuery(
          `UNWIND $edges AS e
         MATCH (l:Listener {id: e.listenerId}), (n {id: e.nodeId})
         MERGE (n)-[:CodeRelation {type: 'HANDLES_ROUTE'}]->(l)`,
          { edges: chunk },
        )
        .catch(() => {});
    }
  }

  mvLog.info(LOG, `${serviceId}: ${batch.length} entry points from graph rules`);
  return batch.length;
}

// ── Built-in Rules ──

export const BUILT_IN_GRAPH_RULES: GraphRule[] = [
  {
    id: 'jobrunr-abstract-job',
    name: 'JobRunr AbstractJob Handler',
    type: 'job',
    enabled: true,
    match: [
      {
        node: 'cls',
        label: 'Class',
        where: {
          name: { regex: '.*Job$' },
        },
      },
      {
        node: 'method',
        label: 'Method',
        from: 'cls',
        edge: 'HAS_METHOD',
        where: { name: 'doWork' },
      },
    ],
    emit: {
      name: 'Job:${cls.name}',
      topic: '${cls.name}',
    },
  },
  {
    id: 'spring-scheduled-method',
    name: 'Spring @Scheduled Method',
    type: 'scheduled',
    enabled: true,
    match: [
      {
        node: 'method',
        label: ['Method', 'Function'],
        where: {
          annotations: { contains: '@Scheduled' },
        },
      },
    ],
    emit: {
      name: '@Scheduled(${method.name})',
      topic: '${method.name}',
    },
  },
  {
    id: 'python-celery-task',
    name: 'Python Celery Task',
    type: 'job',
    enabled: true,
    match: [
      {
        node: 'dec',
        label: 'Decorator',
        where: {
          name: { regex: '.*task.*|.*shared_task.*' },
        },
      },
      {
        node: 'fn',
        label: 'Function',
        from: 'dec',
        edge: 'DECORATES',
        direction: 'outgoing',
      },
    ],
    emit: {
      name: 'celery:${fn.name}',
      topic: '${fn.name}',
    },
  },
  {
    id: 'node-cron-job',
    name: 'Node.js Cron/Schedule',
    type: 'scheduled',
    enabled: true,
    match: [
      {
        node: 'fn',
        label: ['Function', 'Method'],
        where: {
          annotations: { contains: 'Cron' },
        },
      },
    ],
    emit: {
      name: 'cron:${fn.name}',
      topic: '${fn.name}',
    },
  },
  {
    id: 'kafka-listener',
    name: 'Kafka Listener',
    type: 'kafka',
    enabled: false, // disabled: ep-detector handles this; enable to replace ep-detector
    match: [
      {
        node: 'method',
        label: ['Method', 'Function'],
        where: {
          annotations: { contains: 'KafkaListener' },
        },
      },
    ],
    emit: {
      name: '@KafkaListener(${method.annotations | annotationAttr("KafkaListener","topics")})',
      topic: '${method.annotations | annotationAttr("KafkaListener","topics")}',
    },
  },
  {
    id: 'rabbit-listener',
    name: 'Rabbit Listener',
    type: 'rabbit',
    enabled: false, // disabled: ep-detector handles this; enable to replace ep-detector
    match: [
      {
        node: 'method',
        label: ['Method', 'Function'],
        where: {
          annotations: { contains: 'RabbitListener' },
        },
      },
    ],
    emit: {
      name: '@RabbitListener(${method.annotations | annotationAttr("RabbitListener","queues")})',
      topic: '${method.annotations | annotationAttr("RabbitListener","queues")}',
    },
  },
  {
    id: 'event-listener',
    name: 'Event Listener',
    type: 'event',
    enabled: false, // disabled: ep-detector handles this; enable to replace ep-detector
    match: [
      {
        node: 'method',
        label: ['Method', 'Function'],
        where: {
          annotations: { contains: 'EventListener' },
        },
      },
    ],
    emit: {
      name: '@EventListener(${method.name})',
      topic: '${method.name}',
    },
  },
  // ── Node.js / NestJS ──
  {
    id: 'nestjs-controller',
    name: 'NestJS Controller Route',
    type: 'http',
    enabled: true,
    match: [
      {
        node: 'cls',
        label: 'Class',
        where: {
          annotations: { contains: 'Controller' },
        },
      },
      {
        node: 'method',
        label: 'Method',
        from: 'cls',
        edge: 'HAS_METHOD',
        where: {
          annotations: { contains: 'Get' },
        },
      },
    ],
    emit: {
      name: 'NestJS:${cls.name}.${method.name}',
      topic: '${method.name}',
    },
  },
  // ── Python / FastAPI ──
  {
    id: 'python-fastapi-route',
    name: 'Python FastAPI Route',
    type: 'http',
    enabled: true,
    match: [
      {
        node: 'fn',
        label: 'Function',
        where: {
          annotations: { contains: 'app.get' },
        },
      },
    ],
    emit: {
      name: 'FastAPI:${fn.name}',
      topic: '${fn.name}',
    },
  },
  // ── Python / Django ──
  {
    id: 'python-django-view',
    name: 'Python Django View Class',
    type: 'http',
    enabled: true,
    match: [
      {
        node: 'cls',
        label: 'Class',
        where: {
          ancestors: {
            ancestors: {
              edge: 'EXTENDS',
              label: 'Class',
              nameRegex: '.*View$|.*ViewSet$|.*APIView$',
              maxDepth: 3,
            },
          },
        },
      },
    ],
    emit: {
      name: 'Django:${cls.name}',
      topic: '${cls.name}',
    },
  },
  // ── .NET / ASP.NET ──
  {
    id: 'dotnet-controller',
    name: '.NET ASP.NET Controller',
    type: 'http',
    enabled: true,
    match: [
      {
        node: 'cls',
        label: 'Class',
        where: {
          name: { regex: '.*Controller$' },
        },
      },
      {
        node: 'method',
        label: 'Method',
        from: 'cls',
        edge: 'HAS_METHOD',
        where: {
          annotations: { contains: 'HttpGet' },
        },
      },
    ],
    emit: {
      name: '.NET:${cls.name}.${method.name}',
      topic: '${method.name}',
    },
  },
  // ── Java / Quarkus ──
  {
    id: 'quarkus-scheduled',
    name: 'Quarkus @Scheduled',
    type: 'scheduled',
    enabled: true,
    match: [
      {
        node: 'method',
        label: ['Method', 'Function'],
        where: {
          annotations: { contains: 'io.quarkus.scheduler.Scheduled' },
        },
      },
    ],
    emit: {
      name: 'Quarkus:@Scheduled(${method.name})',
      topic: '${method.name}',
    },
  },
];

const NORMALIZED_BUILT_IN_GRAPH_RULES: GraphRule[] = BUILT_IN_GRAPH_RULES.map((rule) =>
  normalizeGraphRule({ ...(BUILT_IN_RULE_APPLICABILITY[rule.id] || {}), ...rule }),
);

/** Merge config rules with built-in defaults. Config overrides by id. */
export function resolveGraphRules(configRules?: unknown[]): GraphRule[] {
  const map = new Map(NORMALIZED_BUILT_IN_GRAPH_RULES.map((r) => [r.id, { ...r }]));
  if (configRules) {
    for (const raw of configRules) {
      const normalized = normalizeGraphRule(raw as Record<string, unknown>) as unknown as GraphRule;
      const id = normalized.id;
      const existing = map.get(id);
      if (existing) {
        map.set(id, normalizeGraphRule({ ...existing, ...normalized }) as unknown as GraphRule);
      } else {
        map.set(id, normalized);
      }
    }
  }
  return [...map.values()].map((rule) => normalizeGraphRule(rule));
}

/**
 * Resolve graph rules from all sources: built-in → config YAML → Neo4j DB.
 * DB rules have highest priority.
 */
export async function resolveGraphRulesWithDB(
  configRules?: Array<Record<string, any>>,
): Promise<GraphRule[]> {
  const base = resolveGraphRules(configRules);
  const map = new Map(base.map((r) => [r.id, r]));

  try {
    const backend = await getGraphBackend();
    const rows = await backend.executeQuery('MATCH (r:GraphRule) RETURN properties(r) AS props');
    for (const row of rows) {
      const p: any = { ...row.props };
      if (typeof p.match === 'string')
        try {
          p.match = JSON.parse(p.match);
        } catch {
          continue;
        }
      if (typeof p.emit === 'string')
        try {
          p.emit = JSON.parse(p.emit);
        } catch {
          continue;
        }
      const normalized = normalizeGraphRule(p);
      const existing = map.get(p.id);
      if (existing) {
        map.set(p.id, normalizeGraphRule({ ...existing, ...normalized }) as GraphRule);
      } else {
        map.set(p.id, normalized as GraphRule);
      }
    }
  } catch {
    // DB not available — use config + built-in only
  }

  return [...map.values()].map((rule) => normalizeGraphRule(rule));
}

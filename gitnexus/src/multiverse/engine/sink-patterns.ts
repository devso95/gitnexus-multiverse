/**
 * Sink Patterns — built-in defaults + config-driven overrides
 *
 * Built-in patterns cover common Spring Boot patterns.
 * Users add custom patterns via multiverse-config.yml sinkPatterns[].
 * Config patterns override built-ins by id, or add new ones.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type {
  PatternApplicabilityConfig,
  SinkPatternConfig,
  ListenerAnnotationConfig,
  EntryPointAnnotationConfig,
  SupportedSourceLanguage,
} from '../config/types.js';
import { getService } from '../admin/service-registry.js';
import {
  matchesFileApplicability,
  normalizeFileExtensions,
  normalizePatternApplicability,
  parseStringArray,
} from './source-file-utils.js';

export type SinkCategory = 'http' | 'kafka' | 'rabbit' | 'redis' | string;
export type SinkPatternScope = 'common' | string | string[];

export interface SinkPattern {
  id: string;
  name: string;
  category: SinkCategory;
  methodPattern: string;
  targetArgIndex: number;
  enabled: boolean;
  /** Default target expression when targetArgIndex is -1 (e.g. config key for library wrappers) */
  defaultTarget?: string;
  /** Scope: common | service-id | project:PROJECT | [mixed selectors] */
  scope?: SinkPatternScope;
  wrapperClass?: string;
  wrapperMethods?: string[];
  languages?: SupportedSourceLanguage[];
  fileExtensions?: string[];
  excludePathPatterns?: string[];
}

interface PatternConfigFile {
  sinkPatterns?: SinkPatternConfig[];
  listenerAnnotations?: ListenerAnnotationConfig[];
  entryPointAnnotations?: EntryPointAnnotationConfig[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATTERN_CONFIG_PATH = path.resolve(__dirname, '../config/default-patterns.json');

const loadPatternConfigFile = (filePath: string): PatternConfigFile => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as PatternConfigFile;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const parseScope = (scope: unknown): SinkPatternScope | undefined => {
  if (scope == null || scope === '') return undefined;
  if (Array.isArray(scope)) return scope.map((item) => String(item));
  if (typeof scope !== 'string') return String(scope);

  const trimmed = scope.trim();
  if (!trimmed) return undefined;
  if (trimmed === 'common' || trimmed.startsWith('project:')) return trimmed;

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item));
    if (parsed && typeof parsed === 'object') {
      const project =
        typeof (parsed as Record<string, unknown>).project === 'string'
          ? (parsed as Record<string, string>).project
          : typeof (parsed as Record<string, unknown>).value === 'string' &&
              ((parsed as Record<string, string>).kind === 'project' ||
                (parsed as Record<string, string>).type === 'project')
            ? (parsed as Record<string, string>).value
            : undefined;
      if (project) return `project:${project}`;
    }
  } catch {
    // not JSON — treat as a plain selector string
  }

  return trimmed;
};

export const normalizeSinkPattern = <T extends object>(pattern: T): T => {
  const normalized = normalizePatternApplicability({ ...pattern }) as T & {
    scope?: unknown;
    wrapperMethods?: unknown;
  };
  const scope = parseScope(normalized.scope);
  if (scope !== undefined) normalized.scope = scope;
  else delete normalized.scope;

  const wrapperMethods = parseStringArray(normalized.wrapperMethods);
  if (wrapperMethods?.length) normalized.wrapperMethods = wrapperMethods;
  else delete normalized.wrapperMethods;

  return normalized as T;
};

const normalizeAnnotationApplicability = <T extends object>(annotation: T): T => {
  const normalized = normalizePatternApplicability({ ...annotation });
  const fileExtensions = normalizeFileExtensions(
    (normalized as { fileExtensions?: unknown }).fileExtensions,
  );
  if (fileExtensions?.length)
    (normalized as { fileExtensions?: string[] }).fileExtensions = fileExtensions;
  return normalized as T;
};

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

const GO_ONLY: PatternApplicabilityConfig = {
  languages: ['go'],
  fileExtensions: ['.go'],
};

const CSHARP_ONLY: PatternApplicabilityConfig = {
  languages: ['csharp'],
  fileExtensions: ['.cs'],
};

const BUILT_IN_SINK_APPLICABILITY: Record<string, PatternApplicabilityConfig> = {
  'spring-rest-template': JAVA_LIKE,
  'spring-web-client': JAVA_LIKE,
  'spring-feign-client': JAVA_LIKE,
  'java-http-client': JAVA_LIKE,
  'okhttp-client': JAVA_LIKE,
  'spring-kafka-template': JAVA_LIKE,
  'spring-kafka-producer-record': JAVA_LIKE,
  'kafka-producer-send': JAVA_LIKE,
  'spring-rabbit-template': JAVA_LIKE,
  'spring-amqp-template': JAVA_LIKE,
  'spring-redis-template': JAVA_LIKE,
  'spring-jms-template': JAVA_LIKE,
  'java-grpc-stub': JAVA_LIKE,
  'node-axios': NODE_LIKE,
  'node-fetch': NODE_LIKE,
  'node-got': NODE_LIKE,
  'node-superagent': NODE_LIKE,
  'node-kafkajs-producer': NODE_LIKE,
  'node-amqplib': NODE_LIKE,
  'node-redis-publish': NODE_LIKE,
  'node-bullmq': NODE_LIKE,
  'python-requests': PYTHON_ONLY,
  'python-httpx': PYTHON_ONLY,
  'python-aiohttp': PYTHON_ONLY,
  'python-kafka-producer': PYTHON_ONLY,
  'python-confluent-kafka': PYTHON_ONLY,
  'python-celery-send': PYTHON_ONLY,
  'python-pika': PYTHON_ONLY,
  'go-http-client': GO_ONLY,
  'go-grpc-dial': GO_ONLY,
  'dotnet-http-client': CSHARP_ONLY,
  'dotnet-masstransit': CSHARP_ONLY,
};

const BUILT_IN_LISTENER_APPLICABILITY: Record<string, PatternApplicabilityConfig> = {
  KafkaListener: JAVA_LIKE,
  RabbitListener: JAVA_LIKE,
  RabbitHandler: JAVA_LIKE,
  EventListener: JAVA_LIKE,
  TransactionalEventListener: JAVA_LIKE,
  StreamListener: JAVA_LIKE,
  JmsListener: JAVA_LIKE,
  SqsListener: JAVA_LIKE,
  GrpcService: {
    languages: ['java', 'kotlin', 'csharp'],
    fileExtensions: ['.java', '.kt', '.kts', '.cs'],
  },
  Consumer: JAVA_LIKE,
};

const BUILT_IN_ENTRYPOINT_APPLICABILITY: Record<string, PatternApplicabilityConfig> = {
  Scheduled: JAVA_LIKE,
  Schedules: JAVA_LIKE,
  Job: JAVA_LIKE,
  Recurring: JAVA_LIKE,
  RecurringJob: JAVA_LIKE,
  periodic_task: PYTHON_ONLY,
  crontab: PYTHON_ONLY,
  TimerTrigger: CSHARP_ONLY,
};

// ── Built-in sink patterns (producers) ──

const BUILT_IN_PATTERN_CONFIG = loadPatternConfigFile(DEFAULT_PATTERN_CONFIG_PATH);

const BUILT_IN_SINK_PATTERNS: SinkPattern[] = (BUILT_IN_PATTERN_CONFIG.sinkPatterns ?? []).map(
  (pattern) =>
    normalizeSinkPattern({
      ...(BUILT_IN_SINK_APPLICABILITY[pattern.id] || {}),
      ...pattern,
    }) as SinkPattern,
);

// ── Built-in listener annotations (consumers) ──

export interface ListenerAnnotation {
  annotation: string;
  type: string;
  topicAttribute?: string;
  enabled: boolean;
  languages?: SupportedSourceLanguage[];
  fileExtensions?: string[];
  excludePathPatterns?: string[];
}

const BUILT_IN_LISTENER_ANNOTATIONS: ListenerAnnotation[] = (
  BUILT_IN_PATTERN_CONFIG.listenerAnnotations ?? []
).map((annotation) =>
  normalizeAnnotationApplicability({
    ...(BUILT_IN_LISTENER_APPLICABILITY[annotation.annotation] || {}),
    ...annotation,
  }),
);

// ── Merge functions ──

/** Merge config patterns with built-in defaults. Config overrides by id. */
export const resolveSinkPatterns = (configPatterns?: SinkPatternConfig[]): SinkPattern[] => {
  const map = new Map(BUILT_IN_SINK_PATTERNS.map((p) => [p.id, { ...p }]));
  if (configPatterns) {
    for (const o of configPatterns) {
      const normalized = normalizeSinkPattern(o);
      const existing = map.get(o.id);
      map.set(
        o.id,
        normalizeSinkPattern(
          existing ? { ...existing, ...normalized } : ({ ...normalized } as SinkPattern),
        ),
      );
    }
  }
  return [...map.values()].map((pattern) => normalizeSinkPattern(pattern));
};

/** Merge config listener annotations with built-in defaults. Config overrides by annotation name. */
export const resolveListenerAnnotations = (
  configAnnotations?: ListenerAnnotationConfig[],
): ListenerAnnotation[] => {
  const map = new Map(BUILT_IN_LISTENER_ANNOTATIONS.map((a) => [a.annotation, { ...a }]));
  if (configAnnotations) {
    for (const o of configAnnotations) {
      const existing = map.get(o.annotation);
      map.set(
        o.annotation,
        normalizeAnnotationApplicability(
          existing ? { ...existing, ...o } : ({ ...o } as ListenerAnnotation),
        ),
      );
    }
  }
  return [...map.values()].map((annotation) => normalizeAnnotationApplicability(annotation));
};

/** Get resolved annotation → type map (for parse-worker) */
export const getListenerAnnotationMap = (
  annotations: ListenerAnnotation[],
): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const a of annotations) if (a.enabled) map[a.annotation] = a.type;
  return map;
};

/** Get resolved annotation → topic attribute map (for parse-worker) */
export const getListenerTopicAttrMap = (
  annotations: ListenerAnnotation[],
): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const a of annotations)
    if (a.enabled && a.topicAttribute) map[a.annotation] = a.topicAttribute;
  return map;
};

// ── Backward compat ──

// ── Entry Point Annotations (Scheduled, Job, etc.) ──

export interface EntryPointAnnotation {
  annotation: string;
  type: string;
  scheduleAttribute?: string;
  enabled: boolean;
  languages?: SupportedSourceLanguage[];
  fileExtensions?: string[];
  excludePathPatterns?: string[];
}

const BUILT_IN_ENTRY_POINT_ANNOTATIONS: EntryPointAnnotation[] = (
  BUILT_IN_PATTERN_CONFIG.entryPointAnnotations ?? []
).map((annotation) =>
  normalizeAnnotationApplicability({
    ...(BUILT_IN_ENTRYPOINT_APPLICABILITY[annotation.annotation] || {}),
    ...annotation,
  }),
);

/** Merge config entry point annotations with built-in defaults */
export const resolveEntryPointAnnotations = (
  configAnnotations?: EntryPointAnnotationConfig[],
): EntryPointAnnotation[] => {
  const map = new Map(BUILT_IN_ENTRY_POINT_ANNOTATIONS.map((a) => [a.annotation, { ...a }]));
  if (configAnnotations) {
    for (const o of configAnnotations) {
      const existing = map.get(o.annotation);
      map.set(
        o.annotation,
        normalizeAnnotationApplicability(
          existing ? { ...existing, ...o } : ({ ...o } as EntryPointAnnotation),
        ),
      );
    }
  }
  return [...map.values()].map((annotation) => normalizeAnnotationApplicability(annotation));
};

export const matchesPatternApplicability = (
  pattern: Pick<SinkPattern, 'languages' | 'fileExtensions' | 'excludePathPatterns'>,
  filePath: string,
): boolean => matchesFileApplicability(filePath, pattern);

export const matchesAnnotationApplicability = (
  annotation: Pick<ListenerAnnotation, 'languages' | 'fileExtensions' | 'excludePathPatterns'>,
  filePath: string,
): boolean => matchesFileApplicability(filePath, annotation);

export const matchesEntryPointApplicability = (
  annotation: Pick<EntryPointAnnotation, 'languages' | 'fileExtensions' | 'excludePathPatterns'>,
  filePath: string,
): boolean => matchesFileApplicability(filePath, annotation);

// ── Backward compat ──

/** @deprecated Use resolveSinkPatterns() instead */
export const DEFAULT_SINK_PATTERNS = BUILT_IN_SINK_PATTERNS;

/** @deprecated Use mergePatterns via resolveSinkPatterns() */
export const mergePatterns = (defaults: SinkPattern[], overrides: SinkPattern[]): SinkPattern[] => {
  const map = new Map(defaults.map((p) => [p.id, p]));
  for (const o of overrides) map.set(o.id, { ...map.get(o.id), ...o });
  return [...map.values()];
};

export const matchesPatternScope = (
  pattern: SinkPattern,
  serviceId: string,
  serviceProject?: string,
): boolean => {
  const normalized = normalizeSinkPattern(pattern) as SinkPattern;
  const scope = normalized.scope;
  if (!scope || scope === 'common') return true;

  const selectors = Array.isArray(scope) ? scope : [scope];
  const project = serviceProject?.toLowerCase();

  return selectors.some((selector) => {
    if (selector === serviceId) return true;
    if (selector === 'common') return true;
    if (selector.startsWith('project:')) {
      return !!project && selector.slice('project:'.length).toLowerCase() === project;
    }
    return false;
  });
};

/** Filter patterns by service/project scope. Patterns with scope="common" or no scope match all services. */
export const getPatternsForService = async (
  patterns: SinkPattern[],
  serviceId: string,
  serviceProject?: string,
): Promise<SinkPattern[]> => {
  const project = serviceProject ?? (await getService(serviceId).catch(() => null))?.repoProject;
  return patterns
    .map((pattern) => normalizeSinkPattern(pattern) as SinkPattern)
    .filter((pattern) => matchesPatternScope(pattern, serviceId, project));
};

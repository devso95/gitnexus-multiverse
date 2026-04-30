/**
 * Multiverse Configuration Types
 */

export interface MultiverseConfig {
  server: ServerConfig;
  neo4j: Neo4jConfig;
  auth: AuthConfig;
  workspace: WorkspaceConfig;
  cloudConfig: CloudConfigSettings;
  analyze: AnalyzeConfig;
  services: ServiceSeedConfig[];
  /** Sink detection patterns — merged with built-in defaults (override by id) */
  sinkPatterns: SinkPatternConfig[];
  /** Listener annotation mappings — merged with built-in defaults (override by annotation) */
  listenerAnnotations: ListenerAnnotationConfig[];
  /** Entry point annotation mappings — detect @Scheduled, @Job, etc. as entry points */
  entryPointAnnotations: EntryPointAnnotationConfig[];
  /** Graph pattern rules — language-agnostic entry point detection via graph traversal */
  graphRules: GraphRuleConfig[];
  /** Wiki generation config */
  wiki: WikiConfig;
}

export interface ServerConfig {
  port: number;
  host: string;
}

export interface WorkspaceConfig {
  dir: string; // where repos are cloned
  gitBase: string; // e.g. https://git.example.com/scm
}

export interface Neo4jConfig {
  uri: string;
  user: string;
  password: string;
  database: string;
}

export interface AuthConfig {
  users: AuthUser[];
}

export interface AuthUser {
  username: string;
  password: string; // bcrypt hash
  role: 'admin' | 'viewer';
}

export interface CloudConfigSettings {
  /** Base URL for Spring Cloud Config Server, e.g. https://config.example.com/config/v2 */
  baseUrl: string;
  /** Default profile to use, e.g. cloud_uat */
  defaultProfile: string;
  /** Whether cloud config is enabled */
  enabled: boolean;
  /** Timeout in ms for cloud config fetch */
  timeoutMs: number;
}

export interface AnalyzeConfig {
  /** Max concurrent analyze jobs */
  maxConcurrency: number;
  /** Git fetch/pull timeout in ms */
  gitTimeoutMs: number;
  /** Git clone timeout in ms */
  cloneTimeoutMs: number;
}

export interface ServiceSeedConfig {
  id: string;
  name: string;
  type: 'service' | 'lib';
  repo: { project: string; slug: string; branch: string };
  urlPrefixes?: string[];
  dependsOn?: string[];
}

export type SupportedSourceLanguage =
  | 'java'
  | 'kotlin'
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'go'
  | 'csharp'
  | 'xml';

export interface PatternApplicabilityConfig {
  /** Restrict matching to specific source languages. */
  languages?: SupportedSourceLanguage[];
  /** Restrict matching to specific file extensions, e.g. [".java", ".kt"]. */
  fileExtensions?: string[];
  /** Regex path filters to exclude files even when language/extension match. */
  excludePathPatterns?: string[];
}

/** Sink pattern config — detect outbound calls (producers) */
export interface SinkPatternConfig extends PatternApplicabilityConfig {
  id: string;
  name: string;
  /** Transport category */
  category: 'http' | 'kafka' | 'rabbit' | 'redis' | string;
  /** Regex matching the method call in source code */
  methodPattern: string;
  /** Which argument (0-based) contains the URL/topic. -1 = unknown */
  targetArgIndex: number;
  enabled: boolean;
  /** Default target expression when targetArgIndex is -1 */
  defaultTarget?: string;
  /**
   * Scope: which services this pattern applies to.
   * - "common" (default) → all services
   * - "service-id" → single service
   * - "project:ABC" → all services with repoProject=ABC
   * - ["svc-a", "project:ABC"] → mixed selectors
   */
  scope?: 'common' | string | string[];
  /**
   * Wrapper pattern: detect sink at wrapper class level instead of primitive.
   * When set, engine finds callers of wrapperMethods and creates per-caller sinks.
   */
  wrapperClass?: string;
  /** Method names in the wrapper class that are outbound call points */
  wrapperMethods?: string[];
}

/** Listener annotation config — detect inbound handlers (consumers) */
export interface ListenerAnnotationConfig extends PatternApplicabilityConfig {
  /** Annotation name without @ (e.g. "KafkaListener") */
  annotation: string;
  /** Transport type this annotation maps to */
  type: 'kafka' | 'rabbit' | 'redis' | 'event' | string;
  /** Annotation attribute that contains the topic/queue (e.g. "topics", "queues") */
  topicAttribute?: string;
  enabled: boolean;
}

/** Entry point annotation config — detect @Scheduled, @Job, etc. as service entry points */
export interface EntryPointAnnotationConfig extends PatternApplicabilityConfig {
  /** Annotation name without @ (e.g. "Scheduled", "Job") */
  annotation: string;
  /** Entry point type label */
  type: 'scheduled' | 'job' | 'cron' | string;
  /** Annotation attribute for schedule expression (e.g. "cron", "value") */
  scheduleAttribute?: string;
  enabled: boolean;
}

/** Wiki generation config — output structured markdown docs for AI retrieval */
export interface WikiConfig {
  /** Output directory for generated wiki files */
  outputDir: string;
  /** Auto-generate wiki after analyze completes */
  autoGenerate: boolean;
  /** LLM config for enriched wiki generation. If not set, falls back to template-based output. */
  llm?: WikiLLMConfig;
}

/** LLM config for wiki generation */
export interface WikiLLMConfig {
  /** API base URL (OpenAI-compatible) */
  baseUrl: string;
  /** API key or auth token */
  apiKey: string;
  /** Model name */
  model: string;
  /** Max tokens per response */
  maxTokens: number;
}

/** Graph pattern rule config — language-agnostic entry point detection via graph traversal */
export interface GraphRuleConfig extends PatternApplicabilityConfig {
  id: string;
  name: string;
  /** Entry point type: job, scheduled, cron, listener, etc. */
  type: string;
  enabled: boolean;
  match: GraphRuleMatchStep[];
  emit: GraphRuleEmit;
}

export interface GraphRuleMatchStep {
  /** Variable name for this node */
  node: string;
  /** Node label(s) to match */
  label: string | string[];
  /** Traverse from a previously matched node variable */
  from?: string;
  /** Edge type to traverse */
  edge?: string;
  /** Traverse direction */
  direction?: 'outgoing' | 'incoming';
  /** Property filters */
  where?: Record<string, unknown>;
}

export interface GraphRuleEmit {
  type?: string;
  /** Template: "${cls.name}" */
  name: string;
  /** Template for topic/schedule */
  topic?: string;
}

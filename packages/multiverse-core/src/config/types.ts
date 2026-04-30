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
  sinkPatterns: SinkPatternConfig[];
  listenerAnnotations: ListenerAnnotationConfig[];
  entryPointAnnotations: EntryPointAnnotationConfig[];
  graphRules: GraphRuleConfig[];
  wiki: WikiConfig;
}

export interface ServerConfig {
  port: number;
  host: string;
}

export interface WorkspaceConfig {
  dir: string;
  gitBase: string;
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
  password: string;
  role: 'admin' | 'viewer';
}

export interface CloudConfigSettings {
  baseUrl: string;
  defaultProfile: string;
  enabled: boolean;
  timeoutMs: number;
}

export interface AnalyzeConfig {
  maxConcurrency: number;
  gitTimeoutMs: number;
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
  languages?: SupportedSourceLanguage[];
  fileExtensions?: string[];
  excludePathPatterns?: string[];
}

export interface SinkPatternConfig extends PatternApplicabilityConfig {
  id: string;
  name: string;
  category: 'http' | 'kafka' | 'rabbit' | 'redis' | string;
  methodPattern: string;
  targetArgIndex: number;
  enabled: boolean;
  defaultTarget?: string;
  scope?: 'common' | string | string[];
  wrapperClass?: string;
  wrapperMethods?: string[];
}

export interface ListenerAnnotationConfig extends PatternApplicabilityConfig {
  annotation: string;
  type: 'kafka' | 'rabbit' | 'redis' | 'event' | string;
  topicAttribute?: string;
  enabled: boolean;
}

export interface EntryPointAnnotationConfig extends PatternApplicabilityConfig {
  annotation: string;
  type: 'scheduled' | 'job' | 'cron' | string;
  scheduleAttribute?: string;
  enabled: boolean;
}

export interface WikiConfig {
  outputDir: string;
  autoGenerate: boolean;
  llm?: WikiLLMConfig;
}

export interface WikiLLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
}

export interface GraphRuleConfig extends PatternApplicabilityConfig {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  match: GraphRuleMatchStep[];
  emit: GraphRuleEmit;
}

export interface GraphRuleMatchStep {
  node: string;
  label: string | string[];
  from?: string;
  edge?: string;
  direction?: 'outgoing' | 'incoming';
  where?: Record<string, unknown>;
}

export interface GraphRuleEmit {
  type?: string;
  name: string;
  topic?: string;
}

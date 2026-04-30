export interface Service {
  id: string;
  name: string;
  type: string;
  repoProject: string;
  repoSlug: string;
  repoBranch: string;
  gitUrl?: string;
  nodeCount?: number;
  edgeCount?: number;
  entryPointCount?: number;
  indexedAt?: string;
  analyzeStatus?: string;
  analyzeError?: string;
}

export interface ServicesResponse {
  services?: Service[];
}

export interface ServiceStatusResponse {
  id?: string;
  analyzeStatus?: string;
  lastAnalyzedAt?: string;
  jobId?: string;
  stats?: AnalyzeStats;
  error?: string;
}

export interface AnalyzeStep {
  step: string;
  status: 'pending' | 'running' | 'done' | 'failed' | string;
  detail?: string;
  ts?: string;
}

export interface AnalyzeStats {
  nodes?: number;
  edges?: number;
  files?: number;
  sinksDetected?: number;
  sinksResolved?: number;
  crossLinks?: number;
  entryPoints?: number;
  businessGroups?: number;
}

export interface AnalyzeResponse {
  jobId?: string;
  status?: string;
  message?: string;
  error?: string;
}

export interface AnalyzeProgressEvent {
  step?: string;
  status?: string;
  detail?: string;
  steps?: AnalyzeStep[];
}

export interface AnalyzeDoneEvent {
  status?: string;
  stats?: AnalyzeStats;
  error?: string;
}

export interface HealthInfo {
  status?: string;
  version?: string;
  uptime?: number;
  neo4j?: {
    connected?: boolean;
    nodes?: number;
    edges?: number;
  };
  services?: {
    total?: number;
  };
  [key: string]: unknown;
}

export interface AddServiceBody {
  id: string;
  name: string;
  type: string;
  repo: { project: string; slug: string; branch: string };
  gitUrl?: string;
  localPath?: string;
}

export interface AddServiceResponse {
  id: string;
}

export interface ResolveSinksResponse {
  resolved: number;
  total: number;
}

export interface Neighbor {
  direction?: string;
  name?: string;
  relType?: string;
}

export interface EntryPoint {
  id: string;
  method?: string;
  path?: string;
  topic?: string;
  name?: string;
  kind?: string;
  kindLabel?: string;
  type?: string;
  description?: string;
  filePath?: string;
  startLine?: number;
  neighbors?: Neighbor[];
}

export interface ServiceSummary {
  id?: string;
  name?: string;
  repoProject?: string;
  type?: string;
  nodeCount?: number;
  edgeCount?: number;
  indexedAt?: string;
}

export interface BusinessGroup {
  name?: string;
  entrypoints?: EntryPoint[];
  entryPointIds?: string[];
  entryPointCount?: number;
}

export interface LinkTarget {
  sourceName?: string;
  source?: string;
  from?: string;
  topic?: string;
  url?: string;
  targetEndpoint?: string;
  targetService?: string;
  service?: string;
  type?: string;
  confidence?: number;
  transportId?: string;
}

export interface IncomingCall {
  callerService?: string;
  service?: string;
  callerMethod?: string;
  name?: string;
  method?: string;
  url?: string;
  topic?: string;
  targetEndpoint?: string;
  endpoint?: string;
  type?: string;
  confidence?: number;
}

export interface TraceNode {
  name?: string;
  file?: string;
}

export interface CrossServiceCall {
  targetService?: string;
  targetName?: string;
  type?: string;
  url?: string;
  topic?: string;
}

export interface TraceResult {
  entryPoint?: EntryPoint;
  internalFlow: TraceNode[];
  crossServiceCalls: CrossServiceCall[];
}

export interface BusinessGroupResponse {
  groups?: BusinessGroup[];
}

export interface OutgoingResponse {
  targets?: LinkTarget[];
  results?: LinkTarget[];
}

export interface IncomingResponse {
  callers?: IncomingCall[];
  results?: IncomingCall[];
}

export interface NodeDetailResponse {
  node?: { props?: Partial<EntryPoint> };
  neighbors?: Neighbor[];
}

export interface MatchEndpointResponse {
  matched?: boolean;
}

export interface Sink {
  id: string;
  method: string;
  callee: string;
  type: string;
  pattern: string;
  expr: string;
  file: string;
  line: number;
  resolved: string | null;
  resolvedVia: string;
  confidence: number;
  status: string;
}

export interface SinksResponse {
  sinks?: Sink[];
  total?: number;
  resolved?: number;
}

export interface ResolveSinkBody {
  sinkId: string;
  value?: string;
}

export interface ResolveSinkResponse {
  resolved?: boolean;
  value?: string;
  via?: string;
}

/**
 * Multiverse Backend Types — Domain Models
 */

export interface ServiceNode {
  id: string;
  name: string;
  type: 'service' | 'lib';
  repoProject: string;
  repoSlug: string;
  repoBranch: string;
  gitUrl?: string;
  localPath?: string;
  teamId?: string;
  urlPrefixes?: string[];
  dependsOn?: string[];
  indexedAt?: string;
  lastCommit?: string;
  nodeCount?: number;
  edgeCount?: number;
  entryPointCount?: number;
  analyzeStatus?: string;
  analyzeError?: string;
}

export interface DetectedSink {
  id: string;
  repoId: string;
  sinkType: 'http' | 'kafka' | 'rabbit' | 'redis' | 'grpc' | 'jms' | 'queue' | 'sqs' | 'other';
  patternId: string;
  methodPattern?: string;
  targetExpression: string;
  callSiteNodeId?: string;
  callSiteMethod: string;
  calleeMethod: string;
  filePath: string;
  lineNumber: number;
  confidence?: number;
  sinkCategory?: string;
  resolvedUrl?: string;
  resolvedTopic?: string;
  resolvedVia?: string;
}

export interface AnalyzeJob {
  id: string;
  serviceId: string;
  status: 'queued' | 'cloning' | 'analyzing' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  error?: string;
  stats?: AnalyzeStats;
  steps: AnalyzeStep[];
}

export interface AnalyzeStep {
  step: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  detail?: string;
  ts?: string;
}

export interface AnalyzeStats {
  nodes?: number;
  edges?: number;
  files?: number;
  sinksDetected: number;
  sinksResolved: number;
  crossLinks: number;
  entryPoints?: number;
  businessGroups?: number;
}

export interface ManualResolution {
  serviceId: string;
  patternId: string;
  filePath: string;
  lineNumber: number;
  resolvedValue: string;
  sinkType: string;
  confidence: number;
  note?: string;
}

export interface SinkPattern {
  id: string;
  name: string;
  category: string;
  methodPattern: string;
  targetArgIndex: number;
  enabled: boolean;
  scope?: string | string[];
}

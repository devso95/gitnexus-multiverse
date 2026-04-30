import type { SeedType } from '../../lib/entrypoints';

export interface GNode {
  id: string;
  name?: string;
  label?: string;
  filePath?: string;
  startLine?: number;
  routePath?: string;
  httpMethod?: string;
  resolvedUrl?: string;
  topic?: string;
  project?: string;
  type?: string;
  entryPoints?: number;
  description?: string;
  kind?: string;
  listenerType?: string;
  sinkType?: string;
  targetExpression?: string;
  confidence?: number;
  depth?: number;
}

export interface GEdge {
  source: string;
  target: string;
  type: string;
  via?: string | string[];
  from?: string;
  to?: string;
  count?: number;
  confidence?: number;
}

export interface SearchResult {
  id: string;
  name: string;
  label: string;
  filePath?: string;
}

export interface GraphSeedOptionDto {
  value: SeedType;
  label: string;
  count: number;
}

export interface GraphResponse {
  nodes: GNode[];
  edges: GEdge[];
  seeds: string[];
  availableSeeds?: GraphSeedOptionDto[];
  focus?: string | null;
}

export interface NodeNeighbor {
  id: string;
  name?: string;
  label?: string;
  relType?: string;
  outgoing?: boolean;
  direction?: 'incoming' | 'outgoing';
}

export interface NodeDetailResponse {
  node: {
    id: string;
    name?: string;
    labels?: string[];
    props?: Record<string, unknown>;
  } | null;
  neighbors?: NodeNeighbor[];
  graph?: GraphResponse;
  relatedEntrypoints?: Array<Record<string, unknown>>;
}

export interface ServiceMapResponse {
  nodes: GNode[];
  edges: Array<{
    from: string;
    to: string;
    type: string;
    count?: number;
    confidence?: number;
    via?: string[];
  }>;
  unmatchedTransports?: Array<{
    from: string;
    via: string;
    type: string;
    confidence?: number;
  }>;
}

export type Mode = 'services' | 'explore';

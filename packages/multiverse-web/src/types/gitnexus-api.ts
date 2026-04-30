/**
 * GitNexus HTTP API response types
 * These interfaces mirror the output schemas from gitnexus/src/mcp/tools.ts
 */

export interface ProcessSymbol {
  id: string;
  name: string;
  type: string; // Class, Function, Route, Listener, etc.
  file: string;
  line: number;
  module?: string;
  description?: string;
}

export interface Process {
  id: string;
  name: string;
  description?: string;
  symbols?: string[];
  stepCount?: number;
  step_count?: number;
}

export interface TypeDefinition {
  name: string;
  kind: string; // Class, Interface, Type, Enum
  file: string;
  line: number;
  module?: string;
}

export interface QueryResponse {
  processes: Process[];
  process_symbols: ProcessSymbol[];
  definitions?: TypeDefinition[];
  query?: string;
  repo?: string;
}

export interface Caller {
  name: string;
  type: string;
  file: string;
  line: number;
  module?: string;
  count?: number;
}

export interface Callee {
  name: string;
  type: string;
  file: string;
  line: number;
  module?: string;
  count?: number;
}

export interface ContextResponse {
  symbol: ProcessSymbol;
  callers: Caller[];
  callees: Callee[];
  member_of?: Array<{ name: string; type: string }>;
  extends?: Array<{ name: string; type: string }>;
  implements?: Array<{ name: string; type: string }>;
  related?: ProcessSymbol[];
}

export interface AffectedSymbol {
  name: string;
  type: string;
  file: string;
  line: number;
  depth: number;
  why: string; // Why it's affected
}

export interface ImpactResponse {
  affected: AffectedSymbol[];
  risk_summary: {
    depth_1_count: number;
    depth_2_count: number;
    depth_3_count: number;
    risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  };
  target?: string;
  direction?: 'upstream' | 'downstream';
}

export interface RenameResponse {
  changes: Array<{
    file: string;
    line: number;
    oldName: string;
    newName: string;
  }>;
  success: boolean;
  count: number;
}

export interface DetectChangesResponse {
  affected_symbols: Array<{
    name: string;
    type: string;
    reason: string;
  }>;
  changed_files: string[];
  scope: string;
  status: 'ok' | 'error';
}

export interface GitNexusContextResponse {
  overview?: string;
  clusters?: Array<{
    name: string;
    symbols: string[];
  }>;
  processes?: Array<{
    name: string;
    steps: number;
  }>;
  index_freshness?: {
    analyzed_at: string;
    file_count: number;
    symbol_count: number;
  };
}

export interface ErrorResponse {
  error: string;
  code?: string;
  details?: string;
}

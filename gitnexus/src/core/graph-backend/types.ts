/**
 * GraphBackend Interface
 *
 * Abstraction over graph database engines (LadybugDB, Neo4j).
 * Both use Cypher, so queries are mostly portable.
 */

import { KnowledgeGraph } from '../graph/types.js';

export type ProgressCallback = (message: string) => void;

export interface LoadGraphResult {
  success: boolean;
  insertedRels: number;
  skippedRels: number;
  warnings: string[];
}

export interface GraphBackend {
  readonly name: string;

  // Lifecycle
  init(
    dbPath: string,
    config?: { uri?: string; user?: string; password?: string; database?: string },
  ): Promise<void>;
  close(): Promise<void>;
  isReady(): boolean;

  /**
   * Execute operation against a specific DB path atomically.
   * For LadybugDB: switches file-based DB. For Neo4j: selects database name.
   */
  withDb<T>(dbPath: string, operation: () => Promise<T>): Promise<T>;

  // Query
  executeQuery(cypher: string, params?: Record<string, any>): Promise<any[]>;

  /** Execute multiple queries in a single session (reduces session overhead for batch operations) */
  executeBatch(queries: Array<{ cypher: string; params?: Record<string, any> }>): Promise<any[][]>;

  // Bulk load
  loadGraph(
    graph: KnowledgeGraph,
    repoPath: string,
    storagePath: string,
    onProgress?: ProgressCallback,
  ): Promise<LoadGraphResult>;

  // Stats
  getStats(): Promise<{ nodes: number; edges: number }>;

  // Node CRUD
  insertNode(label: string, properties: Record<string, any>, dbPath?: string): Promise<boolean>;
  batchInsertNodes(
    nodes: Array<{ label: string; properties: Record<string, any> }>,
    dbPath: string,
  ): Promise<{ inserted: number; failed: number }>;
  deleteNodesForFile(filePath: string, dbPath?: string): Promise<{ deletedNodes: number }>;

  // Embeddings
  loadCachedEmbeddings(): Promise<{
    embeddingNodeIds: Set<string>;
    embeddings: Array<{ nodeId: string; embedding: number[] }>;
  }>;

  // Prepared statement batch execution (LadybugDB optimization, Neo4j falls back to sequential)
  executeWithReusedStatement(cypher: string, paramsList: Array<Record<string, any>>): Promise<void>;

  // FTS
  createFTSIndex(
    tableName: string,
    indexName: string,
    properties: string[],
    stemmer?: string,
  ): Promise<void>;
  queryFTS(
    tableName: string,
    indexName: string,
    query: string,
    limit?: number,
    conjunctive?: boolean,
  ): Promise<
    Array<{ nodeId: string; name: string; filePath: string; score: number; [key: string]: any }>
  >;
  dropFTSIndex(tableName: string, indexName: string): Promise<void>;
}

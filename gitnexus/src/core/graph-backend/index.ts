/**
 * Graph Backend Factory — Neo4j only
 *
 * Re-exports drop-in replacement functions matching old lbug-adapter.ts signatures
 * so existing consumers keep working without import changes.
 */

import type { GraphBackend } from './types.js';
export type { GraphBackend, LoadGraphResult, ProgressCallback } from './types.js';

let _backend: GraphBackend | null = null;

export const getGraphBackend = async (): Promise<GraphBackend> => {
  if (_backend) return _backend;
  const { Neo4jBackend } = await import('./neo4j-backend.js');
  _backend = new Neo4jBackend();
  return _backend;
};

/** Reset singleton (for testing) */
export const resetBackend = () => {
  _backend = null;
};

// ── Drop-in replacement functions (backward compat with old lbug-adapter callers) ──

export const initLbug = async (dbPath: string) => {
  const b = await getGraphBackend();
  await b.init(dbPath);
};

export const withLbugDb = async <T>(dbPath: string, operation: () => Promise<T>): Promise<T> => {
  const b = await getGraphBackend();
  return b.withDb(dbPath, operation);
};

export const executeQuery = async (
  cypher: string,
  params?: Record<string, any>,
): Promise<any[]> => {
  const b = await getGraphBackend();
  return b.executeQuery(cypher, params);
};

export const executeBatch = async (
  queries: Array<{ cypher: string; params?: Record<string, any> }>,
): Promise<any[][]> => {
  const b = await getGraphBackend();
  return b.executeBatch(queries);
};

export const loadGraphToLbug = async (
  graph: any,
  repoPath: string,
  storagePath: string,
  onProgress?: (msg: string) => void,
) => {
  const b = await getGraphBackend();
  return b.loadGraph(graph, repoPath, storagePath, onProgress);
};

export const getLbugStats = async () => {
  const b = await getGraphBackend();
  return b.getStats();
};

export const insertNodeToLbug = async (
  label: string,
  properties: Record<string, any>,
  dbPath?: string,
) => {
  const b = await getGraphBackend();
  return b.insertNode(label, properties, dbPath);
};

export const batchInsertNodesToLbug = async (
  nodes: Array<{ label: string; properties: Record<string, any> }>,
  dbPath: string,
) => {
  const b = await getGraphBackend();
  return b.batchInsertNodes(nodes, dbPath);
};

export const deleteNodesForFile = async (filePath: string, dbPath?: string) => {
  const b = await getGraphBackend();
  return b.deleteNodesForFile(filePath, dbPath);
};

export const executeWithReusedStatement = async (
  cypher: string,
  paramsList: Array<Record<string, any>>,
) => {
  const b = await getGraphBackend();
  return b.executeWithReusedStatement(cypher, paramsList);
};

export const loadCachedEmbeddings = async () => {
  const b = await getGraphBackend();
  return b.loadCachedEmbeddings();
};

export const closeLbug = async () => {
  if (_backend) await _backend.close();
};

export const isLbugReady = (): boolean => {
  return _backend?.isReady() ?? false;
};

export const createFTSIndex = async (
  tableName: string,
  indexName: string,
  properties: string[],
  stemmer?: string,
) => {
  const b = await getGraphBackend();
  return b.createFTSIndex(tableName, indexName, properties, stemmer);
};

export const queryFTS = async (
  tableName: string,
  indexName: string,
  query: string,
  limit?: number,
  conjunctive?: boolean,
) => {
  const b = await getGraphBackend();
  return b.queryFTS(tableName, indexName, query, limit, conjunctive);
};

export const dropFTSIndex = async (tableName: string, indexName: string) => {
  const b = await getGraphBackend();
  return b.dropFTSIndex(tableName, indexName);
};

// Re-export schema constants (unchanged — schema.ts has no native deps)
export {
  NODE_TABLES,
  REL_TABLE_NAME,
  EMBEDDING_TABLE_NAME,
  EMBEDDING_DIMS,
} from '../lbug/schema.js';
import { EMBEDDING_TABLE_NAME } from '../lbug/schema.js';
export const getEmbeddingTableName = (): string => EMBEDDING_TABLE_NAME;

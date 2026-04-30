/**
 * Neo4j Backend — GraphBackend implementation using neo4j-driver.
 *
 * Env vars:
 *   GITNEXUS_NEO4J_URI      bolt://localhost:7687
 *   GITNEXUS_NEO4J_USER     neo4j
 *   GITNEXUS_NEO4J_PASSWORD  password
 *   GITNEXUS_NEO4J_DATABASE  neo4j  (optional)
 */

import type { GraphBackend, LoadGraphResult, ProgressCallback } from './types.js';
import type { KnowledgeGraph } from '../graph/types.js';
import { NODE_TABLES, REL_TABLE_NAME, EMBEDDING_TABLE_NAME } from '../lbug/schema.js';

// Lazy import to avoid crash when neo4j-driver is not installed
let neo4j: any = null;
const loadDriver = async () => {
  if (!neo4j) neo4j = await import('neo4j-driver');
  return neo4j;
};

const BATCH_SIZE = 1000;

const escapeTableName = (t: string) => (/^[A-Z][a-zA-Z]*$/.test(t) ? t : `\`${t}\``);

export class Neo4jBackend implements GraphBackend {
  readonly name = 'neo4j';
  private driver: any = null;
  private database: string;

  constructor() {
    this.database = process.env.GITNEXUS_NEO4J_DATABASE || 'neo4j';
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  async init(
    _dbPath: string,
    config?: { uri?: string; user?: string; password?: string; database?: string },
  ) {
    const drv = await loadDriver();
    const uri = config?.uri || process.env.GITNEXUS_NEO4J_URI || 'bolt://localhost:7687';
    const user = config?.user || process.env.GITNEXUS_NEO4J_USER || 'neo4j';
    const password = config?.password || process.env.GITNEXUS_NEO4J_PASSWORD || 'password';
    if (config?.database) this.database = config.database;
    this.driver = drv.default.driver(uri, drv.default.auth.basic(user, password));
    await this.driver.verifyConnectivity();

    // Create constraints for each node table (idempotent)
    const session = this.driver.session({ database: this.database });
    try {
      for (const table of NODE_TABLES) {
        try {
          await session.run(
            `CREATE CONSTRAINT IF NOT EXISTS FOR (n:${escapeTableName(table)}) REQUIRE n.id IS UNIQUE`,
          );
        } catch {
          /* ignore */
        }
      }
      // Embedding table constraint
      try {
        await session.run(
          `CREATE CONSTRAINT IF NOT EXISTS FOR (n:${EMBEDDING_TABLE_NAME}) REQUIRE n.nodeId IS UNIQUE`,
        );
      } catch {
        /* ignore */
      }
    } finally {
      await session.close();
    }
  }

  async close() {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }

  isReady() {
    return this.driver !== null;
  }

  async withDb<T>(_dbPath: string, operation: () => Promise<T>): Promise<T> {
    // Neo4j doesn't switch files — database is set at constructor level
    return operation();
  }

  // ── Query ──────────────────────────────────────────────────────────

  async executeQuery(cypher: string, params?: Record<string, any>): Promise<any[]> {
    const session = this.driver.session({ database: this.database });
    try {
      const result = await session.run(cypher, this.prepareParams(params ?? {}));
      return result.records.map((r: any) => {
        const obj: any = {};
        r.keys.forEach((key: string) => {
          const val = r.get(key);
          obj[key] = this.convertNeo4jValue(val);
        });
        return obj;
      });
    } finally {
      await session.close();
    }
  }

  /**
   * Execute multiple queries in a single session (reduces session open/close overhead).
   * Each query runs sequentially within the same session.
   */
  async executeBatch(
    queries: Array<{ cypher: string; params?: Record<string, any> }>,
  ): Promise<any[][]> {
    if (!queries.length) return [];
    const session = this.driver.session({ database: this.database });
    try {
      const results: any[][] = [];
      for (const q of queries) {
        const result = await session.run(q.cypher, this.prepareParams(q.params ?? {}));
        results.push(
          result.records.map((r: any) => {
            const obj: any = {};
            r.keys.forEach((key: string) => {
              obj[key] = this.convertNeo4jValue(r.get(key));
            });
            return obj;
          }),
        );
      }
      return results;
    } finally {
      await session.close();
    }
  }

  private convertNeo4jValue(val: any): any {
    if (val === null || val === undefined) return val;
    // Neo4j Integer → JS number
    if (neo4j.default.isInt(val)) return val.toNumber();
    // Neo4j Node → plain object
    if (val.properties) return { ...val.properties };
    if (Array.isArray(val)) return val.map((v: any) => this.convertNeo4jValue(v));
    return val;
  }

  private prepareParams(params: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, val] of Object.entries(params)) {
      if (typeof val === 'number' && Number.isSafeInteger(val)) {
        result[key] = neo4j.default.int(val);
      } else if (Array.isArray(val)) {
        result[key] = val.map((v) =>
          typeof v === 'number' && Number.isSafeInteger(v) ? neo4j.default.int(v) : v,
        );
      } else {
        result[key] = val;
      }
    }
    return result;
  }

  // ── Bulk Load ──────────────────────────────────────────────────────

  async loadGraph(
    graph: KnowledgeGraph,
    _repoPath: string,
    _storagePath: string,
    onProgress?: ProgressCallback,
  ): Promise<LoadGraphResult> {
    const log = onProgress || (() => {});
    const session = this.driver.session({ database: this.database });
    let insertedRels = 0;
    let skippedRels = 0;

    try {
      // Clear existing data
      log('Clearing existing graph data...');
      await session.run('MATCH (n) DETACH DELETE n');

      // ── Insert nodes by label ──
      const nodesByLabel = new Map<string, any[]>();
      for (const node of graph.nodes) {
        const label = node.label;
        if (!nodesByLabel.has(label)) nodesByLabel.set(label, []);
        nodesByLabel.get(label)!.push(node);
      }

      let step = 0;
      const totalLabels = nodesByLabel.size;
      for (const [label, nodes] of nodesByLabel) {
        step++;
        log(`Loading nodes ${step}/${totalLabels}: ${label} (${nodes.length} rows)`);
        const tn = escapeTableName(label);

        for (let i = 0; i < nodes.length; i += BATCH_SIZE) {
          const batch = nodes.slice(i, i + BATCH_SIZE).map((n) => ({
            ...n.properties,
            id: n.id,
          }));
          await session.run(
            `UNWIND $batch AS props MERGE (n:${tn} {id: props.id}) SET n += props`,
            { batch },
          );
        }
      }

      // ── Insert relationships ──
      log(`Loading edges: ${graph.relationships.length} total`);
      const rels = graph.relationships;
      for (let i = 0; i < rels.length; i += BATCH_SIZE) {
        const batch = rels.slice(i, i + BATCH_SIZE).map((r) => ({
          fromId: r.sourceId,
          toId: r.targetId,
          type: r.type,
          confidence: r.confidence ?? 1.0,
          reason: r.reason ?? '',
          step: r.step ?? 0,
        }));

        try {
          await session.run(
            `UNWIND $batch AS r
             MATCH (a {id: r.fromId}), (b {id: r.toId})
             CREATE (a)-[:${REL_TABLE_NAME} {type: r.type, confidence: r.confidence, reason: r.reason, step: r.step}]->(b)`,
            { batch },
          );
          insertedRels += batch.length;
        } catch {
          skippedRels += batch.length;
        }

        if ((i / BATCH_SIZE) % 10 === 0) {
          log(`Loading edges: ${Math.min(i + BATCH_SIZE, rels.length)}/${rels.length}`);
        }
      }
    } finally {
      await session.close();
    }

    return { success: true, insertedRels, skippedRels, warnings: [] };
  }

  // ── Stats ──────────────────────────────────────────────────────────

  async getStats(): Promise<{ nodes: number; edges: number }> {
    const session = this.driver.session({ database: this.database });
    try {
      const nr = await session.run('MATCH (n) RETURN count(n) AS cnt');
      const er = await session.run(`MATCH ()-[r:${REL_TABLE_NAME}]->() RETURN count(r) AS cnt`);
      return {
        nodes: nr.records[0]?.get('cnt')?.toNumber?.() ?? 0,
        edges: er.records[0]?.get('cnt')?.toNumber?.() ?? 0,
      };
    } finally {
      await session.close();
    }
  }

  // ── Node CRUD ──────────────────────────────────────────────────────

  async insertNode(
    label: string,
    properties: Record<string, any>,
    _dbPath?: string,
  ): Promise<boolean> {
    const session = this.driver.session({ database: this.database });
    try {
      const tn = escapeTableName(label);
      await session.run(`MERGE (n:${tn} {id: $id}) SET n += $props`, {
        id: properties.id,
        props: properties,
      });
      return true;
    } catch {
      return false;
    } finally {
      await session.close();
    }
  }

  async batchInsertNodes(
    nodes: Array<{ label: string; properties: Record<string, any> }>,
    _dbPath: string,
  ): Promise<{ inserted: number; failed: number }> {
    if (!nodes.length) return { inserted: 0, failed: 0 };
    const session = this.driver.session({ database: this.database });
    let inserted = 0,
      failed = 0;
    try {
      // Group by label for efficient UNWIND
      const byLabel = new Map<string, Record<string, any>[]>();
      for (const { label, properties } of nodes) {
        if (!byLabel.has(label)) byLabel.set(label, []);
        byLabel.get(label)!.push(properties);
      }
      for (const [label, batch] of byLabel) {
        try {
          const tn = escapeTableName(label);
          await session.run(
            `UNWIND $batch AS props MERGE (n:${tn} {id: props.id}) SET n += props`,
            { batch },
          );
          inserted += batch.length;
        } catch {
          failed += batch.length;
        }
      }
    } finally {
      await session.close();
    }
    return { inserted, failed };
  }

  async deleteNodesForFile(filePath: string, _dbPath?: string): Promise<{ deletedNodes: number }> {
    const session = this.driver.session({ database: this.database });
    try {
      const result = await session.run(
        'MATCH (n) WHERE n.filePath = $fp DETACH DELETE n RETURN count(n) AS cnt',
        { fp: filePath },
      );
      return { deletedNodes: result.records[0]?.get('cnt')?.toNumber?.() ?? 0 };
    } finally {
      await session.close();
    }
  }

  // ── Embeddings ─────────────────────────────────────────────────────

  async executeWithReusedStatement(cypher: string, paramsList: Array<Record<string, any>>) {
    if (!paramsList.length) return;
    const session = this.driver.session({ database: this.database });
    try {
      for (const params of paramsList) {
        await session.run(cypher, params);
      }
    } finally {
      await session.close();
    }
  }

  async loadCachedEmbeddings() {
    const embeddingNodeIds = new Set<string>();
    const embeddings: Array<{ nodeId: string; embedding: number[] }> = [];
    const session = this.driver.session({ database: this.database });
    try {
      const result = await session.run(
        `MATCH (e:${EMBEDDING_TABLE_NAME}) RETURN e.nodeId AS nodeId, e.embedding AS embedding`,
      );
      for (const record of result.records) {
        const nodeId = record.get('nodeId');
        if (!nodeId) continue;
        embeddingNodeIds.add(nodeId);
        const emb = record.get('embedding');
        if (emb) embeddings.push({ nodeId, embedding: Array.from(emb).map(Number) });
      }
    } catch {
      /* table may not exist */
    } finally {
      await session.close();
    }
    return { embeddingNodeIds, embeddings };
  }

  // ── FTS ────────────────────────────────────────────────────────────

  async createFTSIndex(
    tableName: string,
    indexName: string,
    properties: string[],
    _stemmer?: string,
  ) {
    const session = this.driver.session({ database: this.database });
    try {
      const propList = properties.map((p) => `n.${p}`).join(', ');
      await session.run(
        `CREATE FULLTEXT INDEX ${indexName} IF NOT EXISTS FOR (n:${tableName}) ON EACH [${propList}]`,
      );
    } finally {
      await session.close();
    }
  }

  async queryFTS(
    _tableName: string,
    indexName: string,
    query: string,
    limit = 20,
    _conjunctive = false,
  ) {
    const session = this.driver.session({ database: this.database });
    try {
      const result = await session.run(
        `CALL db.index.fulltext.queryNodes($idx, $q) YIELD node, score
         RETURN node, score ORDER BY score DESC LIMIT $lim`,
        { idx: indexName, q: query, lim: neo4j.default.int(limit) },
      );
      return result.records.map((r: any) => {
        const node = r.get('node').properties;
        return {
          nodeId: node.nodeId || node.id || '',
          name: node.name || '',
          filePath: node.filePath || '',
          score: r.get('score'),
          ...node,
        };
      });
    } catch {
      return [];
    } finally {
      await session.close();
    }
  }

  async dropFTSIndex(_tableName: string, indexName: string) {
    const session = this.driver.session({ database: this.database });
    try {
      await session.run(`DROP INDEX ${indexName} IF EXISTS`);
    } catch {
      /* ignore */
    } finally {
      await session.close();
    }
  }
}

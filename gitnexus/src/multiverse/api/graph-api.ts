/**
 * Graph API — neighborhood-based exploration
 *
 * Core concept: given a set of seed nodes, expand N layers of connections.
 */

import { Router } from 'express';
import { getGraphBackend } from '../../core/graph-backend/index.js';
import {
  buildAvailableGraphSeeds,
  normalizeGraphSeedType,
  pickGraphSeedIds,
} from './graph-seeds.js';

const effectiveRelType = (alias: string): string =>
  `CASE WHEN type(${alias}) = 'CodeRelation' THEN ${alias}.type ELSE type(${alias}) END`;

const GRAPH_CANDIDATE_LABELS = [
  'Route',
  'Listener',
  'Tool',
  'DetectedSink',
  'Class',
  'Interface',
  'Method',
];

const GRAPH_TRAVERSAL_EDGE_TYPES = [
  'CALLS',
  'STEP_IN_PROCESS',
  'HANDLES_ROUTE',
  'HANDLES_TOOL',
  'ENTRY_POINT_OF',
  'TRANSPORTS_TO',
  'SERVES',
  'WRAPS',
  'DETECTED_IN',
  'HAS_METHOD',
  'CONTAINS',
  'DEFINES',
  'BELONGS_TO_GROUP',
  'MEMBER_OF',
  'IMPLEMENTS',
  'EXTENDS',
  'METHOD_IMPLEMENTS',
  'METHOD_OVERRIDES',
  'ACCESSES',
];

const serviceNodeScope = (alias: string): string => `(
  ${alias}.repoId = $serviceId
  OR (
    labels(${alias})[0] = 'Tool'
    AND EXISTS {
      MATCH (f {repoId: $serviceId})-[toolRel]->(${alias})
      WHERE ${effectiveRelType('toolRel')} = 'HANDLES_TOOL'
    }
  )
  OR (
    labels(${alias})[0] = 'Transport'
    AND EXISTS {
      MATCH (owner)-[transportRel]->(${alias})
      WHERE owner.repoId = $serviceId AND ${effectiveRelType('transportRel')} IN ['TRANSPORTS_TO', 'SERVES']
    }
  )
  OR (labels(${alias})[0] = 'BusinessGroup' AND ${alias}.id STARTS WITH $serviceGroupPrefix)
  OR (labels(${alias})[0] = 'ServiceNode' AND ${alias}.id = $serviceId)
)`;

interface SeedCandidateRow {
  id: string;
  label?: string;
  listenerType?: string;
}

interface IdRow {
  id: string;
}

interface GraphNodeRow {
  id: string;
  name?: string;
  label?: string;
  filePath?: string;
  startLine?: number;
  routePath?: string;
  httpMethod?: string;
  resolvedUrl?: string;
  topic?: string;
  listenerType?: string;
  sinkType?: string;
  targetExpression?: string;
  confidence?: number;
  description?: string;
}

const getErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function collectGraphNeighborhood(
  backend: Awaited<ReturnType<typeof getGraphBackend>>,
  params: { serviceId: string; seedIds: string[]; down: number; up: number; limit: number },
) {
  const { serviceId, seedIds, down, up, limit } = params;
  const serviceGroupPrefix = `${serviceId}:`;
  const nodeDepth = new Map<string, number>();
  seedIds.forEach((id) => nodeDepth.set(id, 0));

  if (down > 0) {
    const d1 = await backend.executeQuery(
      `
      MATCH (seed)-[rel]->(t1)
      WHERE seed.id IN $seedIds AND ${serviceNodeScope('t1')}
        AND ${effectiveRelType('rel')} IN $edgeTypes
      RETURN DISTINCT t1.id AS id, 1 AS depth
    `,
      { seedIds, serviceId, serviceGroupPrefix, edgeTypes: GRAPH_TRAVERSAL_EDGE_TYPES },
    );
    for (const row of d1 as IdRow[]) if (!nodeDepth.has(row.id)) nodeDepth.set(row.id, 1);

    if (down >= 2) {
      const d1Ids = (d1 as IdRow[]).map((row) => row.id);
      if (d1Ids.length > 0) {
        const d2 = await backend.executeQuery(
          `
          MATCH (n)-[rel]->(t2)
          WHERE n.id IN $d1Ids AND ${serviceNodeScope('t2')}
            AND ${effectiveRelType('rel')} IN $edgeTypes
          RETURN DISTINCT t2.id AS id, 2 AS depth
        `,
          { d1Ids, serviceId, serviceGroupPrefix, edgeTypes: GRAPH_TRAVERSAL_EDGE_TYPES },
        );
        for (const row of d2 as IdRow[]) if (!nodeDepth.has(row.id)) nodeDepth.set(row.id, 2);
      }
    }
  }

  if (up > 0) {
    const u1 = await backend.executeQuery(
      `
      MATCH (src)-[rel]->(seed)
      WHERE seed.id IN $seedIds AND ${serviceNodeScope('src')}
        AND ${effectiveRelType('rel')} IN $edgeTypes
      RETURN DISTINCT src.id AS id, -1 AS depth
    `,
      { seedIds, serviceId, serviceGroupPrefix, edgeTypes: GRAPH_TRAVERSAL_EDGE_TYPES },
    );
    for (const row of u1 as IdRow[]) if (!nodeDepth.has(row.id)) nodeDepth.set(row.id, -1);

    if (up >= 2) {
      const u1Ids = (u1 as IdRow[]).map((row) => row.id);
      if (u1Ids.length > 0) {
        const u2 = await backend.executeQuery(
          `
          MATCH (src2)-[rel]->(u1)
          WHERE u1.id IN $u1Ids AND ${serviceNodeScope('src2')}
            AND ${effectiveRelType('rel')} IN $edgeTypes
          RETURN DISTINCT src2.id AS id, -2 AS depth
        `,
          { u1Ids, serviceId, serviceGroupPrefix, edgeTypes: GRAPH_TRAVERSAL_EDGE_TYPES },
        );
        for (const row of u2 as IdRow[]) if (!nodeDepth.has(row.id)) nodeDepth.set(row.id, -2);
      }
    }
  }

  const allIds = [...nodeDepth.keys()].slice(0, limit * 2);
  const nodeRows = await backend.executeQuery(
    `
    MATCH (n) WHERE n.id IN $ids
    RETURN n.id AS id,
           coalesce(n.name, n.callSiteMethod, n.targetExpression, n.id) AS name,
           labels(n)[0] AS label,
           n.filePath AS filePath,
           coalesce(n.startLine, n.lineNumber) AS startLine,
           n.routePath AS routePath,
           n.httpMethod AS httpMethod,
           n.resolvedUrl AS resolvedUrl,
           coalesce(n.resolvedTopic, n.topic) AS topic,
           n.listenerType AS listenerType,
           n.sinkType AS sinkType,
           n.targetExpression AS targetExpression,
           n.confidence AS confidence,
           n.description AS description
  `,
    { ids: allIds },
  );

  const nodes = (nodeRows as GraphNodeRow[]).map((node) => ({
    ...node,
    depth: nodeDepth.get(node.id) ?? 0,
  }));
  const nodeIds = nodes.map((node) => node.id);
  const edges =
    nodeIds.length > 0
      ? await backend.executeQuery(
          `
      MATCH (a)-[r]->(b)
      WHERE a.id IN $ids AND b.id IN $ids
        AND ${effectiveRelType('r')} IN $edgeTypes
      RETURN a.id AS source, b.id AS target, ${effectiveRelType('r')} AS type
    `,
          { ids: nodeIds, edgeTypes: GRAPH_TRAVERSAL_EDGE_TYPES },
        )
      : [];

  return { nodes, edges, seeds: seedIds };
}

export const createGraphRouter = (): Router => {
  const router = Router();

  /**
   * GET /api/mv/graph/:serviceId/explore
   * ?seeds=Route,Listener  (default: Route,Listener = entry points)
   * ?focus=nodeId           (single node focus)
   * ?down=2&up=1            (layers to expand)
   *
   * Returns nodes with `depth`: negative=upstream, 0=seed, positive=downstream
   */
  router.get('/:serviceId/explore', async (req, res) => {
    try {
      const { serviceId } = req.params;
      const seedType = normalizeGraphSeedType((req.query.seeds as string) || 'ENTRYPOINT');
      const focusId = req.query.focus as string;
      const down = Math.min(parseInt(req.query.down as string) || 2, 4);
      const up = Math.min(parseInt(req.query.up as string) || 1, 3);
      const limit = parseInt(req.query.limit as string) || 150;
      const backend = await getGraphBackend();
      const serviceGroupPrefix = `${serviceId}:`;

      const seedCounts = await backend.executeQuery(
        `
        MATCH (n)
        WHERE ${serviceNodeScope('n')}
          AND labels(n)[0] IN $labels
          AND NOT coalesce(n.filePath, '') CONTAINS '/test/'
        RETURN labels(n)[0] AS label, n.listenerType AS listenerType, count(*) AS count
      `,
        { serviceId, serviceGroupPrefix, labels: GRAPH_CANDIDATE_LABELS },
      );
      const availableSeeds = buildAvailableGraphSeeds(
        seedCounts as Array<SeedCandidateRow & { count: number }>,
      );

      let seedIds: string[];

      if (focusId) {
        seedIds = [focusId];
      } else {
        const seedCandidates = await backend.executeQuery(
          `
          MATCH (n)
          WHERE ${serviceNodeScope('n')}
            AND labels(n)[0] IN $labels
            AND NOT coalesce(n.filePath, '') CONTAINS '/test/'
          RETURN n.id AS id, labels(n)[0] AS label, n.listenerType AS listenerType
          ORDER BY 
            CASE labels(n)[0]
              WHEN 'Route' THEN 0
              WHEN 'Listener' THEN 1
              WHEN 'Tool' THEN 2
              WHEN 'DetectedSink' THEN 3
              WHEN 'Method' THEN 4
              WHEN 'Class' THEN 5
              WHEN 'Interface' THEN 6
              ELSE 7
            END,
            coalesce(n.httpMethod, n.name, n.callSiteMethod, n.targetExpression, n.id)
          LIMIT toInteger($candidateLimit)
        `,
          {
            serviceId,
            serviceGroupPrefix,
            labels: GRAPH_CANDIDATE_LABELS,
            candidateLimit: Math.min(Math.max(limit * 8, 200), 1000),
          },
        );
        seedIds = pickGraphSeedIds(
          seedCandidates as SeedCandidateRow[],
          seedType,
          Math.min(limit, 60),
        );
      }

      if (seedIds.length === 0) {
        res.json({ nodes: [], edges: [], seeds: [], availableSeeds, focus: focusId || null });
        return;
      }

      const graph = await collectGraphNeighborhood(backend, {
        serviceId,
        seedIds,
        down,
        up,
        limit,
      });
      res.json({ ...graph, availableSeeds, focus: focusId || null });
    } catch (err: unknown) {
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // GET /api/mv/graph/:serviceId/search
  router.get('/:serviceId/search', async (req, res) => {
    try {
      const { serviceId } = req.params;
      const q = ((req.query.q as string) || '').trim();
      if (!q) {
        res.json({ results: [] });
        return;
      }
      const backend = await getGraphBackend();
      const results = await backend.executeQuery(
        `
        MATCH (n)
        WHERE ${serviceNodeScope('n')}
          AND labels(n)[0] IN ['Class','Interface','Method','Function','Route','Listener','Tool','DetectedSink','Enum','Constructor']
          AND (
            coalesce(n.name, '') =~ $pattern
            OR coalesce(n.routePath, '') =~ $pattern
            OR coalesce(n.callSiteMethod, '') =~ $pattern
            OR coalesce(n.targetExpression, '') =~ $pattern
          )
        RETURN n.id AS id,
               coalesce(n.name, n.callSiteMethod, n.targetExpression, n.id) AS name,
               labels(n)[0] AS label,
               n.filePath AS filePath
        ORDER BY
          CASE WHEN coalesce(n.name, n.callSiteMethod, n.targetExpression, '') =~ $exact THEN 0 ELSE 1 END,
          CASE labels(n)[0]
            WHEN 'Route' THEN 0
            WHEN 'Tool' THEN 1
            WHEN 'DetectedSink' THEN 2
            WHEN 'Class' THEN 3
            WHEN 'Interface' THEN 4
            ELSE 5
          END,
          size(coalesce(n.name, n.callSiteMethod, n.targetExpression, n.id)) LIMIT 15
      `,
        {
          serviceId,
          serviceGroupPrefix: `${serviceId}:`,
          pattern: `(?i).*${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*`,
          exact: `(?i)${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        },
      );
      res.json({ results });
    } catch (err: unknown) {
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  // GET /api/mv/graph/:serviceId/node/:nodeId
  router.get('/:serviceId/node/:nodeId', async (req, res) => {
    try {
      const { serviceId, nodeId } = req.params;
      const backend = await getGraphBackend();
      const node = await backend.executeQuery(
        `MATCH (n {id: $nodeId}) RETURN n.id AS id, n.name AS name, labels(n) AS labels, properties(n) AS props`,
        { nodeId },
      );
      const neighbors = await backend.executeQuery(
        `
        MATCH (n {id: $nodeId})-[r]-(m)
        WHERE ${serviceNodeScope('m')}
          AND ${effectiveRelType('r')} IN $edgeTypes
        RETURN m.id AS id, m.name AS name, labels(m)[0] AS label,
               ${effectiveRelType('r')} AS relType,
               CASE WHEN startNode(r) = n THEN true ELSE false END AS outgoing
        LIMIT 100
      `,
        {
          nodeId,
          serviceId,
          serviceGroupPrefix: `${serviceId}:`,
          edgeTypes: GRAPH_TRAVERSAL_EDGE_TYPES,
        },
      );
      const graph = await collectGraphNeighborhood(backend, {
        serviceId,
        seedIds: [nodeId],
        down: 1,
        up: 2,
        limit: 80,
      });

      let relatedEntrypoints: Array<Record<string, unknown>> = [];
      if (node[0]?.labels?.[0] === 'DetectedSink') {
        relatedEntrypoints = await backend.executeQuery(
          `
          MATCH (sink:DetectedSink {id: $nodeId})
          OPTIONAL MATCH (sink)-[:TRANSPORTS_TO]->(t:Transport)<-[:SERVES]-(transportEp)
          OPTIONAL MATCH (sink)-[:DETECTED_IN]->(callSite)
          OPTIONAL MATCH (callSite)-[:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)<-[entryRel]-(processEp)
          WHERE ${effectiveRelType('entryRel')} = 'ENTRY_POINT_OF'
          OPTIONAL MATCH (fileEp)
          WHERE callSite.filePath IS NOT NULL
            AND fileEp.filePath = callSite.filePath
            AND fileEp.repoId = $serviceId
            AND labels(fileEp)[0] IN ['Route', 'Listener', 'Tool']
          WITH collect(DISTINCT transportEp) + collect(DISTINCT processEp) + collect(DISTINCT fileEp) AS eps
          UNWIND eps AS ep
          WITH DISTINCT ep WHERE ep IS NOT NULL
          RETURN ep.id AS id,
                 coalesce(ep.name, ep.routePath, ep.topic, ep.id) AS name,
                 labels(ep)[0] AS label,
                 ep.routePath AS routePath,
                 ep.httpMethod AS httpMethod,
                 coalesce(ep.resolvedTopic, ep.topic) AS topic,
                 ep.listenerType AS listenerType,
                 ep.filePath AS filePath,
                 ep.description AS description
          LIMIT 20
        `,
          { nodeId, serviceId },
        );
      }
      res.json({
        node: node[0] || null,
        neighbors: neighbors.map((n: Record<string, unknown>) => ({
          ...n,
          direction: n.outgoing ? 'outgoing' : 'incoming',
        })),
        graph: { ...graph, focus: nodeId },
        relatedEntrypoints,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: getErrorMessage(err) });
    }
  });

  return router;
};

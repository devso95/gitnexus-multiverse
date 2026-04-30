/**
 * Cross-Service Linker v3 — Gateway + Transport model (batched)
 *
 * Graph model:
 *   Gateway (class that calls external) --TRANSPORTS_TO--> Transport (API/Topic hub) <--SERVES-- Route/Listener
 *
 * v3 changes: all matching done in-memory, writes batched via UNWIND.
 */

import { getGraphBackend } from '../../core/graph-backend/index.js';
import type { GraphBackend } from '../../core/graph-backend/types.js';
import type { ResolvedSink } from './bubble-up.js';
import { mvLog } from '../util/logger.js';

const LOG = 'cross-linker';
const BATCH = 500;

export interface LinkingResult {
  gateways: number;
  transports: number;
  transportsTo: number;
  serves: number;
  unresolved: number;
}

/**
 * Main entry: create Gateway + Transport + edges from resolved sinks.
 */
export const linkCrossService = async (
  repoId: string,
  resolvedSinks: ResolvedSink[],
): Promise<LinkingResult> => {
  const backend = await getGraphBackend();
  const result: LinkingResult = {
    gateways: 0,
    transports: 0,
    transportsTo: 0,
    serves: 0,
    unresolved: 0,
  };

  await cleanOldData(backend, repoId);

  result.gateways = await createGateways(backend, repoId, resolvedSinks);

  // Step 2: Batch create Transport nodes + TRANSPORTS_TO edges
  const { created, unresolved } = await batchCreateTransports(backend, repoId, resolvedSinks);
  result.transports = created;
  result.transportsTo = created;
  result.unresolved = unresolved;

  // Step 3+4: Auto-match SERVES edges (both directions)
  result.serves = await batchMatchServes(backend, repoId);

  return result;
};

// ── Step 1: Gateway nodes (already batched) ──

async function createGateways(
  backend: GraphBackend,
  repoId: string,
  sinks: ResolvedSink[],
): Promise<number> {
  const classFiles = new Set<string>();
  for (const s of sinks) {
    if (s.filePath) classFiles.add(s.filePath);
  }
  if (!classFiles.size) return 0;

  const filePaths = [...classFiles];
  let count = 0;

  for (let i = 0; i < filePaths.length; i += BATCH) {
    const batch = filePaths.slice(i, i + BATCH);
    const rows = (await backend
      .executeQuery(
        `
      MATCH (c:Class {repoId: $repoId})
      WHERE c.filePath IN $files
      RETURN c.id AS id, c.name AS name, c.filePath AS filePath
    `,
        { repoId, files: batch },
      )
      .catch(() => [])) as Array<{ id: string; name: string; filePath: string }>;

    if (rows.length) {
      const gatewayBatch = rows.map((r) => ({
        id: `gw:${repoId}:${r.id}`,
        classNodeId: r.id,
        name: r.name,
        filePath: r.filePath,
        repoId,
      }));
      await backend.executeQuery(
        `
        UNWIND $batch AS props
        MERGE (g:Gateway {id: props.id})
        SET g.name = props.name, g.filePath = props.filePath,
            g.repoId = props.repoId, g.classNodeId = props.classNodeId
      `,
        { batch: gatewayBatch },
      );
      await backend.executeQuery(
        `
        UNWIND $batch AS props
        MATCH (g:Gateway {id: props.id}), (c:Class {id: props.classNodeId})
        MERGE (g)-[:WRAPS]->(c)
      `,
        { batch: gatewayBatch },
      );
      count += rows.length;
    }
  }

  return count;
}

// ── Step 2: Batch Transport creation ──

interface TransportData {
  id: string;
  type: string;
  name: string;
  path?: string;
  fullUrl?: string;
  topic?: string;
  sinkId?: string;
  sourceId?: string;
  confidence: number;
  resolvedVia: string;
  sinkType: string;
}

async function batchCreateTransports(
  backend: GraphBackend,
  repoId: string,
  sinks: ResolvedSink[],
): Promise<{ created: number; unresolved: number }> {
  const transports: TransportData[] = [];
  let unresolved = 0;

  for (const sink of sinks) {
    if (!sink.resolvedValue) {
      unresolved++;
      continue;
    }
    const value = sink.resolvedValue;
    const type = sink.sinkType;

    if (type === 'http') {
      let path = value;
      try {
        const parsed = new URL(value.startsWith('http') ? value : `http://dummy${value}`);
        path = parsed.pathname;
      } catch {
        /* use as-is */
      }
      path = path.replace(/\/$/, '').toLowerCase();
      if (!path || path === '/') {
        unresolved++;
        continue;
      }

      transports.push({
        id: `transport:api:${path}`,
        type: 'api',
        name: path,
        path,
        fullUrl: value,
        sinkId: sink.id,
        sourceId: sink.callSiteNodeId || undefined,
        confidence: sink.confidence,
        resolvedVia: sink.resolvedVia,
        sinkType: type,
      });
    } else {
      const topic = value.replace(/^["']|["']$/g, '').replace(/^(activemq|jms):\/\//, '');
      if (!topic) {
        unresolved++;
        continue;
      }

      transports.push({
        id: `transport:${type}:${topic}`,
        type,
        name: topic,
        topic,
        sinkId: sink.id,
        sourceId: sink.callSiteNodeId || undefined,
        confidence: sink.confidence,
        resolvedVia: sink.resolvedVia,
        sinkType: type,
      });
    }
  }

  if (!transports.length) return { created: 0, unresolved };

  // Batch MERGE Transport nodes
  for (let i = 0; i < transports.length; i += BATCH) {
    const batch = transports.slice(i, i + BATCH).map((t) => ({
      id: t.id,
      type: t.type,
      name: t.name,
      path: t.path || null,
      fullUrl: t.fullUrl || null,
      topic: t.topic || null,
    }));
    await backend
      .executeQuery(
        `
      UNWIND $batch AS b
      MERGE (t:Transport {id: b.id})
      SET t.type = b.type, t.name = b.name,
          t.path = CASE WHEN b.path IS NOT NULL THEN b.path ELSE t.path END,
          t.fullUrl = CASE WHEN b.fullUrl IS NOT NULL THEN b.fullUrl ELSE t.fullUrl END,
          t.topic = CASE WHEN b.topic IS NOT NULL THEN b.topic ELSE t.topic END
    `,
        { batch },
      )
      .catch((err: unknown) => mvLog.warn(LOG, 'Batch transport MERGE failed', err));
  }

  // Batch MERGE TRANSPORTS_TO edges
  const seenEdges = new Set<string>();
  const edges = transports
    .flatMap((transport) =>
      [transport.sourceId, transport.sinkId].filter(Boolean).map((sourceId) => ({
        sourceId,
        transportId: transport.id,
        confidence: transport.confidence,
        resolvedVia: transport.resolvedVia,
        repoId,
        sinkType: transport.sinkType,
      })),
    )
    .filter((edge) => {
      const key = `${edge.sourceId}->${edge.transportId}`;
      if (seenEdges.has(key)) return false;
      seenEdges.add(key);
      return true;
    });

  for (let i = 0; i < edges.length; i += BATCH) {
    const batch = edges.slice(i, i + BATCH);
    await backend
      .executeQuery(
        `
      UNWIND $batch AS b
      MATCH (m {id: b.sourceId}), (t:Transport {id: b.transportId})
      MERGE (m)-[r:TRANSPORTS_TO]->(t)
      SET r.confidence = b.confidence, r.resolvedVia = b.resolvedVia,
          r.sourceRepoId = b.repoId, r.sinkType = b.sinkType
    `,
        { batch },
      )
      .catch((err: unknown) => mvLog.warn(LOG, 'Batch TRANSPORTS_TO failed', err));
  }

  return { created: transports.length, unresolved };
}

// ── Step 3+4: Batch SERVES matching ──

/** Check if `short` is a prefix of `long` at a separator boundary (dot, hyphen, underscore) */
function isTopicPrefixMatch(short: string, long: string): boolean {
  if (short.length >= long.length) return false;
  if (!long.startsWith(short)) return false;
  const nextChar = long[short.length];
  return nextChar === '.' || nextChar === '-' || nextChar === '_';
}

/** Build tail segments for fuzzy path matching */
function buildTails(path: string, minLen: number = 8): string[] {
  const segs = path
    .toLowerCase()
    .split('/')
    .filter((s) => s && !s.startsWith('{'));
  const tails: string[] = [];
  for (let i = segs.length - 1; i >= 0; i--) {
    const tail = segs.slice(i).join('/');
    if (tail.length >= minLen) tails.push(tail);
  }
  // Also add version-stripped tails: /v1/orders → /orders, /v2/orders → /orders
  const stripped = segs.filter((s) => !/^v\d+$/.test(s));
  if (stripped.length < segs.length && stripped.length > 0) {
    for (let i = stripped.length - 1; i >= 0; i--) {
      const tail = stripped.slice(i).join('/');
      if (tail.length >= minLen && !tails.includes(tail)) tails.push(tail);
    }
  }
  return tails;
}

/**
 * Match all Routes/Listeners ↔ Transports in-memory, then batch write SERVES edges.
 * Replaces the old O(n×m) per-query approach.
 */
async function batchMatchServes(backend: GraphBackend, repoId: string): Promise<number> {
  // Fetch all data in 4 parallel queries
  const [allTransportsApi, allTransportsMsg, allRoutes, allListeners] = (await Promise.all([
    backend
      .executeQuery(
        `
      MATCH (t:Transport {type: 'api'}) RETURN t.id AS id, t.path AS path
    `,
      )
      .catch(() => []),
    backend
      .executeQuery(
        `
      MATCH (t:Transport) WHERE t.type IN ['kafka','rabbit','redis','activemq']
      RETURN t.id AS id, t.topic AS topic, t.type AS type
    `,
      )
      .catch(() => []),
    backend
      .executeQuery(
        `
      MATCH (r:Route) WHERE r.routePath IS NOT NULL AND r.routePath <> ''
      RETURN r.id AS id, r.routePath AS path, r.repoId AS repoId
    `,
      )
      .catch(() => []),
    backend
      .executeQuery(
        `
      MATCH (l:Listener) WHERE l.topic IS NOT NULL
      RETURN l.id AS id, l.topic AS topic, l.resolvedTopic AS resolvedTopic, l.repoId AS repoId
    `,
      )
      .catch(() => []),
  ])) as [
    Array<{ id: string; path: string }>,
    Array<{ id: string; topic: string; type: string }>,
    Array<{ id: string; path: string; repoId: string }>,
    Array<{ id: string; topic: string; resolvedTopic: string; repoId: string }>,
  ];

  const matches: { fromId: string; toId: string }[] = [];

  // ── API matching: Route ↔ Transport by tail segments ──
  if (allTransportsApi.length && allRoutes.length) {
    // Build tail index from routes: tail → routeId (best = longest tail)
    const tailToRoute = new Map<string, { id: string; len: number }>();
    for (const r of allRoutes) {
      const tails = buildTails(r.path || '');
      for (const tail of tails) {
        const existing = tailToRoute.get(tail);
        if (!existing || tail.length > existing.len) {
          tailToRoute.set(tail, { id: r.id, len: tail.length });
        }
      }
    }

    for (const t of allTransportsApi) {
      const tTails = buildTails(t.path || '');
      let bestRoute: string | null = null;
      let bestScore = 0;
      for (const tail of tTails) {
        const match = tailToRoute.get(tail);
        if (match && match.len > bestScore) {
          bestScore = match.len;
          bestRoute = match.id;
        }
      }
      // Prefix match: transport tail matches start of route path (SOAP: /FOService matches /FOService/sendMessage)
      if (!bestRoute) {
        for (const tail of tTails) {
          if (tail.length < 3) continue;
          for (const r of allRoutes) {
            const rp = (r.path || '').toLowerCase();
            if (rp.startsWith('/' + tail + '/') || rp.startsWith(tail + '/') || rp === '/' + tail) {
              if (tail.length > bestScore) {
                bestScore = tail.length;
                bestRoute = r.id;
              }
            }
          }
        }
      }
      if (bestRoute) {
        matches.push({ fromId: bestRoute, toId: t.id });
      }
    }
  }

  // ── Kafka/Rabbit/Redis matching: Listener ↔ Transport by topic ──
  if (allTransportsMsg.length && allListeners.length) {
    // Build topic index from listeners
    const topicToListeners = new Map<string, string[]>();
    for (const l of allListeners) {
      const topic = ((l.resolvedTopic || l.topic || '') as string).toLowerCase();
      if (!topic || topic.includes('${')) continue;
      if (!topicToListeners.has(topic)) topicToListeners.set(topic, []);
      topicToListeners.get(topic)!.push(l.id);
    }

    for (const t of allTransportsMsg) {
      const tTopic = (t.topic || '').toLowerCase();
      if (!tTopic) continue;

      // Exact match first
      const exact = topicToListeners.get(tTopic);
      if (exact) {
        for (const lid of exact) matches.push({ fromId: lid, toId: t.id });
        continue;
      }
      // Prefix match with dot/hyphen separator (e.g. "order" matches "order.created" but not "reorder")
      for (const [lTopic, lIds] of topicToListeners) {
        if (isTopicPrefixMatch(tTopic, lTopic) || isTopicPrefixMatch(lTopic, tTopic)) {
          for (const lid of lIds) matches.push({ fromId: lid, toId: t.id });
        }
      }
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  const unique = matches.filter((m) => {
    const key = `${m.fromId}→${m.toId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Batch write all SERVES edges
  for (let i = 0; i < unique.length; i += BATCH) {
    const batch = unique.slice(i, i + BATCH);
    await backend
      .executeQuery(
        `
      UNWIND $batch AS b
      MATCH (a {id: b.fromId}), (t:Transport {id: b.toId})
      MERGE (a)-[:SERVES]->(t)
    `,
        { batch },
      )
      .catch((err: unknown) => mvLog.warn(LOG, 'Batch SERVES write failed', err));
  }

  return unique.length;
}

// ── Cleanup ──

async function cleanOldData(backend: GraphBackend, repoId: string) {
  // Combine cleanup into fewer queries
  await backend
    .executeQuery(
      `
    MATCH ()-[r:TRANSPORTS_TO]->() WHERE r.sourceRepoId = $repoId DELETE r
  `,
      { repoId },
    )
    .catch((err) => mvLog.warn(LOG, 'Cleanup TRANSPORTS_TO failed', err));
  await backend
    .executeQuery(
      `
    MATCH (n {repoId: $repoId})-[r:SERVES]->() DELETE r
  `,
      { repoId },
    )
    .catch((err) => mvLog.warn(LOG, 'Cleanup SERVES failed', err));
  await backend
    .executeQuery(
      `
    MATCH (g:Gateway {repoId: $repoId}) DETACH DELETE g
  `,
      { repoId },
    )
    .catch((err) => mvLog.warn(LOG, 'Cleanup Gateway failed', err));
}

/** Cleanup orphaned Transport nodes (no TRANSPORTS_TO and no SERVES) */
export const cleanupOrphans = async (): Promise<{ removed: number }> => {
  const backend = await getGraphBackend();
  try {
    const r = await backend.executeQuery(`
      MATCH (t:Transport)
      WHERE NOT ()-[:TRANSPORTS_TO]->(t) AND NOT ()-[:SERVES]->(t)
      WITH collect(t) AS orphans
      UNWIND orphans AS t
      DETACH DELETE t
      RETURN size(orphans) AS cnt
    `);
    return { removed: r[0]?.cnt ?? 0 };
  } catch {
    return { removed: 0 };
  }
};

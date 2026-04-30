/**
 * Explore MCP Tool Handler — unified graph exploration
 *
 * Actions: neighbors, overview, symbol, implementations, groups, channels
 * Delegates to internal handlers in tool-handlers.ts
 */

import { getGraphBackend } from '../../core/graph-backend/index.js';
import { getEntrypointDisplayKind } from '../engine/entrypoint-kind.js';
import { sanitizeLabels } from './query-handler.js';

// ── Allowed edge types for filter (whitelist) ──

const ALLOWED_EDGE_TYPES = new Set([
  'CALLS',
  'STEP_IN_PROCESS',
  'METHOD_IMPLEMENTS',
  'METHOD_OVERRIDES',
  'DEFINES',
  'HAS_METHOD',
  'HAS_PROPERTY',
  'IMPORTS',
  'CONTAINS',
  'ACCESSES',
  'HANDLES_ROUTE',
  'HANDLES_TOOL',
  'MEMBER_OF',
  'EXTENDS',
  'IMPLEMENTS',
  'ENTRY_POINT_OF',
  'TRANSPORTS_TO',
  'SERVES',
  'DEPENDS_ON',
  'USES',
  'WRAPS',
]);

/** Sanitize comma-separated edge type string → validated array */
function sanitizeEdgeTypes(input: string | undefined): string[] | null {
  if (!input) return null;
  return input
    .split(',')
    .map((t: string) => t.trim())
    .filter((t) => ALLOWED_EDGE_TYPES.has(t));
}

export async function handleExplore(params: Record<string, unknown>): Promise<unknown> {
  const { action } = params;
  switch (action) {
    case 'neighbors':
      return exploreNeighbors(params);
    case 'overview':
      return exploreOverview(params);
    case 'symbol':
      return exploreSymbol(params);
    case 'implementations':
      return exploreImplementations(params);
    case 'groups':
      // Delegate to business-group handler
      const { handleMultiverseTool } = await import('./tool-handlers.js');
      return handleMultiverseTool('business-group', params);
    case 'channels':
      const tool = await import('./tool-handlers.js');
      return tool.handleMultiverseTool('channels', params);
    default:
      return {
        error: `Unknown action: ${action}. Use: neighbors, overview, symbol, implementations, groups, channels`,
      };
  }
}

// ── neighbors — with parameterized filters (FIX: no string interpolation) ──

async function exploreNeighbors(params: Record<string, unknown>) {
  const service = params.service as string;
  const nodeId = params.nodeId as string | undefined;
  const name = params.name as string | undefined;
  const file = params.file as string | undefined;
  const direction = (params.direction as string) || 'out';
  const edgeTypes = params.edgeTypes as string | undefined;
  const nodeLabels = params.nodeLabels as string | undefined;
  if (!service) return { error: 'Required: service' };

  const backend = await getGraphBackend();

  // Resolve node ID
  let resolvedId = nodeId;
  if (!resolvedId && name) {
    const searchQuery = file
      ? `MATCH (n {repoId: $service}) WHERE n.name = $name AND n.filePath CONTAINS $file RETURN n.id AS id LIMIT 1`
      : `MATCH (n {repoId: $service}) WHERE n.name = $name RETURN n.id AS id LIMIT 3`;
    const searchParams: Record<string, unknown> = { service, name };
    if (file) searchParams.file = file;
    const rows = (await backend.executeQuery(searchQuery, searchParams).catch(() => [])) as Array<{
      id: string;
    }>;
    if (!rows.length)
      return { error: `Node not found: name=${name}${file ? ` file=${file}` : ''}` };
    resolvedId = rows[0].id;
  }
  if (!resolvedId) return { error: 'Required: nodeId or name' };

  // Get node info
  const nodeInfo = (await backend
    .executeQuery(
      `MATCH (n {id: $id}) RETURN n.id AS id, n.name AS name, labels(n)[0] AS label, n.filePath AS file, n.startLine AS line`,
      { id: resolvedId },
    )
    .catch(() => [])) as Array<Record<string, unknown>>;

  // Build direction pattern
  let matchPattern: string;
  if (direction === 'in') matchPattern = `(m)-[r]->(n {id: $id})`;
  else if (direction === 'both') matchPattern = `(n {id: $id})-[r]-(m)`;
  else matchPattern = `(n {id: $id})-[r]->(m)`;

  // Build filters — PARAMETERIZED to prevent injection
  const filters: string[] = [];
  const queryParams: Record<string, unknown> = { id: resolvedId };

  if (edgeTypes) {
    const types = sanitizeEdgeTypes(edgeTypes);
    if (types && types.length) {
      filters.push(
        `(CASE WHEN type(r) = 'CodeRelation' THEN r.type ELSE type(r) END) IN $edgeTypeFilter`,
      );
      queryParams.edgeTypeFilter = types;
    }
  }
  if (nodeLabels) {
    const labels = sanitizeLabels(nodeLabels, []);
    if (labels.length) {
      filters.push(`labels(m)[0] IN $nodeLabelFilter`);
      queryParams.nodeLabelFilter = labels;
    }
  }
  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const neighbors = (await backend
    .executeQuery(
      `MATCH ${matchPattern}
     ${whereClause}
     RETURN m.id AS id, m.name AS name, labels(m)[0] AS label, m.filePath AS file, m.startLine AS line,
            CASE WHEN type(r) = 'CodeRelation' THEN r.type ELSE type(r) END AS edgeType,
            r.confidence AS confidence,
            CASE WHEN startNode(r) = n THEN 'out' ELSE 'in' END AS dir
     LIMIT 50`,
      queryParams,
    )
    .catch(() => [])) as Array<Record<string, unknown>>;

  return {
    node: nodeInfo[0] || { id: resolvedId },
    neighbors,
    total: neighbors.length,
  };
}

// ── overview ──

async function exploreOverview(params: Record<string, unknown>) {
  const service = params.service as string;
  if (!service) return { error: 'Required: service' };

  const backend = await getGraphBackend();

  const nodeCounts = (await backend
    .executeQuery(
      `MATCH (n {repoId: $service}) RETURN labels(n)[0] AS label, count(*) AS count ORDER BY count DESC`,
      { service },
    )
    .catch(() => [])) as Array<{ label: string; count: number }>;

  const edgeCounts = (await backend
    .executeQuery(
      `MATCH (a {repoId: $service})-[r:CodeRelation]->(b {repoId: $service})
     RETURN r.type AS type, count(*) AS count ORDER BY count DESC LIMIT 15`,
      { service },
    )
    .catch(() => [])) as Array<{ type: string; count: number }>;

  const keyClasses = (await backend
    .executeQuery(
      `MATCH (c:Class {repoId: $service})-[r]-()
     WITH c, count(r) AS connections
     RETURN c.name AS name, c.filePath AS file, connections
     ORDER BY connections DESC LIMIT 10`,
      { service },
    )
    .catch(() => [])) as Array<{ name: string; file: string; connections: number }>;

  const entryPoints = (await backend
    .executeQuery(
      `MATCH (n)
     WHERE (n.repoId = $service AND labels(n)[0] IN ['Route', 'Listener'])
        OR (
          labels(n)[0] = 'Tool'
          AND EXISTS {
            MATCH (f {repoId: $service})-[rel]->(n)
            WHERE CASE WHEN type(rel) = 'CodeRelation' THEN rel.type ELSE type(rel) END = 'HANDLES_TOOL'
          }
        )
     RETURN labels(n)[0] AS label, n.listenerType AS listenerType`,
      { service },
    )
    .catch(() => [])) as Array<{ label: string; listenerType?: string }>;

  const entryPointCounts = new Map<string, number>();
  for (const row of entryPoints) {
    const kind = getEntrypointDisplayKind({
      label: row.label,
      listenerType: row.listenerType,
    });
    entryPointCounts.set(kind, (entryPointCounts.get(kind) || 0) + 1);
  }

  const crossService = (await backend
    .executeQuery(
      `MATCH (m {repoId: $service})-[:TRANSPORTS_TO]->(t:Transport)
     WHERE labels(m)[0] <> 'DetectedSink'
     OPTIONAL MATCH (entry)-[:SERVES]->(t) WHERE entry.repoId <> $service
     RETURN t.type AS type, count(DISTINCT t) AS channels, collect(DISTINCT entry.repoId) AS targets`,
      { service },
    )
    .catch(() => [])) as Array<{ type: string; channels: number; targets: string[] }>;

  const totalNodes = nodeCounts.reduce((s, r) => s + Number(r.count), 0);
  const totalEdges = edgeCounts.reduce((s, r) => s + Number(r.count), 0);

  return {
    service,
    summary: { totalNodes, totalEdges },
    nodesByType: nodeCounts,
    edgesByType: edgeCounts,
    keyClasses,
    entryPoints: [...entryPointCounts.entries()].map(([type, count]) => ({ type, count })),
    crossServiceConnections: crossService.filter((c) => c.type),
  };
}

// ── symbol — 360° view ──

async function exploreSymbol(params: Record<string, unknown>) {
  const service = params.service as string;
  const name = params.name as string | undefined;
  const file = params.file as string | undefined;
  const nodeId = params.nodeId as string | undefined;
  if (!service) return { error: 'Required: service' };

  const backend = await getGraphBackend();

  let resolvedId = nodeId;
  if (!resolvedId && name) {
    const q = file
      ? `MATCH (n {repoId: $service}) WHERE n.name = $name AND n.filePath CONTAINS $file RETURN n.id AS id, labels(n)[0] AS label LIMIT 3`
      : `MATCH (n {repoId: $service}) WHERE n.name = $name AND labels(n)[0] IN ['Method','Class','Interface','Function'] RETURN n.id AS id, labels(n)[0] AS label LIMIT 3`;
    const qp: Record<string, unknown> = { service, name };
    if (file) qp.file = file;
    const candidates = (await backend.executeQuery(q, qp).catch(() => [])) as Array<{
      id: string;
      label: string;
    }>;
    if (!candidates.length) return { error: `Symbol not found: ${name}` };
    if (candidates.length > 1)
      return { candidates, hint: 'Multiple matches — provide file or nodeId to disambiguate' };
    resolvedId = candidates[0].id;
  }
  if (!resolvedId) return { error: 'Required: name or nodeId' };

  const nodeInfo = (await backend
    .executeQuery(
      `MATCH (n {id: $id}) RETURN n.id AS id, n.name AS name, labels(n)[0] AS label, n.filePath AS file, n.startLine AS line`,
      { id: resolvedId },
    )
    .catch(() => [])) as Array<Record<string, unknown>>;

  const incoming = (await backend
    .executeQuery(
      `MATCH (caller)-[r:CodeRelation {type: 'CALLS'}]->(n {id: $id})
     RETURN caller.name AS name, labels(caller)[0] AS label, caller.filePath AS file,
            r.type AS edgeType, caller.repoId AS service
     LIMIT 30`,
      { id: resolvedId },
    )
    .catch(() => [])) as Array<Record<string, unknown>>;

  const outgoing = (await backend
    .executeQuery(
      `MATCH (n {id: $id})-[r:CodeRelation]->(target)
     WHERE r.type IN ['CALLS', 'STEP_IN_PROCESS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'ACCESSES', 'METHOD_IMPLEMENTS']
     RETURN target.name AS name, labels(target)[0] AS label, target.filePath AS file,
            r.type AS edgeType, target.repoId AS service
     LIMIT 30`,
      { id: resolvedId },
    )
    .catch(() => [])) as Array<Record<string, unknown>>;

  const membership = (await backend
    .executeQuery(
      `MATCH (cls)-[:CodeRelation {type: 'HAS_METHOD'}]->(n {id: $id})
     RETURN cls.name AS className, cls.filePath AS file, labels(cls)[0] AS label`,
      { id: resolvedId },
    )
    .catch(() => [])) as Array<Record<string, unknown>>;

  const processes = (await backend
    .executeQuery(
      `MATCH (n {id: $id})-[:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
     RETURN DISTINCT p.name AS name, p.heuristicLabel AS label`,
      { id: resolvedId },
    )
    .catch(() => [])) as Array<{ name: string; label: string }>;

  const crossService = (await backend
    .executeQuery(
      `MATCH (n {id: $id})-[:TRANSPORTS_TO]->(t:Transport)
     OPTIONAL MATCH (entry)-[:SERVES]->(t) WHERE entry.repoId <> $service
     RETURN t.name AS transport, t.type AS type, entry.repoId AS targetService, entry.name AS targetName`,
      { id: resolvedId, service },
    )
    .catch(() => [])) as Array<{
    transport: string;
    type: string;
    targetService?: string;
    targetName?: string;
  }>;

  return {
    symbol: nodeInfo[0] || { id: resolvedId },
    belongsTo: membership[0] || null,
    incoming: incoming.map((r) => ({ ...r, direction: 'incoming' })),
    outgoing: outgoing.map((r) => ({ ...r, direction: 'outgoing' })),
    processes,
    crossServiceCalls: crossService.filter((c) => c.transport),
    summary: {
      incomingCount: incoming.length,
      outgoingCount: outgoing.length,
      processCount: processes.length,
      crossServiceCount: crossService.filter((c) => c.transport).length,
    },
  };
}

// ── implementations ──

async function exploreImplementations(params: Record<string, unknown>) {
  const service = params.service as string | undefined;
  const ifaceName = params.interface as string | undefined;
  const name = params.name as string | undefined;
  const nodeId = params.nodeId as string | undefined;
  const target = ifaceName || name;
  if (!target && !nodeId) return { error: 'Required: interface (or name or nodeId)' };

  const backend = await getGraphBackend();

  let ifaceId = nodeId;
  if (!ifaceId && target) {
    const serviceFilter = service ? `AND n.repoId = $service` : '';
    const q = `MATCH (n) WHERE n.name = $target AND labels(n)[0] IN ['Interface','Class'] ${serviceFilter}
               RETURN n.id AS id, n.name AS name, labels(n)[0] AS label, n.repoId AS service LIMIT 5`;
    const candidates = (await backend
      .executeQuery(q, { target, ...(service ? { service } : {}) })
      .catch(() => [])) as Array<{ id: string }>;
    if (!candidates.length) return { error: `Interface not found: ${target}` };
    if (candidates.length > 1 && !service)
      return { candidates, hint: 'Multiple matches — provide service to disambiguate' };
    ifaceId = candidates[0].id;
  }

  const classImpls = (await backend
    .executeQuery(
      `MATCH (impl)-[:CodeRelation {type: 'IMPLEMENTS'}]->(iface {id: $id})
     RETURN impl.id AS id, impl.name AS name, labels(impl)[0] AS label, impl.filePath AS file, impl.repoId AS service`,
      { id: ifaceId },
    )
    .catch(() => [])) as Array<Record<string, unknown>>;

  const methodImpls = (await backend
    .executeQuery(
      `MATCH (iface {id: $id})-[:CodeRelation {type: 'HAS_METHOD'}]->(ifaceMethod)
     MATCH (implMethod)-[:CodeRelation {type: 'METHOD_IMPLEMENTS'}]->(ifaceMethod)
     RETURN implMethod.id AS id, implMethod.name AS methodName, labels(implMethod)[0] AS label,
            implMethod.filePath AS file, implMethod.repoId AS service,
            ifaceMethod.name AS interfaceMethod`,
      { id: ifaceId },
    )
    .catch(() => [])) as Array<Record<string, unknown>>;

  const extenders = (await backend
    .executeQuery(
      `MATCH (child)-[:CodeRelation {type: 'EXTENDS'}]->(parent {id: $id})
     RETURN child.id AS id, child.name AS name, labels(child)[0] AS label, child.filePath AS file, child.repoId AS service`,
      { id: ifaceId },
    )
    .catch(() => [])) as Array<Record<string, unknown>>;

  return {
    interface: { id: ifaceId, name: target },
    implementations: classImpls,
    methodImplementations: methodImpls,
    extenders,
    summary: {
      classes: classImpls.length,
      methods: methodImpls.length,
      extenders: extenders.length,
    },
  };
}

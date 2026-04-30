/**
 * Multiverse MCP Tool Handlers — v3.0
 *
 * Router: 9 consolidated MCP tools → modular handlers
 * Internal: legacy handlers for backward-compatible REST API
 */

import { getGraphBackend } from '../../core/graph-backend/index.js';
import { groupEntrypoints } from '../engine/business-grouper.js';
import { getEntrypointDisplayKind } from '../engine/entrypoint-kind.js';
import { resolveClassBasePath } from '../engine/route-fixer.js';
import { handleSinks } from './sinks-handler.js';
import { handleServices } from './services-handler.js';
import { handleExplore } from './explore-handler.js';
import { handleTrace } from './trace-handler.js';
import { handlePatterns } from './patterns-handler.js';
import { handleSource } from './source-handler.js';
import { handleConfig } from './config-handler.js';
import { handleCypher, handleSearch } from './query-handler.js';

export const handleMultiverseTool = async (
  toolName: string,
  params: Record<string, any>,
): Promise<any> => {
  switch (toolName) {
    // ── New consolidated tools (MCP-exposed) ──
    case 'query':
      return handleCypher(params);
    case 'search':
      return handleSearch(params);
    case 'services':
      return handleServices(params);
    case 'explore':
      return handleExplore(params);
    case 'trace':
      return handleTrace(params);
    case 'patterns':
      return handlePatterns(params);
    case 'sinks':
      return handleSinks(params);
    case 'source':
      return handleSource(params);
    case 'config':
      return handleConfig(params);

    // ── Internal handlers (delegated from consolidated tools) ──
    case 'service-map':
      return handleServiceMap(params);
    case 'trace-flow':
      return handleTraceFlow(params);
    case 'who-calls-me':
      return handleWhoCallsMe(params);
    case 'what-do-i-call':
      return handleWhatDoICall(params);
    case 'business-group':
      return handleBusinessGroup(params);
    case 'channels':
      return handleChannels(params);
    case 'config-lookup':
      return handleConfigLookup(params);
    case 'manage-pattern':
      return handleManagePattern(params);
    case 'manage-rule':
      return handleManageRule(params);
    case 'node-neighbors':
      return handleNodeNeighbors(params);
    case 'graph-overview':
      return handleGraphOverview(params);
    case 'cypher':
      return handleCypher(params);
    case 'symbol-context':
      return handleSymbolContext(params);
    case 'impact':
      return handleImpact(params);
    case 'find-implementations':
      return handleFindImplementations(params);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
};

// ── service-map ──

async function handleServiceMap(params: Record<string, any>) {
  const backend = await getGraphBackend();

  const services = await backend
    .executeQuery(
      `MATCH (s:ServiceNode) RETURN s.id AS id, s.name AS name, s.type AS type, s.repoProject AS project, s.entryPointCount AS entryPoints`,
    )
    .catch(() => []);

  // Cross-service links via Transport hub nodes
  const transportEdges = await backend
    .executeQuery(
      `
    MATCH (m)-[tt:TRANSPORTS_TO]->(t:Transport)<-[:SERVES]-(entry)
    WHERE m.repoId <> entry.repoId AND labels(m)[0] <> 'DetectedSink'
    RETURN m.repoId AS from, entry.repoId AS to, t.type AS type, t.name AS via,
           tt.confidence AS confidence
  `,
    )
    .catch(() => []);

  // Library deps
  const libEdges = await backend
    .executeQuery(
      `
    MATCH (a:ServiceNode)-[:DEPENDS_ON]->(b:ServiceNode)
    RETURN a.id AS from, b.id AS to
  `,
    )
    .catch(() => []);

  // Unmatched transports (outgoing, no SERVES yet)
  const unmatchedTransports = await backend
    .executeQuery(
      `
    MATCH (m)-[tt:TRANSPORTS_TO]->(t:Transport)
    WHERE labels(m)[0] <> 'DetectedSink' AND NOT ()-[:SERVES]->(t)
    RETURN DISTINCT m.repoId AS from, t.name AS via, t.type AS type
  `,
    )
    .catch(() => []);

  // Aggregate edges by from→to:type, collect via[]
  const edgeMap = new Map<
    string,
    { from: string; to: string; type: string; count: number; confidence: number; via: string[] }
  >();
  for (const e of transportEdges) {
    if (!e.from || !e.to) continue;
    const key = `${e.from}→${e.to}:${e.type}`;
    const ex = edgeMap.get(key);
    if (ex) {
      ex.count++;
      ex.via.push(e.via);
    } else
      edgeMap.set(key, {
        from: e.from,
        to: e.to,
        type: e.type || 'api',
        count: 1,
        confidence: e.confidence || 0.85,
        via: [e.via],
      });
  }
  for (const e of libEdges) {
    if (!e.from || !e.to) continue;
    edgeMap.set(`${e.from}→${e.to}:lib`, {
      from: e.from,
      to: e.to,
      type: 'lib',
      count: 1,
      confidence: 1,
      via: [],
    });
  }

  let nodes = services;
  if (params.project) nodes = services.filter((s: any) => s.project === params.project);

  return {
    nodes: nodes.map((s: any) => ({
      id: s.id,
      name: s.name,
      type: s.type,
      project: s.project,
      entryPoints: s.entryPoints ?? 0,
    })),
    edges: [...edgeMap.values()].map((e) => ({ ...e, via: [...new Set(e.via)].slice(0, 10) })),
    unmatchedTransports: unmatchedTransports.map((t: any) => ({
      from: t.from,
      via: t.via,
      type: t.type,
    })),
  };
}

// Edge types that represent execution flow (used by trace-flow, what-do-i-call)
const FLOW_EDGE_TYPES = ['CALLS', 'STEP_IN_PROCESS', 'METHOD_IMPLEMENTS', 'METHOD_OVERRIDES'];

// ── trace-flow ──

async function handleTraceFlow(params: Record<string, any>) {
  const backend = await getGraphBackend();
  const maxDepth = Math.min(Math.max(Number(params.depth) || 10, 1), 20);
  const mainFlowOnly = params.mainFlowOnly === true || params.mainFlowOnly === 'true';

  const epId = await resolveEntrypoint(backend, params);
  if (!epId) return { error: 'Entrypoint not found. Provide entryPointId, or path + service.' };

  const epInfo = await backend
    .executeQuery(
      `MATCH (ep {id: $epId})
       RETURN ep.name AS name, ep.routePath AS path, ep.httpMethod AS method, ep.repoId AS service,
              labels(ep)[0] AS label, ep.topic AS topic, ep.listenerType AS listenerType,
              ep.description AS description, ep.filePath AS filePath, ep.startLine AS startLine`,
      { epId },
    )
    .catch(() => []);

  const entryPointInfo = epInfo[0] || { id: epId };
  const entryPointKind = getEntrypointDisplayKind({
    label: entryPointInfo.label,
    listenerType: entryPointInfo.listenerType,
  });

  let internalFlow: any[] = [];

  if (entryPointKind === 'MCP_TOOL') {
    internalFlow = await backend
      .executeQuery(
        `
      MATCH (tool {id: $epId})-[entry]->(p:Process)<-[r:CodeRelation]-(n)
      WHERE (type(entry) = 'ENTRY_POINT_OF' OR (type(entry) = 'CodeRelation' AND entry.type = 'ENTRY_POINT_OF'))
        AND r.type = 'STEP_IN_PROCESS'
      RETURN DISTINCT n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS file,
             n.startLine AS line, n.repoId AS service, coalesce(r.step, 0) AS depth
      ORDER BY depth
    `,
        { epId },
      )
      .catch(() => []);
  }

  if (!internalFlow.length) {
    const handlerRows = await backend
      .executeQuery(
        `MATCH (ep {id: $epId})<-[r]-(handler)
         WHERE CASE WHEN type(r) = 'CodeRelation' THEN r.type ELSE type(r) END IN ['HANDLES_ROUTE', 'CALLS', 'HANDLES_TOOL']
         RETURN handler.id AS id LIMIT 1`,
        { epId },
      )
      .catch(() => []);

    const startId = handlerRows.length ? handlerRows[0].id : epId;
    const flowTypes = mainFlowOnly
      ? ['CALLS', 'METHOD_IMPLEMENTS', 'METHOD_OVERRIDES']
      : FLOW_EDGE_TYPES;

    internalFlow = await backend
      .executeQuery(
        `
      MATCH path = (start {id: $startId})-[:CodeRelation*0..${Number(maxDepth)}]->(callee)
      WHERE ALL(r IN relationships(path) WHERE r.type IN $flowTypes)
      UNWIND nodes(path) AS n
      WITH DISTINCT n, min(length(path)) AS depth
      RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS file,
             n.startLine AS line, n.repoId AS service, depth
      ORDER BY depth
    `,
        { startId, flowTypes },
      )
      .catch(() => []);
  }

  const flowNodeIds = internalFlow.map((n: any) => n.id).filter(Boolean);
  const crossCalls: any[] = [];

  if (flowNodeIds.length > 0) {
    const transports = await backend
      .executeQuery(
        `
      MATCH (n)-[r:TRANSPORTS_TO]->(t:Transport)
      WHERE n.id IN $nodeIds
      OPTIONAL MATCH (entry)-[:SERVES]->(t)
      WHERE entry.repoId <> n.repoId
      RETURN n.name AS sourceName, t.name AS target, t.type AS type,
             r.confidence AS confidence, entry.repoId AS targetService, entry.name AS targetName
    `,
        { nodeIds: flowNodeIds },
      )
      .catch(() => []);
    crossCalls.push(
      ...transports.map((d: any) => ({
        sourceName: d.sourceName,
        type: d.type === 'api' ? 'http' : d.type,
        url: d.type === 'api' ? d.target : null,
        topic: d.type !== 'api' ? d.target : null,
        confidence: d.confidence,
        targetService: d.targetService,
        targetName: d.targetName,
      })),
    );
  }

  return {
    entryPoint: { ...entryPointInfo, id: epId, kind: entryPointKind },
    internalFlow: internalFlow.slice(0, 80),
    crossServiceCalls: crossCalls,
    totalInternalNodes: internalFlow.length,
  };
}

// ── who-calls-me ──

async function handleWhoCallsMe(params: Record<string, any>) {
  const backend = await getGraphBackend();
  const serviceId = params.service;

  // Service-level: return all incoming edges for the service
  if (serviceId) {
    const callers = await backend
      .executeQuery(
        `
      MATCH (entry)-[:SERVES]->(t:Transport)<-[:TRANSPORTS_TO]-(m)
      WHERE entry.repoId = $serviceId AND m.repoId <> $serviceId AND labels(m)[0] <> 'DetectedSink'
      RETURN m.name AS name, m.filePath AS file, m.repoId AS service,
             t.name AS transport, t.type AS transportType
    `,
        { serviceId },
      )
      .catch(() => []);

    return {
      service: serviceId,
      callers: callers.map((c: any) => ({
        name: c.name,
        file: c.file,
        service: c.service,
        url: c.transportType === 'api' ? c.transport : null,
        topic: c.transportType !== 'api' ? c.transport : null,
        type: c.transportType === 'api' ? 'http' : c.transportType,
      })),
      totalUpstream: callers.length,
    };
  }

  // Entrypoint-level: find who calls this via Transport
  const epId = await resolveEntrypoint(backend, params);
  if (!epId) return { error: 'Entrypoint not found.' };

  const callers = await backend
    .executeQuery(
      `
    MATCH (ep {id: $epId})-[:SERVES]->(t:Transport)<-[:TRANSPORTS_TO]-(m)
    WHERE labels(m)[0] <> 'DetectedSink'
    RETURN m.name AS name, m.filePath AS file, m.repoId AS service,
           t.name AS transport, t.type AS transportType
  `,
      { epId },
    )
    .catch(() => []);

  return {
    entryPointId: epId,
    callers: callers.map((c: any) => ({
      name: c.name,
      file: c.file,
      service: c.service,
      url: c.transportType === 'api' ? c.transport : null,
      topic: c.transportType !== 'api' ? c.transport : null,
      type: c.transportType === 'api' ? 'http' : c.transportType || 'kafka',
    })),
    totalUpstream: callers.length,
  };
}

// ── what-do-i-call ──

async function handleWhatDoICall(params: Record<string, any>) {
  const backend = await getGraphBackend();
  const serviceId = params.service;

  // Service-level: return all outgoing edges for the service
  if (serviceId) {
    const targets = await backend
      .executeQuery(
        `
      MATCH (m)-[tt:TRANSPORTS_TO]->(t:Transport)
      WHERE m.repoId = $serviceId AND labels(m)[0] <> 'DetectedSink'
      OPTIONAL MATCH (entry)-[:SERVES]->(t) WHERE entry.repoId <> $serviceId
      RETURN m.name AS sourceName, m.filePath AS callerFile, m.startLine AS callerLine,
             t.id AS transportId, t.name AS transport, t.path AS transportPath, t.type AS transportType,
             tt.confidence AS confidence, entry.repoId AS targetService, entry.name AS targetName
    `,
        { serviceId },
      )
      .catch(() => []);

    return {
      service: serviceId,
      targets: targets.map((t: any) => ({
        sourceName: t.sourceName,
        callerFile: t.callerFile,
        callerLine: t.callerLine,
        transportId: t.transportId,
        transportPath: t.transportPath,
        topic: t.transportType !== 'api' ? t.transport : null,
        url: t.transportType === 'api' ? t.transport : null,
        type: t.transportType === 'api' ? 'http' : t.transportType,
        confidence: t.confidence,
        targetService: t.targetService,
        targetName: t.targetName,
      })),
      totalDownstream: targets.length,
    };
  }

  // Entrypoint-level: trace from specific entry point
  const epId = await resolveEntrypoint(backend, params);
  if (!epId) return { error: 'Entrypoint not found.' };

  // Resolve handler (Route/Listener → Method)
  const handlerRows2 = await backend
    .executeQuery(
      `MATCH (ep {id: $epId})<-[r:CodeRelation]-(handler)
       WHERE r.type IN ['HANDLES_ROUTE', 'CALLS']
       RETURN handler.id AS id LIMIT 1`,
      { epId },
    )
    .catch(() => []);
  const startId2 = handlerRows2.length ? handlerRows2[0].id : epId;

  const flowNodes = await backend
    .executeQuery(
      `
    MATCH path = (start {id: $startId})-[:CodeRelation*0..10]->(n)
    WHERE ALL(r IN relationships(path) WHERE r.type IN $flowTypes)
    RETURN DISTINCT n.id AS id
  `,
      { startId: startId2, flowTypes: FLOW_EDGE_TYPES },
    )
    .catch(() => []);

  const nodeIds = [epId, ...flowNodes.map((n: any) => n.id)].filter(Boolean);
  if (!nodeIds.length) return { entryPointId: epId, targets: [], totalDownstream: 0 };

  const targets = await backend
    .executeQuery(
      `
    MATCH (n)-[r:TRANSPORTS_TO]->(t:Transport)
    WHERE n.id IN $nodeIds AND labels(n)[0] <> 'DetectedSink'
    OPTIONAL MATCH (entry)-[:SERVES]->(t) WHERE entry.repoId <> n.repoId
    RETURN n.name AS sourceName, t.name AS target, t.type AS type,
           r.confidence AS confidence, entry.repoId AS targetService, entry.name AS targetName
  `,
      { nodeIds },
    )
    .catch(() => []);

  return {
    entryPointId: epId,
    targets: targets.map((t: any) => ({
      sourceName: t.sourceName,
      targetName: t.targetName,
      url: t.type === 'api' ? t.target : null,
      topic: t.type !== 'api' ? t.target : null,
      type: t.type === 'api' ? 'http' : t.type || 'kafka',
      confidence: t.confidence,
      targetService: t.targetService,
    })),
    totalDownstream: targets.length,
  };
}

// ── business-group ──

async function handleBusinessGroup(params: Record<string, any>) {
  const serviceId = params.service;
  if (!serviceId) return { error: 'service parameter is required' };

  const backend = await getGraphBackend();
  const groups = await groupEntrypoints(serviceId);

  // Enrich: fetch Route/Listener details for each entrypoint ID
  const allIds = groups.flatMap((g) => g.entryPointIds);
  const routeMap = new Map<string, any>();
  const listenerMap = new Map<string, any>();
  const toolMap = new Map<string, any>();

  if (allIds.length) {
    const routes = await backend
      .executeQuery(
        `
      MATCH (r:Route) WHERE r.id IN $ids
      RETURN r.id AS id, r.routePath AS path, r.httpMethod AS method, r.controllerName AS controller, r.name AS name, r.filePath AS filePath
    `,
        { ids: allIds },
      )
      .catch(() => []);

    // Fix missing base paths by scanning class-level @RequestMapping
    const classBasePaths = new Map<string, string>();
    for (const r of routes) {
      if (r.filePath && r.path != null) {
        // Heuristic: path is likely missing base if it's short and doesn't look like a full API path
        const looksComplete = r.path.match(/^\/[a-z]\/v\d/) || r.path.match(/^\/api\//);
        const needsFix =
          r.path === '' ||
          (r.path.startsWith('/{') && !looksComplete) ||
          (!r.path.startsWith('/') && r.path.length > 0) ||
          (r.path.startsWith('/') && r.path.split('/').length <= 3 && !looksComplete);
        if (needsFix) {
          if (!classBasePaths.has(r.filePath)) {
            classBasePaths.set(r.filePath, await resolveClassBasePath(r.filePath, serviceId));
          }
          const base = classBasePaths.get(r.filePath) || '';
          if (base) r.path = base + (r.path || '');
        }
      }
    }

    for (const r of routes) routeMap.set(r.id, r);

    const listeners = await backend
      .executeQuery(
        `
      MATCH (l:Listener) WHERE l.id IN $ids
      RETURN l.id AS id, COALESCE(l.resolvedTopic, l.topic) AS topic, l.listenerType AS type,
             l.name AS name, l.filePath AS filePath, l.startLine AS startLine
    `,
        { ids: allIds },
      )
      .catch(() => []);
    for (const l of listeners) listenerMap.set(l.id, l);

    const tools = await backend
      .executeQuery(
        `
      MATCH (f)-[rel]->(t:Tool)
      WHERE t.id IN $ids AND f.repoId = $serviceId
        AND CASE WHEN type(rel) = 'CodeRelation' THEN rel.type ELSE type(rel) END = 'HANDLES_TOOL'
      RETURN DISTINCT t.id AS id, t.name AS name, t.filePath AS filePath,
             t.description AS description
    `,
        { ids: allIds, serviceId },
      )
      .catch(() => []);
    for (const tool of tools) toolMap.set(tool.id, tool);
  }

  return {
    serviceId,
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      source: g.source,
      entryPointCount: g.entryPointCount,
      entrypoints: g.entryPointIds.slice(0, 50).map((epId) => {
        const route = routeMap.get(epId);
        if (route)
          return {
            id: epId,
            type: 'api',
            kind: 'API',
            kindLabel: 'API',
            method: route.method || '',
            path: route.path || '',
            name: route.name || '',
            filePath: route.filePath,
          };
        const listener = listenerMap.get(epId);
        if (listener) {
          const kind = getEntrypointDisplayKind({
            label: 'Listener',
            listenerType: listener.type,
          });
          return {
            id: epId,
            type: listener.type || 'kafka',
            kind,
            kindLabel: kind === 'SCHEDULED' ? 'Scheduled' : 'Message',
            topic: listener.topic || '',
            name: listener.topic ? `${listener.topic}` : listener.name || '',
            filePath: listener.filePath,
            startLine: listener.startLine,
          };
        }
        const tool = toolMap.get(epId);
        if (tool)
          return {
            id: epId,
            type: 'mcp_tool',
            kind: 'MCP_TOOL',
            kindLabel: 'MCP Tool',
            name: tool.name || epId,
            filePath: tool.filePath,
            description: tool.description,
          };
        return { id: epId, type: 'unknown', kind: 'OTHER', kindLabel: 'Other', name: epId };
      }),
    })),
    totalGroups: groups.length,
    totalEntryPoints: groups.reduce((sum, g) => sum + g.entryPointCount, 0),
  };
}

// ── Helpers ──

async function resolveEntrypoint(
  backend: any,
  params: Record<string, any>,
): Promise<string | null> {
  if (params.entryPointId) return params.entryPointId;

  if (params.path) {
    const query = params.service
      ? `MATCH (r:Route) WHERE r.routePath CONTAINS $path AND r.repoId = $service RETURN r.id AS id LIMIT 1`
      : `MATCH (r:Route) WHERE r.routePath CONTAINS $path RETURN r.id AS id LIMIT 1`;
    const queryParams: Record<string, any> = { path: params.path };
    if (params.service) queryParams.service = params.service;
    const rows = await backend.executeQuery(query, queryParams).catch(() => []);
    if (rows.length) return rows[0].id;
  }

  return null;
}

// ── channels ──

async function handleChannels(_params: Record<string, any>) {
  const backend = await getGraphBackend();
  const channels = await backend
    .executeQuery(
      `
    MATCH (t:Transport)
    OPTIONAL MATCH (m)-[:TRANSPORTS_TO]->(t) WHERE labels(m)[0] <> 'DetectedSink'
    OPTIONAL MATCH (entry)-[:SERVES]->(t)
    RETURN t.name AS name, t.type AS type,
           collect(DISTINCT {service: m.repoId, method: m.name}) AS producers,
           collect(DISTINCT {service: entry.repoId, listener: entry.name}) AS consumers
    ORDER BY t.type, t.name
  `,
    )
    .catch(() => []);

  return {
    channels: channels.map((ch: any) => ({
      name: ch.name,
      type: ch.type || 'kafka',
      producers: (ch.producers || []).filter((p: any) => p.service),
      consumers: (ch.consumers || []).filter((c: any) => c.service),
    })),
  };
}

// ── config-lookup ──

async function handleConfigLookup(params: Record<string, any>) {
  const { key, service } = params;
  if (!key) return { error: 'key is required' };

  const { resolveConfig } = await import('../engine/config-resolver.js');
  const { listServices } = await import('../admin/service-registry.js');
  const { loadConfig } = await import('../config/loader.js');
  const path = await import('path');
  const config = await loadConfig();

  const services = service ? [{ id: service }] : (await listServices()).map((s) => ({ id: s.id }));
  const results: Array<{ service: string; value: string | null }> = [];

  for (const svc of services) {
    try {
      const repoPath = path.join(config.workspace.dir, svc.id);
      const configMap = await resolveConfig(svc.id, repoPath);
      const val = configMap.get(key) ?? null;
      if (val !== null || service) results.push({ service: svc.id, value: val });
    } catch {
      /* skip */
    }
  }

  return { key, results, found: results.filter((r) => r.value !== null).length };
}
// ── manage-pattern — CRUD sink patterns via MCP ──

async function handleManagePattern(params: Record<string, any>) {
  const { action } = params;
  const backend = await getGraphBackend();

  switch (action) {
    case 'list': {
      const { resolveSinkPatterns, getPatternsForService, normalizeSinkPattern } =
        await import('../engine/sink-patterns.js');
      const { loadConfig } = await import('../config/loader.js');
      const config = await loadConfig();
      const patterns = resolveSinkPatterns(config.sinkPatterns);
      // Merge with DB overrides
      const dbRows = await backend
        .executeQuery('MATCH (p:SinkPattern) RETURN properties(p) AS props')
        .catch(() => []);
      const dbMap = new Map(dbRows.map((r: any) => [r.props.id, normalizeSinkPattern(r.props)]));
      const merged = patterns.map((p) =>
        normalizeSinkPattern({ ...p, ...(dbMap.get(p.id) || {}) }),
      );
      for (const [id, p] of dbMap) {
        if (!merged.find((m) => m.id === id)) merged.push(normalizeSinkPattern(p as any));
      }
      // Filter by service scope if requested
      const result = params.service ? await getPatternsForService(merged, params.service) : merged;
      return {
        patterns: result,
        total: result.length,
        enabled: result.filter((p: any) => p.enabled).length,
      };
    }

    case 'create': {
      const {
        id,
        name,
        category,
        methodPattern,
        targetArgIndex,
        defaultTarget,
        scope,
        wrapperClass,
        wrapperMethods,
        languages,
        fileExtensions,
        excludePathPatterns,
      } = params;
      if (!id || !name) return { error: 'Required: id, name' };
      if (!methodPattern && !wrapperClass)
        return { error: 'Required: methodPattern or wrapperClass' };
      // Validate regex if provided
      if (methodPattern) {
        try {
          new RegExp(methodPattern);
        } catch (e: any) {
          return { error: `Invalid regex: ${e.message}` };
        }
      }
      const props: any = {
        id,
        name,
        category: category || 'http',
        methodPattern: methodPattern || '',
        targetArgIndex: targetArgIndex ?? 0,
        enabled: true,
      };
      if (defaultTarget !== undefined) props.defaultTarget = defaultTarget;
      if (scope) props.scope = typeof scope === 'string' ? scope : JSON.stringify(scope);
      if (wrapperClass) props.wrapperClass = wrapperClass;
      if (wrapperMethods) props.wrapperMethods = JSON.stringify(wrapperMethods);
      if (languages !== undefined) props.languages = JSON.stringify(languages);
      if (fileExtensions !== undefined) props.fileExtensions = JSON.stringify(fileExtensions);
      if (excludePathPatterns !== undefined)
        props.excludePathPatterns = JSON.stringify(excludePathPatterns);
      await backend.executeQuery('MERGE (p:SinkPattern {id: $id}) SET p += $props', { id, props });
      return {
        created: props,
        hint: 'Run relink on affected services to apply: POST /api/mv/services/:id/relink',
      };
    }

    case 'update': {
      const {
        id,
        methodPattern,
        name: pName,
        category: pCat,
        targetArgIndex: pIdx,
        defaultTarget,
        scope,
        wrapperClass,
        wrapperMethods,
        languages,
        fileExtensions,
        excludePathPatterns,
      } = params;
      if (!id) return { error: 'Required: id' };
      if (methodPattern) {
        try {
          new RegExp(methodPattern);
        } catch (e: any) {
          return { error: `Invalid regex: ${e.message}` };
        }
      }
      const updates: any = {};
      if (methodPattern) updates.methodPattern = methodPattern;
      if (pName) updates.name = pName;
      if (pCat) updates.category = pCat;
      if (pIdx !== undefined) updates.targetArgIndex = pIdx;
      if (defaultTarget !== undefined) updates.defaultTarget = defaultTarget;
      if (scope !== undefined)
        updates.scope = typeof scope === 'string' ? scope : JSON.stringify(scope);
      if (wrapperClass !== undefined) updates.wrapperClass = wrapperClass;
      if (wrapperMethods !== undefined) updates.wrapperMethods = JSON.stringify(wrapperMethods);
      if (languages !== undefined) updates.languages = JSON.stringify(languages);
      if (fileExtensions !== undefined) updates.fileExtensions = JSON.stringify(fileExtensions);
      if (excludePathPatterns !== undefined)
        updates.excludePathPatterns = JSON.stringify(excludePathPatterns);
      await backend.executeQuery('MERGE (p:SinkPattern {id: $id}) SET p += $props', {
        id,
        props: { id, ...updates },
      });
      return { updated: { id, ...updates } };
    }

    case 'enable':
    case 'disable': {
      const { id } = params;
      if (!id) return { error: 'Required: id' };
      const enabled = action === 'enable';
      await backend.executeQuery('MERGE (p:SinkPattern {id: $id}) SET p.enabled = $enabled', {
        id,
        enabled,
      });
      return { [action + 'd']: id };
    }

    default:
      return { error: `Unknown action: ${action}. Use: list, create, update, enable, disable` };
  }
}

// ── manage-rule — CRUD entrypoint detection rules (graph pattern rules) via MCP ──

async function handleManageRule(params: Record<string, any>) {
  const { action } = params;
  const backend = await getGraphBackend();

  switch (action) {
    case 'list': {
      const { resolveGraphRules, normalizeGraphRule } = await import('../engine/graph-rules.js');
      const { loadConfig } = await import('../config/loader.js');
      const config = await loadConfig();
      const builtIn = resolveGraphRules(config.graphRules);
      const dbRows = await backend
        .executeQuery('MATCH (r:GraphRule) RETURN properties(r) AS props')
        .catch(() => []);
      const dbMap = new Map(dbRows.map((r: any) => [r.props.id, r.props]));
      const merged = builtIn.map((r) => {
        const db = dbMap.get(r.id);
        if (!db) return normalizeGraphRule(r as any);
        const p: any = { ...r, ...db };
        if (typeof p.match === 'string')
          try {
            p.match = JSON.parse(p.match);
          } catch {}
        if (typeof p.emit === 'string')
          try {
            p.emit = JSON.parse(p.emit);
          } catch {}
        return normalizeGraphRule(p);
      });
      for (const [id, p] of dbMap) {
        if (!merged.find((m: any) => m.id === id)) {
          const parsed: any = { ...p };
          if (typeof parsed.match === 'string')
            try {
              parsed.match = JSON.parse(parsed.match);
            } catch {}
          if (typeof parsed.emit === 'string')
            try {
              parsed.emit = JSON.parse(parsed.emit);
            } catch {}
          merged.push(normalizeGraphRule(parsed));
        }
      }
      const visible = merged.filter((r: any) => !r.deleted);
      return {
        rules: visible,
        total: visible.length,
        enabled: visible.filter((r: any) => r.enabled).length,
      };
    }

    case 'create': {
      const { id, name, type, match, emit, languages, fileExtensions, excludePathPatterns } =
        params;
      if (!id || !name || !match || !emit) return { error: 'Required: id, name, match, emit' };
      const props = {
        id,
        name,
        type: type || 'job',
        match: JSON.stringify(match),
        emit: JSON.stringify(emit),
        enabled: true,
        ...(languages !== undefined ? { languages: JSON.stringify(languages) } : {}),
        ...(fileExtensions !== undefined ? { fileExtensions: JSON.stringify(fileExtensions) } : {}),
        ...(excludePathPatterns !== undefined
          ? { excludePathPatterns: JSON.stringify(excludePathPatterns) }
          : {}),
      };
      await backend.executeQuery('MERGE (r:GraphRule {id: $id}) SET r += $props', { id, props });
      return {
        created: { ...props, match, emit },
        hint: 'Run analyze on affected services to apply.',
      };
    }

    case 'update': {
      const {
        id,
        name: rName,
        type: rType,
        match: rMatch,
        emit: rEmit,
        languages,
        fileExtensions,
        excludePathPatterns,
      } = params;
      if (!id) return { error: 'Required: id' };
      const updates: any = { id };
      if (rName) updates.name = rName;
      if (rType) updates.type = rType;
      if (rMatch) updates.match = JSON.stringify(rMatch);
      if (rEmit) updates.emit = JSON.stringify(rEmit);
      if (languages !== undefined) updates.languages = JSON.stringify(languages);
      if (fileExtensions !== undefined) updates.fileExtensions = JSON.stringify(fileExtensions);
      if (excludePathPatterns !== undefined)
        updates.excludePathPatterns = JSON.stringify(excludePathPatterns);
      await backend.executeQuery('MERGE (r:GraphRule {id: $id}) SET r += $props', {
        id,
        props: updates,
      });
      return { updated: { id, ...updates } };
    }

    case 'enable':
    case 'disable': {
      const { id } = params;
      if (!id) return { error: 'Required: id' };
      const enabled = action === 'enable';
      await backend.executeQuery('MERGE (r:GraphRule {id: $id}) SET r.enabled = $enabled', {
        id,
        enabled,
      });
      return { [action + 'd']: id };
    }

    default:
      return { error: `Unknown action: ${action}. Use: list, create, update, enable, disable` };
  }
}
// ── node-neighbors — explore graph around a node ──

async function handleNodeNeighbors(params: Record<string, any>) {
  const { service, nodeId, name, file, direction = 'out', edgeTypes, nodeLabels } = params;
  if (!service) return { error: 'Required: service' };

  const backend = await getGraphBackend();

  // Resolve node ID
  let resolvedId = nodeId;
  if (!resolvedId && name) {
    const searchQuery = file
      ? `MATCH (n {repoId: $service}) WHERE n.name = $name AND n.filePath CONTAINS $file RETURN n.id AS id LIMIT 1`
      : `MATCH (n {repoId: $service}) WHERE n.name = $name RETURN n.id AS id LIMIT 3`;
    const searchParams: Record<string, any> = { service, name };
    if (file) searchParams.file = file;
    const rows = await backend.executeQuery(searchQuery, searchParams).catch(() => []);
    if (!rows.length)
      return { error: `Node not found: name=${name}${file ? ` file=${file}` : ''}` };
    resolvedId = rows[0].id;
  }
  if (!resolvedId) return { error: 'Required: nodeId or name' };

  // Get node info
  const nodeInfo = await backend
    .executeQuery(
      `MATCH (n {id: $id}) RETURN n.id AS id, n.name AS name, labels(n)[0] AS label, n.filePath AS file, n.startLine AS line, properties(n) AS props`,
      { id: resolvedId },
    )
    .catch(() => []);

  // Build direction pattern
  let matchPattern: string;
  if (direction === 'in') matchPattern = `(m)-[r]->(n {id: $id})`;
  else if (direction === 'both') matchPattern = `(n {id: $id})-[r]-(m)`;
  else matchPattern = `(n {id: $id})-[r]->(m)`;

  // Build filters
  const filters: string[] = [];
  if (edgeTypes) {
    const types = edgeTypes.split(',').map((t: string) => t.trim());
    filters.push(
      `(CASE WHEN type(r) = 'CodeRelation' THEN r.type ELSE type(r) END) IN [${types.map((t: string) => `'${t}'`).join(',')}]`,
    );
  }
  if (nodeLabels) {
    const labels = nodeLabels.split(',').map((l: string) => l.trim());
    filters.push(`labels(m)[0] IN [${labels.map((l: string) => `'${l}'`).join(',')}]`);
  }
  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const neighbors = await backend
    .executeQuery(
      `MATCH ${matchPattern}
     ${whereClause}
     RETURN m.id AS id, m.name AS name, labels(m)[0] AS label, m.filePath AS file, m.startLine AS line,
            CASE WHEN type(r) = 'CodeRelation' THEN r.type ELSE type(r) END AS edgeType,
            r.confidence AS confidence,
            CASE WHEN startNode(r) = n THEN 'out' ELSE 'in' END AS dir
     LIMIT 50`,
      { id: resolvedId },
    )
    .catch(() => []);

  return {
    node: nodeInfo[0] || { id: resolvedId },
    neighbors,
    total: neighbors.length,
  };
}

// ── graph-overview — structural summary of a service ──

async function handleGraphOverview(params: Record<string, any>) {
  const { service } = params;
  if (!service) return { error: 'Required: service' };

  const backend = await getGraphBackend();

  // Node counts by label
  const nodeCounts = await backend
    .executeQuery(
      `MATCH (n {repoId: $service}) RETURN labels(n)[0] AS label, count(*) AS count ORDER BY count DESC`,
      { service },
    )
    .catch(() => []);

  // Edge type distribution
  const edgeCounts = await backend
    .executeQuery(
      `MATCH (a {repoId: $service})-[r:CodeRelation]->(b {repoId: $service})
     RETURN r.type AS type, count(*) AS count ORDER BY count DESC LIMIT 15`,
      { service },
    )
    .catch(() => []);

  // Key classes (most connected)
  const keyClasses = await backend
    .executeQuery(
      `MATCH (c:Class {repoId: $service})-[r]-()
     WITH c, count(r) AS connections
     RETURN c.name AS name, c.filePath AS file, connections
     ORDER BY connections DESC LIMIT 10`,
      { service },
    )
    .catch(() => []);

  // Entry points summary
  const entryPoints = await backend
    .executeQuery(
      `MATCH (n {repoId: $service})
     WHERE labels(n)[0] IN ['Route', 'Listener']
     RETURN labels(n)[0] AS type, count(*) AS count`,
      { service },
    )
    .catch(() => []);

  // Cross-service connections
  const crossService = await backend
    .executeQuery(
      `MATCH (m {repoId: $service})-[:TRANSPORTS_TO]->(t:Transport)
     WHERE labels(m)[0] <> 'DetectedSink'
     OPTIONAL MATCH (entry)-[:SERVES]->(t) WHERE entry.repoId <> $service
     RETURN t.type AS type, count(DISTINCT t) AS channels, collect(DISTINCT entry.repoId) AS targets`,
      { service },
    )
    .catch(() => []);

  const totalNodes = nodeCounts.reduce((s: number, r: any) => s + r.count, 0);
  const totalEdges = edgeCounts.reduce((s: number, r: any) => s + r.count, 0);

  return {
    service,
    summary: { totalNodes, totalEdges },
    nodesByType: nodeCounts,
    edgesByType: edgeCounts,
    keyClasses,
    entryPoints,
    crossServiceConnections: crossService.filter((c: any) => c.type),
  };
}

// ── symbol-context — 360° view of a symbol ──

async function handleSymbolContext(params: Record<string, any>) {
  const { service, name, file, nodeId } = params;
  if (!service) return { error: 'Required: service' };

  const backend = await getGraphBackend();

  // Resolve node
  let resolvedId = nodeId;
  if (!resolvedId && name) {
    const q = file
      ? `MATCH (n {repoId: $service}) WHERE n.name = $name AND n.filePath CONTAINS $file RETURN n.id AS id, labels(n)[0] AS label LIMIT 3`
      : `MATCH (n {repoId: $service}) WHERE n.name = $name AND labels(n)[0] IN ['Method','Class','Interface','Function'] RETURN n.id AS id, labels(n)[0] AS label LIMIT 3`;
    const qp: Record<string, any> = { service, name };
    if (file) qp.file = file;
    const candidates = await backend.executeQuery(q, qp).catch(() => []);
    if (!candidates.length) return { error: `Symbol not found: ${name}` };
    if (candidates.length > 1)
      return { candidates, hint: 'Multiple matches — provide file or nodeId to disambiguate' };
    resolvedId = candidates[0].id;
  }
  if (!resolvedId) return { error: 'Required: name or nodeId' };

  // Node info
  const nodeInfo = await backend
    .executeQuery(
      `MATCH (n {id: $id}) RETURN n.id AS id, n.name AS name, labels(n)[0] AS label, n.filePath AS file, n.startLine AS line`,
      { id: resolvedId },
    )
    .catch(() => []);

  // Incoming refs (who calls/uses this)
  const incoming = await backend
    .executeQuery(
      `MATCH (caller)-[r:CodeRelation]->(n {id: $id})
     WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'ACCESSES']
     RETURN caller.name AS name, labels(caller)[0] AS label, caller.filePath AS file,
            r.type AS edgeType, caller.repoId AS service
     LIMIT 30`,
      { id: resolvedId },
    )
    .catch(() => []);

  // Outgoing refs (what this calls/uses)
  const outgoing = await backend
    .executeQuery(
      `MATCH (n {id: $id})-[r:CodeRelation]->(target)
     WHERE r.type IN ['CALLS', 'STEP_IN_PROCESS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'ACCESSES', 'METHOD_IMPLEMENTS']
     RETURN target.name AS name, labels(target)[0] AS label, target.filePath AS file,
            r.type AS edgeType, target.repoId AS service
     LIMIT 30`,
      { id: resolvedId },
    )
    .catch(() => []);

  // Class membership (if Method)
  const membership = await backend
    .executeQuery(
      `MATCH (cls)-[:CodeRelation {type: 'HAS_METHOD'}]->(n {id: $id})
     RETURN cls.name AS className, cls.filePath AS file, labels(cls)[0] AS label`,
      { id: resolvedId },
    )
    .catch(() => []);

  // Process participation
  const processes = await backend
    .executeQuery(
      `MATCH (n {id: $id})-[:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
     RETURN DISTINCT p.name AS name, p.heuristicLabel AS label`,
      { id: resolvedId },
    )
    .catch(() => []);

  // Cross-service connections
  const crossService = await backend
    .executeQuery(
      `MATCH (n {id: $id})-[:TRANSPORTS_TO]->(t:Transport)
     OPTIONAL MATCH (entry)-[:SERVES]->(t) WHERE entry.repoId <> $service
     RETURN t.name AS transport, t.type AS type, entry.repoId AS targetService, entry.name AS targetName`,
      { id: resolvedId, service },
    )
    .catch(() => []);

  return {
    symbol: nodeInfo[0] || { id: resolvedId },
    belongsTo: membership[0] || null,
    incoming: incoming.map((r: any) => ({ ...r, direction: 'incoming' })),
    outgoing: outgoing.map((r: any) => ({ ...r, direction: 'outgoing' })),
    processes,
    crossServiceCalls: crossService.filter((c: any) => c.transport),
    summary: {
      incomingCount: incoming.length,
      outgoingCount: outgoing.length,
      processCount: processes.length,
      crossServiceCount: crossService.filter((c: any) => c.transport).length,
    },
  };
}

// ── impact — blast radius analysis ──

async function handleImpact(params: Record<string, any>) {
  const {
    service,
    target,
    nodeId,
    direction,
    file,
    maxDepth = 3,
    relationTypes,
    includeTests = false,
  } = params;
  if (!service) return { error: 'Required: service' };
  if (!direction) return { error: 'Required: direction (upstream|downstream)' };

  const backend = await getGraphBackend();

  // Resolve symbol
  let resolvedId = nodeId;
  if (!resolvedId && target) {
    const q = file
      ? `MATCH (n {repoId: $service}) WHERE n.name = $target AND n.filePath CONTAINS $file AND labels(n)[0] IN ['Method','Class','Interface','Function','Constructor'] RETURN n.id AS id, n.name AS name, labels(n)[0] AS label LIMIT 3`
      : `MATCH (n {repoId: $service}) WHERE n.name = $target AND labels(n)[0] IN ['Method','Class','Interface','Function','Constructor'] RETURN n.id AS id, n.name AS name, labels(n)[0] AS label LIMIT 3`;
    const qp: Record<string, any> = { service, target };
    if (file) qp.file = file;
    const candidates = await backend.executeQuery(q, qp).catch(() => []);
    if (!candidates.length) return { error: `Symbol not found: ${target}` };
    if (candidates.length > 1)
      return { status: 'ambiguous', candidates, hint: 'Provide file or nodeId to disambiguate' };
    resolvedId = candidates[0].id;
  }
  if (!resolvedId) return { error: 'Required: target or nodeId' };

  const relTypes = relationTypes
    ? relationTypes.split(',').map((t: string) => t.trim())
    : ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS', 'METHOD_OVERRIDES', 'METHOD_IMPLEMENTS'];
  const safeDepth = Math.min(Number(maxDepth) || 3, 10);

  // BFS traversal
  const impacted: any[] = [];
  const visited = new Set<string>([resolvedId]);
  let frontier = [resolvedId];

  // For Class/Interface: seed with constructors too
  const nodeInfo = await backend
    .executeQuery(`MATCH (n {id: $id}) RETURN labels(n)[0] AS label`, { id: resolvedId })
    .catch(() => []);
  const nodeLabel = nodeInfo[0]?.label;

  if (nodeLabel === 'Class' || nodeLabel === 'Interface') {
    const ctors = await backend
      .executeQuery(
        `MATCH (n {id: $id})-[:CodeRelation {type: 'HAS_METHOD'}]->(c:Constructor) RETURN c.id AS id`,
        { id: resolvedId },
      )
      .catch(() => []);
    for (const c of ctors) {
      if (c.id && !visited.has(c.id)) {
        visited.add(c.id);
        frontier.push(c.id);
      }
    }
  }

  for (let depth = 1; depth <= safeDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];
    // Batch query
    const arrow =
      direction === 'upstream'
        ? `(caller)-[r:CodeRelation]->(n) WHERE n.id IN $ids AND r.type IN $relTypes RETURN caller.id AS id, caller.name AS name, labels(caller)[0] AS label, caller.filePath AS file, r.type AS relType, caller.repoId AS svc`
        : `(n)-[r:CodeRelation]->(callee) WHERE n.id IN $ids AND r.type IN $relTypes RETURN callee.id AS id, callee.name AS name, labels(callee)[0] AS label, callee.filePath AS file, r.type AS relType, callee.repoId AS svc`;

    const rows = await backend
      .executeQuery(`MATCH ${arrow}`, { ids: frontier, relTypes })
      .catch(() => []);

    for (const r of rows) {
      if (!r.id || visited.has(r.id)) continue;
      const fp = r.file || '';
      if (!includeTests && /[/\\](test|spec|__test__|__spec__)[/\\]/i.test(fp)) continue;
      visited.add(r.id);
      nextFrontier.push(r.id);
      impacted.push({
        depth,
        id: r.id,
        name: r.name,
        label: r.label,
        file: fp,
        relationType: r.relType,
        service: r.svc,
      });
    }
    frontier = nextFrontier;
  }

  // Group by depth
  const byDepth: Record<number, any[]> = {};
  for (const item of impacted) {
    (byDepth[item.depth] ??= []).push(item);
  }

  // Affected processes
  const impactedIds = impacted.map((i) => i.id);
  const processes =
    impactedIds.length > 0
      ? await backend
          .executeQuery(
            `MATCH (n)-[:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
         WHERE n.id IN $ids
         RETURN DISTINCT p.name AS name, p.heuristicLabel AS label, count(DISTINCT n) AS hits`,
            { ids: impactedIds.slice(0, 200) },
          )
          .catch(() => [])
      : [];

  // Affected modules (unique file directories)
  const modules = [
    ...new Set(
      impacted
        .map((i) => {
          const fp = i.file || '';
          const parts = fp.split('/');
          return parts.length > 2 ? parts.slice(0, -1).join('/') : fp;
        })
        .filter(Boolean),
    ),
  ];

  const directCount = (byDepth[1] || []).length;
  const risk =
    directCount <= 3
      ? 'LOW'
      : directCount <= 9
        ? 'MEDIUM'
        : directCount <= 19
          ? 'HIGH'
          : 'CRITICAL';

  return {
    target: { id: resolvedId, name: target || resolvedId, label: nodeLabel },
    direction,
    risk,
    summary: {
      directCallers: directCount,
      totalAffected: impacted.length,
      processesAffected: processes.length,
      modulesAffected: modules.length,
    },
    byDepth,
    affectedProcesses: processes,
    affectedModules: modules,
  };
}

// ── find-implementations — find all implementations of an interface ──

async function handleFindImplementations(params: Record<string, any>) {
  const { service, interface: ifaceName, name, nodeId } = params;
  const target = ifaceName || name;
  if (!target && !nodeId) return { error: 'Required: interface (or name or nodeId)' };

  const backend = await getGraphBackend();

  // Resolve interface node
  let ifaceId = nodeId;
  if (!ifaceId && target) {
    const serviceFilter = service ? `AND n.repoId = $service` : '';
    const q = `MATCH (n) WHERE n.name = $target AND labels(n)[0] IN ['Interface','Class'] ${serviceFilter}
               RETURN n.id AS id, n.name AS name, labels(n)[0] AS label, n.repoId AS service LIMIT 5`;
    const candidates = await backend
      .executeQuery(q, { target, ...(service ? { service } : {}) })
      .catch(() => []);
    if (!candidates.length) return { error: `Interface not found: ${target}` };
    if (candidates.length > 1 && !service)
      return { candidates, hint: 'Multiple matches — provide service to disambiguate' };
    ifaceId = candidates[0].id;
  }

  // Find class-level IMPLEMENTS
  const classImpls = await backend
    .executeQuery(
      `MATCH (impl)-[:CodeRelation {type: 'IMPLEMENTS'}]->(iface {id: $id})
     RETURN impl.id AS id, impl.name AS name, labels(impl)[0] AS label, impl.filePath AS file, impl.repoId AS service`,
      { id: ifaceId },
    )
    .catch(() => []);

  // Find method-level METHOD_IMPLEMENTS
  const methodImpls = await backend
    .executeQuery(
      `MATCH (iface {id: $id})-[:CodeRelation {type: 'HAS_METHOD'}]->(ifaceMethod)
     MATCH (implMethod)-[:CodeRelation {type: 'METHOD_IMPLEMENTS'}]->(ifaceMethod)
     RETURN implMethod.id AS id, implMethod.name AS methodName, labels(implMethod)[0] AS label,
            implMethod.filePath AS file, implMethod.repoId AS service,
            ifaceMethod.name AS interfaceMethod`,
      { id: ifaceId },
    )
    .catch(() => []);

  // Find EXTENDS (for abstract classes)
  const extenders = await backend
    .executeQuery(
      `MATCH (child)-[:CodeRelation {type: 'EXTENDS'}]->(parent {id: $id})
     RETURN child.id AS id, child.name AS name, labels(child)[0] AS label, child.filePath AS file, child.repoId AS service`,
      { id: ifaceId },
    )
    .catch(() => []);

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

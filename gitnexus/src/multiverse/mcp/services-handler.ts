/**
 * Services MCP Tool Handler — unified service management
 *
 * Actions: list, info, relink
 */

import { getGraphBackend } from '../../core/graph-backend/index.js';
import { getEntrypointDisplayKind } from '../engine/entrypoint-kind.js';
import { resolveServiceRepoPath } from '../util/repo-path.js';

export async function handleServices(params: Record<string, unknown>): Promise<unknown> {
  const { action } = params;
  switch (action) {
    case 'list':
      return servicesList(params);
    case 'info':
      return servicesInfo(params);
    case 'relink':
      return servicesRelink(params);
    default:
      return { error: `Unknown action: ${action}. Use: list, info, relink` };
  }
}

// ── list — all services with sink stats ──

async function servicesList(params: Record<string, unknown>) {
  const backend = await getGraphBackend();
  const typeFilter = params.type as string | undefined;

  const services = (await backend
    .executeQuery(
      `MATCH (s:ServiceNode) RETURN s.id AS id, s.name AS name, s.type AS type,
       s.repoProject AS project, s.entryPointCount AS entryPoints, s.analyzeStatus AS status`,
    )
    .catch(() => [])) as Array<Record<string, unknown>>;

  // Sink stats per service
  const sinkStats = (await backend
    .executeQuery(
      `MATCH (d:DetectedSink)
       WITH d.repoId AS service, count(*) AS total,
            sum(CASE WHEN d.confidence >= 0.5 THEN 1 ELSE 0 END) AS resolved
       RETURN service, total, resolved`,
    )
    .catch(() => [])) as Array<{ service: string; total: number; resolved: number }>;

  const statsMap = new Map(sinkStats.map((s) => [s.service, s]));

  let result = services.map((s) => {
    const stats = statsMap.get(s.id as string);
    return {
      id: s.id,
      name: s.name,
      type: s.type,
      project: s.project,
      entryPoints: s.entryPoints ?? 0,
      status: s.status,
      sinks: stats
        ? { total: stats.total, resolved: stats.resolved, unresolved: stats.total - stats.resolved }
        : null,
    };
  });

  if (typeFilter) result = result.filter((s) => s.type === typeFilter);

  return { services: result, total: result.length };
}

// ── info — detailed service info ──

async function servicesInfo(params: Record<string, unknown>) {
  const service = params.service as string;
  if (!service) return { error: 'Required: service' };

  const backend = await getGraphBackend();

  const infoRows = (await backend
    .executeQuery(
      `MATCH (s:ServiceNode {id: $service})
       RETURN properties(s) AS props`,
      { service },
    )
    .catch(() => [])) as Array<{ props: Record<string, unknown> }>;
  const info = infoRows[0];
  if (!info) return { error: `Service not found: ${service}` };

  const nodeCounts = (await backend
    .executeQuery(
      `MATCH (n {repoId: $service}) RETURN labels(n)[0] AS label, count(*) AS count ORDER BY count DESC`,
      { service },
    )
    .catch(() => [])) as Array<{ label: string; count: number }>;

  const entryPoints = (await backend
    .executeQuery(
      `
       MATCH (n)
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

  const outbound = (await backend
    .executeQuery(
      `MATCH (m {repoId: $service})-[:TRANSPORTS_TO]->(t:Transport)
       WHERE labels(m)[0] <> 'DetectedSink'
       OPTIONAL MATCH (entry)-[:SERVES]->(t) WHERE entry.repoId <> $service
       RETURN t.name AS transport, t.type AS type, entry.repoId AS targetService
       LIMIT 50`,
      { service },
    )
    .catch(() => [])) as Array<Record<string, unknown>>;

  return {
    service: info.props,
    nodesByType: nodeCounts,
    entryPoints: [...entryPointCounts.entries()].map(([type, count]) => ({ type, count })),
    outboundTransports: outbound,
  };
}

// ── relink — re-run cross-service linking ──

async function servicesRelink(params: Record<string, any>) {
  const { service, skipDetect = true } = params;

  if (service) {
    // Single service relink
    const { relinkService } = await import('../engine/orchestrator.js');
    const repoPath = (await resolveServiceRepoPath(service)).repoPath;
    const result = await relinkService(service, repoPath, undefined, skipDetect);
    return { relinked: [result] };
  }

  // Relink ALL services
  const { relinkAll } = await import('../engine/orchestrator.js');
  const { listServices } = await import('../admin/service-registry.js');
  const services = await listServices();
  const repoPathMap = new Map(
    await Promise.all(
      services.map(
        async (svc) => [svc.id, (await resolveServiceRepoPath(svc.id)).repoPath] as const,
      ),
    ),
  );
  const results = await relinkAll((svcId: string) => repoPathMap.get(svcId) || svcId, skipDetect);
  return {
    relinked: results,
    summary: {
      total: results.length,
      totalTransports: results.reduce((s, r) => s + r.linking.transports, 0),
      totalServes: results.reduce((s, r) => s + r.linking.serves, 0),
    },
  };
}

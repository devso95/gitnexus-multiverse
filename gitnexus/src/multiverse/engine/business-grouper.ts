/**
 * Business Grouper — groups entrypoints into business capabilities
 *
 * Heuristic grouping:
 * 1. URL path prefix (/api/order/*, /api/account/*)
 * 2. Controller name (OrderController → "order")
 * 3. Kafka topic prefix (ordering.workflow.* → "workflow")
 *
 * Creates BusinessGroup nodes + BELONGS_TO_GROUP edges in Neo4j.
 */

import { getGraphBackend } from '../../core/graph-backend/index.js';
import { mvLog } from '../util/logger.js';

const LOG = 'business-grouper';

export interface BusinessGroup {
  id: string;
  name: string;
  serviceId: string;
  source: 'heuristic' | 'manual';
  entryPointIds: string[];
  entryPointCount: number;
}

export interface RouteEntrypointRecord {
  id: string;
  routePath?: string;
  method?: string;
  controller?: string;
  name?: string;
}

export interface ListenerEntrypointRecord {
  id: string;
  topic?: string;
  type?: string;
  name?: string;
}

export interface ToolEntrypointRecord {
  id: string;
  name?: string;
  filePath?: string;
}

export function buildBusinessGroups(
  serviceId: string,
  entrypoints: {
    routes: RouteEntrypointRecord[];
    listeners: ListenerEntrypointRecord[];
    tools: ToolEntrypointRecord[];
  },
): BusinessGroup[] {
  const groups = new Map<string, { name: string; ids: string[] }>();

  for (const r of entrypoints.routes) {
    const controller = r.controller || '';
    const path = r.routePath || '';
    const groupKey = extractGroupKey(path, controller);
    const groupName = formatGroupName(groupKey);

    if (!groups.has(groupKey)) groups.set(groupKey, { name: groupName, ids: [] });
    const routeGroup = groups.get(groupKey);
    if (routeGroup) routeGroup.ids.push(r.id);
  }

  for (const l of entrypoints.listeners) {
    const topic = l.topic || '';
    const type = l.type || '';
    let groupKey: string;
    let groupName: string;

    if (type === 'kafka' && topic) {
      const cleanTopic = topic.replace(/^\$\{([^}]+)}$/, '$1').replace(/^\{?\$\{([^}]+)}.*$/, '$1');
      const parts = cleanTopic.split('.').filter(Boolean);
      const meaningful = parts.length > 2 ? parts.slice(-2).join('.') : cleanTopic;
      groupKey = `kafka:${meaningful}`;
      groupName = `Kafka: ${meaningful}`;
    } else if (type === 'job' || type === 'scheduled' || type === 'cron' || type === 'timer') {
      groupKey = 'jobs';
      groupName = 'Jobs & Scheduled Tasks';
    } else if (type === 'redis') {
      groupKey = 'redis-listeners';
      groupName = 'Redis Listeners';
    } else if (type === 'event') {
      groupKey = 'event-listeners';
      groupName = 'Event Listeners';
    } else {
      groupKey = 'other-listeners';
      groupName = 'Other Listeners';
    }

    if (!groups.has(groupKey)) groups.set(groupKey, { name: groupName, ids: [] });
    const listenerGroup = groups.get(groupKey);
    if (listenerGroup) listenerGroup.ids.push(l.id);
  }

  for (const tool of entrypoints.tools) {
    const groupKey = 'mcp-tools';
    const groupName = 'MCP Tools';
    if (!groups.has(groupKey)) groups.set(groupKey, { name: groupName, ids: [] });
    const toolGroup = groups.get(groupKey);
    if (toolGroup) toolGroup.ids.push(tool.id);
  }

  const result: BusinessGroup[] = [];
  for (const [key, group] of groups) {
    if (!group.ids.length) continue;
    result.push({
      id: `${serviceId}:${key}`,
      name: group.name,
      serviceId,
      source: 'heuristic',
      entryPointIds: group.ids,
      entryPointCount: group.ids.length,
    });
  }

  result.sort((a, b) => b.entryPointCount - a.entryPointCount);
  return result;
}

/**
 * Group entrypoints for a service by heuristic rules.
 */
export const groupEntrypoints = async (serviceId: string): Promise<BusinessGroup[]> => {
  const backend = await getGraphBackend();

  const [routes, listeners, tools] = await Promise.all([
    backend
      .executeQuery(
        `MATCH (r:Route {repoId: $serviceId})
       RETURN r.id AS id, r.routePath AS routePath, r.httpMethod AS method,
              r.controllerName AS controller, r.name AS name`,
        { serviceId },
      )
      .catch((err: unknown) => {
        mvLog.warn(LOG, `Failed to fetch routes for ${serviceId}`, err);
        return [] as RouteEntrypointRecord[];
      }),
    backend
      .executeQuery(
        `MATCH (l:Listener {repoId: $serviceId})
       RETURN l.id AS id, l.topic AS topic, l.listenerType AS type, l.name AS name`,
        { serviceId },
      )
      .catch((err: unknown) => {
        mvLog.warn(LOG, `Failed to fetch listeners for ${serviceId}`, err);
        return [] as ListenerEntrypointRecord[];
      }),
    backend
      .executeQuery(
        `MATCH (f {repoId: $serviceId})-[rel]->(t:Tool)
       WHERE CASE WHEN type(rel) = 'CodeRelation' THEN rel.type ELSE type(rel) END = 'HANDLES_TOOL'
       RETURN DISTINCT t.id AS id, t.name AS name, t.filePath AS filePath`,
        { serviceId },
      )
      .catch((err: unknown) => {
        mvLog.warn(LOG, `Failed to fetch tools for ${serviceId}`, err);
        return [] as ToolEntrypointRecord[];
      }),
  ]);

  return buildBusinessGroups(serviceId, {
    routes: routes as RouteEntrypointRecord[],
    listeners: listeners as ListenerEntrypointRecord[],
    tools: tools as ToolEntrypointRecord[],
  });
};

/** Persist BusinessGroup nodes + BELONGS_TO_GROUP edges */
export const persistBusinessGroups = async (
  serviceId: string,
  groups: BusinessGroup[],
): Promise<void> => {
  const backend = await getGraphBackend();

  // Clean old groups for this service
  await backend
    .executeQuery(`MATCH (bg:BusinessGroup {serviceId: $serviceId}) DETACH DELETE bg`, {
      serviceId,
    })
    .catch((err) => {
      mvLog.warn(LOG, `Failed to clean old groups for ${serviceId}`, err);
    });

  if (!groups.length) return;

  // Batch create BusinessGroup nodes + edges in one pass per batch
  const BATCH = 500;
  const nodeBatch = groups.map((g) => ({
    id: g.id,
    name: g.name,
    serviceId: g.serviceId,
    source: g.source,
    entryPointCount: g.entryPointCount,
    createdAt: new Date().toISOString(),
  }));
  for (let i = 0; i < nodeBatch.length; i += BATCH) {
    await backend
      .executeQuery(
        `UNWIND $batch AS props
       MERGE (bg:BusinessGroup {id: props.id})
       SET bg += props`,
        { batch: nodeBatch.slice(i, i + BATCH) },
      )
      .catch((err) => mvLog.warn(LOG, `Failed to create BusinessGroup batch at offset ${i}`, err));
  }

  // Batch create all BELONGS_TO_GROUP edges
  const edges = groups.flatMap((g) =>
    g.entryPointIds.map((epId) => ({ epId, bgId: g.id, source: g.source })),
  );
  for (let i = 0; i < edges.length; i += BATCH) {
    await backend
      .executeQuery(
        `UNWIND $edges AS e
       MATCH (ep {id: e.epId}), (bg:BusinessGroup {id: e.bgId})
       MERGE (ep)-[:BELONGS_TO_GROUP {source: e.source, confidence: 0.80}]->(bg)`,
        { edges: edges.slice(i, i + BATCH) },
      )
      .catch((err) =>
        mvLog.warn(LOG, `Failed to create BELONGS_TO_GROUP edges at offset ${i}`, err),
      );
  }
};

// ── Helpers ──

function extractGroupKey(routePath: string, controller: string): string {
  // Primary: use controller name (most reliable for Spring Boot)
  if (controller) {
    return controller.replace(/Controller$/i, '').toLowerCase();
  }
  // Fallback: use first meaningful path segment (skip api/v1/rest and path variables)
  if (routePath) {
    const segments = routePath.split('/').filter(Boolean);
    const meaningful = segments.filter(
      (s) => !s.match(/^(api|v\d+|rest|ws)$/i) && !s.startsWith('{'),
    );
    if (meaningful.length > 0) return meaningful[0].toLowerCase();
  }
  return 'uncategorized';
}

function formatGroupName(key: string): string {
  if (key === 'uncategorized') return 'Uncategorized';
  return key
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

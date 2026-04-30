/**
 * Markdown Wiki Generator — structured docs optimized for AI retrieval via MCP
 *
 * Two modes:
 *   1. Template-based (no LLM) — fast, structured tables from graph data
 *   2. LLM-enriched — feeds graph data into LLM for meaningful, contextual docs
 *
 * Falls back to template-based when LLM is not configured or call fails.
 *
 * Output per service:
 *   {outputDir}/{service-id}/README.md        — overview, stats, quick reference
 *   {outputDir}/{service-id}/api-endpoints.md — HTTP routes with callers
 *   {outputDir}/{service-id}/messaging.md     — Kafka/Rabbit/Redis channels
 *   {outputDir}/{service-id}/dependencies.md  — cross-service upstream/downstream
 *   {outputDir}/{service-id}/config.md        — config keys, unresolved sinks
 *   {outputDir}/README.md                     — index of all services
 */

import fs from 'fs';
import path from 'path';
import { getGraphBackend } from '../../core/graph-backend/index.js';
import { listServices, type ServiceNode } from '../admin/service-registry.js';
import { groupEntrypoints } from '../engine/business-grouper.js';
import { loadConfig } from '../config/loader.js';
import { resolveWikiLLMConfig, callWikiLLM } from './llm-wiki-client.js';
import {
  SERVICE_OVERVIEW_SYSTEM,
  SERVICE_OVERVIEW_PROMPT,
  API_ENDPOINTS_SYSTEM,
  API_ENDPOINTS_PROMPT,
  MESSAGING_SYSTEM,
  MESSAGING_PROMPT,
  DEPENDENCIES_SYSTEM,
  DEPENDENCIES_PROMPT,
  fillPrompt,
} from './prompts.js';
import type { LLMConfig } from '../../core/wiki/llm-client.js';
import { mvLog } from '../util/logger.js';

const LOG = 'md-wiki';

// ── Types ──

interface RouteInfo {
  id: string;
  method: string;
  path: string;
  controller: string;
  calledBy: Array<{ service: string; type: string }>;
}

interface ListenerInfo {
  id: string;
  topic: string;
  resolvedTopic: string;
  type: string;
  name: string;
  calledBy: Array<{ service: string; type: string }>;
}

interface OutboundCall {
  targetService: string;
  type: string;
  target: string; // url or topic
  fromMethod: string;
  confidence: number;
}

interface UnresolvedSink {
  file: string;
  line: number;
  sinkType: string;
  expression: string;
  method: string;
}

interface ServiceWikiData {
  service: ServiceNode;
  routes: RouteInfo[];
  listeners: ListenerInfo[];
  outbound: OutboundCall[];
  inbound: Array<{ fromService: string; type: string; target: string }>;
  unresolved: UnresolvedSink[];
  businessGroups: Array<{ name: string; entryPointCount: number }>;
  libDeps: string[];
  dependedBy: string[];
}

// ── Data Fetching ──

async function fetchServiceWikiData(serviceId: string): Promise<ServiceWikiData | null> {
  const backend = await getGraphBackend();
  const services = await listServices();
  const service = services.find((s) => s.id === serviceId);
  if (!service) return null;

  // Routes with upstream callers
  const routeRows = (await backend
    .executeQuery(
      `MATCH (r:Route {repoId: $id})
     OPTIONAL MATCH (r)-[:SERVES]->(t:Transport)<-[:TRANSPORTS_TO]-(m)
     WHERE m.repoId <> $id AND labels(m)[0] <> 'DetectedSink'
     RETURN r.id AS id, r.httpMethod AS method, r.routePath AS path,
            r.controllerName AS controller,
            collect(DISTINCT {service: m.repoId, type: t.type}) AS calledBy`,
      { id: serviceId },
    )
    .catch(() => [])) as Array<{
    id: string;
    method?: string;
    path?: string;
    controller?: string;
    calledBy: Array<{ service?: string; type?: string }>;
  }>;

  const routes: RouteInfo[] = routeRows.map((r) => ({
    id: r.id,
    method: r.method || 'GET',
    path: r.path || '',
    controller: r.controller || '',
    calledBy: r.calledBy.filter((c) => c.service) as Array<{ service: string; type: string }>,
  }));

  // Listeners with upstream
  const listenerRows = (await backend
    .executeQuery(
      `MATCH (l:Listener {repoId: $id})
     OPTIONAL MATCH (l)-[:SERVES]->(t:Transport)<-[:TRANSPORTS_TO]-(m)
     WHERE m.repoId <> $id AND labels(m)[0] <> 'DetectedSink'
     RETURN l.id AS id, l.topic AS topic, l.resolvedTopic AS resolvedTopic,
            l.listenerType AS type, l.name AS name,
            collect(DISTINCT {service: m.repoId, type: t.type}) AS calledBy`,
      { id: serviceId },
    )
    .catch(() => [])) as Array<{
    id: string;
    topic?: string;
    resolvedTopic?: string;
    type?: string;
    name?: string;
    calledBy: Array<{ service?: string; type?: string }>;
  }>;

  const listeners: ListenerInfo[] = listenerRows.map((l) => ({
    id: l.id,
    topic: l.topic || '',
    resolvedTopic: l.resolvedTopic || l.topic || '',
    type: l.type || 'kafka',
    name: l.name || '',
    calledBy: l.calledBy.filter((c) => c.service) as Array<{ service: string; type: string }>,
  }));

  // Outbound calls (this service → others)
  const outRows = (await backend
    .executeQuery(
      `MATCH (m {repoId: $id})-[r:TRANSPORTS_TO]->(t:Transport)
     WHERE labels(m)[0] <> 'DetectedSink'
     OPTIONAL MATCH (entry)-[:SERVES]->(t) WHERE entry.repoId <> $id
     RETURN entry.repoId AS targetService, t.type AS type, t.name AS target,
            m.name AS fromMethod, r.confidence AS confidence`,
      { id: serviceId },
    )
    .catch(() => [])) as Array<{
    targetService?: string;
    type?: string;
    target?: string;
    fromMethod?: string;
    confidence?: number;
  }>;

  const outbound: OutboundCall[] = outRows
    .filter((o) => o.targetService)
    .map((o) => ({
      targetService: o.targetService!,
      type: o.type || 'http',
      target: o.target || '',
      fromMethod: o.fromMethod || '',
      confidence: o.confidence ?? 0.5,
    }));

  // Inbound calls (others → this service)
  const inRows = (await backend
    .executeQuery(
      `MATCH (entry {repoId: $id})-[:SERVES]->(t:Transport)<-[:TRANSPORTS_TO]-(m)
     WHERE m.repoId <> $id AND labels(m)[0] <> 'DetectedSink'
     RETURN DISTINCT m.repoId AS fromService, t.type AS type, t.name AS target`,
      { id: serviceId },
    )
    .catch(() => [])) as Array<{ fromService?: string; type: string; target: string }>;

  const inbound = inRows.filter((i) => i.fromService) as Array<{
    fromService: string;
    type: string;
    target: string;
  }>;

  // Unresolved sinks
  const unresolvedRows = (await backend
    .executeQuery(
      `MATCH (s:DetectedSink {repoId: $id})
     WHERE NOT (s)-[:TRANSPORTS_TO]->(:Transport)
     RETURN s.filePath AS file, s.lineNumber AS line, s.sinkType AS sinkType,
            s.targetExpression AS expression, s.callSiteMethod AS method
     LIMIT 50`,
      { id: serviceId },
    )
    .catch(() => [])) as Array<{
    file?: string;
    line?: number;
    sinkType?: string;
    expression?: string;
    method?: string;
  }>;

  const unresolved: UnresolvedSink[] = unresolvedRows.map((u) => ({
    file: u.file || '',
    line: u.line || 0,
    sinkType: u.sinkType || '',
    expression: u.expression || '',
    method: u.method || '',
  }));

  // Business groups
  const groups = await groupEntrypoints(serviceId);
  const businessGroups = groups.map((g) => ({
    name: g.name,
    entryPointCount: g.entryPointCount,
  }));

  // Library dependencies
  const libRows = await backend
    .executeQuery(
      `MATCH (s:ServiceNode {id: $id})-[:DEPENDS_ON]->(t:ServiceNode)
     RETURN t.id AS dep`,
      { id: serviceId },
    )
    .catch(() => []);
  const libDeps = libRows.map((r: any) => r.dep);

  // Depended by
  const depByRows = await backend
    .executeQuery(
      `MATCH (s:ServiceNode)-[:DEPENDS_ON]->(t:ServiceNode {id: $id})
     RETURN s.id AS dep`,
      { id: serviceId },
    )
    .catch(() => []);
  const dependedBy = depByRows.map((r: any) => r.dep);

  return {
    service,
    routes,
    listeners,
    outbound,
    inbound,
    unresolved,
    businessGroups,
    libDeps,
    dependedBy,
  };
}

// ── Markdown Renderers ──

function renderServiceReadme(data: ServiceWikiData): string {
  const {
    service: s,
    routes,
    listeners,
    outbound,
    inbound,
    businessGroups,
    libDeps,
    dependedBy,
  } = data;

  const upstreamServices = [...new Set(inbound.map((i) => i.fromService))];
  const downstreamServices = [...new Set(outbound.map((o) => o.targetService))];

  return `# ${s.name}

> Service ID: \`${s.id}\` | Type: \`${s.type}\` | Repo: \`${s.repoProject}/${s.repoSlug}\` (branch: \`${s.repoBranch}\`)

## Overview

| Metric | Count |
|--------|-------|
| API Endpoints | ${routes.length} |
| Message Listeners | ${listeners.length} |
| Business Groups | ${businessGroups.length} |
| Upstream Services (calls me) | ${upstreamServices.length} |
| Downstream Services (I call) | ${downstreamServices.length} |
| Library Dependencies | ${libDeps.length} |
| Unresolved Sinks | ${data.unresolved.length} |

${s.indexedAt ? `Last analyzed: ${s.indexedAt}` : '_Not yet analyzed_'}

## Business Capabilities

${businessGroups.length ? businessGroups.map((g) => `- **${g.name}** — ${g.entryPointCount} entry points`).join('\n') : '_No business groups detected. Run analyze first._'}

## Service Dependencies

### Upstream (services that call this service)
${
  upstreamServices.length
    ? upstreamServices
        .map((svc) => {
          const calls = inbound.filter((i) => i.fromService === svc);
          const types = [...new Set(calls.map((c) => c.type))].join(', ');
          return `- **${svc}** via ${types}`;
        })
        .join('\n')
    : '_No upstream callers detected._'
}

### Downstream (services this service calls)
${
  downstreamServices.length
    ? downstreamServices
        .map((svc) => {
          const calls = outbound.filter((o) => o.targetService === svc);
          const types = [...new Set(calls.map((c) => c.type))].join(', ');
          return `- **${svc}** via ${types}`;
        })
        .join('\n')
    : '_No downstream dependencies detected._'
}

${libDeps.length ? `### Library Dependencies\n${libDeps.map((d) => `- ${d}`).join('\n')}` : ''}
${dependedBy.length ? `### Used By (library consumers)\n${dependedBy.map((d) => `- ${d}`).join('\n')}` : ''}

## Quick Links

- [API Endpoints](./api-endpoints.md) — ${routes.length} HTTP routes
- [Messaging](./messaging.md) — ${listeners.length} listeners
- [Dependencies Detail](./dependencies.md) — cross-service call graph
- [Config & Unresolved](./config.md) — ${data.unresolved.length} unresolved sinks
`;
}

function renderApiEndpoints(data: ServiceWikiData): string {
  const { service: s, routes } = data;

  // Group by controller
  const byController = new Map<string, RouteInfo[]>();
  for (const r of routes) {
    const key = r.controller || 'Unknown';
    if (!byController.has(key)) byController.set(key, []);
    byController.get(key)!.push(r);
  }

  let md = `# API Endpoints — ${s.name}

> ${routes.length} HTTP endpoints across ${byController.size} controllers

`;

  for (const [controller, controllerRoutes] of byController) {
    // Sort by path
    controllerRoutes.sort((a, b) => a.path.localeCompare(b.path));

    md += `## ${controller}\n\n`;
    md += '| Method | Path | Called By |\n';
    md += '|--------|------|----------|\n';

    for (const r of controllerRoutes) {
      const callers = r.calledBy.length
        ? r.calledBy.map((c) => `${c.service} (${c.type})`).join(', ')
        : '—';
      md += `| \`${r.method}\` | \`${r.path}\` | ${callers} |\n`;
    }
    md += '\n';
  }

  return md;
}

function renderMessaging(data: ServiceWikiData): string {
  const { service: s, listeners, outbound } = data;

  // Kafka producers (outbound kafka calls)
  const kafkaOut = outbound.filter((o) => o.type === 'kafka');
  const otherOut = outbound.filter((o) => o.type !== 'kafka' && o.type !== 'http');

  // Group listeners by type
  const kafkaListeners = listeners.filter((l) => l.type === 'kafka');
  const rabbitListeners = listeners.filter((l) => l.type === 'rabbit');
  const redisListeners = listeners.filter((l) => l.type === 'redis');
  const eventListeners = listeners.filter((l) => l.type === 'event');
  const otherListeners = listeners.filter(
    (l) => !['kafka', 'rabbit', 'redis', 'event'].includes(l.type),
  );

  let md = `# Messaging — ${s.name}

> Listeners: ${listeners.length} | Kafka producers: ${kafkaOut.length}

`;

  if (kafkaListeners.length) {
    md += `## Kafka Consumers\n\n`;
    md += '| Topic | Resolved Topic | Handler | Producers |\n';
    md += '|-------|---------------|---------|----------|\n';
    for (const l of kafkaListeners) {
      const producers = l.calledBy.length ? l.calledBy.map((c) => c.service).join(', ') : '—';
      md += `| \`${l.topic}\` | \`${l.resolvedTopic}\` | \`${l.name}\` | ${producers} |\n`;
    }
    md += '\n';
  }

  if (kafkaOut.length) {
    md += `## Kafka Producers\n\n`;
    md += '| Topic/Target | From Method | Target Service | Confidence |\n';
    md += '|-------------|-------------|----------------|------------|\n';
    for (const o of kafkaOut) {
      md += `| \`${o.target}\` | \`${o.fromMethod}\` | ${o.targetService} | ${(o.confidence * 100).toFixed(0)}% |\n`;
    }
    md += '\n';
  }

  if (rabbitListeners.length) {
    md += `## RabbitMQ Consumers\n\n`;
    md += '| Queue/Topic | Handler | Producers |\n';
    md += '|------------|---------|----------|\n';
    for (const l of rabbitListeners) {
      const producers = l.calledBy.length ? l.calledBy.map((c) => c.service).join(', ') : '—';
      md += `| \`${l.resolvedTopic || l.topic}\` | \`${l.name}\` | ${producers} |\n`;
    }
    md += '\n';
  }

  if (redisListeners.length) {
    md += `## Redis Listeners\n\n`;
    md += '| Channel | Handler |\n';
    md += '|---------|--------|\n';
    for (const l of redisListeners) {
      md += `| \`${l.resolvedTopic || l.topic}\` | \`${l.name}\` |\n`;
    }
    md += '\n';
  }

  if (eventListeners.length) {
    md += `## Application Event Listeners\n\n`;
    for (const l of eventListeners) {
      md += `- \`${l.name}\` — ${l.topic || 'internal event'}\n`;
    }
    md += '\n';
  }

  if (otherListeners.length) {
    md += `## Other Listeners\n\n`;
    for (const l of otherListeners) {
      md += `- \`${l.name}\` (${l.type}) — ${l.resolvedTopic || l.topic}\n`;
    }
    md += '\n';
  }

  if (otherOut.length) {
    md += `## Other Outbound Channels\n\n`;
    md += '| Type | Target | From Method | Target Service |\n';
    md += '|------|--------|-------------|----------------|\n';
    for (const o of otherOut) {
      md += `| ${o.type} | \`${o.target}\` | \`${o.fromMethod}\` | ${o.targetService} |\n`;
    }
    md += '\n';
  }

  if (!listeners.length && !kafkaOut.length && !otherOut.length) {
    md += '_No messaging channels detected._\n';
  }

  return md;
}

function renderDependencies(data: ServiceWikiData): string {
  const { service: s, outbound, inbound } = data;

  // Group outbound by target service
  const outByService = new Map<string, OutboundCall[]>();
  for (const o of outbound) {
    if (!outByService.has(o.targetService)) outByService.set(o.targetService, []);
    outByService.get(o.targetService)!.push(o);
  }

  // Group inbound by source service
  const inByService = new Map<string, typeof inbound>();
  for (const i of inbound) {
    if (!inByService.has(i.fromService)) inByService.set(i.fromService, []);
    inByService.get(i.fromService)!.push(i);
  }

  let md = `# Cross-Service Dependencies — ${s.name}

> Upstream: ${inByService.size} services | Downstream: ${outByService.size} services

`;

  if (inByService.size) {
    md += `## Upstream — Who Calls This Service\n\n`;
    for (const [svc, calls] of inByService) {
      md += `### ${svc}\n\n`;
      md += '| Type | Target (this service) |\n';
      md += '|------|----------------------|\n';
      for (const c of calls) {
        md += `| ${c.type} | \`${c.target}\` |\n`;
      }
      md += '\n';
    }
  }

  if (outByService.size) {
    md += `## Downstream — What This Service Calls\n\n`;
    for (const [svc, calls] of outByService) {
      md += `### ${svc}\n\n`;
      md += '| Type | Target | From Method | Confidence |\n';
      md += '|------|--------|-------------|------------|\n';
      for (const c of calls) {
        md += `| ${c.type} | \`${c.target}\` | \`${c.fromMethod}\` | ${(c.confidence * 100).toFixed(0)}% |\n`;
      }
      md += '\n';
    }
  }

  if (!inByService.size && !outByService.size) {
    md += '_No cross-service dependencies detected._\n';
  }

  return md;
}

function renderConfig(data: ServiceWikiData): string {
  const { service: s, unresolved } = data;

  let md = `# Config & Unresolved Sinks — ${s.name}

`;

  if (unresolved.length) {
    md += `## Unresolved Sinks (${unresolved.length})\n\n`;
    md +=
      'These outbound calls could not be resolved to a target service. They may need additional sink patterns or config.\n\n';
    md += '| File | Line | Type | Expression | Method |\n';
    md += '|------|------|------|-----------|--------|\n';
    for (const u of unresolved) {
      const shortFile = u.file.split('/').slice(-3).join('/');
      md += `| \`${shortFile}\` | ${u.line} | ${u.sinkType} | \`${u.expression.slice(0, 60)}\` | \`${u.method}\` |\n`;
    }
  } else {
    md += '_All sinks resolved successfully._\n';
  }

  return md;
}

function renderIndex(services: ServiceNode[], allData: Map<string, ServiceWikiData>): string {
  let md = `# Service Wiki

> Auto-generated documentation for ${services.length} services managed by Multiverse.
> Optimized for AI retrieval. Each service folder contains structured docs about
> API endpoints, messaging channels, cross-service dependencies, and config.

## Services

| Service | Type | Endpoints | Listeners | Upstream | Downstream |
|---------|------|-----------|-----------|----------|------------|
`;

  for (const s of services) {
    const data = allData.get(s.id);
    if (data) {
      const up = new Set(data.inbound.map((i) => i.fromService)).size;
      const down = new Set(data.outbound.map((o) => o.targetService)).size;
      md += `| [${s.name}](./${s.id}/) | ${s.type} | ${data.routes.length} | ${data.listeners.length} | ${up} | ${down} |\n`;
    } else {
      md += `| ${s.name} | ${s.type} | — | — | — | — |\n`;
    }
  }

  md += `\n## Cross-Service Communication Map\n\n`;
  md += '```\n';

  // Build simple text graph
  const edges = new Set<string>();
  for (const [, data] of allData) {
    for (const o of data.outbound) {
      edges.add(`${data.service.id} --[${o.type}]--> ${o.targetService}`);
    }
  }
  if (edges.size) {
    for (const e of edges) md += `${e}\n`;
  } else {
    md += '(no cross-service links detected)\n';
  }
  md += '```\n';

  md += `\n---\nGenerated: ${new Date().toISOString()}\n`;
  return md;
}

// ── LLM Enrichment ──

/** Build prompt vars from service data */
function buildPromptVars(data: ServiceWikiData): Record<string, string> {
  const {
    service: s,
    routes,
    listeners,
    outbound,
    inbound,
    unresolved,
    businessGroups,
    libDeps,
  } = data;

  const routesSummary = routes.length
    ? routes
        .slice(0, 50)
        .map((r) => `${r.method} ${r.path} (${r.controller})`)
        .join('\n')
    : 'None';

  const listenersSummary = listeners.length
    ? listeners
        .slice(0, 30)
        .map((l) => `${l.type}: ${l.resolvedTopic || l.topic} — ${l.name}`)
        .join('\n')
    : 'None';

  const upstream = [...new Set(inbound.map((i) => i.fromService))];
  const downstream = [...new Set(outbound.map((o) => o.targetService))];

  // Routes grouped by controller for API prompt
  const byController = new Map<string, RouteInfo[]>();
  for (const r of routes) {
    const key = r.controller || 'Unknown';
    if (!byController.has(key)) byController.set(key, []);
    byController.get(key)!.push(r);
  }
  const routesByController = [...byController.entries()]
    .map(([ctrl, rs]) => `### ${ctrl}\n${rs.map((r) => `- ${r.method} ${r.path}`).join('\n')}`)
    .join('\n\n');

  const callers =
    routes
      .filter((r) => r.calledBy.length > 0)
      .map(
        (r) =>
          `${r.method} ${r.path} ← ${r.calledBy.map((c) => `${c.service}(${c.type})`).join(', ')}`,
      )
      .join('\n') || 'None';

  const kafkaConsumers =
    listeners
      .filter((l) => l.type === 'kafka')
      .map(
        (l) =>
          `- topic: ${l.resolvedTopic || l.topic}, handler: ${l.name}, producers: ${l.calledBy.map((c) => c.service).join(', ') || 'unknown'}`,
      )
      .join('\n') || 'None';

  const kafkaProducers =
    outbound
      .filter((o) => o.type === 'kafka')
      .map((o) => `- topic: ${o.target}, from: ${o.fromMethod}, to: ${o.targetService}`)
      .join('\n') || 'None';

  const otherChannels =
    [
      ...listeners
        .filter((l) => l.type !== 'kafka')
        .map((l) => `- ${l.type} consumer: ${l.resolvedTopic || l.topic}`),
      ...outbound
        .filter((o) => o.type !== 'kafka' && o.type !== 'http')
        .map((o) => `- ${o.type} producer: ${o.target} → ${o.targetService}`),
    ].join('\n') || 'None';

  const upstreamDetail = inbound.length
    ? inbound.map((i) => `- ${i.fromService} → ${i.target} (${i.type})`).join('\n')
    : 'None';

  const downstreamDetail = outbound.length
    ? outbound
        .map(
          (o) =>
            `- ${o.fromMethod} → ${o.targetService}: ${o.target} (${o.type}, ${(o.confidence * 100).toFixed(0)}%)`,
        )
        .join('\n')
    : 'None';

  return {
    SERVICE_NAME: s.name,
    SERVICE_ID: s.id,
    REPO_PROJECT: s.repoProject,
    REPO_SLUG: s.repoSlug,
    REPO_BRANCH: s.repoBranch,
    SERVICE_TYPE: s.type,
    ROUTE_COUNT: String(routes.length),
    ROUTES_SUMMARY: routesSummary,
    LISTENER_COUNT: String(listeners.length),
    LISTENERS_SUMMARY: listenersSummary,
    BUSINESS_GROUPS:
      businessGroups.map((g) => `- ${g.name} (${g.entryPointCount} entry points)`).join('\n') ||
      'None',
    UPSTREAM: upstream.length ? upstream.join(', ') : 'None',
    DOWNSTREAM: downstream.length ? downstream.join(', ') : 'None',
    LIB_DEPS: libDeps.length ? libDeps.join(', ') : 'None',
    UNRESOLVED_COUNT: String(unresolved.length),
    UNRESOLVED_SUMMARY:
      unresolved
        .slice(0, 20)
        .map((u) => `- ${u.sinkType}: ${u.expression.slice(0, 80)} (${u.file}:${u.line})`)
        .join('\n') || 'None',
    ROUTES_BY_CONTROLLER: routesByController || 'None',
    CALLERS: callers,
    KAFKA_CONSUMERS: kafkaConsumers,
    KAFKA_PRODUCERS: kafkaProducers,
    OTHER_CHANNELS: otherChannels,
    UPSTREAM_DETAIL: upstreamDetail,
    DOWNSTREAM_DETAIL: downstreamDetail,
  };
}

/** Try LLM enrichment for a specific file, fallback to template */
async function enrichWithLLM(
  llmConfig: LLMConfig,
  systemPrompt: string,
  userPromptTemplate: string,
  vars: Record<string, string>,
  templateFallback: string,
  label: string,
): Promise<string> {
  const prompt = fillPrompt(userPromptTemplate, vars);
  const result = await callWikiLLM(prompt, systemPrompt, llmConfig);
  if (result) {
    mvLog.info(LOG, `${label}: LLM enriched`);
    return result;
  }
  mvLog.info(LOG, `${label}: LLM failed, using template`);
  return templateFallback;
}

// ── Public API ──

/** Resolve LLM config once, reuse across calls */
async function getLLMConfig(): Promise<LLMConfig | null> {
  try {
    const config = await loadConfig();
    return resolveWikiLLMConfig(config.wiki?.llm);
  } catch {
    return null;
  }
}

/** Generate wiki markdown files for a single service */
export const generateServiceWiki = async (
  serviceId: string,
  outputDir: string,
): Promise<{ files: string[]; llmEnriched: boolean }> => {
  const data = await fetchServiceWikiData(serviceId);
  if (!data) throw new Error(`Service "${serviceId}" not found`);

  const dir = path.join(outputDir, serviceId);
  fs.mkdirSync(dir, { recursive: true });

  const llmConfig = await getLLMConfig();
  let llmEnriched = false;

  let files: Array<[string, string]>;

  if (llmConfig) {
    const vars = buildPromptVars(data);
    mvLog.info(LOG, `${serviceId}: generating with LLM enrichment (${llmConfig.model})`);

    const [readme, apiEndpoints, messaging, dependencies] = await Promise.all([
      enrichWithLLM(
        llmConfig,
        SERVICE_OVERVIEW_SYSTEM,
        SERVICE_OVERVIEW_PROMPT,
        vars,
        renderServiceReadme(data),
        `${serviceId}/README`,
      ),
      enrichWithLLM(
        llmConfig,
        API_ENDPOINTS_SYSTEM,
        API_ENDPOINTS_PROMPT,
        vars,
        renderApiEndpoints(data),
        `${serviceId}/api-endpoints`,
      ),
      enrichWithLLM(
        llmConfig,
        MESSAGING_SYSTEM,
        MESSAGING_PROMPT,
        vars,
        renderMessaging(data),
        `${serviceId}/messaging`,
      ),
      enrichWithLLM(
        llmConfig,
        DEPENDENCIES_SYSTEM,
        DEPENDENCIES_PROMPT,
        vars,
        renderDependencies(data),
        `${serviceId}/dependencies`,
      ),
    ]);

    files = [
      ['README.md', readme],
      ['api-endpoints.md', apiEndpoints],
      ['messaging.md', messaging],
      ['dependencies.md', dependencies],
      ['config.md', renderConfig(data)], // config/unresolved always template — factual data only
    ];
    llmEnriched = true;
  } else {
    files = [
      ['README.md', renderServiceReadme(data)],
      ['api-endpoints.md', renderApiEndpoints(data)],
      ['messaging.md', renderMessaging(data)],
      ['dependencies.md', renderDependencies(data)],
      ['config.md', renderConfig(data)],
    ];
  }

  const written: string[] = [];
  for (const [name, content] of files) {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, content, 'utf-8');
    written.push(filePath);
  }

  mvLog.info(
    LOG,
    `${serviceId}: wrote ${written.length} wiki files to ${dir} (llm: ${llmEnriched})`,
  );
  return { files: written, llmEnriched };
};

/** Generate wiki for all services + index */
export const generateAllWiki = async (
  outputDir: string,
): Promise<{ services: number; files: string[]; llmEnriched: boolean }> => {
  const services = await listServices();
  if (!services.length) throw new Error('No services registered');

  fs.mkdirSync(outputDir, { recursive: true });

  const allData = new Map<string, ServiceWikiData>();
  const allFiles: string[] = [];
  let llmEnriched = false;

  for (const s of services) {
    try {
      const data = await fetchServiceWikiData(s.id);
      if (data) {
        allData.set(s.id, data);
        const result = await generateServiceWiki(s.id, outputDir);
        allFiles.push(...result.files);
        if (result.llmEnriched) llmEnriched = true;
      }
    } catch (err: any) {
      mvLog.warn(LOG, `Skipping ${s.id}: ${err.message}`);
    }
  }

  // Write index (always template — it's a navigation page)
  const indexPath = path.join(outputDir, 'README.md');
  fs.writeFileSync(indexPath, renderIndex(services, allData), 'utf-8');
  allFiles.push(indexPath);

  mvLog.info(
    LOG,
    `Wiki generated: ${services.length} services, ${allFiles.length} files → ${outputDir} (llm: ${llmEnriched})`,
  );
  return { services: services.length, files: allFiles, llmEnriched };
};

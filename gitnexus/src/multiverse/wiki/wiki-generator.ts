/**
 * Entrypoint-Centric Wiki Generator
 *
 * Generates HTML wiki pages per service showing:
 * - Overview with stats
 * - Business groups with entrypoints
 * - Per-entrypoint: upstream, internal flow, downstream, config deps
 */

import { getGraphBackend } from '../../core/graph-backend/index.js';
import { groupEntrypoints } from '../engine/business-grouper.js';

export interface WikiData {
  serviceId: string;
  generatedAt: string;
  overview: { entryPointCount: number; businessGroupCount: number; crossLinkCount: number };
  businessGroups: Array<{
    name: string;
    entryPoints: Array<{
      id: string;
      type: string;
      method?: string;
      path?: string;
      upstream: Array<{ service: string; type: string; confidence: number }>;
      downstream: Array<{
        service: string;
        type: string;
        topic?: string;
        url?: string;
        confidence: number;
      }>;
    }>;
  }>;
}

/** Generate wiki data (JSON) for a service */
export const generateWikiData = async (serviceId: string): Promise<WikiData> => {
  const backend = await getGraphBackend();
  const groups = await groupEntrypoints(serviceId);

  const businessGroups = [];
  let totalCrossLinks = 0;

  for (const group of groups) {
    const entryPoints = [];
    for (const epId of group.entryPointIds.slice(0, 30)) {
      // Limit per group
      const ep = await getEntryPointDetail(backend, epId);
      if (ep) {
        totalCrossLinks += ep.upstream.length + ep.downstream.length;
        entryPoints.push(ep);
      }
    }
    businessGroups.push({ name: group.name, entryPoints });
  }

  const totalEps = groups.reduce((s, g) => s + g.entryPointCount, 0);

  return {
    serviceId,
    generatedAt: new Date().toISOString(),
    overview: {
      entryPointCount: totalEps,
      businessGroupCount: groups.length,
      crossLinkCount: totalCrossLinks,
    },
    businessGroups,
  };
};

/** Generate HTML wiki page for a service */
export const generateWikiHtml = async (serviceId: string): Promise<string> => {
  const data = await generateWikiData(serviceId);
  return renderHtml(data);
};

async function getEntryPointDetail(backend: any, epId: string) {
  // Get basic info
  const info = await backend
    .executeQuery(
      `MATCH (n {id: $epId}) RETURN n.id AS id, n.name AS name, n.routePath AS path, n.httpMethod AS method, n.topic AS topic, labels(n) AS labels`,
      { epId },
    )
    .catch(() => []);
  if (!info.length) return null;

  const ep = info[0];
  const type = ep.path ? 'route' : 'listener';

  // Upstream: who calls this via Transport
  const upstream = await backend
    .executeQuery(
      `
    MATCH (ep {id: $epId})-[:SERVES]->(t:Transport)<-[:TRANSPORTS_TO]-(m)
    WHERE labels(m)[0] <> 'DetectedSink'
    RETURN m.repoId AS service, t.type AS type, 0.9 AS confidence
  `,
      { epId },
    )
    .catch(() => []);

  // Downstream: what does this flow call via Transport
  const downstream = await backend
    .executeQuery(
      `
    MATCH (ep {id: $epId})<-[:CodeRelation*1..8 {type: 'CALLS'}]-(n)
    MATCH (n)-[r:TRANSPORTS_TO]->(t:Transport)
    WHERE labels(n)[0] <> 'DetectedSink'
    OPTIONAL MATCH (entry)-[:SERVES]->(t) WHERE entry.repoId <> n.repoId
    RETURN entry.repoId AS service, t.type AS type,
      CASE WHEN t.type = 'api' THEN t.name ELSE null END AS url,
      CASE WHEN t.type <> 'api' THEN t.name ELSE null END AS topic,
      r.confidence AS confidence
  `,
      { epId },
    )
    .catch(() => []);

  return {
    id: ep.id,
    type,
    method: ep.method,
    path: ep.path || ep.topic,
    upstream: upstream.filter((u: any) => u.service),
    downstream: downstream.filter((d: any) => d.service || d.topic),
  };
}

// ── HTML Renderer ──

function renderHtml(data: WikiData): string {
  const { serviceId, overview, businessGroups } = data;

  const groupsHtml = businessGroups
    .map(
      (g) => `
    <div class="group">
      <h3>📋 ${h(g.name)} <span class="count">${g.entryPoints.length}</span></h3>
      ${g.entryPoints.map((ep) => renderEntryPoint(ep)).join('\n')}
    </div>
  `,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Wiki — ${h(serviceId)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 24px; max-width: 1000px; margin: 0 auto; }
  h1 { margin-bottom: 8px; } h2 { margin: 24px 0 12px; color: #a29bfe; } h3 { margin: 16px 0 8px; }
  a { color: #6c5ce7; } code { background: #16213e; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin: 16px 0; }
  .stat { background: #16213e; border-radius: 8px; padding: 16px; text-align: center; }
  .stat .val { font-size: 28px; font-weight: 700; color: #6c5ce7; }
  .stat .lbl { font-size: 12px; color: #888; margin-top: 4px; }
  .group { margin: 16px 0; padding: 16px; background: #16213e; border-radius: 8px; }
  .count { font-size: 12px; color: #888; font-weight: 400; }
  .ep { margin: 12px 0; padding: 12px; background: #1a1a2e; border-radius: 6px; border-left: 3px solid #6c5ce7; }
  .ep-title { font-weight: 600; margin-bottom: 8px; }
  .method { display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: 600; }
  .method.get { background: #00b894; color: #fff; } .method.post { background: #e17055; color: #fff; }
  .method.put { background: #fdcb6e; color: #333; } .method.delete { background: #d63031; color: #fff; }
  .links { font-size: 13px; color: #aaa; margin-top: 6px; }
  .links span { margin-right: 12px; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 11px; }
  .badge.http { background: rgba(116,185,255,.15); color: #74b9ff; }
  .badge.kafka { background: rgba(253,203,110,.15); color: #fdcb6e; }
  .back { margin-bottom: 16px; display: inline-block; }
  .generated { font-size: 11px; color: #666; margin-top: 24px; }
</style>
</head><body>
<a href="/" class="back">← Dashboard</a>
<h1>📖 ${h(serviceId)}</h1>
<div class="stats">
  <div class="stat"><div class="val">${overview.entryPointCount}</div><div class="lbl">Entry Points</div></div>
  <div class="stat"><div class="val">${overview.businessGroupCount}</div><div class="lbl">Business Groups</div></div>
  <div class="stat"><div class="val">${overview.crossLinkCount}</div><div class="lbl">Cross-Service Links</div></div>
</div>
<h2>Business Groups</h2>
${groupsHtml || '<p style="color:#888">No entrypoints found. Run analyze first.</p>'}
<div class="generated">Generated: ${data.generatedAt}</div>
</body></html>`;
}

function renderEntryPoint(ep: any): string {
  const methodClass = (ep.method || 'get').toLowerCase();
  const title = ep.method
    ? `<span class="method ${methodClass}">${ep.method}</span> ${h(ep.path || '')}`
    : h(ep.path || ep.id);

  const upstreamHtml = ep.upstream.length
    ? ep.upstream
        .map((u: any) => `<span class="badge ${u.type}">${h(u.service)} (${u.type})</span>`)
        .join(' ')
    : '<span style="color:#666">none</span>';

  const downstreamHtml = ep.downstream.length
    ? ep.downstream
        .map(
          (d: any) =>
            `<span class="badge ${d.type}">${h(d.service || d.topic || '?')} (${d.type})</span>`,
        )
        .join(' ')
    : '<span style="color:#666">none</span>';

  return `<div class="ep">
  <div class="ep-title">${title}</div>
  <div class="links"><span>📥 Upstream: ${upstreamHtml}</span></div>
  <div class="links"><span>📤 Downstream: ${downstreamHtml}</span></div>
</div>`;
}

const h = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

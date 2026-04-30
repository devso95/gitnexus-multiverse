/**
 * Query MCP Tool Handler — raw Cypher + symbol search
 *
 * Extracted from tool-handlers.ts for modularity.
 */

import { getGraphBackend } from '../../core/graph-backend/index.js';

// ── Allowed node labels for search/filter (whitelist) ──

const ALLOWED_NODE_LABELS = new Set([
  'Method',
  'Class',
  'Interface',
  'Route',
  'Listener',
  'Process',
  'Enum',
  'Constructor',
  'Function',
  'File',
  'Folder',
  'Property',
  'Variable',
  'Const',
  'Struct',
  'Trait',
  'Impl',
  'TypeAlias',
  'Module',
  'Namespace',
  'Record',
  'Delegate',
  'Annotation',
  'Template',
  'Community',
  'Transport',
  'Gateway',
  'ServiceNode',
  'DetectedSink',
]);

const DEFAULT_SEARCH_LABELS = [
  'Method',
  'Class',
  'Interface',
  'Route',
  'Listener',
  'Process',
  'Enum',
  'Constructor',
];

/** Sanitize comma-separated label string → validated array */
export function sanitizeLabels(input: string | undefined, defaults: string[]): string[] {
  if (!input) return defaults;
  return input
    .split(',')
    .map((l: string) => l.trim())
    .filter((l) => ALLOWED_NODE_LABELS.has(l));
}

// ── Cypher read-only validation ──

const CYPHER_WRITE_KEYWORDS = /\b(CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|CALL\s*\{|FOREACH)\b/i;

function validateReadOnlyCypher(query: string): string | null {
  const stripped = query
    .replace(/'[^']*'|"[^"]*"/g, '""')
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  if (CYPHER_WRITE_KEYWORDS.test(stripped)) {
    return 'Write operations not allowed via query tool. Use the REST API for mutations.';
  }
  return null;
}

// ── cypher ──

export async function handleCypher(params: Record<string, unknown>) {
  const query = params.query as string;
  const service = params.service as string | undefined;
  if (!query) return { error: 'Required: query' };

  const writeErr = validateReadOnlyCypher(query);
  if (writeErr) return { error: writeErr };

  const backend = await getGraphBackend();
  const queryParams: Record<string, unknown> = {};
  if (service) queryParams.service = service;

  try {
    const rows = await backend.executeQuery(query, queryParams);
    return { rows: rows.slice(0, 100), rowCount: rows.length, truncated: rows.length > 100 };
  } catch (err: unknown) {
    return { error: `Cypher error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── search ──

export async function handleSearch(params: Record<string, unknown>) {
  const query = params.query as string;
  const service = params.service as string | undefined;
  const nodeLabels = params.nodeLabels as string | undefined;
  const limit = Number(params.limit || 20);
  if (!query) return { error: 'Required: query' };

  const backend = await getGraphBackend();

  const labels = sanitizeLabels(nodeLabels, DEFAULT_SEARCH_LABELS);
  if (!labels.length) return { error: 'No valid node labels provided' };

  const serviceFilter = service ? `AND n.repoId = $service` : '';
  const safeLimit = Math.min(Number(limit) || 20, 50);

  const terms = query.split(/[|,\s]+/).filter(Boolean);
  const escaped = terms.map((t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = `(?i).*(${escaped.join('|')}).*`;

  const rows = await backend
    .executeQuery(
      `MATCH (n)
     WHERE labels(n)[0] IN $labels
       AND (n.name =~ $pattern OR n.filePath =~ $pattern OR coalesce(n.qualifiedName, '') =~ $pattern)
       ${serviceFilter}
     RETURN n.id AS id, n.name AS name, labels(n)[0] AS label, n.filePath AS file,
            n.repoId AS service, n.startLine AS line, n.qualifiedName AS qualifiedName
     ORDER BY
       CASE WHEN n.name =~ $exact THEN 0 WHEN n.filePath =~ $exact THEN 1 ELSE 2 END,
       CASE labels(n)[0] WHEN 'Class' THEN 0 WHEN 'Route' THEN 1 WHEN 'Interface' THEN 2 WHEN 'Method' THEN 3 ELSE 4 END,
       size(n.name)
     LIMIT ${safeLimit}`,
      { labels, pattern, exact: `(?i).*(${escaped.join('|')}).*`, ...(service ? { service } : {}) },
    )
    .catch(() => []);

  return { results: rows, total: rows.length };
}

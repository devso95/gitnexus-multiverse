import {
  getEntrypointDisplayKind,
  matchesEntrypointSeedType,
  normalizeEntrypointSeedType,
  type EntrypointDisplayKind,
  type EntrypointSeedType,
} from '../engine/entrypoint-kind.js';

export type GraphSeedType = EntrypointSeedType | 'SINK';

export interface GraphSeedCandidate {
  id: string;
  label?: string | null;
  listenerType?: string | null;
}

export interface GraphSeedCountRow {
  label?: string | null;
  listenerType?: string | null;
  count?: number | null;
}

export interface GraphSeedOption {
  value: GraphSeedType;
  label: string;
  count: number;
}

const GRAPH_SEED_ORDER: GraphSeedType[] = [
  'ENTRYPOINT',
  'API',
  'MCP_TOOL',
  'MESSAGE',
  'SCHEDULED',
  'SINK',
  'Class',
  'Interface',
  'Method',
];

const GRAPH_SEED_LABELS: Record<GraphSeedType, string> = {
  ENTRYPOINT: 'Entrypoints',
  API: 'API',
  MCP_TOOL: 'MCP Tools',
  MESSAGE: 'Messages',
  SCHEDULED: 'Scheduled',
  SINK: 'Sinks',
  Class: 'Classes',
  Interface: 'Interfaces',
  Method: 'Methods',
  'Route,Listener': 'Legacy Entrypoints',
};

function getCandidateBucket(candidate: {
  label?: string | null;
  listenerType?: string | null;
}): GraphSeedType | 'OTHER' {
  switch (candidate.label) {
    case 'DetectedSink':
      return 'SINK';
    case 'Class':
      return 'Class';
    case 'Interface':
      return 'Interface';
    case 'Method':
      return 'Method';
    default:
      return getEntrypointDisplayKind(candidate) as EntrypointDisplayKind | 'OTHER';
  }
}

export function normalizeGraphSeedType(seedType?: string | null): GraphSeedType {
  const normalized = (seedType || '').trim().toUpperCase();
  if (normalized === 'SINK') return 'SINK';
  return normalizeEntrypointSeedType(seedType);
}

export function matchesGraphSeedType(
  candidate: { label?: string | null; listenerType?: string | null },
  seedType?: string | null,
): boolean {
  const normalized = normalizeGraphSeedType(seedType);
  if (normalized === 'SINK') return candidate.label === 'DetectedSink';
  return matchesEntrypointSeedType(candidate, normalized);
}

export function buildAvailableGraphSeeds(rows: GraphSeedCountRow[]): GraphSeedOption[] {
  const counts = new Map<GraphSeedType, number>();

  for (const row of rows) {
    const count = Number(row.count) || 0;
    if (count <= 0) continue;

    const bucket = getCandidateBucket(row);
    if (bucket === 'OTHER') continue;

    counts.set(bucket, (counts.get(bucket) || 0) + count);
    if (
      bucket === 'API' ||
      bucket === 'MCP_TOOL' ||
      bucket === 'MESSAGE' ||
      bucket === 'SCHEDULED'
    ) {
      counts.set('ENTRYPOINT', (counts.get('ENTRYPOINT') || 0) + count);
    }
  }

  return GRAPH_SEED_ORDER.filter((value) => (counts.get(value) || 0) > 0).map((value) => ({
    value,
    label: GRAPH_SEED_LABELS[value],
    count: counts.get(value) || 0,
  }));
}

export function pickGraphSeedIds(
  candidates: GraphSeedCandidate[],
  seedType?: string | null,
  limit: number = 50,
): string[] {
  const normalized = normalizeGraphSeedType(seedType);
  const max = Math.max(1, Math.min(Number(limit) || 50, 200));
  const filtered = candidates.filter((candidate) => matchesGraphSeedType(candidate, normalized));

  if (normalized !== 'ENTRYPOINT') {
    return filtered.slice(0, max).map((candidate) => candidate.id);
  }

  const bucketOrder: Array<Extract<GraphSeedType, 'API' | 'MCP_TOOL' | 'MESSAGE' | 'SCHEDULED'>> = [
    'API',
    'MCP_TOOL',
    'MESSAGE',
    'SCHEDULED',
  ];
  const buckets = new Map<(typeof bucketOrder)[number], GraphSeedCandidate[]>();
  bucketOrder.forEach((bucket) => buckets.set(bucket, []));

  for (const candidate of filtered) {
    const bucket = getCandidateBucket(candidate);
    if (
      bucket === 'API' ||
      bucket === 'MCP_TOOL' ||
      bucket === 'MESSAGE' ||
      bucket === 'SCHEDULED'
    ) {
      buckets.get(bucket)?.push(candidate);
    }
  }

  const selected: string[] = [];
  while (selected.length < max) {
    let advanced = false;
    for (const bucket of bucketOrder) {
      const next = buckets.get(bucket)?.shift();
      if (!next) continue;
      selected.push(next.id);
      advanced = true;
      if (selected.length >= max) break;
    }
    if (!advanced) break;
  }

  if (selected.length > 0) return selected;
  return filtered.slice(0, max).map((candidate) => candidate.id);
}

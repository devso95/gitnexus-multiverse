export type EntrypointDisplayKind = 'API' | 'MCP_TOOL' | 'MESSAGE' | 'SCHEDULED' | 'OTHER';

export type EntrypointSeedType =
  | 'ENTRYPOINT'
  | 'API'
  | 'MCP_TOOL'
  | 'MESSAGE'
  | 'SCHEDULED'
  | 'Class'
  | 'Interface'
  | 'Method'
  | 'Route,Listener';

export interface EntrypointCandidate {
  label?: string | null;
  listenerType?: string | null;
}

const SCHEDULED_LISTENER_TYPES = new Set(['scheduled', 'job', 'cron', 'timer', 'recurring']);

export function normalizeEntrypointSeedType(seedType?: string | null): EntrypointSeedType {
  const normalized = (seedType || 'ENTRYPOINT').trim().toUpperCase();
  switch (normalized) {
    case 'API':
      return 'API';
    case 'MCP_TOOL':
      return 'MCP_TOOL';
    case 'MESSAGE':
      return 'MESSAGE';
    case 'SCHEDULED':
      return 'SCHEDULED';
    case 'CLASS':
      return 'Class';
    case 'INTERFACE':
      return 'Interface';
    case 'METHOD':
      return 'Method';
    case 'ROUTE,LISTENER':
      return 'Route,Listener';
    case 'ENTRYPOINT':
    default:
      return 'ENTRYPOINT';
  }
}

export function isScheduledListenerType(listenerType?: string | null): boolean {
  if (!listenerType) return false;
  return SCHEDULED_LISTENER_TYPES.has(listenerType.trim().toLowerCase());
}

export function getEntrypointDisplayKind(candidate: EntrypointCandidate): EntrypointDisplayKind {
  if (candidate.label === 'Route') return 'API';
  if (candidate.label === 'Tool') return 'MCP_TOOL';
  if (candidate.label === 'Listener') {
    return isScheduledListenerType(candidate.listenerType) ? 'SCHEDULED' : 'MESSAGE';
  }
  return 'OTHER';
}

export function matchesEntrypointSeedType(
  candidate: EntrypointCandidate,
  seedType?: string | null,
): boolean {
  const normalized = normalizeEntrypointSeedType(seedType);
  const kind = getEntrypointDisplayKind(candidate);

  switch (normalized) {
    case 'ENTRYPOINT':
      return kind !== 'OTHER';
    case 'Route,Listener':
      return kind === 'API' || kind === 'MESSAGE' || kind === 'SCHEDULED';
    case 'API':
      return kind === 'API';
    case 'MCP_TOOL':
      return kind === 'MCP_TOOL';
    case 'MESSAGE':
      return kind === 'MESSAGE';
    case 'SCHEDULED':
      return kind === 'SCHEDULED';
    default:
      return candidate.label === normalized;
  }
}

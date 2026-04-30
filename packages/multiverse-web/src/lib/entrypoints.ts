export type EntryPointKind = 'API' | 'MCP_TOOL' | 'MESSAGE' | 'SCHEDULED' | 'OTHER';

export type SeedType =
  | 'ENTRYPOINT'
  | 'API'
  | 'MCP_TOOL'
  | 'MESSAGE'
  | 'SCHEDULED'
  | 'SINK'
  | 'Class'
  | 'Interface'
  | 'Method';

export interface SeedOption {
  value: SeedType;
  label: string;
  count?: number;
  icon?: string;
}

export interface EntryPointLike {
  kind?: string;
  label?: string;
  listenerType?: string;
  routePath?: string;
  httpMethod?: string;
  topic?: string;
  path?: string;
  method?: string;
  name?: string;
}

export const SEED_OPTIONS: Array<{ value: SeedType; label: string }> = [
  { value: 'ENTRYPOINT', label: 'Entrypoints' },
  { value: 'API', label: 'API' },
  { value: 'MCP_TOOL', label: 'MCP Tools' },
  { value: 'MESSAGE', label: 'Messages' },
  { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'SINK', label: 'Sinks' },
  { value: 'Class', label: 'Classes' },
  { value: 'Interface', label: 'Interfaces' },
];

const SEED_META: Record<SeedType, { label: string; icon: string }> = {
  ENTRYPOINT: { label: 'Entrypoints', icon: '⚡' },
  API: { label: 'API', icon: '🌐' },
  MCP_TOOL: { label: 'MCP Tools', icon: '🛠️' },
  MESSAGE: { label: 'Messages', icon: '📡' },
  SCHEDULED: { label: 'Scheduled', icon: '⏰' },
  SINK: { label: 'Sinks', icon: '🪤' },
  Class: { label: 'Classes', icon: '🧱' },
  Interface: { label: 'Interfaces', icon: '🧩' },
  Method: { label: 'Methods', icon: 'ƒ' },
};

export function getSeedMeta(seed: string | undefined): { label: string; icon: string } {
  if (!seed) return { label: 'Other', icon: '•' };
  return SEED_META[seed as SeedType] || { label: seed, icon: '•' };
}

export function buildSeedOptions(
  options?: Array<Partial<SeedOption> & { value: string }>,
): SeedOption[] {
  if (!options?.length) {
    return SEED_OPTIONS.map((option) => ({
      ...option,
      icon: getSeedMeta(option.value).icon,
    }));
  }

  return options.map((option) => {
    const meta = getSeedMeta(option.value);
    return {
      value: option.value as SeedType,
      label: option.label || meta.label,
      count: option.count,
      icon: option.icon || meta.icon,
    };
  });
}

export function getEntryPointKind(entry: EntryPointLike): EntryPointKind {
  if (
    entry.kind === 'API' ||
    entry.kind === 'MCP_TOOL' ||
    entry.kind === 'MESSAGE' ||
    entry.kind === 'SCHEDULED'
  ) {
    return entry.kind;
  }
  if (entry.label === 'Route' || entry.routePath || entry.path) return 'API';
  if (entry.label === 'Tool') return 'MCP_TOOL';
  if (entry.label === 'Listener') {
    const normalized = (entry.listenerType || '').toLowerCase();
    return ['scheduled', 'job', 'cron', 'timer', 'recurring'].includes(normalized)
      ? 'SCHEDULED'
      : 'MESSAGE';
  }
  return 'OTHER';
}

export function getEntryPointKindMeta(kind: string | undefined): {
  label: string;
  icon: string;
} {
  switch (kind) {
    case 'API':
      return { label: 'API', icon: '🌐' };
    case 'MCP_TOOL':
      return { label: 'MCP Tool', icon: '🛠️' };
    case 'MESSAGE':
      return { label: 'Message', icon: '📡' };
    case 'SCHEDULED':
      return { label: 'Scheduled', icon: '⏰' };
    default:
      return { label: 'Other', icon: '•' };
  }
}

export function getEntryPointDisplayName(entry: EntryPointLike): string {
  const method = entry.httpMethod || entry.method || '';
  const path = entry.routePath || entry.path || '';
  if (path) return `${method} ${path}`.trim();
  if (entry.topic) return entry.topic;
  return entry.name || 'Unnamed entrypoint';
}

export function getMethodToneClass(method?: string): string {
  switch (method) {
    case 'GET':
      return 'text-ok';
    case 'POST':
      return 'text-info';
    case 'PUT':
      return 'text-warn';
    case 'DELETE':
      return 'text-err';
    case 'SOAP':
      return 'text-amber-400';
    default:
      return 'text-text2';
  }
}

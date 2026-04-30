import { describe, expect, it } from 'vitest';
import {
  SEED_OPTIONS,
  getEntryPointDisplayName,
  getEntryPointKind,
  getEntryPointKindMeta,
  getMethodToneClass,
} from './entrypoints';

describe('entrypoints ui helpers', () => {
  it('exposes normalized seed options including MCP tools', () => {
    expect(SEED_OPTIONS.map((option) => option.value)).toEqual(
      expect.arrayContaining(['ENTRYPOINT', 'API', 'MCP_TOOL', 'MESSAGE', 'SCHEDULED']),
    );
  });

  it('detects entrypoint kind from node shape', () => {
    expect(getEntryPointKind({ label: 'Route', routePath: '/api/orders' })).toBe('API');
    expect(getEntryPointKind({ label: 'Tool', name: 'listServices' })).toBe('MCP_TOOL');
    expect(getEntryPointKind({ label: 'Listener', listenerType: 'kafka' })).toBe('MESSAGE');
    expect(getEntryPointKind({ label: 'Listener', listenerType: 'cron' })).toBe('SCHEDULED');
  });

  it('formats entrypoint display names and metadata consistently', () => {
    expect(getEntryPointDisplayName({ httpMethod: 'POST', routePath: '/api/orders' })).toBe(
      'POST /api/orders',
    );
    expect(getEntryPointDisplayName({ topic: 'orders.created' })).toBe('orders.created');
    expect(getEntryPointDisplayName({ name: 'syncOrders' })).toBe('syncOrders');
    expect(getEntryPointKindMeta('MCP_TOOL')).toEqual({ label: 'MCP Tool', icon: '🛠️' });
    expect(getMethodToneClass('DELETE')).toBe('text-err');
  });
});

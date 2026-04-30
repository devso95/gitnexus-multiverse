import { describe, expect, it } from 'vitest';
import {
  getEntrypointDisplayKind,
  matchesEntrypointSeedType,
  normalizeEntrypointSeedType,
} from '../../src/multiverse/engine/entrypoint-kind.js';

describe('entrypoint-kind', () => {
  it('normalizes legacy and new seed types', () => {
    expect(normalizeEntrypointSeedType()).toBe('ENTRYPOINT');
    expect(normalizeEntrypointSeedType('api')).toBe('API');
    expect(normalizeEntrypointSeedType('mcp_tool')).toBe('MCP_TOOL');
    expect(normalizeEntrypointSeedType('Route,Listener')).toBe('Route,Listener');
    expect(normalizeEntrypointSeedType('unknown')).toBe('ENTRYPOINT');
  });

  it('maps route, listener, and tool nodes to normalized display kinds', () => {
    expect(getEntrypointDisplayKind({ label: 'Route' })).toBe('API');
    expect(getEntrypointDisplayKind({ label: 'Tool' })).toBe('MCP_TOOL');
    expect(getEntrypointDisplayKind({ label: 'Listener', listenerType: 'scheduled' })).toBe(
      'SCHEDULED',
    );
    expect(getEntrypointDisplayKind({ label: 'Listener', listenerType: 'kafka' })).toBe('MESSAGE');
  });

  it('matches candidates against normalized seed filters', () => {
    const api = { label: 'Route' };
    const tool = { label: 'Tool' };
    const message = { label: 'Listener', listenerType: 'rabbit' };
    const scheduled = { label: 'Listener', listenerType: 'cron' };

    expect(matchesEntrypointSeedType(api, 'ENTRYPOINT')).toBe(true);
    expect(matchesEntrypointSeedType(tool, 'ENTRYPOINT')).toBe(true);
    expect(matchesEntrypointSeedType(tool, 'MCP_TOOL')).toBe(true);
    expect(matchesEntrypointSeedType(tool, 'API')).toBe(false);
    expect(matchesEntrypointSeedType(message, 'MESSAGE')).toBe(true);
    expect(matchesEntrypointSeedType(message, 'Route,Listener')).toBe(true);
    expect(matchesEntrypointSeedType(scheduled, 'MESSAGE')).toBe(false);
    expect(matchesEntrypointSeedType(scheduled, 'SCHEDULED')).toBe(true);
  });
});

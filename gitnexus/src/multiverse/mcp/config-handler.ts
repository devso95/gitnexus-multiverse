/**
 * Config MCP Tool Handler — direct config lookup, search, list
 *
 * Actions: lookup, search, list, sources
 * Enables LLM to query config keys directly instead of relying on filtered analyze output.
 */

import { resolveConfig, lookupConfig } from '../engine/config-resolver.js';
import { loadConfig } from '../config/loader.js';
import path from 'path';
import { resolveServiceRepoPath } from '../util/repo-path.js';

export async function handleConfig(params: Record<string, unknown>): Promise<unknown> {
  const { action } = params;
  switch (action) {
    case 'lookup':
      return configLookup(params);
    case 'search':
      return configSearch(params);
    case 'list':
      return configList(params);
    case 'sources':
      return configSources(params);
    default:
      return { error: `Unknown action: ${action}. Use: lookup, search, list, sources` };
  }
}

async function getConfigMap(service: string): Promise<Map<string, string>> {
  const repoPath = (await resolveServiceRepoPath(service)).repoPath;
  return resolveConfig(service, repoPath);
}

// ── lookup: resolve a single config key ──

async function configLookup(params: Record<string, unknown>) {
  const service = params.service as string;
  const key = params.key as string;
  if (!service || !key) return { error: 'Required: service, key' };

  const configMap = await getConfigMap(service);
  const value = lookupConfig(configMap, key);

  return value !== null
    ? { key, value, resolved: true }
    : {
        key,
        value: null,
        resolved: false,
        hint: `Key not found. Use config(search, pattern) to find similar keys.`,
      };
}

// ── search: fuzzy search config keys by pattern ──

async function configSearch(params: Record<string, unknown>) {
  const service = params.service as string;
  const pattern = params.pattern as string;
  const limit = Number(params.limit || 30);
  if (!service || !pattern) return { error: 'Required: service, pattern' };

  const configMap = await getConfigMap(service);

  // Support glob-like patterns: *.url, kafka.*.topic
  const regexStr = pattern.replace(/\./g, '\\.').replace(/\*/g, '.*');
  const regex = new RegExp(regexStr, 'i');

  const matches: Array<{ key: string; value: string }> = [];
  for (const [key, rawValue] of configMap) {
    if (matches.length >= limit) break;
    if (regex.test(key)) {
      const value = lookupConfig(configMap, key) || rawValue;
      matches.push({ key, value });
    }
  }

  return { pattern, matches, total: matches.length };
}

// ── list: all config keys, optionally filtered by prefix ──

async function configList(params: Record<string, unknown>) {
  const service = params.service as string;
  const prefix = params.prefix as string | undefined;
  const limit = Number(params.limit || 100);
  if (!service) return { error: 'Required: service' };

  const configMap = await getConfigMap(service);
  const entries: Array<{ key: string; value: string }> = [];
  const prefixLower = prefix?.toLowerCase();

  for (const [key, rawValue] of configMap) {
    if (entries.length >= limit) break;
    if (prefixLower && !key.toLowerCase().startsWith(prefixLower)) continue;
    const value = lookupConfig(configMap, key) || rawValue;
    entries.push({ key, value });
  }

  return {
    service,
    prefix: prefix || null,
    entries,
    total: entries.length,
    totalKeys: configMap.size,
  };
}

// ── sources: list active config sources ──

async function configSources(params: Record<string, unknown>) {
  const service = params.service as string;
  if (!service) return { error: 'Required: service' };

  const config = await loadConfig();
  const repoPath = (await resolveServiceRepoPath(service)).repoPath;

  // Check which config files exist
  const fs = await import('fs');
  const sources: Array<{ name: string; path: string; exists: boolean }> = [];

  for (const file of [
    'application.yml',
    'application.yaml',
    'application.properties',
    'bootstrap.yml',
    'bootstrap.yaml',
  ]) {
    const full = path.join(repoPath, 'src', 'main', 'resources', file);
    sources.push({ name: file, path: `src/main/resources/${file}`, exists: fs.existsSync(full) });
  }

  // Check cloud config
  const cloudEnabled = !!(config.cloudConfig?.enabled && config.cloudConfig?.baseUrl);

  return {
    service,
    localSources: sources.filter((s) => s.exists),
    cloudConfig: {
      enabled: cloudEnabled,
      baseUrl: cloudEnabled ? config.cloudConfig?.baseUrl : null,
      profile: config.cloudConfig?.defaultProfile || null,
    },
  };
}

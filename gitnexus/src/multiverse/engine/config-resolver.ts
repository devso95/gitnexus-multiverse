/**
 * Config Resolver — resolves Spring @Value("${key}") to actual values
 *
 * Uses ConfigSource plugin system:
 *   1. Local application.yml / bootstrap.yml (default)
 *   2. Local application-{profile}.yml (profile override)
 *   3. Spring Cloud Config Server (remote, highest priority)
 *
 * Flattens nested YAML keys: { app: { services: { payment: { base-url: "..." } } } }
 * → "app.services.payment.base-url" = "..."
 */

import {
  createConfigSources,
  resolveAllConfigs,
  type ConfigSourceOptions,
} from './config-source.js';
import { mvLog } from '../util/logger.js';

const LOG = 'config-resolver';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Cache: serviceId → { map, timestamp } */
const configCache = new Map<string, { map: Map<string, string>; ts: number }>();

/** Clear cache for a service (call on re-analyze) */
export const clearConfigCache = (serviceId: string) => configCache.delete(serviceId);

/** Clear all caches */
export const clearAllConfigCache = () => configCache.clear();

export interface ResolveConfigOptions {
  serviceId: string;
  repoPath: string;
  profile?: string;
  cloudConfigBaseUrl?: string;
  cloudConfigProfile?: string;
}

/**
 * Resolve config for a service using plugin system.
 * Priority: cloud config > profile YAML > default YAML > bootstrap.
 */
export const resolveConfig = async (
  serviceId: string,
  repoPath: string,
  profile: string = 'default',
  cloudConfigBaseUrl?: string,
  cloudConfigProfile?: string,
): Promise<Map<string, string>> => {
  const cached = configCache.get(serviceId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.map;

  const opts: ConfigSourceOptions = {
    serviceId,
    repoPath,
    profile,
    cloudConfigBaseUrl,
    cloudConfigProfile,
  };

  const sources = createConfigSources(opts);
  mvLog.info(
    LOG,
    `${serviceId}: resolving config from ${sources.length} sources: ${sources.map((s) => s.name).join(', ')}`,
  );

  const configMap = await resolveAllConfigs(sources);
  mvLog.info(LOG, `${serviceId}: ${configMap.size} config keys resolved`);

  configCache.set(serviceId, { map: configMap, ts: Date.now() });
  return configMap;
};

/** Lookup a single config key, with ${ref} substitution */
export const lookupConfig = (configMap: Map<string, string>, key: string): string | null => {
  // Exact match first, then case-insensitive fallback
  let raw = configMap.get(key);
  if (raw === undefined) {
    const keyLower = key.toLowerCase();
    for (const [k, v] of configMap) {
      if (k.toLowerCase() === keyLower) {
        raw = v;
        break;
      }
    }
  }
  if (raw === undefined) return null;

  // Resolve ${ref} references within values
  return raw.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    const [refKey, fallback] = expr.split(':');
    const cleanFallback = fallback?.replace(/^#\{null\}$/, '').trim();
    return configMap.get(refKey.trim()) ?? cleanFallback ?? '';
  });
};

/**
 * Extract config key from @Value annotation string.
 * Handles: "${key}", "${key:default}", "${key:#{null}}"
 */
export const extractValueKey = (
  annotation: string,
): { key: string; defaultValue?: string } | null => {
  const match = annotation.match(/\$\{([^}]+)\}/);
  if (!match) return null;

  const expr = match[1];
  const colonIdx = expr.indexOf(':');
  if (colonIdx < 0) return { key: expr.trim() };

  const key = expr.slice(0, colonIdx).trim();
  const defaultValue = expr.slice(colonIdx + 1).trim();
  return { key, defaultValue: defaultValue === '#{null}' ? undefined : defaultValue };
};

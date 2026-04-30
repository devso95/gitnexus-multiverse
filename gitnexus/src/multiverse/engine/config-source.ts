/**
 * Config Source Plugin System
 *
 * Priority (highest wins):
 *   1. Spring Cloud Config Server (remote, if configured)
 *   2. application-{profile}.yml (local, profile-specific)
 *   3. application.yml (local, default)
 *   4. bootstrap.yml (local, Spring Cloud bootstrap)
 *
 * Usage:
 *   const sources = createConfigSources(serviceId, repoPath, profile, cloudConfigUrl);
 *   const configMap = await resolveAllConfigs(sources);
 */

import fs from 'fs';
import path from 'path';
import { mvLog } from '../util/logger.js';

const LOG = 'config-source';

export interface ConfigSource {
  readonly name: string;
  readonly priority: number; // higher = wins on conflict
  resolve(): Promise<Map<string, string>>;
}

// ── Local YAML Config Source ──

export class LocalYamlConfigSource implements ConfigSource {
  readonly name: string;
  readonly priority: number;
  private filePath: string;

  constructor(filePath: string, priority: number) {
    this.filePath = filePath;
    this.name = `local:${path.basename(filePath)}`;
    this.priority = priority;
  }

  async resolve(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!fs.existsSync(this.filePath)) return map;
    try {
      const text = fs.readFileSync(this.filePath, 'utf-8');
      flattenYaml(text, map);
      mvLog.debug(LOG, `${this.name}: ${map.size} keys loaded`);
    } catch (err) {
      mvLog.warn(LOG, `Failed to parse ${this.filePath}`, err);
    }
    return map;
  }
}

// ── Spring Cloud Config Source ──

/**
 * Fetches config from Spring Cloud Config Server.
 *
 * URL pattern: {baseUrl}/{serviceName}/{profile}
 * Example: https://config.example.com/config/v2/order-service/production
 *
 * Response format (Spring Cloud Config v2):
 * {
 *   "name": "order-service",
 *   "profiles": ["cloud_uat"],
 *   "propertySources": [
 *     { "name": "...", "source": { "key1": "val1", "key2": "val2" } }
 *   ]
 * }
 */
export class SpringCloudConfigSource implements ConfigSource {
  readonly name: string;
  readonly priority: number;
  private url: string;
  private timeoutMs: number;

  constructor(url: string, priority: number = 100, timeoutMs: number = 10000) {
    this.url = url;
    this.name = `cloud:${url.split('/').slice(-2).join('/')}`;
    this.priority = priority;
    this.timeoutMs = timeoutMs;
  }

  async resolve(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const resp = await fetch(this.url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(timer);

      if (!resp.ok) {
        mvLog.warn(LOG, `Cloud config ${this.url} returned ${resp.status}`);
        return map;
      }

      const data = (await resp.json()) as {
        propertySources?: Array<{ name: string; source: Record<string, unknown> }>;
        properties?: Record<string, unknown>;
      };

      // Spring Cloud Config v2 format
      if (data.propertySources && Array.isArray(data.propertySources)) {
        // Reverse order: last source has lowest priority within cloud config
        const sources = [...data.propertySources].reverse();
        for (const ps of sources) {
          if (ps.source && typeof ps.source === 'object') {
            for (const [key, val] of Object.entries(ps.source)) {
              if (val !== null && val !== undefined) {
                map.set(key, String(val));
              }
            }
          }
        }
      }

      // Spring Cloud Config v1 / flat format
      if (data.properties && typeof data.properties === 'object') {
        for (const [key, val] of Object.entries(data.properties)) {
          if (val !== null && val !== undefined) {
            map.set(key, String(val));
          }
        }
      }

      mvLog.info(LOG, `${this.name}: ${map.size} keys from cloud config`);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        mvLog.warn(LOG, `Cloud config timeout after ${this.timeoutMs}ms: ${this.url}`);
      } else {
        mvLog.warn(
          LOG,
          `Cloud config fetch failed: ${this.url}`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return map;
  }
}

// ── Build Cloud Config URL ──

/**
 * Build Spring Cloud Config URL from base + service + profile.
 * Pattern: {cloudConfigBase}/{serviceName}/{profile}
 */
export const buildCloudConfigUrl = (
  baseUrl: string,
  serviceName: string,
  profile: string,
): string => {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return `${base}/${serviceName}/${profile}`;
};

// ── Factory ──

export interface ConfigSourceOptions {
  serviceId: string;
  repoPath: string;
  profile?: string;
  cloudConfigBaseUrl?: string;
  cloudConfigProfile?: string;
}

/**
 * Create ordered config sources for a service.
 * Returns sources sorted by priority (lowest first — last one wins).
 */
export const createConfigSources = (opts: ConfigSourceOptions): ConfigSource[] => {
  const { serviceId, repoPath, profile = 'default' } = opts;
  const sources: ConfigSource[] = [];
  const resourceDir = path.join(repoPath, 'src', 'main', 'resources');
  const dirs = [resourceDir, repoPath];

  // Priority 10: bootstrap.yml
  for (const dir of dirs) {
    const bootstrap = path.join(dir, 'bootstrap.yml');
    if (fs.existsSync(bootstrap)) {
      sources.push(new LocalYamlConfigSource(bootstrap, 10));
    }
  }

  // Priority 20: application.yml (default)
  for (const dir of dirs) {
    for (const ext of ['yml', 'yaml']) {
      const file = path.join(dir, `application.${ext}`);
      if (fs.existsSync(file)) {
        sources.push(new LocalYamlConfigSource(file, 20));
      }
    }
  }

  // Priority 30: application-{profile}.yml
  if (profile !== 'default') {
    for (const dir of dirs) {
      for (const ext of ['yml', 'yaml']) {
        const file = path.join(dir, `application-${profile}.${ext}`);
        if (fs.existsSync(file)) {
          sources.push(new LocalYamlConfigSource(file, 30));
        }
      }
    }
  }

  // Priority 100: Spring Cloud Config Server (remote)
  if (opts.cloudConfigBaseUrl) {
    const cloudProfile = opts.cloudConfigProfile || profile;
    const url = buildCloudConfigUrl(opts.cloudConfigBaseUrl, serviceId, cloudProfile);
    sources.push(new SpringCloudConfigSource(url, 100));
  }

  // Sort by priority ascending (lowest first, highest wins on merge)
  sources.sort((a, b) => a.priority - b.priority);
  return sources;
};

/**
 * Resolve all config sources into a single merged map.
 * Higher priority sources override lower ones.
 */
export const resolveAllConfigs = async (sources: ConfigSource[]): Promise<Map<string, string>> => {
  const merged = new Map<string, string>();
  for (const source of sources) {
    const map = await source.resolve();
    for (const [key, val] of map) {
      merged.set(key, val);
    }
  }
  return merged;
};

// ── YAML Flattener (improved, single implementation) ──

function flattenYaml(text: string, map: Map<string, string>) {
  const lines = text.split('\n');
  const stack: Array<{ indent: number; prefix: string }> = [{ indent: -1, prefix: '' }];

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // Skip array items and multi-line indicators
    if (trimmed.startsWith('- ')) continue;
    if (trimmed === '|' || trimmed === '>') continue;

    // Pop stack to correct level
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }

    // Match key: value — handle keys with dots (e.g. "app.services.base-url")
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let val = trimmed.slice(colonIdx + 1).trim();
    if (!key) continue;

    const parent = stack[stack.length - 1];
    const fullKey = parent.prefix ? `${parent.prefix}.${key}` : key;

    if (val === '' || val === '|' || val === '>') {
      stack.push({ indent, prefix: fullKey });
    } else {
      // Strip inline comments (but not inside quoted strings)
      if (!val.startsWith('"') && !val.startsWith("'")) {
        const commentIdx = val.indexOf(' #');
        if (commentIdx > 0) val = val.slice(0, commentIdx).trim();
      }
      // Strip quotes
      const cleanVal = val.replace(/^["']|["']$/g, '');
      map.set(fullKey, cleanVal);
    }
  }
}

/**
 * Multiverse Config Loader
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MultiverseConfig } from './types.js';
import { mvLog } from '../util/logger.js';
import { normalizePatternApplicability } from '../engine/source-file-utils.js';

const requireFromGitNexus = createRequire(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../gitnexus/package.json'),
);

const LOG = 'config-loader';
const CUSTOM_PATTERN_FILE_NAME = 'multiverse-patterns.custom.json';

const DEFAULTS: MultiverseConfig = {
  server: { port: 3003, host: '0.0.0.0' },
  neo4j: {
    uri: 'bolt://localhost:7687',
    user: 'neo4j',
    password: 'password',
    database: 'neo4j',
  },
  auth: {
    users: [],
  },
  workspace: {
    dir: '/var/tmp/kiro-cli/workspace/multiverse-repos',
    gitBase: 'https://git.example.com/scm',
  },
  cloudConfig: {
    baseUrl: '',
    defaultProfile: 'cloud_uat',
    enabled: false,
    timeoutMs: 10000,
  },
  analyze: {
    maxConcurrency: 3,
    gitTimeoutMs: 120000,
    cloneTimeoutMs: 300000,
  },
  services: [],
  sinkPatterns: [],
  listenerAnnotations: [],
  entryPointAnnotations: [],
  graphRules: [],
  wiki: {
    outputDir: '',
    autoGenerate: false,
    llm: undefined,
  },
};

const substituteEnvVars = (text: string): string =>
  text.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    const [key, fallback] = expr.split(':-');
    return process.env[key.trim()] ?? fallback?.trim() ?? '';
  });

const parseSimpleYaml = (text: string): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  const lines = text.split('\n');
  const stack: Array<{ indent: number; obj: Record<string, unknown>; key?: string }> = [
    { indent: -1, obj: result },
  ];
  let currentArray: unknown[] | null = null;
  let currentArrayKey = '';

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const indent = line.search(/\S/);
    const trimmed = line.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
      currentArray = null;
    }

    const parent = stack[stack.length - 1].obj;

    if (trimmed.startsWith('- ')) {
      const val = trimmed.slice(2).trim();
      const mapMatch = val.match(/^(\w+):\s*(.+)$/);

      if (!currentArray && currentArrayKey) {
        const grandParent = stack.length > 1 ? stack[stack.length - 2].obj : result;
        const potentialArray = grandParent[currentArrayKey];
        if (
          potentialArray &&
          typeof potentialArray === 'object' &&
          !Array.isArray(potentialArray) &&
          Object.keys(potentialArray as object).length === 0
        ) {
          grandParent[currentArrayKey] = [];
          currentArray = grandParent[currentArrayKey] as unknown[];
          if (stack[stack.length - 1].key === currentArrayKey) stack.pop();
        }
      }

      if (currentArray) {
        if (mapMatch) {
          const item: Record<string, unknown> = {};
          item[mapMatch[1]] = parseValue(mapMatch[2]);
          currentArray.push(item);
          stack.push({ indent, obj: item });
        } else {
          currentArray.push(parseValue(val));
        }
      }
      continue;
    }

    const kvMatch = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim();
      const val = kvMatch[2].trim();
      if (val === '' || val === '|' || val === '>') {
        const newObj: Record<string, unknown> = {};
        parent[key] = newObj;
        stack.push({ indent, obj: newObj, key });
        currentArray = null;
        currentArrayKey = key;
      } else {
        parent[key] = parseValue(val);
        currentArray = null;
      }
    }
  }

  return result;
};

const parseValue = (val: string): unknown => {
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null') return null;
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  const num = Number(val);
  if (!Number.isNaN(num) && val !== '') return num;
  return val;
};

const deepMerge = (
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> => {
  if (!source || typeof source !== 'object') return target;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sVal = source[key];
    const tVal = target[key];
    if (
      Array.isArray(sVal) &&
      sVal.length === 0 &&
      tVal &&
      typeof tVal === 'object' &&
      !Array.isArray(tVal)
    ) {
      continue;
    }
    if (sVal && typeof sVal === 'object' && !Array.isArray(sVal)) {
      result[key] = deepMerge(
        (tVal || {}) as Record<string, unknown>,
        sVal as Record<string, unknown>,
      );
    } else {
      result[key] = sVal;
    }
  }
  return result;
};

type PatternOverrides = Pick<
  MultiverseConfig,
  'sinkPatterns' | 'listenerAnnotations' | 'entryPointAnnotations'
>;

const readPatternOverrides = (filePath: string): PatternOverrides & { loaded: boolean } => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PatternOverrides>;
    return {
      loaded: true,
      sinkPatterns: Array.isArray(parsed?.sinkPatterns) ? parsed.sinkPatterns : [],
      listenerAnnotations: Array.isArray(parsed?.listenerAnnotations)
        ? parsed.listenerAnnotations
        : [],
      entryPointAnnotations: Array.isArray(parsed?.entryPointAnnotations)
        ? parsed.entryPointAnnotations
        : [],
    };
  } catch (err) {
    mvLog.warn(LOG, `Failed to read custom pattern file at ${filePath}`, err);
    return {
      loaded: false,
      sinkPatterns: [],
      listenerAnnotations: [],
      entryPointAnnotations: [],
    };
  }
};

const normalizePatternArray = <T>(value: unknown): T[] => {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
};

let cachedConfig: MultiverseConfig | null = null;

export const loadConfig = async (configPath?: string): Promise<MultiverseConfig> => {
  if (cachedConfig && !configPath) return cachedConfig;

  for (const suffix of ['URI', 'USER', 'PASSWORD', 'DATABASE']) {
    if (process.env[`GITNEXUS_NEO4J_${suffix}`] && !process.env[`NEO4J_${suffix}`]) {
      process.env[`NEO4J_${suffix}`] = process.env[`GITNEXUS_NEO4J_${suffix}`];
    }
  }
  if (process.env.MV_WORKSPACE && !process.env.WORKSPACE_DIR) {
    process.env.WORKSPACE_DIR = process.env.MV_WORKSPACE;
  }
  if (process.env.MV_GIT_BASE && !process.env.GIT_BASE) {
    process.env.GIT_BASE = process.env.MV_GIT_BASE;
  }

  const filePath = configPath || path.resolve(process.cwd(), 'multiverse-config.yml');

  let config: MultiverseConfig;
  if (!fs.existsSync(filePath)) {
    mvLog.info(LOG, `Config not found at ${filePath}, using defaults`);
    config = { ...DEFAULTS };
  } else {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const substituted = substituteEnvVars(raw);
    const parsed = parseSimpleYaml(substituted);
    const merged = deepMerge(
      DEFAULTS as unknown as Record<string, unknown>,
      parsed as Record<string, unknown>,
    );
    config = merged as unknown as MultiverseConfig;
  }

  config.sinkPatterns = normalizePatternArray(config.sinkPatterns);
  config.listenerAnnotations = normalizePatternArray(config.listenerAnnotations);
  config.entryPointAnnotations = normalizePatternArray(config.entryPointAnnotations);
  config.graphRules = normalizePatternArray(config.graphRules);

  const customPatternPath = path.resolve(path.dirname(filePath), CUSTOM_PATTERN_FILE_NAME);
  if (fs.existsSync(customPatternPath)) {
    const overrides = readPatternOverrides(customPatternPath);
    config.sinkPatterns = [...(config.sinkPatterns || []), ...overrides.sinkPatterns];
    config.listenerAnnotations = [
      ...(config.listenerAnnotations || []),
      ...overrides.listenerAnnotations,
    ];
    config.entryPointAnnotations = [
      ...(config.entryPointAnnotations || []),
      ...overrides.entryPointAnnotations,
    ];
    if (overrides.loaded) {
      mvLog.info(LOG, `Loaded custom multiverse patterns from ${customPatternPath}`);
    }
  }

  config.sinkPatterns = config.sinkPatterns.map((pattern) =>
    normalizePatternApplicability(pattern),
  );
  config.listenerAnnotations = config.listenerAnnotations.map((annotation) =>
    normalizePatternApplicability(annotation),
  );
  config.entryPointAnnotations = config.entryPointAnnotations.map((annotation) =>
    normalizePatternApplicability(annotation),
  );
  config.graphRules = config.graphRules.map((rule) => normalizePatternApplicability(rule));

  if (!config.auth?.users?.length) {
    config.auth = { ...config.auth, users: [] };
  }

  const envUser = process.env.MV_ADMIN_USER;
  const envPass = process.env.MV_ADMIN_PASS;
  if (envUser && envPass) {
    try {
      const bcrypt = requireFromGitNexus('bcryptjs') as { hashSync?(s: string, n: number): string };
      if (typeof bcrypt.hashSync === 'function') {
        const hash = bcrypt.hashSync(envPass, 10);
        config.auth.users = [{ username: envUser, password: hash, role: 'admin' }];
      }
    } catch {
      mvLog.warn(LOG, 'bcryptjs not available, cannot hash MV_ADMIN_PASS');
    }
  }

  if (!config.auth.users.length) {
    mvLog.warn(
      LOG,
      'No auth users configured. Set MV_ADMIN_USER + MV_ADMIN_PASS env vars or configure auth.users in multiverse-config.yml',
    );
  }

  if (process.env.MV_CLOUD_CONFIG_URL && !config.cloudConfig?.baseUrl) {
    config.cloudConfig = {
      ...config.cloudConfig,
      baseUrl: process.env.MV_CLOUD_CONFIG_URL,
      enabled: true,
    };
  }

  if (!config.neo4j?.uri) {
    mvLog.warn(LOG, 'neo4j.uri not configured — using default bolt://localhost:7687');
  }
  if (!config.workspace?.dir) {
    mvLog.warn(LOG, 'workspace.dir not configured — using default');
  }

  cachedConfig = config;
  return config;
};

export const clearConfigLoaderCache = () => {
  cachedConfig = null;
};

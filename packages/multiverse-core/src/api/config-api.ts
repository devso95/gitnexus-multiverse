/**
 * Config API — Sink Patterns CRUD
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../config/loader.js';
import { mvLog } from '../util/logger.js';

const requireFromGitNexus = createRequire(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../gitnexus/package.json'),
);

const multiverseRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../gitnexus/src/multiverse',
);
const coreRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../gitnexus/src/core',
);

const legacyMultiverseModuleUrl = (...segments: string[]) =>
  pathToFileURL(path.resolve(multiverseRoot, ...segments)).href;
const legacyCoreModuleUrl = (...segments: string[]) =>
  pathToFileURL(path.resolve(coreRoot, ...segments)).href;

const LOG = 'config-api';

async function getGraphBackend() {
  const mod = (await import(legacyCoreModuleUrl('graph-backend/index.ts'))) as {
    getGraphBackend: () => Promise<{
      executeQuery: (cypher: string, params?: Record<string, unknown>) => Promise<any[]>;
    }>;
  };
  return mod.getGraphBackend();
}

async function loadSinkPatternModule() {
  return (await import(legacyMultiverseModuleUrl('engine/sink-patterns.ts'))) as {
    resolveSinkPatterns: (patterns: unknown[]) => any[];
    normalizeSinkPattern: (value: unknown) => any;
  };
}

async function loadGraphRulesModule() {
  return (await import(legacyMultiverseModuleUrl('engine/graph-rules.ts'))) as {
    normalizeGraphRule: (value: unknown) => any;
    resolveGraphRules: (rules: unknown[]) => any[];
    BUILT_IN_GRAPH_RULES: Array<{ id: string }>;
  };
}

async function loadConfigSourceModule() {
  return (await import(legacyMultiverseModuleUrl('engine/config-source.ts'))) as {
    SpringCloudConfigSource: new (
      url: string,
      ttlMs: number,
      timeoutMs: number,
    ) => {
      resolve: () => Promise<Map<string, string>>;
    };
    buildCloudConfigUrl: (baseUrl: string, serviceId: string, profile: string) => string;
  };
}

async function loadRepoManagerModule() {
  return (await import(legacyCoreModuleUrl('storage/repo-manager.ts'))) as {
    loadCLIConfig: () => Promise<unknown>;
    saveCLIConfig: (value: unknown) => Promise<void>;
  };
}

export const createConfigRouter = () => {
  const express = requireFromGitNexus('express') as { Router: () => any };
  const router = express.Router();

  router.get('/patterns', async (_req: any, res: any) => {
    try {
      const backend = await getGraphBackend();
      const rows = (await backend
        .executeQuery('MATCH (p:SinkPattern) RETURN properties(p) AS props ORDER BY p.id')
        .catch(() => [])) as Array<{ props: Record<string, unknown> }>;
      const config = await loadConfig();
      const { resolveSinkPatterns, normalizeSinkPattern } = await loadSinkPatternModule();
      const builtIn = resolveSinkPatterns(config.sinkPatterns);
      const dbMap = new Map<string, any>(
        rows.map((row) => {
          const normalized = normalizeSinkPattern(row.props);
          return [String(normalized.id), normalized] as const;
        }),
      );
      const merged = builtIn.map((pattern) =>
        normalizeSinkPattern({
          ...pattern,
          ...(dbMap.get(pattern.id) || {}),
          enabled: dbMap.has(pattern.id) ? dbMap.get(pattern.id).enabled : pattern.enabled,
        }),
      );
      for (const [id, pattern] of dbMap) {
        if (!merged.find((item) => item.id === id)) merged.push(pattern);
      }
      const visible = merged.filter((pattern) => !pattern.deleted);
      res.json({ patterns: visible });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put('/patterns/:id', async (req: any, res: any) => {
    try {
      const backend = await getGraphBackend();
      const {
        enabled,
        methodPattern,
        name,
        category,
        targetArgIndex,
        defaultTarget,
        scope,
        wrapperClass,
        wrapperMethods,
        languages,
        fileExtensions,
        excludePathPatterns,
      } = req.body;
      const props: Record<string, unknown> = { id: req.params.id };
      if (enabled !== undefined) props.enabled = enabled;
      if (methodPattern) props.methodPattern = methodPattern;
      if (name) props.name = name;
      if (category) props.category = category;
      if (targetArgIndex !== undefined) props.targetArgIndex = targetArgIndex;
      if (defaultTarget !== undefined) props.defaultTarget = defaultTarget;
      if (scope !== undefined)
        props.scope = typeof scope === 'string' ? scope : JSON.stringify(scope);
      if (wrapperClass !== undefined) props.wrapperClass = wrapperClass;
      if (wrapperMethods !== undefined) props.wrapperMethods = JSON.stringify(wrapperMethods);
      if (languages !== undefined) props.languages = JSON.stringify(languages);
      if (fileExtensions !== undefined) props.fileExtensions = JSON.stringify(fileExtensions);
      if (excludePathPatterns !== undefined) {
        props.excludePathPatterns = JSON.stringify(excludePathPatterns);
      }

      await backend.executeQuery('MERGE (p:SinkPattern {id: $id}) SET p += $props', {
        id: req.params.id,
        props,
      });
      res.json(props);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/patterns', async (req: any, res: any) => {
    try {
      const {
        id,
        name,
        category,
        methodPattern,
        targetArgIndex,
        enabled,
        defaultTarget,
        scope,
        wrapperClass,
        wrapperMethods,
        languages,
        fileExtensions,
        excludePathPatterns,
      } = req.body;
      if (!id || !name || !methodPattern) {
        res.status(400).json({ error: 'Required: id, name, methodPattern' });
        return;
      }
      const backend = await getGraphBackend();
      const props = {
        id,
        name,
        category: category || 'http',
        methodPattern,
        targetArgIndex: targetArgIndex ?? 0,
        enabled: enabled !== false,
        ...(defaultTarget !== undefined ? { defaultTarget } : {}),
        ...(scope !== undefined
          ? { scope: typeof scope === 'string' ? scope : JSON.stringify(scope) }
          : {}),
        ...(wrapperClass !== undefined ? { wrapperClass } : {}),
        ...(wrapperMethods !== undefined ? { wrapperMethods: JSON.stringify(wrapperMethods) } : {}),
        ...(languages !== undefined ? { languages: JSON.stringify(languages) } : {}),
        ...(fileExtensions !== undefined ? { fileExtensions: JSON.stringify(fileExtensions) } : {}),
        ...(excludePathPatterns !== undefined
          ? { excludePathPatterns: JSON.stringify(excludePathPatterns) }
          : {}),
      };
      await backend.executeQuery('MERGE (p:SinkPattern {id: $id}) SET p += $props', { id, props });
      res.status(201).json(props);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/patterns/:id', async (req: any, res: any) => {
    try {
      const backend = await getGraphBackend();
      const id = req.params.id;
      const config = await loadConfig();
      const { resolveSinkPatterns } = await loadSinkPatternModule();
      const builtIn = resolveSinkPatterns(config.sinkPatterns);
      const isBuiltIn = builtIn.some((pattern) => pattern.id === id);
      if (isBuiltIn) {
        await backend.executeQuery(
          'MERGE (p:SinkPattern {id: $id}) SET p.enabled = false, p.deleted = true',
          { id },
        );
        res.json({ deleted: id, note: 'Built-in pattern hidden (disabled + deleted)' });
      } else {
        await backend.executeQuery('MATCH (p:SinkPattern {id: $id}) DELETE p', { id });
        res.json({ deleted: id });
      }
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/rules', async (_req: any, res: any) => {
    try {
      const backend = await getGraphBackend();
      const rows = await backend
        .executeQuery('MATCH (r:GraphRule) RETURN properties(r) AS props ORDER BY r.id')
        .catch(() => []);
      const { resolveGraphRules, normalizeGraphRule } = await loadGraphRulesModule();
      const config = await loadConfig();
      const builtIn = resolveGraphRules(config.graphRules);
      const dbMap = new Map(rows.map((row: any) => [row.props.id, row.props]));
      const merged = builtIn.map((rule) => {
        const dbRule = dbMap.get(rule.id);
        if (!dbRule) return normalizeGraphRule(rule);
        const parsed = { ...rule, ...dbRule } as any;
        if (typeof parsed.match === 'string') {
          try {
            parsed.match = JSON.parse(parsed.match);
          } catch {}
        }
        if (typeof parsed.emit === 'string') {
          try {
            parsed.emit = JSON.parse(parsed.emit);
          } catch {}
        }
        return normalizeGraphRule(parsed);
      });
      for (const [id, rule] of dbMap) {
        if (!merged.find((item: any) => item.id === id)) {
          const parsed: any = { ...rule };
          if (typeof parsed.match === 'string') {
            try {
              parsed.match = JSON.parse(parsed.match);
            } catch {}
          }
          if (typeof parsed.emit === 'string') {
            try {
              parsed.emit = JSON.parse(parsed.emit);
            } catch {}
          }
          merged.push(normalizeGraphRule(parsed));
        }
      }
      const visible = merged.filter((rule: any) => !rule.deleted);
      res.json({ rules: visible });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put('/rules/:id', async (req: any, res: any) => {
    try {
      const backend = await getGraphBackend();
      const { enabled, name, type, match, emit, languages, fileExtensions, excludePathPatterns } =
        req.body;
      const props: Record<string, unknown> = { id: req.params.id };
      if (enabled !== undefined) props.enabled = enabled;
      if (name) props.name = name;
      if (type) props.type = type;
      if (match) props.match = JSON.stringify(match);
      if (emit) props.emit = JSON.stringify(emit);
      if (languages !== undefined) props.languages = JSON.stringify(languages);
      if (fileExtensions !== undefined) props.fileExtensions = JSON.stringify(fileExtensions);
      if (excludePathPatterns !== undefined) {
        props.excludePathPatterns = JSON.stringify(excludePathPatterns);
      }
      await backend.executeQuery('MERGE (r:GraphRule {id: $id}) SET r += $props', {
        id: req.params.id,
        props,
      });
      res.json({ ...props, match: match || props.match, emit: emit || props.emit });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/rules', async (req: any, res: any) => {
    try {
      const {
        id,
        name,
        type,
        match,
        emit,
        enabled,
        languages,
        fileExtensions,
        excludePathPatterns,
      } = req.body;
      if (!id || !name || !match || !emit) {
        res.status(400).json({ error: 'Required: id, name, match, emit' });
        return;
      }
      const backend = await getGraphBackend();
      const props = {
        id,
        name,
        type: type || 'job',
        match: JSON.stringify(match),
        emit: JSON.stringify(emit),
        enabled: enabled !== false,
        ...(languages !== undefined ? { languages: JSON.stringify(languages) } : {}),
        ...(fileExtensions !== undefined ? { fileExtensions: JSON.stringify(fileExtensions) } : {}),
        ...(excludePathPatterns !== undefined
          ? { excludePathPatterns: JSON.stringify(excludePathPatterns) }
          : {}),
      };
      await backend.executeQuery('MERGE (r:GraphRule {id: $id}) SET r += $props', { id, props });
      res.status(201).json({ ...props, match, emit });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/rules/:id', async (req: any, res: any) => {
    try {
      const backend = await getGraphBackend();
      const id = req.params.id;
      const { BUILT_IN_GRAPH_RULES } = await loadGraphRulesModule();
      const isBuiltIn = BUILT_IN_GRAPH_RULES.some((rule) => rule.id === id);
      if (isBuiltIn) {
        await backend.executeQuery(
          'MERGE (r:GraphRule {id: $id}) SET r.enabled = false, r.deleted = true',
          { id },
        );
        res.json({ deleted: id, note: 'Built-in rule hidden (disabled + deleted)' });
      } else {
        await backend.executeQuery('MATCH (r:GraphRule {id: $id}) DELETE r', { id });
        res.json({ deleted: id });
      }
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/cloud-config/status', async (_req: any, res: any) => {
    try {
      const config = await loadConfig();
      res.json({
        enabled: config.cloudConfig?.enabled ?? false,
        baseUrl: config.cloudConfig?.baseUrl || '',
        defaultProfile: config.cloudConfig?.defaultProfile || '',
        timeoutMs: config.cloudConfig?.timeoutMs || 10000,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/cloud-config/test/:serviceId', async (req: any, res: any) => {
    try {
      const config = await loadConfig();
      if (!config.cloudConfig?.enabled || !config.cloudConfig?.baseUrl) {
        res.status(400).json({
          error:
            'Cloud config not enabled. Set cloudConfig.enabled=true and cloudConfig.baseUrl in config.',
        });
        return;
      }

      const profile = (req.query.profile as string) || config.cloudConfig.defaultProfile;
      const { buildCloudConfigUrl, SpringCloudConfigSource } = await loadConfigSourceModule();
      const url = buildCloudConfigUrl(config.cloudConfig.baseUrl, req.params.serviceId, profile);
      const source = new SpringCloudConfigSource(url, 100, config.cloudConfig.timeoutMs);
      const configMap = await source.resolve();

      res.json({
        serviceId: req.params.serviceId,
        profile,
        url,
        keysFound: configMap.size,
        sampleKeys: [...configMap.keys()].slice(0, 20),
      });
    } catch (err: any) {
      mvLog.error(LOG, 'Cloud config test failed', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/llm', async (_req: any, res: any) => {
    try {
      const { loadCLIConfig } = await loadRepoManagerModule();
      const config = await loadCLIConfig();
      res.json(config);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put('/llm', async (req: any, res: any) => {
    try {
      const { saveCLIConfig } = await loadRepoManagerModule();
      await saveCLIConfig(req.body);
      res.json(req.body);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
};

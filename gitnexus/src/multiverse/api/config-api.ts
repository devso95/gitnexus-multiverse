/**
 * Config API — Sink Patterns CRUD
 */

import { Router } from 'express';
import { getGraphBackend } from '../../core/graph-backend/index.js';
import { resolveSinkPatterns, normalizeSinkPattern } from '../engine/sink-patterns.js';
import type { SinkPattern as EngineSinkPattern } from '../engine/sink-patterns.js';
import { normalizeGraphRule } from '../engine/graph-rules.js';
import { SpringCloudConfigSource, buildCloudConfigUrl } from '../engine/config-source.js';
import { loadConfig } from '../config/loader.js';
import { mvLog } from '../util/logger.js';

const LOG = 'config-api';

export const createConfigRouter = (): Router => {
  const router = Router();

  // ── Sink Patterns ──

  // GET /api/mv/config/patterns
  router.get('/patterns', async (_req, res) => {
    try {
      const backend = await getGraphBackend();
      const rows = (await backend
        .executeQuery('MATCH (p:SinkPattern) RETURN properties(p) AS props ORDER BY p.id')
        .catch(() => [])) as Array<{ props: Record<string, unknown> }>;
      const config = await loadConfig();
      const builtIn = resolveSinkPatterns(config.sinkPatterns);
      const dbMap = new Map<string, EngineSinkPattern>(
        rows.map((r) => {
          const normalized = normalizeSinkPattern(r.props) as unknown as EngineSinkPattern;
          return [String(normalized.id), normalized] as const;
        }),
      );
      const merged = builtIn.map((d) =>
        normalizeSinkPattern({
          ...d,
          ...(dbMap.get(d.id) || {}),
          enabled: dbMap.has(d.id) ? dbMap.get(d.id).enabled : d.enabled,
        }),
      );
      // Add custom patterns not in defaults
      for (const [id, p] of dbMap) {
        if (!merged.find((m) => m.id === id)) merged.push(p);
      }
      // Filter out deleted patterns
      const visible = merged.filter((p) => !(p as any).deleted);
      res.json({ patterns: visible });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PUT /api/mv/config/patterns/:id — update (enable/disable, edit)
  router.put('/patterns/:id', async (req, res) => {
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
      if (excludePathPatterns !== undefined)
        props.excludePathPatterns = JSON.stringify(excludePathPatterns);

      await backend.executeQuery('MERGE (p:SinkPattern {id: $id}) SET p += $props', {
        id: req.params.id,
        props,
      });
      res.json(props);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/mv/config/patterns — create custom pattern
  router.post('/patterns', async (req, res) => {
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

  // DELETE /api/mv/config/patterns/:id — hide pattern (built-in: mark deleted, custom: remove)
  router.delete('/patterns/:id', async (req, res) => {
    try {
      const backend = await getGraphBackend();
      const id = req.params.id;
      // Check if it's a built-in pattern
      const config = await loadConfig();
      const builtIn = resolveSinkPatterns(config.sinkPatterns);
      const isBuiltIn = builtIn.some((p) => p.id === id);
      if (isBuiltIn) {
        // Can't truly delete built-in — mark as disabled+deleted in DB to suppress it
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

  // ── Graph Rules ──

  // GET /api/mv/config/rules
  router.get('/rules', async (_req, res) => {
    try {
      const backend = await getGraphBackend();
      const rows = await backend
        .executeQuery('MATCH (r:GraphRule) RETURN properties(r) AS props ORDER BY r.id')
        .catch(() => []);
      const { resolveGraphRules } = await import('../engine/graph-rules.js');
      const config = await loadConfig();
      const builtIn = resolveGraphRules(config.graphRules);
      const dbMap = new Map(rows.map((r: any) => [r.props.id, r.props]));
      // DB rules override built-in by id
      const merged = builtIn.map((d) => {
        const dbRule = dbMap.get(d.id);
        if (!dbRule) return normalizeGraphRule(d as any);
        // Parse match/emit from JSON strings if stored as strings
        const parsed = { ...d, ...dbRule };
        if (typeof parsed.match === 'string')
          try {
            parsed.match = JSON.parse(parsed.match);
          } catch {}
        if (typeof parsed.emit === 'string')
          try {
            parsed.emit = JSON.parse(parsed.emit);
          } catch {}
        return normalizeGraphRule(parsed);
      });
      // Add custom rules not in built-in
      for (const [id, p] of dbMap) {
        if (!merged.find((m: any) => m.id === id)) {
          const parsed: any = { ...p };
          if (typeof parsed.match === 'string')
            try {
              parsed.match = JSON.parse(parsed.match);
            } catch {}
          if (typeof parsed.emit === 'string')
            try {
              parsed.emit = JSON.parse(parsed.emit);
            } catch {}
          merged.push(normalizeGraphRule(parsed));
        }
      }
      // Filter out deleted rules
      const visible = merged.filter((r: any) => !r.deleted);
      res.json({ rules: visible });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PUT /api/mv/config/rules/:id
  router.put('/rules/:id', async (req, res) => {
    try {
      const backend = await getGraphBackend();
      const { enabled, name, type, match, emit, languages, fileExtensions, excludePathPatterns } =
        req.body;
      const props: any = { id: req.params.id };
      if (enabled !== undefined) props.enabled = enabled;
      if (name) props.name = name;
      if (type) props.type = type;
      if (match) props.match = JSON.stringify(match);
      if (emit) props.emit = JSON.stringify(emit);
      if (languages !== undefined) props.languages = JSON.stringify(languages);
      if (fileExtensions !== undefined) props.fileExtensions = JSON.stringify(fileExtensions);
      if (excludePathPatterns !== undefined)
        props.excludePathPatterns = JSON.stringify(excludePathPatterns);
      await backend.executeQuery('MERGE (r:GraphRule {id: $id}) SET r += $props', {
        id: req.params.id,
        props,
      });
      res.json({ ...props, match: match || props.match, emit: emit || props.emit });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/mv/config/rules
  router.post('/rules', async (req, res) => {
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

  // DELETE /api/mv/config/rules/:id — hide rule (built-in: mark deleted, custom: remove)
  router.delete('/rules/:id', async (req, res) => {
    try {
      const backend = await getGraphBackend();
      const id = req.params.id;
      const { BUILT_IN_GRAPH_RULES } = await import('../engine/graph-rules.js');
      const isBuiltIn = BUILT_IN_GRAPH_RULES.some((r: any) => r.id === id);
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

  // ── Cloud Config ──

  // GET /api/mv/config/cloud-config/status — check cloud config settings
  router.get('/cloud-config/status', async (_req, res) => {
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

  // GET /api/mv/config/cloud-config/test/:serviceId — test cloud config fetch for a service
  router.get('/cloud-config/test/:serviceId', async (req, res) => {
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

  // ── Global LLM Settings ──
  router.get('/llm', async (_req, res) => {
    try {
      const { loadCLIConfig } = await import('../../storage/repo-manager.js');
      const config = await loadCLIConfig();
      res.json(config);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.put('/llm', async (req, res) => {
    try {
      const { saveCLIConfig } = await import('../../storage/repo-manager.js');
      await saveCLIConfig(req.body);
      res.json(req.body);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
};

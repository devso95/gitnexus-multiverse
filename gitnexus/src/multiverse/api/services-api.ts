/**
 * Services REST API — CRUD for ServiceNode
 *
 * Routes mounted at /api/mv/services
 */

import { Router } from 'express';
import {
  listServices,
  getService,
  createService,
  updateService,
  deleteService,
} from '../admin/service-registry.js';

const LOG = 'services-api';

/** Validate service ID: alphanumeric, hyphens, underscores, max 64 chars */
const isValidId = (id: string): boolean => /^[a-zA-Z0-9_-]{1,64}$/.test(id);

/** Validate project key: uppercase alphanumeric, max 20 chars */
const isValidProject = (project: string): boolean => /^[A-Za-z0-9_-]{1,20}$/.test(project);

/** Validate repo slug: alphanumeric, hyphens, underscores, max 64 chars */
const isValidSlug = (slug: string): boolean => /^[a-zA-Z0-9_.-]{1,64}$/.test(slug);

export const createServicesRouter = (): Router => {
  const router = Router();

  // GET /api/mv/services
  router.get('/', async (req, res) => {
    try {
      const type = req.query.type as string | undefined;
      const services = await listServices(type);
      res.json({ services });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/mv/services/manual-resolutions (all services — before :id)
  router.get('/manual-resolutions', async (_req, res) => {
    try {
      const { listManualResolutions } = await import('../engine/manual-resolutions.js');
      const items = await listManualResolutions();
      res.json({ items, total: items.length });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/mv/services/:id
  router.get('/:id', async (req, res) => {
    try {
      const svc = await getService(req.params.id);
      if (!svc) {
        res
          .status(404)
          .json({ error: `Service "${req.params.id}" not found`, code: 'SERVICE_NOT_FOUND' });
        return;
      }
      res.json(svc);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /api/mv/services
  router.post('/', async (req, res) => {
    try {
      const { id, name, type, repo, gitUrl, localPath, urlPrefixes, dependsOn } = req.body;

      // Accept gitUrl like https://git.example.com/scm/project/repo.git
      // Auto-parse project + slug from URL if repo not provided
      let project = repo?.project;
      let slug = repo?.slug;
      const branch = repo?.branch || 'master';

      if (gitUrl && (!project || !slug)) {
        const m = gitUrl.match(/\/scm\/([^/]+)\/([^/.]+)/);
        if (m) {
          project = project || m[1].toUpperCase();
          slug = slug || m[2];
        }
      } else if (localPath && (!project || !slug)) {
        slug = slug || localPath.split('/').filter(Boolean).pop();
        project = project || 'LOCAL';
      }

      const svcId = id || slug;
      const svcName = name || slug || id;

      if (!svcId || !project || !slug) {
        res.status(400).json({
          error: 'Provide gitUrl or localPath, or id + repo.project + repo.slug',
        });
        return;
      }

      // Input validation
      if (!isValidId(svcId)) {
        res.status(400).json({
          error: 'Invalid service ID. Use alphanumeric, hyphens, underscores (max 64 chars).',
        });
        return;
      }
      if (!isValidProject(project)) {
        res.status(400).json({ error: 'Invalid project key. Use alphanumeric (max 20 chars).' });
        return;
      }
      if (!isValidSlug(slug)) {
        res.status(400).json({
          error: 'Invalid repo slug. Use alphanumeric, hyphens, underscores (max 64 chars).',
        });
        return;
      }

      const svc = await createService({
        id: svcId,
        name: svcName,
        type: type || 'service',
        repoProject: project,
        repoSlug: slug,
        repoBranch: branch,
        gitUrl: gitUrl || undefined,
        localPath: localPath || undefined,
        urlPrefixes,
        dependsOn,
      });
      res.status(201).json(svc);
    } catch (err: any) {
      const status = err.message?.includes('already exists') ? 409 : 500;
      res.status(status).json({ error: err.message });
    }
  });

  // PUT /api/mv/services/:id
  router.put('/:id', async (req, res) => {
    try {
      const updates: Record<string, unknown> = {};
      const { name, type, repo, localPath, urlPrefixes, dependsOn } = req.body;
      if (name) updates.name = name;
      if (type) updates.type = type;
      if (repo?.project) updates.repoProject = repo.project;
      if (repo?.slug) updates.repoSlug = repo.slug;
      if (repo?.branch) updates.repoBranch = repo.branch;
      if (localPath !== undefined) updates.localPath = localPath;
      if (urlPrefixes) updates.urlPrefixes = urlPrefixes;
      if (dependsOn) updates.dependsOn = dependsOn;

      const svc = await updateService(req.params.id, updates);
      if (!svc) {
        res
          .status(404)
          .json({ error: `Service "${req.params.id}" not found`, code: 'SERVICE_NOT_FOUND' });
        return;
      }
      res.json(svc);
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // DELETE /api/mv/services/:id
  router.delete('/:id', async (req, res) => {
    try {
      const confirm = req.query.confirm === 'true';
      const result = await deleteService(req.params.id, confirm);
      if (!result.deleted && !result.impact) {
        res
          .status(404)
          .json({ error: `Service "${req.params.id}" not found`, code: 'SERVICE_NOT_FOUND' });
        return;
      }
      if (!result.deleted) {
        res
          .status(400)
          .json({ error: 'Confirm required', code: 'CONFIRM_REQUIRED', impact: result.impact });
        return;
      }
      res.json({ deleted: req.params.id, impact: result.impact });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/mv/services/:id/sinks — list all detected sinks for a service
  router.get('/:id/sinks', async (req, res) => {
    try {
      const { getGraphBackend } = await import('../../core/graph-backend/index.js');
      const backend = await getGraphBackend();
      const repoId = req.params.id;
      const sinks = await backend.executeQuery(
        `
        MATCH (ds:DetectedSink {repoId: $repoId})
        RETURN ds.id AS id, ds.callSiteMethod AS method, ds.calleeMethod AS callee,
               ds.sinkType AS type, ds.patternId AS pattern, ds.targetExpression AS expr,
               ds.filePath AS file, ds.lineNumber AS line,
               ds.resolvedUrl AS resolvedUrl, ds.resolvedTopic AS resolvedTopic,
               ds.resolvedVia AS resolvedVia, ds.confidence AS confidence,
               ds.resolutionStatus AS resolutionStatus, ds.resolutionConfidence AS resolutionConfidence,
               ds.resolutionReason AS resolutionReason, ds.resolutionMethod AS resolutionMethod,
               ds.resolutionEvidence AS resolutionEvidence
        ORDER BY ds.sinkType, ds.confidence DESC
      `,
        { repoId },
      );
      const items = (sinks as Array<Record<string, unknown>>).map((s) => ({
        ...s,
        resolved:
          s.resolvedVia && s.resolvedVia !== 'unresolvable'
            ? s.resolvedUrl || s.resolvedTopic || null
            : null,
        status:
          (s.resolutionStatus as string) ||
          (!s.resolvedVia || s.resolvedVia === 'unresolvable' ? 'unresolved' : 'resolved'),
      }));
      res.json({
        service: repoId,
        sinks: items,
        total: items.length,
        resolved: items.filter((s) => s.status === 'resolved').length,
      });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/mv/services/:id/config — merged config for a service
  router.get('/:id/config', async (req, res) => {
    try {
      const { resolveConfig, clearConfigCache } = await import('../engine/config-resolver.js');
      const { loadConfig } = await import('../config/loader.js');
      const { resolveServiceRepoPath } = await import('../util/repo-path.js');
      const config = await loadConfig();
      const repoId = req.params.id;
      const repoPath = (await resolveServiceRepoPath(repoId)).repoPath;
      clearConfigCache(repoId);
      const configMap = await resolveConfig(
        repoId,
        repoPath,
        undefined,
        config.cloudConfig?.baseUrl,
        config.cloudConfig?.defaultProfile,
      );
      const q = ((req.query.q as string) || '').toLowerCase();
      let entries = [...configMap.entries()].map(([key, value]) => ({ key, value }));
      if (q)
        entries = entries.filter(
          (e) => e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q),
        );
      entries.sort((a, b) => a.key.localeCompare(b.key));
      res.json({ service: repoId, config: entries, total: entries.length });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
};

/**
 * File System API — Directory browsing for localPath
 */

import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../config/loader.js';
import { mvLog } from '../util/logger.js';

const LOG = 'fs-api';

export const createFsRouter = (): Router => {
  const router = Router();

  // GET /api/mv/fs/list?path=...
  router.get('/list', async (req, res) => {
    try {
      const config = await loadConfig();
      // CONTAINER_WORKSPACE is the Linux path where the host workspace is
      // mounted inside the container (always /workspace). HOST_WORKSPACE is
      // the host-side path kept for reference. Prefer CONTAINER_WORKSPACE so
      // this code always receives a valid Linux path regardless of the OS the
      // Docker host is running (Windows paths in HOST_WORKSPACE are invalid
      // as Linux filesystem paths inside the container).
      let targetPath =
        (req.query.path as string) ||
        process.env.CONTAINER_WORKSPACE ||
        process.env.HOST_WORKSPACE ||
        config.workspace.dir;

      // Ensure path exists
      if (!targetPath || !fs.existsSync(targetPath)) {
        // Fallback to workspace dir or /
        targetPath = config.workspace.dir;
        if (!fs.existsSync(targetPath)) targetPath = '/';
      }

      const stats = fs.statSync(targetPath);
      if (!stats.isDirectory()) {
        res.status(400).json({ error: 'Not a directory' });
        return;
      }

      const entries = fs.readdirSync(targetPath, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => ({
          name: e.name,
          path: path.join(targetPath, e.name),
          type: 'dir',
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const parent = path.dirname(targetPath);

      res.json({
        currentPath: targetPath,
        parentPath: targetPath === '/' ? null : parent,
        directories: dirs,
      });
    } catch (err: unknown) {
      mvLog.error(LOG, 'Failed to list directory', err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
};

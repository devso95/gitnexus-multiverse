/**
 * File System API — Directory browsing for localPath
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/loader.js';
import { mvLog } from '../util/logger.js';

const requireFromGitNexus = createRequire(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../gitnexus/package.json'),
);

const LOG = 'fs-api';

export const createFsRouter = () => {
  const express = requireFromGitNexus('express') as { Router: () => any };
  const router = express.Router();

  router.get('/list', async (req: any, res: any) => {
    try {
      const config = await loadConfig();
      let targetPath =
        (req.query.path as string) ||
        process.env.CONTAINER_WORKSPACE ||
        process.env.HOST_WORKSPACE ||
        config.workspace.dir;

      if (!targetPath || !fs.existsSync(targetPath)) {
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
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => ({
          name: entry.name,
          path: path.join(targetPath, entry.name),
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

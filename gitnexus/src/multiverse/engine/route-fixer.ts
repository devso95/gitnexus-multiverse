/**
 * Route Fixer — resolve class-level @RequestMapping base paths
 *
 * Core pipeline only stores method-level paths. This scans source files
 * to find class-level @RequestMapping and prepends it.
 */

import fs from 'fs';
import path from 'path';
import { loadConfig } from '../config/loader.js';

const cache = new Map<string, string>();

/**
 * Scan a Java file for class-level @RequestMapping to get the base path.
 * e.g. @RequestMapping("/api/v1/orders/create") → "/api/v1/orders/create"
 */
export const resolveClassBasePath = async (
  filePath: string,
  serviceId: string,
): Promise<string> => {
  const key = `${serviceId}:${filePath}`;
  if (cache.has(key)) return cache.get(key)!;

  try {
    const config = await loadConfig();
    const fullPath = path.join(config.workspace.dir, serviceId, filePath);
    if (!fs.existsSync(fullPath)) {
      cache.set(key, '');
      return '';
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');

    // Find class-level @RequestMapping before the class declaration
    // Pattern: @RequestMapping("...") or @RequestMapping(value = "...", ...)
    let basePath = '';
    let inClass = false;

    for (const line of lines) {
      const trimmed = line.trim();

      // Stop at class or interface declaration
      if (/^(public\s+)?(abstract\s+)?(class|interface)\s+/.test(trimmed)) {
        inClass = true;
        break;
      }

      // Match @RequestMapping("path") or @RequestMapping(value="path") or @RequestMapping(path={"path"})
      const m = trimmed.match(/@RequestMapping\s*\(\s*(?:(?:value|path)\s*=\s*)?[{"{\s]*"([^"]+)"/);
      if (m) {
        basePath = m[1];
      }
    }

    // Normalize: ensure starts with /, remove trailing /
    if (basePath && !basePath.startsWith('/')) basePath = '/' + basePath;
    basePath = basePath.replace(/\/$/, '');

    cache.set(key, basePath);
    return basePath;
  } catch {
    cache.set(key, '');
    return '';
  }
};

/** Clear cache (call after re-analyze) */
export const clearRouteFixerCache = () => cache.clear();

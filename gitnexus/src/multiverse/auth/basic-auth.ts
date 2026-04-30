/**
 * Basic Auth Middleware for Multiverse
 *
 * - Bcrypt password verification
 * - Role-based access: viewer blocks POST/PUT/DELETE
 * - Skip auth for health endpoint
 */

import type { Request, Response, NextFunction } from 'express';
import type { AuthUser } from '../config/types.js';

// Dynamic import to avoid TS module resolution error when bcryptjs not installed
let bcryptModule: any = null;
const BCRYPT_MODULE = 'bcryptjs';
const loadBcrypt = async () => {
  if (!bcryptModule) {
    try {
      const mod = await import(BCRYPT_MODULE);
      bcryptModule = mod.default || mod;
    } catch {
      bcryptModule = null;
    }
  }
  return bcryptModule;
};

// Pre-load bcrypt at module level (non-blocking)
loadBcrypt().catch(() => {});

export interface AuthenticatedRequest extends Request {
  user?: { username: string; role: string };
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

export const createBasicAuth = (users: AuthUser[]) => {
  // Build lookup map
  const userMap = new Map(users.map((u) => [u.username, u]));

  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Multiverse"');
      res.status(401).json({ error: 'Authentication required', code: 'UNAUTHORIZED' });
      return;
    }

    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString();
    const colonIdx = decoded.indexOf(':');
    if (colonIdx < 0) {
      res.status(401).json({ error: 'Invalid credentials', code: 'UNAUTHORIZED' });
      return;
    }

    const username = decoded.slice(0, colonIdx);
    const password = decoded.slice(colonIdx + 1);
    const user = userMap.get(username);

    if (!user) {
      res.status(401).json({ error: 'Invalid credentials', code: 'UNAUTHORIZED' });
      return;
    }

    try {
      const bcrypt = await loadBcrypt();
      if (!bcrypt) {
        console.error('bcryptjs not installed — auth disabled');
        res.status(500).json({ error: 'Auth module not available' });
        return;
      }
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        res.status(401).json({ error: 'Invalid credentials', code: 'UNAUTHORIZED' });
        return;
      }
    } catch {
      res.status(500).json({ error: 'Auth verification failed' });
      return;
    }

    // Role check: viewer cannot write
    if (user.role === 'viewer' && WRITE_METHODS.has(req.method)) {
      res
        .status(403)
        .json({ error: 'Viewer role cannot perform write operations', code: 'FORBIDDEN' });
      return;
    }

    req.user = { username: user.username, role: user.role };
    next();
  };
};

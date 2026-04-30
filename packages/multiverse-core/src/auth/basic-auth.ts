/**
 * Basic Auth Middleware for Multiverse
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthUser } from '../config/types.js';

type RequestLike = {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  user?: { username: string; role: string };
};

type ResponseLike = {
  setHeader(name: string, value: string): void;
  status(code: number): ResponseLike;
  json(payload: unknown): void;
};

type NextLike = () => void;

const requireFromGitNexus = createRequire(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../gitnexus/package.json'),
);

let bcryptModule: { compare?(password: string, hash: string): Promise<boolean> } | null = null;

const loadBcrypt = async () => {
  if (!bcryptModule) {
    try {
      bcryptModule = requireFromGitNexus('bcryptjs') as {
        compare?(password: string, hash: string): Promise<boolean>;
      };
    } catch {
      bcryptModule = null;
    }
  }
  return bcryptModule;
};

loadBcrypt().catch(() => {});

export interface AuthenticatedRequest extends RequestLike {
  user?: { username: string; role: string };
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

export const createBasicAuth = (users: AuthUser[]) => {
  const userMap = new Map(users.map((user) => [user.username, user]));

  return async (req: AuthenticatedRequest, res: ResponseLike, next: NextLike) => {
    const rawAuthHeader = req.headers.authorization;
    const authHeader = Array.isArray(rawAuthHeader) ? rawAuthHeader[0] : rawAuthHeader;
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
      if (!bcrypt?.compare) {
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

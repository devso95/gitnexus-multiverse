/**
 * GitNexus HTTP API Client
 * Bridges Multiverse web UI to gitnexus serve REST API
 */

import type {
  QueryResponse,
  ContextResponse,
  ImpactResponse,
  RenameResponse,
  GitNexusContextResponse,
  ErrorResponse,
} from '../types/gitnexus-api';

export interface GitNexusConfig {
  baseUrl: string; // e.g., "http://localhost:4747"
  timeout?: number; // default 30s
  onError?: (error: GitNexusError) => void;
}

export class GitNexusError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: string,
  ) {
    super(message);
    this.name = 'GitNexusError';
  }
}

class GitNexusClient {
  private config: GitNexusConfig;
  private abortControllers = new Map<string, AbortController>();

  constructor(config: GitNexusConfig) {
    this.config = {
      timeout: 30000,
      ...config,
    };
  }

  private async fetch<T>(
    method: string,
    path: string,
    body?: unknown,
    abortKey?: string,
  ): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);
    if (abortKey) {
      this.abortControllers.set(abortKey, controller);
    }

    try {
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        let errorData: ErrorResponse | undefined;
        try {
          errorData = await response.json();
        } catch {}

        const error = new GitNexusError(
          `HTTP_${response.status}`,
          errorData?.error || `HTTP ${response.status}`,
          errorData?.details,
        );
        this.config.onError?.(error);
        throw error;
      }

      return response.json();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        const error = new GitNexusError(
          'TIMEOUT',
          `Request timeout after ${this.config.timeout}ms`,
        );
        this.config.onError?.(error);
        throw error;
      }
      if (err instanceof GitNexusError) throw err;
      const error = new GitNexusError(
        'NETWORK_ERROR',
        err instanceof Error ? err.message : 'Unknown error',
      );
      this.config.onError?.(error);
      throw error;
    } finally {
      clearTimeout(timeoutId);
      if (abortKey) {
        this.abortControllers.delete(abortKey);
      }
    }
  }

  /**
   * Query symbols and processes for a given concept/keyword
   */
  async query(
    repoId: string,
    params: {
      query: string;
      service?: string;
      limit?: number;
      maxSymbols?: number;
    },
    abortKey?: string,
  ): Promise<QueryResponse> {
    return this.fetch<QueryResponse>(
      'POST',
      '/api/tools/query',
      {
        query: params.query,
        repo: repoId,
        service: params.service,
        limit: params.limit ?? 10,
        max_symbols: params.maxSymbols ?? 20,
      },
      abortKey,
    );
  }

  /**
   * Get complete context for a symbol (callers, callees, relations)
   */
  async context(
    repoId: string,
    symbolName: string,
    params?: {
      service?: string;
    },
    abortKey?: string,
  ): Promise<ContextResponse> {
    return this.fetch<ContextResponse>(
      'POST',
      '/api/tools/context',
      {
        name: symbolName,
        repo: repoId,
        service: params?.service,
      },
      abortKey,
    );
  }

  /**
   * Get impact (blast radius) of a change
   */
  async impact(
    repoId: string,
    target: string,
    direction: 'upstream' | 'downstream',
    params?: {
      service?: string;
    },
    abortKey?: string,
  ): Promise<ImpactResponse> {
    return this.fetch<ImpactResponse>(
      'POST',
      '/api/tools/impact',
      {
        target,
        repo: repoId,
        direction,
        service: params?.service,
      },
      abortKey,
    );
  }

  /**
   * Dry-run a rename operation
   */
  async renamePreview(
    repoId: string,
    symbolName: string,
    newName: string,
    abortKey?: string,
  ): Promise<RenameResponse> {
    return this.fetch<RenameResponse>(
      'POST',
      '/api/tools/rename',
      {
        symbol_name: symbolName,
        new_name: newName,
        repo: repoId,
        dry_run: true,
      },
      abortKey,
    );
  }

  /**
   * Get repository/index context (freshness, symbol counts, etc.)
   */
  async getRepositoryContext(repoId: string, abortKey?: string): Promise<GitNexusContextResponse> {
    return this.fetch<GitNexusContextResponse>(
      'GET',
      `/api/repo/${encodeURIComponent(repoId)}/context`,
      undefined,
      abortKey,
    );
  }

  /**
   * Check if a repository is indexed
   */
  async isRepositoryIndexed(repoId: string, abortKey?: string): Promise<boolean> {
    try {
      await this.getRepositoryContext(repoId, abortKey);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Cancel any pending request with the given key
   */
  cancel(abortKey: string): void {
    const controller = this.abortControllers.get(abortKey);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(abortKey);
    }
  }

  /**
   * Cancel all pending requests
   */
  cancelAll(): void {
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();
  }

  /**
   * Update base URL (for dynamic reconfiguration)
   */
  setBaseUrl(baseUrl: string): void {
    this.config.baseUrl = baseUrl;
  }
}

// Singleton instance
let clientInstance: GitNexusClient | null = null;

export function initGitNexusClient(config: GitNexusConfig): GitNexusClient {
  clientInstance = new GitNexusClient(config);
  return clientInstance;
}

export function getGitNexusClient(): GitNexusClient {
  if (!clientInstance) {
    const baseUrl = import.meta.env.VITE_GITNEXUS_API || 'http://localhost:4747';
    clientInstance = new GitNexusClient({ baseUrl });
  }
  return clientInstance;
}

export default GitNexusClient;

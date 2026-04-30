/**
 * React hook for GitNexus client integration
 */

import { useCallback, useEffect, useState } from 'react';
import {
  getGitNexusClient,
  GitNexusError,
  type GitNexusConfig,
  initGitNexusClient,
} from '../lib/gitnexus-client';
import type { QueryResponse, ContextResponse, ImpactResponse } from '../types/gitnexus-api';

export interface UseGitNexusOptions {
  config?: GitNexusConfig;
  onError?: (error: GitNexusError) => void;
  autoInitialize?: boolean;
}

export interface UseGitNexusResult {
  isAvailable: boolean;
  isLoading: boolean;
  error: GitNexusError | null;

  // Methods
  query(
    repoId: string,
    queryStr: string,
    options?: { service?: string; limit?: number },
  ): Promise<QueryResponse>;

  context(repoId: string, symbolName: string, service?: string): Promise<ContextResponse>;

  impact(
    repoId: string,
    target: string,
    direction: 'upstream' | 'downstream',
    service?: string,
  ): Promise<ImpactResponse>;

  isIndexed(repoId: string): Promise<boolean>;

  cancel(key: string): void;
  cancelAll(): void;
}

/**
 * Hook for GitNexus integration
 * Handles initialization, error handling, and request management
 */
export function useGitNexus(options: UseGitNexusOptions = {}): UseGitNexusResult {
  const [isAvailable, setIsAvailable] = useState(false);
  const [error, setError] = useState<GitNexusError | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Initialize client on mount
  useEffect(() => {
    if (!options.autoInitialize && options.autoInitialize !== undefined) {
      return;
    }

    const baseUrl = options.config?.baseUrl || import.meta.env.VITE_GITNEXUS_API;
    if (!baseUrl) {
      console.warn('GitNexus API URL not configured (VITE_GITNEXUS_API)');
      setIsAvailable(false);
      return;
    }

    const client = initGitNexusClient({
      baseUrl,
      timeout: options.config?.timeout,
      onError: (err) => {
        setError(err);
        options.onError?.(err);
      },
    });

    // Test connectivity
    client
      .getRepositoryContext('test')
      .then(() => setIsAvailable(true))
      .catch(() => setIsAvailable(false));

    return () => {
      client.cancelAll();
    };
  }, [options.config?.baseUrl, options.autoInitialize, options.onError]);

  const client = getGitNexusClient();

  const query = useCallback(
    async (
      repoId: string,
      queryStr: string,
      queryOptions?: { service?: string; limit?: number },
    ): Promise<QueryResponse> => {
      if (!isAvailable) {
        throw new GitNexusError('NOT_AVAILABLE', 'GitNexus API not available');
      }
      setIsLoading(true);
      setError(null);
      try {
        return await client.query(repoId, {
          query: queryStr,
          service: queryOptions?.service,
          limit: queryOptions?.limit,
        });
      } catch (err) {
        const gitNexusErr =
          err instanceof GitNexusError ? err : new GitNexusError('UNKNOWN', String(err));
        setError(gitNexusErr);
        throw gitNexusErr;
      } finally {
        setIsLoading(false);
      }
    },
    [client, isAvailable],
  );

  const context = useCallback(
    async (repoId: string, symbolName: string, service?: string): Promise<ContextResponse> => {
      if (!isAvailable) {
        throw new GitNexusError('NOT_AVAILABLE', 'GitNexus API not available');
      }
      setIsLoading(true);
      setError(null);
      try {
        return await client.context(repoId, symbolName, { service });
      } catch (err) {
        const gitNexusErr =
          err instanceof GitNexusError ? err : new GitNexusError('UNKNOWN', String(err));
        setError(gitNexusErr);
        throw gitNexusErr;
      } finally {
        setIsLoading(false);
      }
    },
    [client, isAvailable],
  );

  const impact = useCallback(
    async (
      repoId: string,
      target: string,
      direction: 'upstream' | 'downstream',
      service?: string,
    ): Promise<ImpactResponse> => {
      if (!isAvailable) {
        throw new GitNexusError('NOT_AVAILABLE', 'GitNexus API not available');
      }
      setIsLoading(true);
      setError(null);
      try {
        return await client.impact(repoId, target, direction, { service });
      } catch (err) {
        const gitNexusErr =
          err instanceof GitNexusError ? err : new GitNexusError('UNKNOWN', String(err));
        setError(gitNexusErr);
        throw gitNexusErr;
      } finally {
        setIsLoading(false);
      }
    },
    [client, isAvailable],
  );

  const isIndexed = useCallback(
    async (repoId: string): Promise<boolean> => {
      try {
        return await client.isRepositoryIndexed(repoId);
      } catch {
        return false;
      }
    },
    [client],
  );

  const cancel = useCallback(
    (key: string) => {
      client.cancel(key);
    },
    [client],
  );

  const cancelAll = useCallback(() => {
    client.cancelAll();
  }, [client]);

  return {
    isAvailable,
    isLoading,
    error,
    query,
    context,
    impact,
    isIndexed,
    cancel,
    cancelAll,
  };
}

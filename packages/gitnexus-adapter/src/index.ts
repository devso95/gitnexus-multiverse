import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ServiceNode } from '../../multiverse-core/src/api/types.js';

export interface GitNexusPipelineResult {
  graph: {
    nodeCount: number;
    relationshipCount: number;
  };
  totalFileCount: number;
}

export interface StartMultiverseOptions {
  config?: string;
  port?: number;
  host?: string;
}

const adapterRoot = path.dirname(fileURLToPath(import.meta.url));

const sourceModuleUrl = (...segments: string[]): string =>
  pathToFileURL(path.resolve(adapterRoot, ...segments)).href;

export async function runGitNexusPipeline(
  repoPath: string,
  onProgress: (message: string) => void = () => {},
): Promise<GitNexusPipelineResult> {
  const mod = (await import(
    sourceModuleUrl('../../../gitnexus/src/core/ingestion/pipeline.ts')
  )) as {
    runPipelineFromRepo: (
      repoPath: string,
      onProgress: (message: string) => void,
    ) => Promise<GitNexusPipelineResult>;
  };
  return mod.runPipelineFromRepo(repoPath, onProgress);
}

export async function startLegacyMultiverseServer(options: StartMultiverseOptions = {}) {
  const mod = (await import(sourceModuleUrl('../../../gitnexus/src/multiverse/server.ts'))) as {
    startMultiverseServer: (options: StartMultiverseOptions) => Promise<unknown>;
  };
  return mod.startMultiverseServer(options);
}

export async function getLegacyService(serviceId: string): Promise<ServiceNode | null> {
  const mod = (await import(
    sourceModuleUrl('../../../gitnexus/src/multiverse/admin/service-registry.ts')
  )) as {
    getService: (serviceId: string) => Promise<ServiceNode | null>;
  };
  return mod.getService(serviceId);
}

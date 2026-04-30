import fs from 'fs';
import path from 'path';
import { getService } from '../admin/service-registry.js';
import { loadConfig } from '../config/loader.js';

export interface ResolvedServiceRepoPath {
  repoPath: string;
  source: 'localPath' | 'repoSlug' | 'serviceId';
}

export async function resolveServiceRepoPath(serviceId: string): Promise<ResolvedServiceRepoPath> {
  const config = await loadConfig();
  const service = await getService(serviceId).catch(() => null);

  const candidates: ResolvedServiceRepoPath[] = [];
  if (service?.localPath) {
    candidates.push({ repoPath: service.localPath, source: 'localPath' });
  }
  if (service?.repoSlug) {
    candidates.push({
      repoPath: path.join(config.workspace.dir, service.repoSlug),
      source: 'repoSlug',
    });
  }
  candidates.push({ repoPath: path.join(config.workspace.dir, serviceId), source: 'serviceId' });

  return candidates.find((candidate) => fs.existsSync(candidate.repoPath)) || candidates[0];
}

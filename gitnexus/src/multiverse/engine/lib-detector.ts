/**
 * Library Dependency Detector — parse pom.xml to find dependencies on registered services
 * Creates DEPENDS_ON edges between ServiceNodes in Neo4j.
 */

import fs from 'fs';
import path from 'path';
import { getGraphBackend } from '../../core/graph-backend/index.js';
import { listServices } from '../admin/service-registry.js';
import { mvLog } from '../util/logger.js';

const LOG = 'lib-detector';

/**
 * Parse pom.xml, find dependencies matching registered services (type=lib),
 * create DEPENDS_ON edges.
 */
export const detectLibDependencies = async (
  serviceId: string,
  repoPath: string,
): Promise<number> => {
  const pomPath = path.join(repoPath, 'pom.xml');
  if (!fs.existsSync(pomPath)) return 0;

  let pom: string;
  try {
    pom = fs.readFileSync(pomPath, 'utf-8');
  } catch {
    return 0;
  }

  // Extract artifactIds from <dependency> blocks
  const depRegex = /<dependency>[^]*?<artifactId>([^<]+)<\/artifactId>[^]*?<\/dependency>/g;
  const artifactIds = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = depRegex.exec(pom)) !== null) {
    artifactIds.add(match[1].trim());
  }

  if (!artifactIds.size) return 0;

  // Match against registered services
  const services = await listServices();
  const backend = await getGraphBackend();
  let linked = 0;

  // Clean old DEPENDS_ON edges from this service
  await backend
    .executeQuery(`MATCH (s:ServiceNode {id: $id})-[r:DEPENDS_ON]->() DELETE r`, { id: serviceId })
    .catch((err: unknown) => {
      mvLog.warn(LOG, `Failed to clean old DEPENDS_ON for ${serviceId}`, err);
    });

  for (const svc of services) {
    if (svc.id === serviceId) continue;
    // Match by repoSlug or id
    if (artifactIds.has(svc.repoSlug) || artifactIds.has(svc.id)) {
      await backend
        .executeQuery(
          `
        MATCH (a:ServiceNode {id: $from}), (b:ServiceNode {id: $to})
        MERGE (a)-[r:DEPENDS_ON]->(b)
        SET r.type = 'maven', r.detectedAt = $now
      `,
          { from: serviceId, to: svc.id, now: new Date().toISOString() },
        )
        .catch((err: unknown) => {
          mvLog.warn(LOG, `Failed to create DEPENDS_ON ${serviceId} → ${svc.id}`, err);
        });
      linked++;
    }
  }

  return linked;
};

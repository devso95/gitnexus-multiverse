/**
 * Service Registry — Neo4j ServiceNode CRUD
 */

import { getGraphBackend } from '../../core/graph-backend/index.js';
import { mvLog } from '../util/logger.js';
import { ServiceNode } from '../api/types.js';

const LOG = 'service-registry';

// Re-export for convenience if needed by other files importing from here
export { ServiceNode };

const toProps = (s: ServiceNode): Record<string, unknown> => ({
  id: s.id,
  name: s.name,
  type: s.type,
  repoProject: s.repoProject,
  repoSlug: s.repoSlug,
  repoBranch: s.repoBranch,
  gitUrl: s.gitUrl || null,
  localPath: s.localPath || null,
  teamId: s.teamId || null,
  urlPrefixes: (s.urlPrefixes || []).join(','),
  dependsOn: (s.dependsOn || []).join(','),
  indexedAt: s.indexedAt || null,
  lastCommit: s.lastCommit || null,
  nodeCount: s.nodeCount ?? 0,
  edgeCount: s.edgeCount ?? 0,
  entryPointCount: s.entryPointCount ?? 0,
  analyzeStatus: s.analyzeStatus || null,
  analyzeError: s.analyzeError || null,
});

const fromRecord = (r: Record<string, unknown>): ServiceNode => ({
  id: String(r.id),
  name: String(r.name),
  type: (r.type as 'service' | 'lib') || 'service',
  repoProject: String(r.repoProject),
  repoSlug: String(r.repoSlug),
  repoBranch: String(r.repoBranch),
  gitUrl: r.gitUrl ? String(r.gitUrl) : undefined,
  localPath: r.localPath ? String(r.localPath) : undefined,
  teamId: r.teamId ? String(r.teamId) : undefined,
  urlPrefixes: typeof r.urlPrefixes === 'string' ? r.urlPrefixes.split(',').filter(Boolean) : [],
  dependsOn: typeof r.dependsOn === 'string' ? r.dependsOn.split(',').filter(Boolean) : [],
  indexedAt: r.indexedAt ? String(r.indexedAt) : undefined,
  lastCommit: r.lastCommit ? String(r.lastCommit) : undefined,
  nodeCount: Number(r.nodeCount ?? 0),
  edgeCount: Number(r.edgeCount ?? 0),
  entryPointCount: Number(r.entryPointCount ?? 0),
  analyzeStatus: r.analyzeStatus ? String(r.analyzeStatus) : undefined,
  analyzeError: r.analyzeError ? String(r.analyzeError) : undefined,
});

export const listServices = async (type?: string): Promise<ServiceNode[]> => {
  const backend = await getGraphBackend();
  if (type) {
    const rows = await backend.executeQuery(
      `MATCH (n:ServiceNode) WHERE n.type = $type RETURN properties(n) AS props ORDER BY n.name`,
      { type },
    );
    return rows.map((r) => fromRecord(r.props ?? r));
  }
  const rows = await backend.executeQuery(
    `MATCH (n:ServiceNode) RETURN properties(n) AS props ORDER BY n.name`,
  );
  return rows.map((r) => fromRecord(r.props ?? r));
};

export const getService = async (id: string): Promise<ServiceNode | null> => {
  const backend = await getGraphBackend();
  const rows = await backend.executeQuery(
    `MATCH (n:ServiceNode {id: $id}) RETURN properties(n) AS props`,
    { id },
  );
  return rows.length ? fromRecord(rows[0].props ?? rows[0]) : null;
};

export const createService = async (data: ServiceNode): Promise<ServiceNode> => {
  const backend = await getGraphBackend();
  const existing = await getService(data.id);
  if (existing) throw new Error(`Service "${data.id}" already exists`);

  const props = toProps(data);
  await backend.insertNode('ServiceNode', props);
  return data;
};

export const updateService = async (
  id: string,
  updates: Partial<ServiceNode>,
): Promise<ServiceNode | null> => {
  const existing = await getService(id);
  if (!existing) return null;

  const merged = { ...existing, ...updates, id }; // id cannot change
  const backend = await getGraphBackend();
  const props = toProps(merged);
  const { id: _id, ...propsWithoutId } = props;
  await backend.executeQuery(`MATCH (n:ServiceNode {id: $id}) SET n += $props`, {
    id,
    props: propsWithoutId,
  });
  return merged;
};

export const deleteService = async (
  id: string,
  confirm: boolean,
): Promise<{ deleted: boolean; impact?: Record<string, unknown> }> => {
  const existing = await getService(id);
  if (!existing) return { deleted: false };

  const backend = await getGraphBackend();
  const impactRows = await backend
    .executeQuery(`MATCH (n {repoId: $id}) RETURN count(n) AS nodeCount`, { id })
    .catch(() => [{ nodeCount: 0 }]);
  const nodeCount = impactRows[0]?.nodeCount ?? 0;

  if (!confirm) {
    return {
      deleted: false,
      impact: { nodesAffected: nodeCount, message: 'Pass ?confirm=true to delete' },
    };
  }

  await backend.executeQuery(`MATCH (n:ServiceNode {id: $id}) DETACH DELETE n`, { id });
  if (nodeCount > 0) {
    await backend.executeQuery(`MATCH (n {repoId: $id}) DETACH DELETE n`, { id });
  }

  return { deleted: true, impact: { nodesDeleted: nodeCount } };
};

/** Ensure ServiceNode constraint + performance indexes */
export const ensureServiceConstraints = async (): Promise<void> => {
  const backend = await getGraphBackend();

  const indexes = [
    // Uniqueness
    'CREATE CONSTRAINT IF NOT EXISTS FOR (n:ServiceNode) REQUIRE n.id IS UNIQUE',
    // repoId — used by almost every multiverse query
    ...[
      'CodeElement',
      'Class',
      'Method',
      'Function',
      'Route',
      'Listener',
      'File',
      'Interface',
      'Enum',
      'Const',
      'Annotation',
      'Constructor',
      'Property',
      'Community',
      'Process',
    ].map((l) => `CREATE INDEX IF NOT EXISTS FOR (n:${l}) ON (n.repoId)`),
    // Route lookups
    'CREATE INDEX IF NOT EXISTS FOR (n:Route) ON (n.routePath)',
    'CREATE INDEX IF NOT EXISTS FOR (n:Route) ON (n.repoId, n.routePath)',
    // Listener lookups
    'CREATE INDEX IF NOT EXISTS FOR (n:Listener) ON (n.topic)',
    'CREATE INDEX IF NOT EXISTS FOR (n:Listener) ON (n.repoId, n.topic)',
    // Multiverse nodes
    'CREATE INDEX IF NOT EXISTS FOR (n:DetectedSink) ON (n.repoId)',
    'CREATE INDEX IF NOT EXISTS FOR (n:BusinessGroup) ON (n.serviceId)',
    // Gateway + Transport (cross-service model)
    'CREATE INDEX IF NOT EXISTS FOR (n:Gateway) ON (n.repoId)',
    'CREATE CONSTRAINT IF NOT EXISTS FOR (n:Gateway) REQUIRE n.id IS UNIQUE',
    'CREATE CONSTRAINT IF NOT EXISTS FOR (n:Transport) REQUIRE n.id IS UNIQUE',
    'CREATE INDEX IF NOT EXISTS FOR (n:Transport) ON (n.type)',
    'CREATE INDEX IF NOT EXISTS FOR (n:Transport) ON (n.name)',
    'CREATE INDEX IF NOT EXISTS FOR (n:Transport) ON (n.path)',
    'CREATE INDEX IF NOT EXISTS FOR (n:Transport) ON (n.topic)',
    // name lookups
    ...['Class', 'Method', 'Function', 'Interface'].map(
      (l) => `CREATE INDEX IF NOT EXISTS FOR (n:${l}) ON (n.name)`,
    ),
    // filePath lookups
    ...['Class', 'Method', 'Function', 'File'].map(
      (l) => `CREATE INDEX IF NOT EXISTS FOR (n:${l}) ON (n.filePath)`,
    ),
    // Relationship indexes
    'CREATE INDEX IF NOT EXISTS FOR ()-[r:TRANSPORTS_TO]-() ON (r.sourceRepoId)',
    'CREATE INDEX IF NOT EXISTS FOR ()-[r:CodeRelation]-() ON (r.type)',
    // ServiceNode
    'CREATE INDEX IF NOT EXISTS FOR (n:ServiceNode) ON (n.type)',
  ];

  let ok = 0;
  for (const q of indexes) {
    try {
      await backend.executeQuery(q);
      ok++;
    } catch (err) {
      mvLog.debug(LOG, `Index already exists or failed: ${q.slice(0, 60)}...`, err);
    }
  }
  mvLog.info(LOG, `${ok}/${indexes.length} indexes ensured`);
};

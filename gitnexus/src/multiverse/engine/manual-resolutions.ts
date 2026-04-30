/**
 * Manual Resolution Store — persists user-provided sink resolutions
 * that survive re-analyze. Stored as ManualResolution nodes in Neo4j.
 *
 * After bubble-up + LLM resolve, applyManualResolutions() overlays
 * these onto the resolved array before cross-linking.
 */

import { getGraphBackend } from '../../core/graph-backend/index.js';
import { mvLog } from '../util/logger.js';
import type { ResolvedSink } from './bubble-up.js';

const LOG = 'manual-res';

export interface ManualResolution {
  /** Sink match key: patternId + filePath + lineNumber */
  id: string;
  serviceId: string;
  patternId: string;
  filePath: string;
  lineNumber: number;
  resolvedValue: string;
  sinkType: string;
  confidence: number;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

/** Save or update a manual resolution */
export async function saveManualResolution(
  r: Omit<ManualResolution, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<ManualResolution> {
  const backend = await getGraphBackend();
  const id = `mr:${r.serviceId}:${r.filePath}:${r.lineNumber}:${r.patternId}`;
  const now = new Date().toISOString();

  await backend.executeQuery(
    `MERGE (m:ManualResolution {id: $id})
     SET m.serviceId = $serviceId, m.patternId = $patternId,
         m.filePath = $filePath, m.lineNumber = $line,
         m.resolvedValue = $value, m.sinkType = $type,
         m.confidence = $conf, m.note = $note,
         m.updatedAt = $now,
         m.createdAt = COALESCE(m.createdAt, $now)`,
    {
      id,
      serviceId: r.serviceId,
      patternId: r.patternId,
      filePath: r.filePath,
      line: r.lineNumber,
      value: r.resolvedValue,
      type: r.sinkType,
      conf: r.confidence,
      note: r.note || '',
      now,
    },
  );

  mvLog.info(LOG, `Saved: ${id} → ${r.resolvedValue}`);
  return { ...r, id, createdAt: now, updatedAt: now };
}

/** List manual resolutions for a service (or all) */
export async function listManualResolutions(serviceId?: string): Promise<ManualResolution[]> {
  const backend = await getGraphBackend();
  const where = serviceId ? 'WHERE m.serviceId = $svc' : '';
  const rows = (await backend.executeQuery(
    `MATCH (m:ManualResolution) ${where} RETURN m { .* } AS props ORDER BY m.serviceId, m.filePath`,
    serviceId ? { svc: serviceId } : {},
  )) as Array<{ props: ManualResolution }>;
  return rows.map((r) => r.props);
}

/** Delete a manual resolution */
export async function deleteManualResolution(id: string): Promise<boolean> {
  const backend = await getGraphBackend();
  const rows = await backend.executeQuery(
    `MATCH (m:ManualResolution {id: $id}) DELETE m RETURN 1 AS ok`,
    { id },
  );
  return rows.length > 0;
}

/**
 * Apply manual resolutions onto resolved sinks array.
 * Call after bubble-up + LLM resolve, before cross-linking.
 * Matches by filePath + lineNumber + patternId.
 */
export async function applyManualResolutions(
  serviceId: string,
  resolved: ResolvedSink[],
): Promise<number> {
  const manuals = await listManualResolutions(serviceId);
  if (!manuals.length) return 0;

  const lookup = new Map<string, ManualResolution>();
  for (const m of manuals) {
    lookup.set(`${m.filePath}:${m.lineNumber}:${m.patternId}`, m);
  }

  let applied = 0;
  for (const r of resolved) {
    if (r.resolvedValue && r.confidence >= 0.7) continue;
    const key = `${r.filePath}:${r.lineNumber}:${r.patternId}`;
    const manual = lookup.get(key);
    if (manual) {
      r.resolvedValue = manual.resolvedValue;
      r.confidence = manual.confidence;
      r.resolvedVia = 'manual-cached';
      applied++;
    }
  }

  if (applied > 0) {
    mvLog.info(LOG, `${serviceId}: applied ${applied} manual resolutions`);
  }
  return applied;
}

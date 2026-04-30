/**
 * LLM Endpoint Matcher — stub for future LLM-assisted endpoint matching
 *
 * Matches unresolved Transport nodes to Routes/Listeners using LLM analysis.
 */

import type { LLMConfig } from '../../core/wiki/llm-client.js';
import { mvLog } from '../util/logger.js';

const LOG = 'llm-endpoint-matcher';

export interface MatchResult {
  matched: number;
  total?: number;
  details: Array<{ transportId: string; entryId: string; confidence: number }>;
}

/** Match unresolved transports to endpoints using LLM */
export async function llmMatchEndpoints(
  _serviceId: string,
  _repoPath: string,
  llmConfig?: LLMConfig | null,
): Promise<MatchResult> {
  if (!llmConfig) {
    mvLog.info(LOG, 'No LLM configured — skipping endpoint matching');
    return { matched: 0, details: [] };
  }
  // TODO: implement LLM-assisted matching
  return { matched: 0, details: [] };
}

/** Match a single transport to an endpoint using LLM */
export async function llmMatchSingleEndpoint(
  _serviceId: string,
  _repoPath: string,
  _transportId: string,
  llmConfig?: LLMConfig | null,
): Promise<MatchResult> {
  if (!llmConfig) return { matched: 0, details: [] };
  // TODO: implement single endpoint matching
  return { matched: 0, details: [] };
}

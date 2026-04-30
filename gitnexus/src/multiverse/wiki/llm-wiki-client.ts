/**
 * Multiverse Wiki LLM Client — thin wrapper over core callLLM
 *
 * Resolves config from multiverse-config.yml / env vars (not CLI config).
 * Falls back gracefully when no LLM is configured.
 * Includes circuit breaker to avoid retry storms on persistent failures.
 */

import { callLLM, type LLMConfig, type LLMResponse } from '../../core/wiki/llm-client.js';
import type { WikiLLMConfig } from '../config/types.js';
import { mvLog } from '../util/logger.js';

const LOG = 'wiki-llm';

// ── Circuit Breaker ──
// After `FAILURE_THRESHOLD` consecutive failures, open the circuit for `COOLDOWN_MS`.
// While open, all calls return null immediately without hitting the API.
const FAILURE_THRESHOLD = 2;
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

let consecutiveFailures = 0;
let circuitOpenUntil = 0;

/** Reset the circuit breaker (e.g. after a successful call or manual reset) */
export function resetCircuitBreaker(): void {
  consecutiveFailures = 0;
  circuitOpenUntil = 0;
}

/** Check if circuit breaker is currently open */
export function isCircuitOpen(): boolean {
  if (circuitOpenUntil === 0) return false;
  if (Date.now() >= circuitOpenUntil) {
    // Cooldown expired — half-open: allow one attempt
    circuitOpenUntil = 0;
    consecutiveFailures = FAILURE_THRESHOLD - 1; // next failure re-opens
    return false;
  }
  return true;
}

/** Resolve LLM config from multiverse wiki config + env vars */
export function resolveWikiLLMConfig(wikiLlm?: WikiLLMConfig): LLMConfig | null {
  const baseUrl = String(
    wikiLlm?.baseUrl || process.env.MV_WIKI_LLM_BASE_URL || process.env.ANTHROPIC_BASE_URL || '',
  );
  const apiKey = String(
    wikiLlm?.apiKey || process.env.MV_WIKI_LLM_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '',
  );
  const model = String(wikiLlm?.model || process.env.MV_WIKI_LLM_MODEL || 'claude-opus-4-6');
  const maxTokens = Number(wikiLlm?.maxTokens) || 4096;

  if (!baseUrl || !apiKey) {
    mvLog.info(LOG, 'No LLM configured for wiki — using template-based output');
    return null;
  }

  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, '') + '/v1',
    model,
    maxTokens,
    temperature: 0,
    provider: 'custom',
  };
}

/** Call LLM for wiki generation. Returns null if LLM not available or circuit is open. */
export async function callWikiLLM(
  prompt: string,
  systemPrompt: string,
  llmConfig: LLMConfig,
): Promise<string | null> {
  // Circuit breaker check
  if (isCircuitOpen()) return null;

  try {
    const response: LLMResponse = await callLLM(prompt, llmConfig, systemPrompt);
    // Success — reset failures
    consecutiveFailures = 0;
    return response.content;
  } catch (err: unknown) {
    consecutiveFailures++;
    const msg = err instanceof Error ? err.message : String(err);
    if (consecutiveFailures >= FAILURE_THRESHOLD) {
      circuitOpenUntil = Date.now() + COOLDOWN_MS;
      mvLog.warn(
        LOG,
        `Circuit OPEN after ${consecutiveFailures} failures — skipping LLM for ${COOLDOWN_MS / 1000}s. Last error: ${msg}`,
      );
    } else {
      mvLog.warn(LOG, `LLM call failed (${consecutiveFailures}/${FAILURE_THRESHOLD}): ${msg}`);
    }
    return null;
  }
}

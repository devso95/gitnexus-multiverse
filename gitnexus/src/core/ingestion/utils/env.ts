/**
 * Environment constants shared across the ingestion module.
 *
 * Centralizes `isDev` so every file in `ingestion/` imports from
 * one canonical location rather than re-declaring the check.
 *
 * @module
 */

/** Whether we're running in development mode (enables verbose console logging). */
export const isDev = process.env.NODE_ENV === 'development';

/**
 * Whether detailed analyze timing logs are enabled.
 *
 * Set `GITNEXUS_ANALYZE_TIMING=1` to log per-phase, per-chunk, and
 * per-worker timing so you can pinpoint where analyze is slow.
 * Safe to enable in production containers — output goes to stdout only.
 *
 * Read every call (not memoized) so test setups using `vi.stubEnv` work.
 */
export const isAnalyzeTiming = (): boolean => isDev || process.env.GITNEXUS_ANALYZE_TIMING === '1';

/**
 * Whether scope-resolution dev validators (e.g. `validateBindingsImmutability`)
 * should run AND emit warnings. Off by default in CLI runs to avoid silent
 * O(n) scans on large repos; on in `NODE_ENV=development` or when explicitly
 * opted-in via `VALIDATE_SEMANTIC_MODEL=1`. `VALIDATE_SEMANTIC_MODEL=0` is the
 * explicit off switch and wins over both.
 *
 * Read every call (not memoized) so test setups using `vi.stubEnv` work.
 */
export const isSemanticModelValidatorEnabled = (): boolean => {
  if (process.env.VALIDATE_SEMANTIC_MODEL === '0') return false;
  return process.env.NODE_ENV === 'development' || process.env.VALIDATE_SEMANTIC_MODEL === '1';
};

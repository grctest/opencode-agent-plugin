/**
 * Degradation helper — the single error-handling policy for Loom (audit 07 EH1).
 *
 * Three-tier policy table:
 * | policy            | when                              | behavior                                  |
 * |-------------------|-----------------------------------|-------------------------------------------|
 * | abort             | failure must halt the operation   | rethrow after logging                      |
 * | degrade           | operation can continue degraded   | swallow + count + flag + throttled warn    |
 * | ignore-with-count | pure telemetry, never affects flow| count only                                 |
 *
 * Every bare `catch {}` and unguarded persist path should be swept onto one of
 * these tiers so failures are visible, counted, and classified — never silent.
 */

import { Logger } from "../logger.js";
import { incrementKeyedCounter } from "../metrics.js";

const logger = new Logger();

/** Process-wide degradation counters, surfaced via /api/metrics. */
const degradationCounters = {};

function bump(key) {
  degradationCounters[key] = (degradationCounters[key] ?? 0) + 1;
  incrementKeyedCounter("degradation_events", key);
}

export function getDegradationSnapshot() {
  return { ...degradationCounters };
}

/**
 * DEGRADE tier: run fn; on failure log once per key (throttled), count the
 * failure, and return the typed fallback. The operation continues degraded.
 *
 * @param {string} key - Stable throttle/counter key, e.g. "persist.contribution"
 * @param {string} context - Human-readable description for logs
 * @param {Function} fn - Async or sync thunk to attempt
 * @param {*} fallback - Value returned when fn fails
 * @param {{ details?: Function, onFlag?: Function }} [opts]
 *   onFlag: called with the error when degradation first engages in a while —
 *   use to set meeting-row flags like semantic_degraded.
 * @returns {Promise<*>} fn's result, or fallback
 */
export async function degrade(key, context, fn, fallback = null, opts = {}) {
  try {
    return await fn();
  } catch (err) {
    logger.warnThrottled(`degrade.${key}`, context, `${context} failed — continuing degraded`, {
      error: err?.message ?? String(err),
    });
    bump(key);
    try {
      opts.onFlag?.(err);
    } catch {
      // Flag hooks must never throw past the helper
    }
    return typeof fallback === "function" ? fallback(err) : fallback;
  }
}

/**
 * IGNORE-WITH-COUNT tier: run fn; on failure only count it. No log, no fallback.
 * Use for best-effort telemetry writes whose failure carries no signal.
 */
export async function ignoreWithCount(key, fn) {
  try {
    return await fn();
  } catch {
    bump(key);
    return undefined;
  }
}

/**
 * ABORT tier: run fn; on failure log loudly and rethrow. Use for writes whose
 * loss corrupts the deliverable (synthesis artifact, terminal status transitions).
 */
export async function attemptOrAbort(context, fn) {
  try {
    return await fn();
  } catch (err) {
    logger.error("abort_tier_failure", `${context} failed — aborting`, { error: err?.message ?? String(err) });
    throw err;
  }
}

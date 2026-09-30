/**
 * Centralized retry utility with exponential backoff.
 * Provides consistent retry behavior across the application.
 */

import { incrementKeyedCounter } from "../metrics.js";

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  maxDelayMs: 8000,
  jitterMs: 500,
};

/**
 * Determines if an error is retryable.
 * @param {Error} err - The error to check
 * @returns {boolean} True if the error is retryable
 */
export function isRateLimitError(err) {
  if (!err) return false;
  if (err.status === 429 || err.statusCode === 429) return true;
  if (err.message && /\b429\b/.test(err.message)) return true;
  if (err.message && /rate.?limit/i.test(err.message)) return true;
  return false;
}

const GO_UPSELL_MESSAGE = "Free usage exceeded, subscribe to Go";
const GO_UPSELL_URL = "https://opencode.ai/go";

function parseRetryAfterMs(headers) {
  if (!headers) return null;
  const retryAfterMs = headers["retry-after-ms"];
  if (retryAfterMs) {
    const parsed = Number.parseFloat(retryAfterMs);
    if (!Number.isNaN(parsed) && parsed > 0) return Math.ceil(parsed);
  }
  const retryAfter = headers["retry-after"];
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (!Number.isNaN(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs) && dateMs > Date.now()) return Math.ceil(dateMs - Date.now());
  }
  return null;
}

function formatResetDuration(ms) {
  if (!ms || ms <= 0) return "less than a minute";
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return minutes > 0 ? `${minutes}m` : `${seconds}s`;
}

export function classifyRateLimitError(err) {
  if (!err) return null;
  const statusCode = err.status ?? err.statusCode ?? err.providerData?.statusCode;
  const responseBody = err.providerData?.responseBody ?? err.responseBody ?? "";
  const responseHeaders = err.providerData?.responseHeaders ?? err.responseHeaders ?? null;
  const message = err.message ?? "";
  const bodyStr = typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody ?? "");

  if (statusCode === 429 || /\b429\b/.test(message)) {
    if (bodyStr.includes("FreeUsageLimitError")) {
      return {
        type: "free_tier_limit",
        message: GO_UPSELL_MESSAGE,
        retryAfterMs: null,
        action: {
          reason: "free_tier_limit",
          title: "Free limit reached",
          message: "Subscribe to OpenCode Go for reliable access to the best open-source models, starting at $5/month.",
          label: "subscribe",
          link: GO_UPSELL_URL,
        },
      };
    }

    if (bodyStr.includes("GoUsageLimitError")) {
      let workspace = "";
      let limitName = "";
      try {
        const body = JSON.parse(bodyStr);
        workspace = body?.metadata?.workspace ?? "";
        limitName = body?.metadata?.limitName ?? "";
      } catch {}
      const retryAfterMs = parseRetryAfterMs(responseHeaders);
      const resetIn = retryAfterMs != null ? formatResetDuration(retryAfterMs) : "";
      const displayMessage = `${limitName ? `${limitName} usage limit` : "Usage limit"} reached.${resetIn ? ` It will reset in ${resetIn}.` : ""} To continue using this model now, enable usage from your available balance`;
      const link = workspace ? `https://opencode.ai/workspace/${workspace}/go` : "https://opencode.ai/go";
      return {
        type: "account_rate_limit",
        message: displayMessage,
        retryAfterMs,
        action: {
          reason: "account_rate_limit",
          title: "Go limit reached",
          message: displayMessage,
          label: "open settings",
          link,
        },
      };
    }

    const retryAfterMs = parseRetryAfterMs(responseHeaders);
    return {
      type: "transient_rate_limit",
      message: message || "Rate limit exceeded. Please try again later.",
      retryAfterMs,
      action: null,
    };
  }

  if (/rate.?limit|too many requests|rate_limit/i.test(message)) {
    return {
      type: "transient_rate_limit",
      message,
      retryAfterMs: null,
      action: null,
    };
  }

  return null;
}

export function isHardRateLimitError(err) {
  const classification = classifyRateLimitError(err);
  return classification !== null && (classification.type === "free_tier_limit" || classification.type === "account_rate_limit");
}

/**
 * Classify the two input-rejection shapes that are NOT rate limits.
 *
 * Both are refusals of the request, not transient failures, so both are
 * non-retryable: retrying an identical prompt against a hard limit wastes the
 * attempt and can wedge a round. They are kept out of classifyRateLimitError
 * because that function's contract is "is this a throttle, and should we back
 * off" — a caller that backs off on these waits for nothing.
 *
 * - `token_budget_exhausted`: the provider's own credit/quota for tokens is
 *   gone. Arrives as a 400 or an unrecognised 429 today, i.e. previously
 *   mislabelled as a transient rate limit (retried) or dropped entirely.
 * - `context_overflow`: the prompt exceeded the model's input window. This is
 *   the backstop for any payload the per-model guard in utils/context-budget.js
 *   failed to catch, and the signal that the estimate was too generous.
 */
export function classifyInputRejectionError(err) {
  if (!err) return null;
  const statusCode = err.status ?? err.statusCode ?? err.providerData?.statusCode ?? null;
  const responseBody = err.providerData?.responseBody ?? err.responseBody ?? "";
  const message = err.message ?? "";
  const bodyStr = typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody ?? "");
  const haystack = `${message} ${bodyStr}`;

  // Context overflow first: a provider may report it as 400, or as a 429 on
  // shared capacity, and the remedy (shorten the prompt) differs from backing off.
  if (/context[\s_-]*length|context[\s_-]*(?:window|size)[\s_-]*(?:exceeded|exceeds|too|limit)|maximum context|input[\s_-]*(?:too large|length)|too many tokens|prompt[\s_-]*(?:is[\s_-]*)?(?:too long|too large|exceeds|exceeded)|reduce the length of the messages|reduce your prompt|input length and `max_tokens`|string too long|request too large|payload too large|entity too large/i.test(haystack)) {
    return {
      type: "context_overflow",
      message: message || "Prompt exceeded the model's input context window.",
      statusCode,
    };
  }

  // Provider-side token budget/credit exhaustion. Deliberately does not match a
  // bare "usage limit": account_rate_limit already owns that on a 429, and this
  // branch is reached for the non-429 shapes that were previously unclassified.
  if (/insufficient[\s_-]*(?:quota|credit|balance|tokens?|funds)|quota[\s_-]*(?:exceeded|exhausted)|out of credit|credit balance is too low|billing[\s_-]*hard limit|exceeded your current quota|token[\s_-]*(?:budget|quota|limit)[\s_-]*(?:exceeded|exhausted)|payment required|purchase more tokens|add (?:credits|funds)|exceeded your token balance/i.test(haystack)) {
    return {
      type: "token_budget_exhausted",
      message: message || "Provider rejected the request: token budget exhausted.",
      statusCode,
    };
  }

  return null;
}

/** True for the input rejections that must never be retried as-is. */
export function isInputRejectionError(err) {
  return classifyInputRejectionError(err) !== null;
}

export function isRetryableError(err) {
  if (!err) return false;

  if (
    err.code === 'ECONNREFUSED' ||
    err.code === 'ETIMEDOUT' ||
    err.code === 'ENOTFOUND' ||
    err.code === 'ECONNRESET' ||
    err.code === 'EPIPE' ||
    err.code === 'SQLITE_BUSY' ||
    err.code === 'SQLITE_BUSY_SNAPSHOT'
  ) {
    return true;
  }
  if (err.message && /SQLITE_BUSY|database is locked|database is busy/i.test(err.message)) {
    return true;
  }

  if (err.name === "TimeoutError") {
    return true;
  }
  if (err.name === "AbortError") {
    return false;
  }
  // Session lifecycle errors are not model errors — retrying the same deleted session is futile
  if (err.name === "NotFoundError" || (err.message && /session not found/i.test(err.message))) {
    return false;
  }
  // Fetch network: status 0 + ECONNRESET/ETIMEDOUT is retryable; prose containing "timeout" is not
  if (err.status === 0 && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT')) {
    return true;
  }
  if (err.message && /(timed out|timeout after|ETIMEDOUT)/i.test(err.message)) {
    return true;
  }

  if (err.status >= 500 && err.status < 600) {
    return true;
  }

  if (isHardRateLimitError(err)) {
    return false;
  }

  // Context overflow and provider token-budget exhaustion are refusals of this
  // request, not throttles: the same prompt will be refused again. Non-retryable,
  // and classified elsewhere so the turn can degrade rather than die opaquely.
  if (isInputRejectionError(err)) {
    return false;
  }

  if (isRateLimitError(err) || err.status === 408 || err.statusCode === 408) {
    return true;
  }

  return false;
}

/**
 * Executes a function with retry logic and exponential backoff.
 * @template T
 * @param {() => Promise<T>} fn - Async function to execute
 * @param {Object} [options] - Retry options
 * @param {number} [options.maxAttempts=3] - Maximum number of attempts
 * @param {number} [options.baseDelayMs=1000] - Base delay in milliseconds
 * @param {number} [options.maxDelayMs=8000] - Maximum delay in milliseconds
 * @param {number} [options.jitterMs=500] - Random jitter to add to delay
 * @param {(err: Error, attempt: number) => boolean} [options.retryable] - Custom retryable check
 * @param {(err: Error, attempt: number, delay: number) => void} [options.onRetry] - Callback on retry
 * @param {(err: Error) => number|null} [options.getRetryAfterMs] - Extract Retry-After delay from error
 * @returns {Promise<T>} Result of the function
 */
export async function withRetry(fn, options = {}) {
  const {
    maxAttempts = DEFAULT_RETRY_CONFIG.maxAttempts,
    baseDelayMs = DEFAULT_RETRY_CONFIG.baseDelayMs,
    maxDelayMs = DEFAULT_RETRY_CONFIG.maxDelayMs,
    jitterMs = DEFAULT_RETRY_CONFIG.jitterMs,
    retryable = isRetryableError,
    onRetry = () => {},
    getRetryAfterMs = null,
  } = options;

  let lastError;
  if (maxAttempts < 1) {
    throw new Error(`withRetry: maxAttempts must be >= 1, got ${maxAttempts}`);
  }
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fn();
      if (attempt > 0) incrementKeyedCounter('retry_events', 'retry_success');
      return res;
    } catch (err) {
      lastError = err;
      
      if (attempt === maxAttempts - 1 || !retryable(err)) {
        if (attempt > 0) {
          incrementKeyedCounter('retry_events', 'exhausted');
        }
        throw err;
      }
      incrementKeyedCounter('retry_events', 'attempted');
      
      let delay;
      if (getRetryAfterMs) {
        const retryAfter = getRetryAfterMs(err);
        if (retryAfter != null && retryAfter > 0) {
          delay = retryAfter;
        } else {
          delay = Math.min(
            baseDelayMs * Math.pow(2, attempt) + Math.random() * jitterMs,
            maxDelayMs
          );
        }
      } else {
        delay = Math.min(
          baseDelayMs * Math.pow(2, attempt) + Math.random() * jitterMs,
          maxDelayMs
        );
      }
      
      onRetry(err, attempt, delay);
      
      await new Promise(resolve => { const t = setTimeout(resolve, delay); if (t.unref) t.unref(); });
    }
  }
  
  throw lastError;
}

/**
 * Global unhealthy registry — cross-meeting persistent until explicitly enabled.
 * Promoted models never auto-recover via half-open; they require re-enabling in the dashboard Setup tab.
 */
const globalUnhealthyKeys = new Set();
const allBreakers = new Set();

export function markGlobalUnhealthyKey(key) {
  if (!key || key === "unknown") return;
  globalUnhealthyKeys.add(key);
}

export function clearGlobalUnhealthyKey(key) {
  globalUnhealthyKeys.delete(key);
  // Also clear per-instance local breaker state so enable is immediate, not 5 min delayed
  for (const b of allBreakers) {
    try { b._clearLocalKey(key); } catch {}
  }
}

export function clearAllGlobalUnhealthyKeys() {
  globalUnhealthyKeys.clear();
  for (const b of allBreakers) {
    try { b.clear(); } catch {}
  }
}

export function isGlobalUnhealthyKey(key) {
  return globalUnhealthyKeys.has(key);
}

export function getGlobalUnhealthyKeys() {
  return new Set(globalUnhealthyKeys);
}

/**
 * Circuit breaker with half-open state for gradual recovery.
 * Tracks per-model failures and allows retry testing once the reset timeout elapses.
 * Global unhealthy keys bypass half-open — they stay unhealthy until explicitly cleared.
 */
export class CircuitBreaker {
  constructor({ failureThreshold = 3, resetTimeoutMs = 300000, maxSize = 50 } = {}) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.maxSize = maxSize;
    this.#states = new Map();
    allBreakers.add(this);
  }

  #states;

  static #getModelKey(model) {
    return model ? `${model.providerID}/${model.modelID}` : 'unknown';
  }

  static getModelKey(model) {
    return CircuitBreaker.#getModelKey(model);
  }

  isHealthy(model) {
    const key = CircuitBreaker.#getModelKey(model);
    if (globalUnhealthyKeys.has(key)) return false;
    const state = this.#states.get(key);
    if (!state) return true;

    if (state.failures < this.failureThreshold) return true;

    if (Date.now() > state.nextAttempt) {
      if (state.status !== 'half-open') {
        state.status = 'half-open';
        state.nextAttempt = Date.now() + this.resetTimeoutMs;
      }
      return true;
    }

    return false;
  }

  recordSuccess(model) {
    const key = CircuitBreaker.#getModelKey(model);
    this.#states.delete(key);
  }

  recordFailure(model) {
    const key = CircuitBreaker.#getModelKey(model);
    const state = this.#states.get(key) ?? { failures: 0, status: 'closed', nextAttempt: 0 };
    state.failures = Math.min(state.failures + 1, this.failureThreshold + 1);
    state.status = state.failures >= this.failureThreshold ? 'open' : 'closed';
    if (state.status === 'open') {
      state.nextAttempt = Date.now() + this.resetTimeoutMs;
      // Promote to global unhealthy — requires explicit re-enabling in the dashboard Setup tab to recover
      globalUnhealthyKeys.add(key);
      // Breaker transitions are observable (audit 07 EH3)
      incrementKeyedCounter('breaker_events', `${key}:open`);
    }
    // Refresh recency for LRU — delete+re-set moves to end
    if (this.#states.has(key)) this.#states.delete(key);
    this.#states.set(key, state);
    if (this.#states.size > this.maxSize) {
      // Evict expired open breakers first, then oldest non-open, then oldest open (preserved if still within timeout)
      const now = Date.now();
      let oldest = null;
      for (const [k, v] of this.#states) {
        if (v.status === "open" && now > v.nextAttempt) { oldest = k; break; }
      }
      if (oldest == null) {
        for (const [k, v] of this.#states) {
          if (v.status !== "open") { oldest = k; break; }
        }
      }
      if (oldest == null) oldest = this.#states.keys().next().value;
      if (oldest !== key) this.#states.delete(oldest);
    }
    return state;
  }

  getState(model) {
    const key = CircuitBreaker.#getModelKey(model);
    return this.#states.get(key) ?? { failures: 0, status: 'closed', nextAttempt: 0 };
  }

  /**
   * Returns models from the available list whose circuit breaker is not open.
   * @param {Array<{providerID: string, modelID: string}>} availableModels
   * @returns {Array<{providerID: string, modelID: string}>}
   */
  getHealthyModels(availableModels) {
    return availableModels.filter((m) => this.isHealthy(m));
  }

  clear() {
    this.#states.clear();
  }

  _clearLocalKey(key) {
    this.#states.delete(key);
  }
}
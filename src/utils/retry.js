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
          // Retry exhaustion is observable (audit 07 EH3)
          incrementKeyedCounter('retry_events', 'exhausted');
        }
        throw err;
      }
      incrementKeyedCounter('retry_events', 'attempted');
      
      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt) + Math.random() * jitterMs,
        maxDelayMs
      );
      
      onRetry(err, attempt, delay);
      
      await new Promise(resolve => { const t = setTimeout(resolve, delay); if (t.unref) t.unref(); });
    }
  }
  
  throw lastError;
}

/**
 * Circuit breaker with half-open state for gradual recovery.
 * Tracks per-model failures and allows retry testing once the reset timeout elapses.
 */
export class CircuitBreaker {
  constructor({ failureThreshold = 3, resetTimeoutMs = 300000, maxSize = 50 } = {}) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.maxSize = maxSize;
    this.#states = new Map();
  }

  #states;

  static #getModelKey(model) {
    return model ? `${model.providerID}/${model.modelID}` : 'unknown';
  }

  isHealthy(model) {
    const key = CircuitBreaker.#getModelKey(model);
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
}
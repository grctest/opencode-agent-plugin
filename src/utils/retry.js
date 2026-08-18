/**
 * Centralized retry utility with exponential backoff.
 * Provides consistent retry behavior across the application.
 */

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
export function isRetryableError(err) {
  if (!err) return false;
  
  // Network errors
  if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
    return true;
  }
  
  // Timeout errors
  if (err.message && /timed?\s*out/i.test(err.message)) {
    return true;
  }
  
  // HTTP 5xx errors (if response object is attached)
  if (err.status >= 500 && err.status < 600) {
    return true;
  }
  
  // Rate limiting
  if (err.status === 429) {
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
      return await fn();
    } catch (err) {
      lastError = err;
      
      if (attempt === maxAttempts - 1 || !retryable(err)) {
        throw err;
      }
      
      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt) + Math.random() * jitterMs,
        maxDelayMs
      );
      
      onRetry(err, attempt, delay);
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

/**
 * Circuit breaker with half-open state for gradual recovery.
 * Tracks per-model failures and allows retry testing once the reset timeout elapses.
 */
export class CircuitBreaker {
  constructor({ failureThreshold = 3, resetTimeoutMs = 300000 } = {}) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
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
      state.status = 'half-open';
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
    state.failures++;
    state.status = state.failures >= this.failureThreshold ? 'open' : 'closed';
    if (state.status === 'open') {
      state.nextAttempt = Date.now() + this.resetTimeoutMs;
    }
    this.#states.set(key, state);
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
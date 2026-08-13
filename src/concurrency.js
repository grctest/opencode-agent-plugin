/** A semaphore for limiting concurrent async operations. */
export class Semaphore {
  #permits;
  #queue = [];
  #defaultTimeoutMs = 120000;

  constructor(permits) {
    this.#permits = permits;
  }

  async acquire(timeoutMs = this.#defaultTimeoutMs) {
    if (this.#permits > 0) {
      this.#permits--;
      return;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.#queue.indexOf(reject);
        if (idx >= 0) this.#queue.splice(idx, 1);
        reject(new Error(`Semaphore acquire timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#queue.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  release() {
    this.#permits++;
    const next = this.#queue.shift();
    if (next) {
      this.#permits--;
      next();
    }
  }
}

/** Runs tasks with a concurrency limit, returning results in order. */
export async function withConcurrency(tasks, limit, timeoutMs = 120000) {
  const semaphore = new Semaphore(limit);
  const wrapped = tasks.map(async (task) => {
    await semaphore.acquire(timeoutMs);
    try {
      return await task();
    } finally {
      semaphore.release();
    }
  });
  return Promise.allSettled(wrapped).then((results) => {
    return results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      // Individual task failures should not abort the rest of the batch.
      // Tasks that need to react to errors handle them internally.
      return undefined;
    });
  });
}

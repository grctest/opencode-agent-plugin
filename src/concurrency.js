/** A semaphore for limiting concurrent async operations. */
export class Semaphore {
  /** @type {number} */
  #permits;
  /** @type {Array<() => void>} */
  #queue = [];

  constructor(permits) {
    this.#permits = permits;
  }

  /** Acquires a permit, waiting if none are available. */
  async acquire() {
    if (this.#permits > 0) {
      this.#permits--;
      return;
    }
    return new Promise((resolve) => this.#queue.push(resolve));
  }

  /** Releases a permit, waking up the next waiter if any. */
  release() {
    this.#permits++;
    const next = this.#queue.shift();
    if (next) {
      this.#permits--;
      next();
    }
  }
}

/** Runs tasks with a concurrency limit, returning settled results in order. */
export async function withConcurrency(tasks, limit) {
  const semaphore = new Semaphore(limit);
  const wrapped = tasks.map(async (task) => {
    await semaphore.acquire();
    try {
      return await task();
    } finally {
      semaphore.release();
    }
  });
  return Promise.allSettled(wrapped);
}

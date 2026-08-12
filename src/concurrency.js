/** A semaphore for limiting concurrent async operations. */
export class Semaphore {
  #permits;
  #queue = [];

  constructor(permits) {
    this.#permits = permits;
  }

  async acquire() {
    if (this.#permits > 0) {
      this.#permits--;
      return;
    }
    return new Promise((resolve) => this.#queue.push(resolve));
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
  return Promise.all(wrapped);
}

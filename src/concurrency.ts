/** A semaphore for limiting concurrent async operations. */
export class Semaphore {
  private permits: number;
  private queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  /** Acquires a permit, waiting if none are available. */
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  /** Releases a permit, waking up the next waiter if any. */
  release(): void {
    this.permits++;
    const next = this.queue.shift();
    if (next) {
      this.permits--;
      next();
    }
  }
}

/** Runs tasks with a concurrency limit, returning settled results in order. */
export async function withConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<Array<PromiseSettledResult<T>>> {
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

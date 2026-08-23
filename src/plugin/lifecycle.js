import { Logger } from "../logger.js";

const logger = new Logger();

export function createLifecycleHandlers(activeLooms) {
  const markActiveMeetingsAborted = () => {
    for (const [id, engine] of activeLooms) {
      try {
        const state = engine.getState();
        if (state.status !== "converged" && state.status !== "cancelled" &&
            state.status !== "timeout" && state.status !== "max_rounds_reached" &&
            state.status !== "aborted" && state.status !== "deadlocked") {
          engine.cancel();
          logger.warn("process_exit", `Marking meeting ${id} as aborted due to process exit`);
        }
      } catch { /* best effort */ }
    }
  };

  const markActiveMeetingsAbortedAsync = async () => {
    for (const [id, engine] of activeLooms) {
      try {
        const state = engine.getState();
        if (state.status !== "converged" && state.status !== "cancelled" &&
            state.status !== "timeout" && state.status !== "max_rounds_reached" &&
            state.status !== "aborted" && state.status !== "deadlocked") {
          engine.cancel();
          logger.warn("process_exit", `Marking meeting ${id} as aborted due to process exit`);
        }
      } catch { /* best effort */ }
    }
    await new Promise((r) => setTimeout(r, 500));
  };

  function setupProcessHandlers() {
    const originalExit = process.exit.bind(process);

    process.on("exit", () => {
      try { markActiveMeetingsAborted(); } catch {}
    });
    process.on("SIGINT", async () => {
      await markActiveMeetingsAbortedAsync();
      process.exit(130);
    });
    process.on("SIGTERM", async () => {
      await markActiveMeetingsAbortedAsync();
      process.exit(143);
    });
    process.on("uncaughtException", (err) => {
      logger.error("uncaught_exception", "Uncaught exception — aborting active meetings", { message: err.message, stack: err.stack });
      markActiveMeetingsAborted();
      process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
      logger.error("unhandled_rejection", "Unhandled rejection — aborting active meetings", { reason: String(reason) });
      markActiveMeetingsAborted();
      process.exit(1);
    });

    return { markActiveMeetingsAborted, markActiveMeetingsAbortedAsync };
  }

  return { markActiveMeetingsAborted, markActiveMeetingsAbortedAsync, setupProcessHandlers };
}

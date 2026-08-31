import { Logger } from "../logger.js";
import { TERMINAL_STATUSES } from "../constants.js";

const logger = new Logger();

export function createLifecycleHandlers(activeLooms) {
  const markActiveMeetingsAborted = () => {
    const seen = new Set();
    for (const [id, engine] of activeLooms) {
      if (seen.has(engine)) continue;
      seen.add(engine);
      try {
        const state = engine.getState();
        if (!TERMINAL_STATUSES.has(state.status)) {
          engine.cancel();
          logger.warn("process_exit", `Marking meeting ${id} as aborted due to process exit`);
        }
      } catch { /* best effort */ }
    }
  };

  const markActiveMeetingsAbortedAsync = async () => {
    const seen = new Set();
    for (const [id, engine] of activeLooms) {
      if (seen.has(engine)) continue;
      seen.add(engine);
      try {
        const state = engine.getState();
        if (!TERMINAL_STATUSES.has(state.status)) {
          engine.cancel();
          logger.warn("process_exit", `Marking meeting ${id} as aborted due to process exit`);
        }
      } catch { /* best effort */ }
    }
    // Allow cancel to propagate to DB checkpoint — 800ms with unref so it doesn't hang tests
    await new Promise((r) => { const t = setTimeout(r, 800); if (t.unref) t.unref(); });
  };

  function setupProcessHandlers() {
    const handlers = {};
    handlers.exit = () => { try { markActiveMeetingsAborted(); } catch {} };
    handlers.sigint = async () => {
      await markActiveMeetingsAbortedAsync();
      process.exit(130);
    };
    handlers.sigterm = async () => {
      await markActiveMeetingsAbortedAsync();
      process.exit(143);
    };
    handlers.uncaughtException = (err) => {
      logger.error("uncaught_exception", "Uncaught exception — aborting active meetings (host process survives)", { message: err.message, stack: err.stack });
      markActiveMeetingsAborted();
      // Do not process.exit — let opencode host survive a stray rejection
    };
    handlers.unhandledRejection = (reason) => {
      logger.error("unhandled_rejection", "Unhandled rejection — aborting active meetings (host process survives)", { reason: String(reason) });
      markActiveMeetingsAborted();
      // Do not process.exit — let opencode host survive a stray rejection
    };
    process.on("exit", handlers.exit);
    process.on("SIGINT", handlers.sigint);
    process.on("SIGTERM", handlers.sigterm);
    process.on("uncaughtException", handlers.uncaughtException);
    process.on("unhandledRejection", handlers.unhandledRejection);

    const teardown = () => {
      try { process.off("exit", handlers.exit); } catch {}
      try { process.off("SIGINT", handlers.sigint); } catch {}
      try { process.off("SIGTERM", handlers.sigterm); } catch {}
      try { process.off("uncaughtException", handlers.uncaughtException); } catch {}
      try { process.off("unhandledRejection", handlers.unhandledRejection); } catch {}
    };

    return { markActiveMeetingsAborted, markActiveMeetingsAbortedAsync, teardown };
  }

  return { markActiveMeetingsAborted, markActiveMeetingsAbortedAsync, setupProcessHandlers };
}

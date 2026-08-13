import { getConfig } from "../config.js";
import { Logger, extractErrorInfo } from "../logger.js";

const WATCHDOG_TICK_MS = 30000;

/**
 * Monitors meeting activity and triggers stall timeout when no activity occurs.
 * Extracted from MeetingOrchestrator for single responsibility.
 */
export class StallWatchdog {
  /** @type {import("../logger.js").Logger} */
  #logger;
  /** @type {NodeJS.Timeout|null} */
  #timer = null;
  /** @type {number} */
  #lastActivityAt = 0;
  /** @type {boolean} */
  #stallCancelled = false;
  /** @type {Function} */
  #onStall;

  /**
   * @param {object} params
   * @param {Function} params.onStall - Called when stall is detected
   * @param {import("../logger.js").Logger} [params.logger]
   */
  constructor({ onStall, logger }) {
    this.#onStall = onStall;
    this.#logger = logger ?? new Logger();
  }

  get stallCancelled() {
    return this.#stallCancelled;
  }

  touch() {
    this.#lastActivityAt = Date.now();
  }

  start(getStatus, cancelled) {
    const stallTimeoutMs = getConfig().stallTimeoutMs ?? 300000;
    this.#lastActivityAt = Date.now();
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      try {
        if (cancelled()) return;
        const status = getStatus();
        if (status !== "weaving" && status !== "initializing") {
          this.stop();
          return;
        }
        if (Date.now() - this.#lastActivityAt <= stallTimeoutMs) return;
        this.#logger.warn("stall_detected", `No activity for ${Math.round(stallTimeoutMs / 1000)}s — stopping meeting`, { idleMs: Date.now() - this.#lastActivityAt });
        this.#stallCancelled = true;
        this.#onStall();
      } catch (err) {
        const info = extractErrorInfo(err);
        this.#logger.error("watchdog_failed", "Stall watchdog check failed", info);
      }
    }, WATCHDOG_TICK_MS);
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  reset() {
    this.#stallCancelled = false;
    this.#lastActivityAt = Date.now();
  }
}

import { getConfig } from "../config.js";
import { Logger, extractErrorInfo } from "../logger.js";
import { TUNING } from "../config/defaults.js";

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
    if (this.#timer) {
      this.touch();
      return;
    }
    this.#lastActivityAt = Date.now();
    const tickMs = getConfig()?.tuning?.WATCHDOG_TICK_MS ?? TUNING.WATCHDOG_TICK_MS;
    this.#timer = setInterval(() => {
      try {
        if (cancelled()) {
          // Don't keep ticking forever if meeting cancelled — stop timer but keep unref
          return;
        }
        const status = getStatus();
        if (status !== "weaving" && status !== "initializing") {
          this.stop();
          return;
        }
        const stallTimeoutMs = getConfig().stallTimeoutMs ?? 300000;
        if (Date.now() - this.#lastActivityAt <= stallTimeoutMs) return;
        this.#logger.warn("stall_detected", `No activity for ${Math.round(stallTimeoutMs / 1000)}s — stopping meeting`, { idleMs: Date.now() - this.#lastActivityAt });
        this.#stallCancelled = true;
        this.#onStall();
      } catch (err) {
        const info = extractErrorInfo(err);
        this.#logger.error("watchdog_failed", "Stall watchdog check failed", info);
      }
    }, tickMs);
    this.#timer.unref?.();
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
    // Touch ensures lastActivityAt updated even if timer already running; start() is now idempotent so caller can just touch
  }

  restart(getStatus, cancelled) {
    this.stop();
    this.#stallCancelled = false;
    this.start(getStatus, cancelled);
  }
}

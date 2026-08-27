/**
 * TimeBudget — centralizes meeting deadline logic (audit Phase 3).
 *
 * Duplicated deadline math previously lived in orchestrator/weaving.js
 * (_remainingMs / _checkTimeout) and orchestrator/round.js (grace-window
 * check + deadline propagation). Single source prevents drift between the
 * weaving loop and per-round guard.
 */

export class TimeBudget {
  /**
   * @param {number} startTime - epoch ms when meeting (or extension) started
   * @param {number} meetingTimeoutMs - total budget in ms
   */
  constructor(startTime, meetingTimeoutMs) {
    this.startTime = startTime;
    this.meetingTimeoutMs = meetingTimeoutMs;
  }

  /**
   * Update budget after meeting extension or re-init.
   * @param {number} [startTime]
   * @param {number} [meetingTimeoutMs]
   */
  reset(startTime, meetingTimeoutMs) {
    if (startTime !== undefined) this.startTime = startTime;
    if (meetingTimeoutMs !== undefined) this.meetingTimeoutMs = meetingTimeoutMs;
  }

  /** @deprecated — TimeBudget is now authoritative after init/extend reset. Kept for compat. */
  syncFrom(orchestrator) {
    if (orchestrator._startTime !== undefined) this.startTime = orchestrator._startTime;
    if (orchestrator._meetingTimeoutMs !== undefined) this.meetingTimeoutMs = orchestrator._meetingTimeoutMs;
  }

  /** ms remaining until deadline (Infinity if disabled, negative if expired). */
  remainingMs() {
    if (!this.meetingTimeoutMs || this.meetingTimeoutMs <= 0) return Infinity;
    return this.startTime + this.meetingTimeoutMs - Date.now();
  }

  /**
   * True if remaining time is at or below grace threshold.
   * Default grace 5000ms matches round.js pre-round guard.
   * @param {number} [graceMs=5000]
   */
  isExpired(graceMs = 5000) {
    if (!this.meetingTimeoutMs || this.meetingTimeoutMs <= 0) return false;
    return this.remainingMs() <= graceMs;
  }

  /** Absolute deadline as epoch ms (Infinity if disabled). */
  deadline() {
    if (!this.meetingTimeoutMs || this.meetingTimeoutMs <= 0) return Infinity;
    return this.startTime + this.meetingTimeoutMs;
  }

  /**
   * Strict timeout check (remaining <= 0) — matches weaving loop / _checkTimeout.
   * Side-effect-free; caller decides whether to transition/log.
   */
  checkTimeout() {
    if (!this.meetingTimeoutMs || this.meetingTimeoutMs <= 0) return false;
    return this.remainingMs() <= 0;
  }

  /** Human-readable remaining time for logs/progress. */
  formatRemaining() {
    if (!this.meetingTimeoutMs || this.meetingTimeoutMs <= 0) return "no limit";
    const ms = this.remainingMs();
    if (ms <= 0) return "expired";
    const totalSec = Math.floor(ms / 1000);
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    if (mins > 0) return `${mins}m ${secs}s remaining`;
    return `${secs}s remaining`;
  }
}

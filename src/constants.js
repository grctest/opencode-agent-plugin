export const SUMMARY_TRUNCATE_LEN = 200;
export const MAX_ORCHESTRATOR_MESSAGES = 200;
export const TERMINAL_STATUSES = new Set(["converged", "cancelled", "timeout", "max_rounds_reached", "aborted"]);

/**
 * The statuses a meeting can be RESUMED from.
 *
 * "weaving"/"initializing" are the crash-recovery case (the server died
 * mid-run). "cancelled" and "timeout" are the STOPPED case: the user pressed
 * "Cancel run", or the stall watchdog fired. Both are explicit stops that
 * leave the round open, so the resume continues the interrupted round from
 * where it left off.
 *
 * A meeting that reached a natural end (converged / max_rounds_reached /
 * aborted) is NOT resumable — it is extended, not resumed.
 */
export const RESUMABLE_STATUSES = new Set(["weaving", "initializing", "cancelled", "timeout"]);

/** True when a meeting in this status can be continued by the Resume button. */
export function canResumeStatus(status) {
  return RESUMABLE_STATUSES.has(String(status ?? ""));
}
export { TUNING } from "./config/defaults.js";

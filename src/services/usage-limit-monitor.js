/**
 * Account-wide hard usage-limit registry.
 *
 * When opencode's free/Go gateway rejects with FreeUsageLimitError or
 * GoUsageLimitError, the server does NOT return that 429 on the open
 * session.prompt HTTP request — it emits session.status with a retry
 * action (the same signal the opencode web UI uses) and holds the prompt
 * open until client-side timeout. Loom used to treat those timeouts as
 * retryable and hang in multi-minute loops.
 *
 * This module is the shared detection point: fed by the plugin event hook
 * (session.status) and by any prompt error that already carries a hard
 * rate-limit classification. SessionContract races in-flight prompts
 * against it; orchestrators halt sticky when it flips.
 */
import { Logger } from "../logger.js";

const logger = new Logger();

/** Reasons that must stop every deliberation immediately. */
export const HARD_USAGE_LIMIT_REASONS = new Set([
  "free_tier_limit",
  "account_rate_limit",
]);

/** @type {null | {
 *   type: "free_tier_limit"|"account_rate_limit",
 *   message: string,
 *   retryAfterMs: number|null,
 *   retryAt: number|null,
 *   action: object|null,
 *   provider: string|null,
 *   sourceSessionId: string|null,
 *   detectedVia: "session.status"|"prompt_error",
 *   at: number,
 * }} */
let state = null;

/** Listeners fired on any state change (set or cleared). */
const changeListeners = new Set();
/** Waiters fired only when a hard limit is reported (reject with the error). */
const hitWaiters = new Set();

function nextUtcMidnightMs(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function buildActionFromStatusAction(action) {
  if (!action || typeof action !== "object") return null;
  return {
    reason: typeof action.reason === "string" ? action.reason : null,
    provider: typeof action.provider === "string" ? action.provider : null,
    title: typeof action.title === "string" ? action.title : null,
    message: typeof action.message === "string" ? action.message : null,
    label: typeof action.label === "string" ? action.label : null,
    link: typeof action.link === "string" ? action.link : null,
  };
}

function notifyChange() {
  for (const fn of changeListeners) {
    try { fn(state); } catch { /* listeners must never break detection */ }
  }
}

function notifyHit(err) {
  const waiters = [...hitWaiters];
  hitWaiters.clear();
  for (const w of waiters) {
    try { w.reject(err); } catch { /* waiter rejection is fire-and-forget */ }
  }
}

function setState(next) {
  const prev = state;
  state = next;
  if (next && (!prev || prev.type !== next.type || prev.at !== next.at)) {
    logger.warn(
      "usage_limit_detected",
      `Hard usage limit detected (${next.type}) via ${next.detectedVia}${next.sourceSessionId ? ` on session ${next.sourceSessionId}` : ""}: ${next.message}`,
      {
        type: next.type,
        provider: next.provider,
        retryAt: next.retryAt ? new Date(next.retryAt).toISOString() : null,
        detectedVia: next.detectedVia,
        sourceSessionId: next.sourceSessionId,
      },
    );
    notifyHit(buildAbortError(next));
  }
  notifyChange();
}

/**
 * Build the synthetic error surfaced by SessionContract / ladder breaks.
 * Shaped like a hard rate-limit error so isHardRateLimitError() matches.
 */
export function buildAbortError(s = state) {
  if (!s) return null;
  const err = new Error(s.message || "Usage limit reached");
  err.name = "UsageLimitError";
  err.status = 429;
  err.statusCode = 429;
  err.rateLimitClassification = {
    type: s.type,
    message: s.message,
    retryAfterMs: s.retryAfterMs,
    action: s.action,
  };
  return err;
}

/** Lazily expire free/Go limits whose estimated reset has passed. */
function getStateLive() {
  if (state?.retryAt != null && Date.now() >= state.retryAt) {
    logger.info(
      "usage_limit_expired",
      `Hard usage limit (${state.type}) reached its estimated reset time — clearing`,
      { type: state.type, retryAt: new Date(state.retryAt).toISOString() },
    );
    state = null;
    notifyChange();
  }
  return state;
}

/**
 * Report a session.status retry event (the web-UI signal).
 * Only free_tier_limit / account_rate_limit actions arm the monitor.
 * @returns {boolean} true when this call changed state
 */
export function reportFromSessionStatus(sessionID, status) {
  if (!status || status.type !== "retry") return false;
  const reason = status?.action?.reason;
  if (!HARD_USAGE_LIMIT_REASONS.has(reason)) return false;

  const now = Date.now();
  const action = buildActionFromStatusAction(status.action);
  let retryAfterMs = null;
  let retryAt = null;
  if (reason === "free_tier_limit") {
    // Daily free quota: estimated reset is next UTC midnight. Resume stays
    // available before then (user may subscribe and retry immediately).
    retryAt = nextUtcMidnightMs(now);
    retryAfterMs = retryAt - now;
  } else {
    // Go account limit: server retry time is the best available reset hint.
    if (Number.isFinite(status.next) && status.next > now) {
      retryAt = status.next;
      retryAfterMs = retryAt - now;
    }
  }

  const message = action?.message
    || (typeof status.message === "string" && status.message)
    || (reason === "free_tier_limit"
      ? "Free usage exceeded, subscribe to Go"
      : "Usage limit reached.");

  const next = {
    type: reason,
    message,
    retryAfterMs,
    retryAt,
    action: action ?? {
      reason,
      provider: null,
      title: reason === "free_tier_limit" ? "Free limit reached" : "Go limit reached",
      message,
      label: reason === "free_tier_limit" ? "subscribe" : "open settings",
      link: reason === "free_tier_limit" ? "https://opencode.ai/go" : "https://opencode.ai/go",
    },
    provider: action?.provider ?? null,
    sourceSessionId: sessionID ?? null,
    detectedVia: "session.status",
    at: now,
  };

  if (state && state.type === next.type && state.at === next.at) return false;
  setState(next);
  return true;
}

/**
 * Report a prompt error that already carries a hard rate-limit classification
 * (the path when the server eventually returns the 429 body).
 * @returns {boolean} true when this call changed state
 */
export function reportFromError(err, sessionID = null) {
  if (!err) return false;
  const classification = err.rateLimitClassification
    ?? (typeof err === "object" ? err.rateLimitClassification : null);
  if (!classification || !HARD_USAGE_LIMIT_REASONS.has(classification.type)) return false;

  const now = Date.now();
  const next = {
    type: classification.type,
    message: classification.message || err.message || "Usage limit reached",
    retryAfterMs: Number.isFinite(classification.retryAfterMs) ? classification.retryAfterMs : null,
    retryAt: classification.retryAfterMs != null && classification.retryAfterMs > 0
      ? now + classification.retryAfterMs
      : (classification.type === "free_tier_limit" ? nextUtcMidnightMs(now) : null),
    action: classification.action ?? null,
    provider: err.providerError ?? null,
    sourceSessionId: sessionID,
    detectedVia: "prompt_error",
    at: now,
  };
  setState(next);
  return true;
}

/** Current live state, or null. */
export function getState() {
  return getStateLive();
}

/** True while a hard usage limit is in effect. */
export function isBlocked() {
  return getStateLive() !== null;
}

/** Synthetic hard-limit error while blocked; null when clear. */
export function getAbortReason() {
  return isBlocked() ? buildAbortError(state) : null;
}

/**
 * Promise that rejects with the hard-limit error the next time one is
 * reported (or immediately if already blocked). Dispose to detach.
 * @returns {{ promise: Promise<never>, dispose: () => void }}
 */
export function waitForHit() {
  if (isBlocked()) {
    const err = buildAbortError(state);
    return { promise: Promise.reject(err), dispose: () => {} };
  }
  let rejectFn;
  const promise = new Promise((_, reject) => { rejectFn = reject; });
  const waiter = { reject: rejectFn };
  hitWaiters.add(waiter);
  return { promise, dispose: () => { hitWaiters.delete(waiter); } };
}

/**
 * Clear the hard limit (user resume after subscribing, manual recovery).
 * @returns {boolean} true when a limit was cleared
 */
export function clear(reason = "manual") {
  if (!state) return false;
  const prevType = state.type;
  state = null;
  logger.info("usage_limit_cleared", `Hard usage limit (${prevType}) cleared (${reason})`, { reason, type: prevType });
  notifyChange();
  return true;
}

/** Subscribe to state changes. Returns an unsubscribe fn. */
export function onChange(listener) {
  if (typeof listener !== "function") return () => {};
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

/** Test-only: wipe all module state. */
export function _resetForTests() {
  state = null;
  changeListeners.clear();
  const waiters = [...hitWaiters];
  hitWaiters.clear();
  for (const w of waiters) {
    try { w.reject(new Error("monitor reset")); } catch {}
  }
}

import { TUNING } from "./config/defaults.js";
import { getConfig } from "./config.js";

const LogLevel = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4 };

const LEVEL_LABELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

// Ring buffer of recent log lines — O(1) circular, bounded memory so the dashboard can tail recent activity without file I/O.
function getRingSize() { try { return getConfig()?.tuning?.RING_BUFFER_SIZE ?? TUNING.RING_BUFFER_SIZE; } catch { return TUNING.RING_BUFFER_SIZE; } }
let ringBuffer = new Array(TUNING.RING_BUFFER_SIZE);
let ringHead = 0;
let ringCount = 0;
let ringSeq = 0;
const globalThrottleMap = new Map();

function orderedRing() {
  const cap = getRingSize();
  if (ringCount < cap && ringBuffer.length <= cap) {
    // Not yet wrapped and cap hasn't shrunk
    return ringBuffer.slice(0, ringCount).filter(Boolean);
  }
  // Wrapped or cap changed — reconstruct in chronological order
  const out = [];
  const effectiveCap = Math.min(cap, ringCount);
  const start = ringCount >= cap ? ringHead : 0;
  for (let i = 0; i < effectiveCap; i++) {
    const idx = (start + i) % cap;
    const e = ringBuffer[idx];
    if (e) out.push(e);
  }
  return out;
}

export function getRecentLogs(limit = 100, minLevel = null, meetingId = null) {
  const minIdx = minLevel ? LEVEL_LABELS.indexOf(String(minLevel).toUpperCase()) : -1;
  let rows = orderedRing().filter((e) => (minIdx < 0 || LEVEL_LABELS.indexOf(e.level) >= minIdx));
  if (meetingId) {
    const short = meetingId.slice(0, 8);
    rows = rows.filter((e) => e.fullMeetingId === meetingId || e.meetingId === short);
  }
  const cap = getRingSize();
  const n = Math.max(1, Math.min(limit, cap));
  if (rows.length <= n) return rows;
  return rows.slice(rows.length - n);
}

function resolveMinLevel() {
  const envLevel = process.env.LOOM_LOG_LEVEL;
  if (!envLevel) return LogLevel.INFO;
  const upper = envLevel.toUpperCase();
  const idx = LEVEL_LABELS.indexOf(upper);
  return idx >= 0 ? idx : LogLevel.INFO;
}

export class LoomError extends Error {
  constructor(message, { phase = 'unknown', participantId = null, recoverable = false, cause = null } = {}) {
    super(message);
    this.name = 'LoomError';
    this.phase = phase;
    this.participantId = participantId;
    this.recoverable = recoverable;
    this.cause = cause;
    this.timestamp = new Date().toISOString();
  }
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
}

export class Logger {
  #meetingId = null;
  #correlationId = null;
  #minLevel = resolveMinLevel();

  constructor(meetingId = null) {
    this.#meetingId = meetingId;
    this.#correlationId = uuid();
  }

  forMeeting(meetingId) {
    const child = new Logger(meetingId);
    child.#correlationId = this.#correlationId;
    return child;
  }

  /**
   * Logs at WARN level but emits at most one message per key within throttleMs.
   * Prevents legitimate transient failures (e.g. session delete, DB lock) from
   * spamming logs while still surfacing the problem once.
   * @param {string} key - Dedup key (e.g. "${session-id}:delete").
   * @param {string} context
   * @param {string} message
   * @param {Object|null} details
   * @param {number} [throttleMs=30000]
   */
  warnThrottled(key, context, message, details = null, throttleMs = 30000) {
    const now = Date.now();
    const last = globalThrottleMap.get(key) ?? 0;
    if (now - last < throttleMs) return;
    globalThrottleMap.set(key, now);
    if (globalThrottleMap.size > 200) {
      const oldest = globalThrottleMap.keys().next().value;
      globalThrottleMap.delete(oldest);
    }
    this.warn(context, message, details);
  }

  debug(context, message, details = null) {
    this.#log(LogLevel.DEBUG, context, message, details);
  }

  info(context, message, details = null) {
    this.#log(LogLevel.INFO, context, message, details);
  }

  warn(context, message, details = null) {
    this.#log(LogLevel.WARN, context, message, details);
  }

  error(context, message, details = null) {
    this.#log(LogLevel.ERROR, context, message, details);
  }

  fatal(context, message, details = null) {
    this.#log(LogLevel.FATAL, context, message, details);
  }

  #redact(details) {
    if (details == null) return details;
    if (typeof details === "string") {
      return details.replace(/(authorization|api[_-]?key|bearer|token|password|secret|client[_-]?secret|private[_-]?key|credentials)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}\]]+)/gi, (m, k, sep, val) => {
        const isQuoted = val.startsWith('"') || val.startsWith("'");
        return `${k}${sep}${isQuoted ? '"[REDACTED]"' : '[REDACTED]'}`;
      }).replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]").replace(/Basic\s+[A-Za-z0-9+/]+=*/gi, "Basic [REDACTED]");
    }
    if (typeof details !== "object") return details;
    const SECRET_KEY_RE = /authorization|api[_-]?key|bearer|token|password|secret|client[_-]?secret|private[_-]?key|credentials/i;
    const seen = new WeakSet();
    const walk = (val) => {
      if (val == null) return val;
      if (typeof val === "string") {
        if (/^(Bearer|Basic)\s+/i.test(val)) return "[REDACTED]";
        return val;
      }
      if (typeof val !== "object") return val;
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
      if (Array.isArray(val)) return val.map((v) => walk(v));
      const out = {};
      for (const [k, v] of Object.entries(val)) {
        if (SECRET_KEY_RE.test(k)) {
          out[k] = "[REDACTED]";
        } else if (typeof v === "string" && /^(Bearer|Basic)\s+/i.test(v) && /auth/i.test(k)) {
          out[k] = "[REDACTED]";
        } else {
          out[k] = walk(v);
        }
      }
      return out;
    };
    try {
      return walk(details);
    } catch {
      return { redacted: true };
    }
  }

  #log(level, context, message, details) {
    if (level < this.#minLevel) return;
    const safeDetails = this.#redact(details);
    const entry = {
      seq: ++ringSeq,
      level: LEVEL_LABELS[level],
      correlationId: this.#correlationId,
      meetingId: this.#meetingId ? this.#meetingId.slice(0, 8) : null,
      fullMeetingId: this.#meetingId,
      context,
      message,
      ...(safeDetails !== null ? { details: safeDetails } : {}),
      timestamp: new Date().toISOString(),
    };
    // Ring buffer push: O(1) circular, bounded at getRingSize() (tunable).
    const cap = getRingSize();
    // Resize buffer if cap changed
    if (ringBuffer.length !== cap) {
      const ordered = orderedRing();
      ringBuffer = new Array(cap);
      ringHead = 0;
      ringCount = 0;
      for (const e of ordered.slice(-cap)) {
        ringBuffer[ringHead] = e;
        ringHead = (ringHead + 1) % cap;
        ringCount++;
      }
      if (ringCount >= cap) ringHead = ringCount % cap;
    }
    ringBuffer[ringHead] = entry;
    ringHead = (ringHead + 1) % cap;
    if (ringCount < cap) ringCount++;
    let full;
    try {
      full = JSON.stringify(entry);
    } catch {
      full = JSON.stringify({ level: entry.level, context: entry.context, message: entry.message, timestamp: entry.timestamp });
    }
    if (level >= LogLevel.ERROR) {
      console.error(full);
    } else if (level === LogLevel.WARN) {
      console.warn(full);
    } else {
      console.log(full);
    }
  }
}

export function extractErrorInfo(err) {
  if (err instanceof Error) {
    const info = { message: err.message, stack: err.stack, name: err.name };
    // Cause chain (Node 16+ Error.cause): surface nested causes so root
    // failures aren't lost behind a generic wrapper.
    if (err.cause) {
      try {
        info.cause = err.cause instanceof Error
          ? extractErrorInfo(err.cause)
          : { message: String(err.cause), name: 'Cause' };
      } catch {}
      // Preserve top-level cause message for log searchability
      if (!info.causeMessage) {
        info.causeMessage = err.cause instanceof Error ? err.cause.message : String(err.cause);
      }
    }
    return info;
  }
  return { message: String(err), stack: null, name: 'Unknown' };
}

export { LogLevel };
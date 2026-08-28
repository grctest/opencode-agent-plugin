const LogLevel = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4 };

const LEVEL_LABELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

// Ring buffer of recent log lines — bounded memory so the dashboard can tail recent activity without file I/O.
const RING_BUFFER_SIZE = 500;
const logRing = [];
let ringSeq = 0;
const globalThrottleMap = new Map();

export function getRecentLogs(limit = 100, minLevel = null, meetingId = null) {
  const minIdx = minLevel ? LEVEL_LABELS.indexOf(String(minLevel).toUpperCase()) : -1;
  let rows = logRing.filter((e) => (minIdx < 0 || LEVEL_LABELS.indexOf(e.level) >= minIdx));
  if (meetingId) {
    const short = meetingId.slice(0, 8);
    rows = rows.filter((e) => e.fullMeetingId === meetingId || e.meetingId === short);
  }
  const n = Math.max(1, Math.min(limit, RING_BUFFER_SIZE));
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

  #log(level, context, message, details) {
    if (level < this.#minLevel) return;
    const entry = {
      seq: ++ringSeq,
      level: LEVEL_LABELS[level],
      correlationId: this.#correlationId,
      meetingId: this.#meetingId ? this.#meetingId.slice(0, 8) : null,
      fullMeetingId: this.#meetingId,
      context,
      message,
      ...(details !== null ? { details } : {}),
      timestamp: new Date().toISOString(),
    };
    // Ring buffer push (audit 07 EH6): O(1), bounded at RING_BUFFER_SIZE.
    logRing.push(entry);
    if (logRing.length > RING_BUFFER_SIZE) logRing.shift();
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
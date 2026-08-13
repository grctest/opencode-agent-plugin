const LogLevel = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4 };

const LEVEL_LABELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

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

export class Logger {
  #meetingId = null;
  #correlationId = null;
  #minLevel = resolveMinLevel();

  constructor(meetingId = null) {
    this.#meetingId = meetingId;
    this.#correlationId = crypto.randomUUID();
  }

  forMeeting(meetingId) {
    return new Logger(meetingId);
  }

  withCorrelationId(correlationId) {
    const logger = new Logger(this.#meetingId);
    logger.#correlationId = correlationId;
    return logger;
  }

  setMinLevel(level) {
    this.#minLevel = level;
    return this;
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
      level: LEVEL_LABELS[level],
      correlationId: this.#correlationId,
      meetingId: this.#meetingId ? this.#meetingId.slice(0, 8) : null,
      fullMeetingId: this.#meetingId,
      context,
      message,
      ...(details !== null ? { details } : {}),
      timestamp: new Date().toISOString(),
    };
    const full = JSON.stringify(entry);
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
    return { message: err.message, stack: err.stack, name: err.name };
  }
  return { message: String(err), stack: null, name: 'Unknown' };
}

export { LogLevel };
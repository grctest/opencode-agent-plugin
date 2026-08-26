import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync, unlinkSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { Logger } from "../logger.js";
import { resolveLoomBaseDir } from "../paths.js";

const indexLogger = new Logger();
const sessionIndex = new Map();
let indexDir = null;

function getIndexFilePath() {
  if (!indexDir) return null;
  return join(resolveLoomBaseDir(indexDir), "session-index.json");
}

// ─── Inter-process lock (audit 04 PD4) ────────────────────────────────────────
// The index is a read-modify-write JSON file shared by every opencode process.
// Without a lock, two processes clobber each other (last writer wins).

const LOCK_TIMEOUT_MS = 5000;
const LOCK_STEAL_MS = 30000;

/**
 * Acquire an exclusive lock file ('wx' fails when it already exists).
 * Stale locks (crashed process) are stolen after LOCK_STEAL_MS.
 * Returns true on success.
 */
function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      // Write our PID so other processes can detect a dead holder
      const fd = openSync(lockPath, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") return false;
      // Check for staleness — a lock older than LOCK_STEAL_MS belongs to a dead process
      try {
        const content = readFileSync(lockPath, "utf-8");
        const pid = parseInt(content, 10);
        let mtimeMs = null;
        try { mtimeMs = statSync(lockPath).mtimeMs; } catch { /* vanished */ }
        const staleByAge = mtimeMs != null && Date.now() - mtimeMs > LOCK_STEAL_MS;
        const staleByPid = Number.isInteger(pid) && pid !== process.pid && !processExists(pid);
        if (staleByAge || staleByPid) {
          unlinkSync(lockPath);
          continue; // retry acquisition immediately
        }
      } catch {
        // Lock vanished between checks — retry below
      }
      if (Date.now() >= deadline) return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // EPERM means the process exists but is not ours
  }
}

function releaseLock(lockPath) {
  try {
    unlinkSync(lockPath);
  } catch { /* already gone */ }
}

export function loadSessionIndex(directory) {
  indexDir = directory;
  const filePath = getIndexFilePath();
  if (!filePath) return;
  try {
    const data = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(data);
    for (const [sessionId, entries] of Object.entries(parsed)) {
      const validEntries = entries.filter((e) => existsSync(e.dbPath));
      if (validEntries.length > 0) {
        sessionIndex.set(sessionId, validEntries);
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      indexLogger.warn("session_index_load_failed", "Failed to load session index", { filePath, error: err.message });
    }
  }
}

function persistSessionIndex({ compact = false } = {}) {
  const filePath = getIndexFilePath();
  if (!filePath) {
    indexLogger.warn("session_index_not_loaded", "Skipping session index persistence — loadSessionIndex() was never called");
    return;
  }
  const lockPath = `${filePath}.lock`;
  let locked = false;
  try {
    locked = acquireLock(lockPath);
    if (!locked) {
      indexLogger.warn("session_index_lock_timeout", "Could not acquire session-index lock — skipping this persist (will retry on next change)");
      return;
    }
    // Re-read inside lock and merge so we don't clobber another process's writes (last-writer-wins fix)
    try {
      const onDisk = JSON.parse(readFileSync(filePath, "utf-8"));
      for (const [sid, entries] of Object.entries(onDisk)) {
        const mine = sessionIndex.get(sid);
        if (!mine) { sessionIndex.set(sid, entries.filter((e) => existsSync(e.dbPath))); continue; }
        const merged = new Map();
        for (const e of [...entries, ...mine]) merged.set(e.dbPath, e);
        const valid = [...merged.values()].filter((e) => existsSync(e.dbPath));
        if (valid.length > 0) sessionIndex.set(sid, valid); else sessionIndex.delete(sid);
      }
    } catch (err) { if (err.code !== "ENOENT") indexLogger.debug("session_index_merge_failed", "Could not re-read index for merge", { error: err.message }); }
    if (compact) {
      // Drop entries whose DB files no longer exist before persisting the compacted result
      for (const [sessionId, entries] of sessionIndex) {
        const valid = entries.filter((e) => existsSync(e.dbPath));
        if (valid.length > 0) sessionIndex.set(sessionId, valid);
        else sessionIndex.delete(sessionId);
      }
    }
    const obj = Object.fromEntries(sessionIndex);
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
    renameSync(tmpPath, filePath);
  } catch (err) {
    indexLogger.warn("session_index_persist_failed", "Failed to persist session index", { filePath, error: err.message });
  } finally {
    if (locked) releaseLock(lockPath);
  }
}

export function indexMeeting(dbPath, meetingId, sessionId) {
  if (!sessionId) return;
  const existing = sessionIndex.get(sessionId);
  if (!existing) {
    sessionIndex.set(sessionId, []);
  }
  const entries = sessionIndex.get(sessionId);
  if (!entries.some((e) => e.dbPath === dbPath)) {
    entries.push({ meetingId, dbPath });
    persistSessionIndex();
  }
}

export function unindexMeeting(dbPath) {
  for (const [sessionId, entries] of sessionIndex) {
    const filtered = entries.filter((e) => e.dbPath !== dbPath);
    if (filtered.length === 0) {
      sessionIndex.delete(sessionId);
    } else {
      sessionIndex.set(sessionId, filtered);
    }
  }
  persistSessionIndex();
}

export function getDatabasesBySessionId(sessionId) {
  const entries = sessionIndex.get(sessionId);
  return entries ? [...entries] : [];
}

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Logger, extractErrorInfo } from "../logger.js";
import { resolveLoomBaseDir, getMeetingDbPath } from "../paths.js";
import { ensureDb, getDatabaseClass } from "./connection.js";
import { loadSessionIndex, indexMeeting as _indexMeeting, unindexMeeting as _unindexMeeting, getDatabasesBySessionId as _getDatabasesBySessionId } from "./session-index.js";

export { loadSessionIndex, _indexMeeting as indexMeeting, _unindexMeeting as unindexMeeting, _getDatabasesBySessionId as getDatabasesBySessionId };

const dbLogger = new Logger();

export async function findMeetingBySessionId(directory, sessionId) {
  await ensureDb();
  const DatabaseClass = getDatabaseClass();
  const indexed = _getDatabasesBySessionId(sessionId);
  const candidates = [];
  for (const { dbPath } of indexed) {
    if (!existsSync(dbPath)) continue;
    let conn = null;
    try {
      conn = new DatabaseClass(dbPath, { readonly: true });
      const row = conn
        .prepare(
          `SELECT id, question, status, round, max_rounds, created_at FROM meetings
           WHERE opencode_session_id = ?
           ORDER BY created_at DESC
           LIMIT 1`,
        )
        .get(sessionId);
      if (row) candidates.push({ row, dbPath });
    } catch (err) {
      const info = extractErrorInfo(err);
      dbLogger.warn("indexed_db_lookup_failed", `Indexed DB lookup failed for ${dbPath}`, info);
    } finally {
      if (conn) conn.close();
    }
  }
  if (candidates.length > 0) {
    candidates.sort((a, b) => String(b.row.created_at ?? "").localeCompare(String(a.row.created_at ?? "")));
    const { row, dbPath } = candidates[0];
    return { meetingId: row.id, question: row.question, status: row.status, round: row.round, max_rounds: row.max_rounds, dbPath };
  }

  const meetingsDir = join(resolveLoomBaseDir(directory), "meetings");
  if (!existsSync(meetingsDir)) return null;
  await ensureDb();
  const files = readdirSync(meetingsDir)
    .filter((f) => f.endsWith(".db"))
    .map((f) => join(meetingsDir, f))
    .sort((a, b) => {
      let am = 0, bm = 0;
      try { am = statSync(a).mtimeMs; } catch {}
      try { bm = statSync(b).mtimeMs; } catch {}
      return bm - am;
    });
  for (const filePath of files) {
    let conn = null;
    try {
      conn = new DatabaseClass(filePath, { readonly: true });
      const row = conn
        .prepare(
          `SELECT id, question, status, round, max_rounds FROM meetings
           WHERE opencode_session_id = ?
           LIMIT 1`,
        )
        .get(sessionId);
      if (row) {
        _indexMeeting(filePath, row.id, sessionId);
        return { meetingId: row.id, question: row.question, status: row.status, round: row.round, max_rounds: row.max_rounds, dbPath: filePath };
      }
    } catch (err) {
      const info = extractErrorInfo(err);
      dbLogger.warn("db_scan_failed", `DB scan failed for ${filePath}`, info);
    } finally {
      if (conn) conn.close();
    }
  }
  return null;
}

export function getDbPathForMeeting(directory, meetingId) {
  const path = getMeetingDbPath(directory, meetingId);
  return existsSync(path) ? path : null;
}

export function deleteMeetingFiles(dbPath) {
  _unindexMeeting(dbPath);
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
  }
}

export function listMeetingFiles(directory) {
  const dir = join(resolveLoomBaseDir(directory), "meetings");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".db"));
}

export async function readSessionIdFromDbAsync(dbPath) {
  try {
    await ensureDb();
    const DatabaseClass = getDatabaseClass();
    const db = new DatabaseClass(dbPath, { readonly: true });
    try {
      const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meetings'").get();
      if (!tableCheck) return null;

      const row = db.prepare("SELECT opencode_session_id FROM meetings LIMIT 1").get();
      return row?.opencode_session_id ?? null;
    } finally {
      db.close();
    }
  } catch (err) {
    const info = extractErrorInfo(err);
    dbLogger.warn("read_session_id_failed", `Failed to read session ID from ${dbPath}`, info);
    return null;
  }
}

export async function deleteMeetingsBySessionId(directory, sessionId) {
  const meetingsDir = join(resolveLoomBaseDir(directory), "meetings");
  if (!existsSync(meetingsDir)) return 0;

  let deleted = 0;
  for (const file of readdirSync(meetingsDir)) {
    if (!file.endsWith(".db")) continue;
    const dbPath = join(meetingsDir, file);
    const dbSessionId = await readSessionIdFromDbAsync(dbPath);
    if (dbSessionId === sessionId) {
      deleteMeetingFiles(dbPath);
      deleted++;
    }
  }
  return deleted;
}

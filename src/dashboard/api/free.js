import { join } from "node:path";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { resolveLoomBaseDir } from "../../paths.js";
import { Database } from "bun:sqlite";
import { getModelBaseDir } from "../../services/model-manager.js";
import { withReadonlyDb } from "../../database/connection.js";

const listMeetingsCache = new Map(); // directory -> { at, data }
const LIST_MEETINGS_TTL_MS = 2000;

/**
 * Drop the cached meetings list for a directory (or all directories when
 * omitted) so a newly created meeting is visible on the next poll instead of
 * after the TTL. Called by the control plane after start/extend.
 */
export function invalidateMeetingsCache(directory = null) {
  if (directory == null) {
    listMeetingsCache.clear();
    return;
  }
  listMeetingsCache.delete(directory || "__global__");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function listDownloadedModels() {
  const modelDir = getModelBaseDir();

  if (!existsSync(modelDir)) return [];

  const models = [];
  try {
    const entries = readdirSync(modelDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const modelJsonPath = join(modelDir, entry.name, "model.json");
        if (existsSync(modelJsonPath)) {
          try {
            const stat = statSync(modelJsonPath);
            if (stat.size > 0) {
              const content = readFileSync(modelJsonPath, "utf-8");
              const modelJson = JSON.parse(content);
              models.push(modelJson);
            }
          } catch {
            // Skip invalid model.json
          }
        }
      }
    }
  } catch {
    // Skip on error
  }

  return models;
}

export function listMeetings(directory) {
  const now = Date.now();
  const cacheKey = directory || "__global__";
  const cached = listMeetingsCache.get(cacheKey);
  if (cached && cached.data && (now - cached.at) < LIST_MEETINGS_TTL_MS) {
    return cached.data;
  }
  const meetingsDir = join(resolveLoomBaseDir(directory), "meetings");
  if (!existsSync(meetingsDir)) return [];

  const files = [];
  try {
    const entries = readdirSync(meetingsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".db")) {
        const filePath = join(meetingsDir, entry.name);
        let mtimeMs = 0;
        try { mtimeMs = statSync(filePath).mtimeMs; } catch {}
        files.push({ path: filePath, mtimeMs });
      }
    }
  } catch {
    return [];
  }

  const meetings = [];
  const PAGINATION_LIMIT = 100;
  const filesToScan = files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, PAGINATION_LIMIT).map((file) => file.path);
  for (const file of filesToScan) {
    let state = null;
    let participantCount = 0;
    try {
      const { result } = withReadonlyDb(file, (db) => {
        const s = db
          .prepare(
            `SELECT id as meeting_id, question, status, round, max_rounds, convergence, created_at FROM meetings LIMIT 1`,
          )
          .get();
        const pc = s
          ? (db.prepare(`SELECT COUNT(*) as count FROM participants`).get())?.count ?? 0
          : 0;
        return { state: s ?? null, participantCount: pc };
      });
      state = result.state;
      participantCount = result.participantCount;
    } catch (err) {
      const msg = String(err?.message ?? err);
      const isBusy = /SQLITE_BUSY|busy|locked/i.test(msg);
      // Busy — skip this file this tick; next poll will retry (non-blocking).
      // Readonly-unrecoverable already retried + degraded inside
      // withReadonlyDb; dropping the file here only skips one poll tick.
      void isBusy;
      state = null;
    }
    if (state) {
      meetings.push({
        meeting_id: state.meeting_id,
        question: state.question,
        status: state.status,
        round: state.round,
        max_rounds: state.max_rounds,
        convergence: state.convergence,
        created_at: state.created_at,
        participant_count: participantCount,
      });
    }
  }

  meetings.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  listMeetingsCache.set(cacheKey, { at: now, data: meetings });
  // Evict old entries beyond 50
  if (listMeetingsCache.size > 50) {
    const first = listMeetingsCache.keys().next().value;
    listMeetingsCache.delete(first);
  }
  return meetings;
}

export function isValidMeetingId(id) {
  return UUID_RE.test(id);
}

export function getMeetingDbPath(directory, meetingId) {
  if (!isValidMeetingId(meetingId)) return null;
  const path = join(resolveLoomBaseDir(directory), "meetings", `${meetingId}.db`);
  return existsSync(path) ? path : null;
}


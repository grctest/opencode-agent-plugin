import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { resolveLoomBaseDir } from "../../paths.js";
import { Database } from "bun:sqlite";

const listMeetingsCache = new Map(); // directory -> { at, data }
const LIST_MEETINGS_TTL_MS = 2000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function listDownloadedModels() {
  const modelDir = join(homedir(), ".config", "opencode", "loom", "models");

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
        files.push(join(meetingsDir, entry.name));
      }
    }
  } catch {
    return [];
  }

  const meetings = [];
  for (const file of files) {
    let db = null;
    try {
      db = new Database(file, { readonly: true });
      try { db.exec("PRAGMA busy_timeout = 5000"); } catch {}
      const state = db
        .prepare(
          `SELECT id as meeting_id, question, status, round, max_rounds, convergence, created_at FROM meetings LIMIT 1`,
        )
        .get();
      const participantCount = (
        db.prepare(`SELECT COUNT(*) as count FROM participants`).get()
      )?.count ?? 0;

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
    } catch {
      // Corrupted or locked DB — skip this meeting file
    } finally {
      try { if (db) db.close(); } catch {}
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


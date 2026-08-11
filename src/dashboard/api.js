import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

const DB_CACHE_MAX = 10;

export class DashboardApi {
  /** @type {Database} */
  #db;
  /** @type {string} */
  #dbPath;
  /** @type {number} */
  #lastModified = 0;

  /** @type {Map<string, DashboardApi>} */
  static cache = new Map();

  static get(dbPath) {
    const existing = DashboardApi.cache.get(dbPath);
    if (existing) {
      existing.#touch();
      return existing;
    }
    if (DashboardApi.cache.size >= DB_CACHE_MAX) {
      let oldest = null;
      for (const [path, api] of DashboardApi.cache) {
        if (!oldest || api.#lastModified < oldest.api.#lastModified) {
          oldest = { path, api };
        }
      }
      if (oldest) {
        oldest.api.#db.close();
        DashboardApi.cache.delete(oldest.path);
      }
    }
    const api = new DashboardApi(dbPath);
    DashboardApi.cache.set(dbPath, api);
    return api;
  }

  static closeAll() {
    for (const api of DashboardApi.cache.values()) {
      api.#db.close();
    }
    DashboardApi.cache.clear();
  }

  constructor(dbPath) {
    this.#dbPath = dbPath;
    this.#db = new Database(dbPath, { readonly: true });
    this.#lastModified = Date.now();
  }

  #touch() {
    this.#lastModified = Date.now();
  }

  getState() {
    const row = this.#db
      .prepare(
        `SELECT id as meeting_id, question, context, status, round, max_rounds, convergence, warp
         FROM meetings LIMIT 1`,
      )
      .get();
    return row ?? null;
  }

  getParticipants() {
    return this.#db
      .prepare(
        `SELECT id, name, persona, agenda, tier, provider_id, model_id, session_id, status
         FROM participants ORDER BY tier ASC`,
      )
      .all();
  }

  getAgentErrors() {
    return this.#db
      .prepare(
        `SELECT id, participant_id, round, error_type, error_message, attempts, created_at
         FROM agent_errors ORDER BY id ASC`,
      )
      .all();
  }

  getContributions() {
    return this.#db
      .prepare(
        `SELECT id, participant_id, round, type, content, confidence, created_at
         FROM contributions ORDER BY round ASC, id ASC`,
      )
      .all();
  }

  getContributionsSince(sinceId) {
    return this.#db
      .prepare(
        `SELECT id, participant_id, round, type, content, confidence, created_at
         FROM contributions WHERE id > ? ORDER BY id ASC`,
      )
      .all(sinceId);
  }

  getInterjections() {
    return this.#db
      .prepare(
        `SELECT id, participant_id, target_participant_id, content, priority, granted, pushback, resolved, created_at
         FROM interjections ORDER BY id ASC`,
      )
      .all();
  }

  getMaxContributionId() {
    const row = this.#db
      .prepare(`SELECT MAX(id) as maxId FROM contributions`)
      .get();
    return row.maxId ?? 0;
  }

  getMaxErrorId() {
    const row = this.#db
      .prepare(`SELECT MAX(id) as maxId FROM agent_errors`)
      .get();
    return row.maxId ?? 0;
  }

  getRound(round) {
    const contributions = this.#db
      .prepare(
        `SELECT id, participant_id, round, type, content, confidence, created_at
         FROM contributions WHERE round = ? ORDER BY id ASC`,
      )
      .all(round);
    return { contributions };
  }

  close() {
    this.#db.close();
    DashboardApi.cache.delete(this.#dbPath);
  }
}

export function listMeetings(directory) {
  const meetingsDir = join(directory, ".opencode", "loom", "meetings");
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
    try {
      const db = new Database(file, { readonly: true });
      const state = db
        .prepare(
          `SELECT id as meeting_id, question, status, round, max_rounds, convergence FROM meetings LIMIT 1`,
        )
        .get();
      const participantCount = (
        db.prepare(`SELECT COUNT(*) as count FROM participants`).get()
      )?.count ?? 0;
      db.close();

      if (state) {
        meetings.push({
          meeting_id: state.meeting_id,
          question: state.question,
          status: state.status,
          round: state.round,
          max_rounds: state.max_rounds,
          convergence: state.convergence,
          participant_count: participantCount,
        });
      }
    } catch {
    }
  }

  meetings.sort((a, b) => b.meeting_id.localeCompare(a.meeting_id));
  return meetings;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidMeetingId(id) {
  return UUID_RE.test(id);
}

export function getMeetingDbPath(directory, meetingId) {
  if (!isValidMeetingId(meetingId)) return null;
  const path = join(directory, ".opencode", "loom", "meetings", `${meetingId}.db`);
  return existsSync(path) ? path : null;
}

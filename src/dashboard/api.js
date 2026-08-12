import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync, readdirSync, statSync } from "node:fs";

const DB_CACHE_MAX = 10;

const DB_REFRESH_INTERVAL_MS = 2000;

const DB_TTL_MS = 5 * 60 * 1000;

export class DashboardApi {
  /** @type {Database} */
  #db;
  /** @type {string} */
  #dbPath;
  /** @type {number} */
  #lastModified = 0;
  /** @type {number} */
  #openedAt = 0;
  /** @type {number} */
  #fileMtimeMs = 0;

  /** @type {Map<string, DashboardApi>} */
  static cache = new Map();

  static get(dbPath) {
    const existing = DashboardApi.cache.get(dbPath);
    if (existing) {
      existing.#touch();
      existing.#maybeRefresh();
      return existing;
    }
    DashboardApi.#evictExpired();
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

  static #evictExpired() {
    const now = Date.now();
    for (const [path, api] of DashboardApi.cache) {
      if (now - api.#lastModified > DB_TTL_MS) {
        api.#db.close();
        DashboardApi.cache.delete(path);
      }
    }
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
    this.#openedAt = Date.now();
    try {
      const stat = statSync(dbPath);
      this.#fileMtimeMs = stat.mtimeMs;
    } catch {
    }
  }

  #touch() {
    this.#lastModified = Date.now();
  }

  #maybeRefresh() {
    const now = Date.now();
    if (now - this.#openedAt <= DB_REFRESH_INTERVAL_MS) return;

    try {
      const stat = statSync(this.#dbPath);
      const mtimeMs = stat.mtimeMs;
      if (mtimeMs !== this.#fileMtimeMs) {
        this.#db.close();
        this.#db = new Database(this.#dbPath, { readonly: true });
        this.#fileMtimeMs = mtimeMs;
      }
    } catch {
    }
    this.#openedAt = now;
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
        `SELECT id, participant_id, round, type, content, created_at
         FROM contributions ORDER BY round ASC, id ASC`,
      )
      .all();
  }

  getContributionsSince(sinceId) {
    return this.#db
      .prepare(
        `SELECT id, participant_id, round, type, content, created_at
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

  getOrchestratorMessages(meetingId) {
    return this.#db
      .prepare(
        `SELECT id, msg_type, role, content, created_at
         FROM orchestrator_messages WHERE meeting_id = ? ORDER BY id ASC`,
      )
      .all(meetingId)
      .map((r) => ({
        id: r.id,
        type: r.msg_type,
        role: r.role,
        content: r.content,
        created_at: r.created_at,
      }));
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

  getAgentContext(meetingId, participantId) {
    const meeting = this.#db
      .prepare(`SELECT warp, question FROM meetings WHERE id = ?`)
      .get(meetingId);
    const participant = this.#db
      .prepare(`SELECT name, persona, agenda, tier, provider_id, model_id FROM participants WHERE id = ? AND meeting_id = ?`)
      .get(participantId, meetingId);
    return { meeting, participant };
  }

  getRound(round) {
    const contributions = this.#db
      .prepare(
        `SELECT id, participant_id, round, type, content, created_at
         FROM contributions WHERE round = ? ORDER BY id ASC`,
      )
      .all(round);
    return { contributions };
  }

  exportMarkdown(meetingId) {
    const meeting = this.getState();
    const participants = this.getParticipants();
    const contributions = this.getContributions();
    const interjections = this.getInterjections();
    const errors = this.getAgentErrors();

    const lines = [];
    lines.push(`# Loom Deliberation Output`);
    lines.push("");
    lines.push(`**Question:** ${meeting?.question ?? "Unknown"}`);
    lines.push(`**Status:** ${meeting?.status ?? "Unknown"}`);
    lines.push(`**Rounds:** ${meeting?.round ?? 0}/${meeting?.max_rounds ?? 0}`);
    lines.push(`**Convergence:** ${meeting?.convergence ?? "Unknown"}`);
    lines.push(`**Meeting ID:** ${meetingId}`);
    lines.push("");
    lines.push(`## Participants`);
    lines.push("");
    for (const p of participants) {
      lines.push(`- **${p.name}** (${p.tier}) — ${p.provider_id ?? "unknown"}/${p.model_id ?? "unknown"}`);
    }
    lines.push("");

    const roundMap = new Map();
    for (const c of contributions) {
      if (!roundMap.has(c.round)) roundMap.set(c.round, []);
      roundMap.get(c.round).push(c);
    }

    for (const [roundNum, contribs] of [...roundMap.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push(`## Round ${roundNum}`);
      lines.push("");
      for (const c of contribs) {
        const participant = participants.find((p) => p.id === c.participant_id);
        const name = participant?.name ?? c.participant_id;
        lines.push(`- **[${name}]** (${c.type}): ${c.content}`);
      }
      lines.push("");
    }

    if (interjections.length > 0) {
      lines.push(`## Interjections`);
      lines.push("");
      for (const ij of interjections) {
        const participant = participants.find((p) => p.id === ij.participant_id);
        const name = participant?.name ?? ij.participant_id;
        lines.push(`- **[${name}]** P${ij.priority}: ${ij.content} → ${ij.granted ? "granted" : "denied"}`);
      }
      lines.push("");
    }

    if (errors.length > 0) {
      lines.push(`## Errors`);
      lines.push("");
      for (const e of errors) {
        const participant = participants.find((p) => p.id === e.participant_id);
        const name = participant?.name ?? e.participant_id;
        lines.push(`- **[${name}]** Round ${e.round}: ${e.error_type} — ${e.error_message}`);
      }
      lines.push("");
    }

    if (meeting?.warp) {
      lines.push(`## Final Warp Context`);
      lines.push("");
      lines.push(meeting.warp);
      lines.push("");
    }

    return lines.join("\n");
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

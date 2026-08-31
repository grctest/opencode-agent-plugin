import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { resolveLoomBaseDir } from "../paths.js";
import { parseReflections, safeParseJson } from "../utils/db-parsing.js";
import * as queriesHelpers from "./api/queries.js";
import * as exportsHelpers from "./api/exports.js";
import { TUNING } from "../config/defaults.js";
import { getConfig } from "../config.js";
function getDbCacheMax() { try { return getConfig()?.tuning?.MAX_DB_CACHE_SIZE ?? TUNING.MAX_DB_CACHE_SIZE; } catch { return TUNING.MAX_DB_CACHE_SIZE; } }

const DB_REFRESH_INTERVAL_MS = 500;

const DB_TTL_MS = 5 * 60 * 1000;

/**
 * Single mapper so fetch and SSE emit identically-shaped turn-request rows (audit 11 UF2/UF3).
 */
function mapTurnRequest(r) {
  return {
    id: r.id,
    participant_id: r.participant_id,
    target_participant_id: r.target_participant_id,
    round: r.round,
    reason: r.content,
    priority: r.priority,
    created_at: r.created_at,
  };
}

export class DashboardApi {
  /** @type {Database} */
  _db;
  /** @type {string} */
  _dbPath;
  /** @type {number} */
  _lastModified = 0;
  /** @type {number} */
  _openedAt = 0;
  /** @type {number} */
  _fileMtimeMs = 0;
  /** @type {number} */
  #walMtime = 0;
  /** @type {number} */
  #shmMtime = 0;

  /** @type {Map<string, DashboardApi>} */
  static cache = new Map();

  static get(dbPath) {
    const existing = DashboardApi.cache.get(dbPath);
    if (existing) {
      existing._touch();
      existing._maybeRefresh();
      return existing;
    }
    DashboardApi._evictExpired();
    if (DashboardApi.cache.size >= getDbCacheMax()) {
      let oldest = null;
      for (const [path, api] of DashboardApi.cache) {
        if (!oldest || api._lastModified < oldest.api._lastModified) {
          oldest = { path, api };
        }
      }
      if (oldest) {
        try { if (!oldest.api._db?.closed) oldest.api._db.close(); } catch {}
        DashboardApi.cache.delete(oldest.path);
      }
    }
    const api = new DashboardApi(dbPath);
    DashboardApi.cache.set(dbPath, api);
    return api;
  }

  static _evictExpired() {
    const now = Date.now();
    for (const [path, api] of DashboardApi.cache) {
      if (now - api._lastModified > DB_TTL_MS) {
        try { if (!api._db?.closed) api._db.close(); } catch {}
        DashboardApi.cache.delete(path);
      }
    }
  }

  static closeAll() {
    for (const api of DashboardApi.cache.values()) {
      try { if (!api._db?.closed) api._db.close(); } catch {}
    }
    DashboardApi.cache.clear();
  }

  constructor(dbPath) {
    this._dbPath = dbPath;
    this._db = new Database(dbPath, { readonly: true });
    try { this._db.exec("PRAGMA busy_timeout = 5000"); } catch {}
    this._lastModified = Date.now();
    this._openedAt = Date.now();
    try {
      const stat = statSync(this._dbPath);
      this._fileMtimeMs = stat.mtimeMs;
    } catch {
      // DB file may have been deleted between cache check and stat — not fatal
    }
    try { this.#walMtime = statSync(this._dbPath + "-wal").mtimeMs; } catch {}
    try { this.#shmMtime = statSync(this._dbPath + "-shm").mtimeMs; } catch {}
  }

  getMtimeMs() {
    return this._fileMtimeMs;
  }

  refreshIfStale() {
    this._maybeRefresh();
    return this._fileMtimeMs;
  }

  _touch() {
    this._lastModified = Date.now();
  }

  #refreshing = null;

  _maybeRefresh() {
    const now = Date.now();
    if (now - this._openedAt <= DB_REFRESH_INTERVAL_MS) return;
    if (this.#refreshing) return;
    this.#refreshing = (async () => {
      try {
        const stat = statSync(this._dbPath);
        const mtimeMs = stat.mtimeMs;
        let walMtime = 0, shmMtime = 0;
        try { walMtime = statSync(this._dbPath + "-wal").mtimeMs; } catch {}
        try { shmMtime = statSync(this._dbPath + "-shm").mtimeMs; } catch {}
        const mainChanged = mtimeMs !== this._fileMtimeMs;
        const walChanged = walMtime !== this.#walMtime;
        const shmChanged = shmMtime !== this.#shmMtime;
        if (mainChanged || walChanged || shmChanged) {
          try { if (!this._db?.closed) this._db.close(); } catch {}
          this._db = new Database(this._dbPath, { readonly: true });
          try { this._db.exec("PRAGMA busy_timeout = 5000"); } catch {}
          this._fileMtimeMs = mtimeMs;
          this.#walMtime = walMtime;
          this.#shmMtime = shmMtime;
        }
      } catch {
        // DB file may have been deleted or locked — will retry on next access
      }
      this._openedAt = Date.now();
    })();
    // Fire-and-forget but coalesce concurrent callers
    this.#refreshing.finally(() => { this.#refreshing = null; });
  }
  getState(...args) {
    return queriesHelpers.getState.apply(this, args);
  }
  getStateWithStats(...args) {
    return queriesHelpers.getStateWithStats.apply(this, args);
  }
  getArtifact(...args) {
    return queriesHelpers.getArtifact.apply(this, args);
  }
  getParticipants(...args) {
    return queriesHelpers.getParticipants.apply(this, args);
  }
  getAgentErrors(...args) {
    return queriesHelpers.getAgentErrors.apply(this, args);
  }
  getAgentErrorsAfter(...args) {
    return queriesHelpers.getAgentErrorsAfter.apply(this, args);
  }
  getMaxOrchestratorMessageId(...args) {
    return queriesHelpers.getMaxOrchestratorMessageId.apply(this, args);
  }
  getContributions(...args) {
    return queriesHelpers.getContributions.apply(this, args);
  }
  getContributionsAfter(...args) {
    return queriesHelpers.getContributionsAfter.apply(this, args);
  }
  getContributionsCount(...args) {
    return queriesHelpers.getContributionsCount.apply(this, args);
  }
  getContributionsSince(...args) {
    return queriesHelpers.getContributionsSince.apply(this, args);
  }

  getTurnRequests(limit = 500) {
    const n = Math.min(Math.max(limit ?? 500, 0), 500);
    return this._db
      .prepare(
        `SELECT id, participant_id, target_participant_id, round, content, priority, created_at
         FROM turn_requests ORDER BY id ASC LIMIT ?`,
      )
      .all(n)
      .map(mapTurnRequest);
  }

  getMaxTurnRequestId() {
    const row = this._db.prepare(`SELECT MAX(id) as max_id FROM turn_requests`).get();
    return row?.max_id ?? 0;
  }

  getTurnRequestsSince(sinceId, limit = 500) {
    const n = Math.min(Math.max(limit ?? 500, 0), 500);
    return this._db
      .prepare(
        `SELECT id, participant_id, target_participant_id, round, content, priority, created_at
         FROM turn_requests WHERE id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(sinceId, n)
      .map(mapTurnRequest);
  }

  getOrchestratorMessagesSince(sinceId, meetingId) {
    return this._db
      .prepare(
        `SELECT id, msg_type, role, content, round, created_at
         FROM orchestrator_messages WHERE id > ? AND meeting_id = ? ORDER BY id ASC`,
      )
      .all(sinceId, meetingId)
      .map((r) => ({
        id: r.id,
        type: r.msg_type,
        role: r.role,
        content: r.content,
        round: r.round,
        created_at: r.created_at,
      }));
  }

  getOrchestratorMessages(meetingId) {
    return this._db
      .prepare(
        `SELECT id, msg_type, role, content, round, created_at
         FROM orchestrator_messages WHERE meeting_id = ? ORDER BY id ASC`,
      )
      .all(meetingId)
      .map((r) => ({
        id: r.id,
        type: r.msg_type,
        role: r.role,
        content: r.content,
        round: r.round,
        created_at: r.created_at,
      }));
  }

  getMaxContributionId() {
    const row = this._db
      .prepare(`SELECT MAX(id) as maxId FROM contributions`)
      .get();
    return row.maxId ?? 0;
  }

  getRoundSummaries(meetingId) {
    const rows = this._db
      .prepare(
        `SELECT round, summary FROM rounds WHERE meeting_id = ? ORDER BY round ASC`,
      )
      .all(meetingId);
    const map = {};
    for (const r of rows) map[r.round] = r.summary;
    return map;
  }

  getMaxErrorId() {
    const row = this._db
      .prepare(`SELECT MAX(id) as maxId FROM agent_errors`)
      .get();
    return row.maxId ?? 0;
  }

  getContributionContext(contributionId) {
    const contribution = this._db
      .prepare(
        `SELECT id, participant_id, round, type, tool_calls, prompt_context, created_at
         FROM contributions WHERE id = ?`,
      )
      .get(contributionId);
    if (!contribution) return null;

    const participant = this._db
      .prepare(`SELECT name, persona, agenda, tier, provider_id, model_id, reflection FROM participants WHERE id = ?`)
      .get(contribution.participant_id);

    return {
      contribution_id: contribution.id,
      participant_id: contribution.participant_id,
      participant_name: participant?.name ?? contribution.participant_id,
      participant_tier: participant?.tier ?? "mid",
      participant_persona: participant?.persona ?? "",
      participant_agenda: participant?.agenda ?? "",
      participant_model: participant?.provider_id && participant?.model_id
        ? `${participant.provider_id}/${participant.model_id}` : null,
      participant_reflection: participant?.reflection ?? "",
      round: contribution.round,
      type: contribution.type,
      tool_calls: safeParseJson(contribution.tool_calls),
      prompt_context: safeParseJson(contribution.prompt_context),
      created_at: contribution.created_at,
    };
  }

  getAgentContext(meetingId, participantId) {
    const meeting = this._db
      .prepare(`SELECT fabric, question FROM meetings WHERE id = ?`)
      .get(meetingId);
    const participant = this._db
      .prepare(`SELECT name, persona, agenda, tier, provider_id, model_id FROM participants WHERE id = ? AND meeting_id = ?`)
      .get(participantId, meetingId);
    return { meeting, participant };
  }
  exportMarkdown(...args) {
    return exportsHelpers.exportMarkdown.apply(this, args);
  }
  exportJSON(...args) {
    return exportsHelpers.exportJSON.apply(this, args);
  }

  /**
   * Generates a streaming markdown export for large meetings.
   * Yields chunks in order so the response starts immediately.
   */
  *exportMarkdownStream(...args) {
    yield* exportsHelpers.exportMarkdownStream.apply(this, args);
  }

  close() {
    try { if (!this._db?.closed) this._db.close(); } catch {}
    DashboardApi.cache.delete(this._dbPath);
  }

  /**
   * Get the embedding model information for this meeting.
   */
  getEmbeddingModel(meetingId) {
    const meeting = this._db
      .prepare(`SELECT embedding_model, embedding_dim FROM meetings WHERE id = ?`)
      .get(meetingId);
    return meeting ?? null;
  }
}

export { listDownloadedModels, listMeetings, isValidMeetingId, getMeetingDbPath } from "./api/free.js";

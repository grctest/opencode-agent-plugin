import { mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { Logger, extractErrorInfo } from "./logger.js";
import { initSchema, migrateSchema } from "./database/schema.js";
import { resolveLoomBaseDir, getMeetingDbPath } from "./paths.js";
import {
  loadSessionIndex,
  indexMeeting as _indexMeeting,
  unindexMeeting as _unindexMeeting,
  getDatabasesBySessionId as _getDatabasesBySessionId,
} from "./database/session-index.js";

const dbLogger = new Logger();

// sqlite-vec native extension path — load directly via db.loadExtension()
// This bypasses the sqlite-vec npm package which fails in bundled context
// because import.meta.resolve() can't find vec0.so when code is bundled.
const VEC0_PATH = join(import.meta.dir, 'deps', 'node_modules', 'sqlite-vec-linux-x64', 'vec0.so');

// Single bun:sqlite import point — all DB access goes through this
let DatabaseClass = null;
let dbReady = null;

function ensureDb() {
  if (DatabaseClass) return Promise.resolve();
  if (dbReady) return dbReady;
  dbReady = (async () => {
    const mod = await import("bun:sqlite");
    DatabaseClass = mod.Database;
  })();
  return dbReady;
}

function safeParseJsonArray(value) {
  if (!value) return undefined;
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// findMeetingBySessionId uses DatabaseClass from ensureDb — no separate import needed

function isoNow() {
  return new Date().toISOString();
}

export { isoNow };

export class MeetingDatabase {
  #db;
  #meetingId;

  // ── Factory Methods ──────────────────────────────────────────────

  static async create(dbPath, meetingId) {
    await ensureDb();
    return new MeetingDatabase(dbPath, meetingId);
  }

  static async withTransaction(dbPath, fn) {
    await ensureDb();
    const db = new DatabaseClass(dbPath);
    try {
      db.exec('BEGIN TRANSACTION');
      const result = await fn(db);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.close();
    }
  }

  static async readParticipants(dbPath) {
    await ensureDb();
    const db = new DatabaseClass(dbPath, { readonly: true });
    try {
      return db.prepare(
        `SELECT id, name, persona, agenda, tier, provider_id, model_id FROM participants ORDER BY tier ASC`
      ).all();
    } finally {
      db.close();
    }
  }

  static async readMeeting(dbPath) {
    await ensureDb();
    const db = new DatabaseClass(dbPath, { readonly: true });
    try {
      const row = db.prepare(
        `SELECT id, question, context, status, round, max_rounds, convergence, domain, fabric
         FROM meetings LIMIT 1`
      ).get();
      return row ?? null;
    } finally {
      db.close();
    }
  }

  constructor(dbPath, meetingId) {
    this.#meetingId = meetingId;
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseClass(dbPath);
    this.#db = db;
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    if (existsSync(VEC0_PATH)) {
      try {
        this.#db.loadExtension(VEC0_PATH);
      } catch (err) {
        dbLogger.warn("sqlite_vec_load_error", "Failed to load sqlite-vec extension", extractErrorInfo(err));
      }
    } else {
      dbLogger.warn("sqlite_vec_not_found", "sqlite-vec extension not found — vector search disabled", { expectedPath: VEC0_PATH });
    }
    initSchema(this.#db);
    migrateSchema(this.#db);
    this.#initVectorTable();
    this.#cleanupOldErrors();
    this.#checkIntegrity();
  }

  #initVectorTable(dim = 384) {
    try {
      this.#db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_fabric_chunks_${dim} USING vec0(
          embedding float[${dim}]
        )
      `);
    } catch (err) {
      dbLogger.warn("vec_table_init_failed", "Could not create vector table — sqlite-vec may not be loaded", extractErrorInfo(err));
    }
  }

  #checkIntegrity() {
    try {
      const result = this.#db.prepare("PRAGMA integrity_check").get();
      if (result.integrity_check !== "ok") {
        dbLogger.warn("integrity_check_failed", "Database integrity check failed", { result: result.integrity_check });
      }
    } catch (err) {
      dbLogger.debug("integrity_check_error", "Integrity check could not run", extractErrorInfo(err));
    }
  }

  #cleanupOldErrors() {
    try {
      this.#db.prepare("DELETE FROM agent_errors WHERE created_at < datetime('now', '-30 days')").run();
      this.#db.prepare("DELETE FROM error_log WHERE created_at < datetime('now', '-30 days')").run();
    } catch { /* non-critical */ }
  }

  // ── Write Operations ─────────────────────────────────────────────

  initializeMeeting(input) {
    const now = isoNow();
    const insertMeeting = this.#db.prepare(
      `INSERT OR REPLACE INTO meetings (id, question, context, status, round, fabric, max_rounds, convergence, domain, tags, parent_session_id, opencode_session_id, embedding_model, embedding_dim, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertParticipant = this.#db.prepare(
      `INSERT INTO participants (id, meeting_id, name, persona, agenda, tier, provider_id, model_id, session_id, known_biases, communication_style, preferred_contribution_types)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    this.#db.exec('BEGIN TRANSACTION');
    try {
      insertMeeting.run(
        this.#meetingId,
        input.question,
        input.context ?? "",
        "initializing",
        input.context ?? "",
        input.maxRounds,
        input.convergence,
        input.domain ?? null,
        JSON.stringify(input.tags ?? []),
        input.parentSessionId,
        input.opencodeSessionId,
        input.embedding_model ?? null,
        input.embedding_dim ?? null,
        now,
        now,
      );

      for (const p of input.participants) {
        insertParticipant.run(
          p.id,
          this.#meetingId,
          p.name,
          p.persona,
          p.agenda,
          p.tier,
          p.model?.providerID ?? null,
          p.model?.modelID ?? null,
          null,
          p.known_biases ? JSON.stringify(p.known_biases) : null,
          p.communication_style ?? null,
          p.preferred_contribution_types ? JSON.stringify(p.preferred_contribution_types) : null,
        );
      }

      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }

    const dbPath = this.getDatabasePath();
    _indexMeeting(dbPath, this.#meetingId, input.opencodeSessionId);
  }

  /**
   * Upserts a meeting row — inserts if missing, updates if already present.
   * Unlike initializeMeeting, this does NOT delete existing persona embeddings
   * (no CASCADE), making it safe to call after composition-phase indexing.
   */
  upsertMeeting(input) {
    const now = isoNow();
    const existing = this.#db.prepare(`SELECT id FROM meetings WHERE id = ?`).get(this.#meetingId);
    if (existing) {
      this.#db.prepare(`
        UPDATE meetings SET question = ?, context = ?, max_rounds = ?, convergence = ?, domain = ?,
          tags = ?, parent_session_id = ?, opencode_session_id = ?, embedding_model = ?, embedding_dim = ?, updated_at = ?
        WHERE id = ?
      `).run(
        input.question, input.context ?? "", input.maxRounds, input.convergence,
        input.domain ?? null, JSON.stringify(input.tags ?? []),
        input.parentSessionId, input.opencodeSessionId,
        input.embedding_model ?? null, input.embedding_dim ?? null, now, this.#meetingId,
      );
    } else {
      this.initializeMeeting(input);
    }
  }

  /**
   * Inserts composed participants into the participants table.
   * Used after composeRoomWithSimilarity() returns participants in memory
   * that need to be persisted for dashboard display and meeting resumption.
   */
  insertParticipants(participants) {
    const insertParticipant = this.#db.prepare(
      `INSERT INTO participants (id, meeting_id, name, persona, agenda, tier, provider_id, model_id, session_id, known_biases, communication_style, preferred_contribution_types)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#db.exec('BEGIN TRANSACTION');
    try {
      for (const p of participants) {
        insertParticipant.run(
          p.id,
          this.#meetingId,
          p.name,
          p.persona,
          p.agenda,
          p.tier,
          p.model?.providerID ?? null,
          p.model?.modelID ?? null,
          null,
          p.known_biases ? JSON.stringify(p.known_biases) : null,
          p.communication_style ?? null,
          p.preferred_contribution_types ? JSON.stringify(p.preferred_contribution_types) : null,
        );
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Executes a function within a database transaction.
   * @param {Function} fn - Function to execute, receives the database instance
   * @returns {Promise<any>} Result of the function
   */
  async transaction(fn) {
    this.#db.exec('BEGIN TRANSACTION');
    try {
      const result = await fn(this.#db);
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  logError(context, message, details = null, severity = 'error') {
    try {
      this.#db
        .prepare(
          `INSERT INTO error_log (meeting_id, severity, context, message, details, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(this.#meetingId, severity, context, message, details ? JSON.stringify(details) : null, isoNow());
    } catch (err) {
      dbLogger.error("error_log_write_failed", "Failed to write error_log", { meetingId: this.#meetingId, error: err.message });
    }
  }

  getErrorLog(meetingId) {
    return this.#db
      .prepare(
        `SELECT id, severity, context, message, details, created_at
         FROM error_log WHERE meeting_id = ? ORDER BY id ASC`,
      )
      .all(meetingId)
      .map((r) => ({
        id: r.id,
        severity: r.severity,
        context: r.context,
        message: r.message,
        details: r.details ? JSON.parse(r.details) : null,
        created_at: r.created_at,
      }));
  }

  getFabric() {
    try {
      const row = this.#db
        .prepare("SELECT fabric FROM meetings WHERE id = ?")
        .get(this.#meetingId);
      return row?.fabric ?? "";
    } catch (err) {
      const info = extractErrorInfo(err);
      dbLogger.warn("get_fabric_failed", `Failed to get fabric for meeting ${this.#meetingId}`, info);
      return "";
    }
  }

  setFabric(fabric) {
    this.#db
      .prepare("UPDATE meetings SET fabric = ?, updated_at = ? WHERE id = ?")
      .run(fabric, isoNow(), this.#meetingId);
  }

  getStateOfPlay() {
    try {
      const row = this.#db
        .prepare("SELECT state_of_play FROM meetings WHERE id = ?")
        .get(this.#meetingId);
      return row?.state_of_play ?? "";
    } catch {
      return "";
    }
  }

  setStateOfPlay(stateOfPlay) {
    this.#db
      .prepare("UPDATE meetings SET state_of_play = ?, updated_at = ? WHERE id = ?")
      .run(stateOfPlay, isoNow(), this.#meetingId);
  }

  updateMeetingDomain(meetingId, domain) {
    this.#db
      .prepare("UPDATE meetings SET domain = ?, updated_at = ? WHERE id = ?")
      .run(domain, isoNow(), meetingId);
  }

  updateMeetingTags(meetingId, tags) {
    this.#db
      .prepare("UPDATE meetings SET tags = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(tags), isoNow(), meetingId);
  }

  addOrchestratorMessage(msgType, role, content) {
    this.#db
      .prepare(
        `INSERT INTO orchestrator_messages (meeting_id, msg_type, role, content, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(this.#meetingId, msgType, role, content, isoNow());
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

  getMaxOrchestratorMessageId() {
    const row = this.#db
      .prepare(`SELECT MAX(id) as maxId FROM orchestrator_messages WHERE meeting_id = ?`)
      .get(this.#meetingId);
    return row.maxId ?? 0;
  }

  getRound() {
    try {
      const row = this.#db
        .prepare("SELECT round FROM meetings WHERE id = ?")
        .get(this.#meetingId);
      return row?.round ?? 0;
    } catch (err) {
      const info = extractErrorInfo(err);
      dbLogger.warn("get_round_failed", `Failed to get round for meeting ${this.#meetingId}`, info);
      return 0;
    }
  }

   setRound(round) {
    this.#db
      .prepare("UPDATE meetings SET round = ?, updated_at = ? WHERE id = ?")
      .run(round, isoNow(), this.#meetingId);
  }

  setMaxRounds(maxRounds) {
    this.#db
      .prepare("UPDATE meetings SET max_rounds = ?, updated_at = ? WHERE id = ?")
      .run(maxRounds, isoNow(), this.#meetingId);
  }

  getStatus() {
    try {
      const row = this.#db
        .prepare("SELECT status FROM meetings WHERE id = ?")
        .get(this.#meetingId);
      return row ? row.status : "initializing";
    } catch (err) {
      const info = extractErrorInfo(err);
      dbLogger.warn("get_status_failed", `Failed to get status for meeting ${this.#meetingId}`, info);
      return "initializing";
    }
  }

  setStatus(status) {
    this.#db
      .prepare("UPDATE meetings SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, isoNow(), this.#meetingId);
  }

  setReflectingParticipants(participantIds) {
    const value = participantIds && participantIds.length > 0 ? JSON.stringify(participantIds) : null;
    this.#db
      .prepare("UPDATE meetings SET reflecting_participants = ?, updated_at = ? WHERE id = ?")
      .run(value, isoNow(), this.#meetingId);
  }

  setQueryingParticipants(participantIds) {
    const value = participantIds && participantIds.length > 0 ? JSON.stringify(participantIds) : null;
    this.#db
      .prepare("UPDATE meetings SET querying_participants = ?, updated_at = ? WHERE id = ?")
      .run(value, isoNow(), this.#meetingId);
  }

  addContribution(meetingId, contribution) {
    this.#db
      .prepare(
        `INSERT INTO contributions (meeting_id, participant_id, round, type, content, target_which, tool_calls, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        meetingId,
        contribution.participant_id,
        contribution.round ?? this.getRound(),
        contribution.type,
        contribution.content,
        contribution.targets_which ?? null,
        contribution.tool_calls ? JSON.stringify(contribution.tool_calls) : null,
        contribution.created_at ?? isoNow(),
      );
  }

  getContributions(meetingId) {
    const rows = this.#db
      .prepare(
        `SELECT id, participant_id, round, type, content, target_which, tool_calls, created_at
         FROM contributions WHERE meeting_id = ? ORDER BY id ASC`,
      )
      .all(meetingId);
    return rows.map((r) => ({
      id: r.id,
      participant_id: r.participant_id,
      round: r.round,
      content: r.content,
      type: r.type,
      targets_which: r.target_which != null ? Number(r.target_which) : null,
      tool_calls: r.tool_calls ? JSON.parse(r.tool_calls) : null,
      created_at: r.created_at,
    }));
  }

  getRecentContributions(meetingId, count) {
    const rows = this.#db
      .prepare(
        `SELECT id, participant_id, round, type, content, target_which, tool_calls, created_at
         FROM contributions WHERE meeting_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(meetingId, count);
    return rows.reverse().map((r) => ({
      id: r.id,
      participant_id: r.participant_id,
      round: r.round,
      content: r.content,
      type: r.type,
      targets_which: r.target_which != null ? Number(r.target_which) : null,
      tool_calls: r.tool_calls ? JSON.parse(r.tool_calls) : null,
      created_at: r.created_at,
    }));
  }

  addTurnRequest(meetingId, turnRequest) {
    this.#db
      .prepare(
        `INSERT INTO turn_requests (meeting_id, participant_id, target_participant_id, round, content, priority, granted, pushback, resolved, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        meetingId,
        turnRequest.participant_id,
        turnRequest.target_participant_id ?? null,
        turnRequest.round ?? null,
        turnRequest.reason,
        turnRequest.priority,
        turnRequest.granted ? 1 : 0,
        turnRequest.pushback ?? null,
        turnRequest.resolved,
        isoNow(),
      );
  }

  /**
   * Atomically adds a contribution and its associated turn request (if present).
   * Ensures both writes succeed or neither does, preventing orphaned records.
   */
  addContributionWithTurnRequest(meetingId, contribution, turnRequest) {
    this.#db.exec('BEGIN TRANSACTION');
    try {
      this.#db
        .prepare(
          `INSERT INTO contributions (meeting_id, participant_id, round, type, content, target_which, tool_calls, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          meetingId,
          contribution.participant_id,
          contribution.round ?? this.getRound(),
          contribution.type,
          contribution.content,
          contribution.targets_which ?? null,
          contribution.tool_calls ? JSON.stringify(contribution.tool_calls) : null,
          contribution.created_at ?? isoNow(),
        );

      if (turnRequest) {
        this.#db
          .prepare(
            `INSERT INTO turn_requests (meeting_id, participant_id, target_participant_id, round, content, priority, granted, pushback, resolved, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            meetingId,
            turnRequest.participant_id,
            turnRequest.target_participant_id ?? null,
            turnRequest.round ?? null,
            turnRequest.reason,
            turnRequest.priority,
            turnRequest.granted ? 1 : 0,
            turnRequest.pushback ?? null,
            turnRequest.resolved,
            isoNow(),
          );
      }

      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  getTurnRequests(meetingId) {
    const rows = this.#db
      .prepare(
        `SELECT id, participant_id, target_participant_id, round, content as reason, priority, granted, pushback, resolved, created_at
         FROM turn_requests WHERE meeting_id = ? ORDER BY id ASC`,
      )
      .all(meetingId);
    return rows.map((r) => ({
      id: r.id,
      participant_id: r.participant_id,
      target_participant_id: r.target_participant_id,
      round: r.round,
      priority: r.priority,
      content: r.reason,
      reason: r.reason,
      granted: r.granted === 1,
      pushback: r.pushback,
      resolved: r.resolved,
      created_at: r.created_at,
    }));
  }

  getMaxContributionId() {
    const row = this.#db
      .prepare(`SELECT MAX(id) as maxId FROM contributions WHERE meeting_id = ?`)
      .get(this.#meetingId);
    return row.maxId ?? 0;
  }

  setParticipantSessionId(participantId, sessionId) {
    this.#db
      .prepare("UPDATE participants SET session_id = ?, session_version = session_version + 1 WHERE id = ? AND meeting_id = ?")
      .run(sessionId, participantId, this.#meetingId);
  }

  setParticipantStatus(participantId, status) {
    this.#db
      .prepare("UPDATE participants SET status = ? WHERE id = ? AND meeting_id = ?")
      .run(status, participantId, this.#meetingId);
  }

  setParticipantReflection(participantId, reflection) {
    this.#db
      .prepare("UPDATE participants SET reflection = ? WHERE id = ? AND meeting_id = ?")
      .run(reflection, participantId, this.#meetingId);
  }

  getParticipantStatus(participantId) {
    const row = this.#db
      .prepare("SELECT status FROM participants WHERE id = ? AND meeting_id = ?")
      .get(participantId, this.#meetingId);
    return row?.status ?? "listening";
  }

  getAllParticipantsWithStatus() {
    return this.#db
      .prepare(
        `SELECT id, name, persona, agenda, tier, provider_id, model_id, session_id, session_version, status, reflection, known_biases, communication_style, preferred_contribution_types
         FROM participants WHERE meeting_id = ?`,
      )
      .all(this.#meetingId)
       .map((r) => ({
        id: r.id,
        name: r.name,
        persona: r.persona,
        agenda: r.agenda,
        tier: r.tier,
        provider_id: r.provider_id,
        model_id: r.model_id,
        session_id: r.session_id,
        session_version: r.session_version ?? 0,
        status: r.status,
        reflection: r.reflection,
        known_biases: safeParseJsonArray(r.known_biases),
        communication_style: r.communication_style ?? null,
        preferred_contribution_types: safeParseJsonArray(r.preferred_contribution_types),
      }));
  }

  setRoundSummary(round, summary) {
    this.#db
      .prepare(
        `INSERT INTO rounds (meeting_id, round, summary, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(meeting_id, round) DO UPDATE SET summary = excluded.summary, created_at = excluded.created_at`,
      )
      .run(this.#meetingId, round, summary ?? "", isoNow());
  }

  getRoundSummaries(meetingId) {
    const rows = this.#db
      .prepare(
        `SELECT round, summary FROM rounds WHERE meeting_id = ? ORDER BY round ASC`,
      )
      .all(meetingId);
    const map = {};
    for (const r of rows) map[r.round] = r.summary;
    return map;
  }

  getMeeting() {
    const row = this.#db
      .prepare(
        `SELECT id, question, context, status, round, fabric, max_rounds, convergence, domain, tags, parent_session_id, opencode_session_id, next_speaker_id, state_of_play, stats, embedding_model, embedding_dim, created_at
         FROM meetings WHERE id = ?`,
      )
      .get(this.#meetingId);
    return row ?? null;
  }

  setNextSpeaker(nextSpeakerId) {
    this.#db
      .prepare("UPDATE meetings SET next_speaker_id = ? WHERE id = ?")
      .run(nextSpeakerId ?? null, this.#meetingId);
  }

  setStats(statsJson) {
    this.#db
      .prepare("UPDATE meetings SET stats = ? WHERE id = ?")
      .run(statsJson ?? null, this.#meetingId);
  }

  saveArtifact(artifact) {
    this.#db
      .prepare(
        `INSERT INTO artifacts (meeting_id, content, decisions, action_items, dissent, open_questions, confidence, refusals, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(meeting_id) DO UPDATE SET
           content = excluded.content,
           decisions = excluded.decisions,
           action_items = excluded.action_items,
           dissent = excluded.dissent,
           open_questions = excluded.open_questions,
           confidence = excluded.confidence,
           refusals = excluded.refusals,
           created_at = excluded.created_at`,
      )
      .run(
        this.#meetingId,
        artifact.content,
        artifact.decisions ? JSON.stringify(artifact.decisions) : null,
        artifact.action_items ? JSON.stringify(artifact.action_items) : null,
        artifact.dissent ? JSON.stringify(artifact.dissent) : null,
        artifact.open_questions ? JSON.stringify(artifact.open_questions) : null,
        artifact.confidence ?? null,
        artifact.refusals ? JSON.stringify(artifact.refusals) : null,
        isoNow(),
      );
  }

  getArtifact(meetingId) {
    const row = this.#db
      .prepare(
        `SELECT content, decisions, action_items, dissent, open_questions, confidence, refusals, created_at
         FROM artifacts WHERE meeting_id = ?`,
      )
      .get(meetingId);
    if (!row) return null;
    const parse = (json) => {
      if (!json) return [];
      try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };
    return {
      content: row.content,
      decisions: parse(row.decisions),
      action_items: parse(row.action_items),
      dissent: parse(row.dissent),
      open_questions: parse(row.open_questions),
      refusals: parse(row.refusals),
      confidence: row.confidence,
      created_at: row.created_at,
    };
  }

  recordAgentError(meetingId, participantId, round, errorType, errorMessage, attempts) {
    this.#db
      .prepare(
        `INSERT INTO agent_errors (meeting_id, participant_id, round, error_type, error_message, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(meetingId, participantId, round, errorType, errorMessage ?? null, attempts, isoNow());
  }

  getAgentErrors(meetingId) {
    return this.#db
      .prepare(
        `SELECT participant_id, round, error_type, error_message, attempts, created_at
         FROM agent_errors WHERE meeting_id = ? ORDER BY id ASC`,
      )
      .all(meetingId)
      .map((r) => ({
        participant_id: r.participant_id,
        round: r.round,
        error_type: r.error_type,
        error_message: r.error_message,
        attempts: r.attempts,
        created_at: r.created_at,
      }));
  }

  // ── Read-Only Queries (used by dashboard & synthesis) ────────────

  getTranscriptData(meetingId) {
    const meeting = this.#db
      .prepare("SELECT question, fabric, domain FROM meetings WHERE id = ?")
      .get(meetingId);

    const contributions = this.#db
      .prepare(
        `SELECT id, participant_id, round, type, content, target_which, created_at
         FROM contributions WHERE meeting_id = ? ORDER BY round ASC, id ASC`,
      )
      .all(meetingId);

    const turnRequests = this.#db
      .prepare(
        `SELECT id, participant_id, target_participant_id, round, content as reason, priority, granted, pushback, resolved, created_at
         FROM turn_requests WHERE meeting_id = ? ORDER BY id ASC`,
      )
      .all(meetingId);

    const summaries = this.getRoundSummaries(meetingId);

    const roundMap = new Map();
    for (const c of contributions) {
      if (!roundMap.has(c.round)) {
        roundMap.set(c.round, { number: c.round, contributions: [], turn_requests: [], summary: summaries[c.round] ?? "" });
      }
      roundMap.get(c.round).contributions.push({
        id: c.id,
        participant_id: c.participant_id,
        content: c.content,
        type: c.type,
        round: c.round,
        targets_which: c.target_which != null ? Number(c.target_which) : null,
        created_at: c.created_at,
      });
    }

    for (const tr of turnRequests) {
      const roundNum = tr.round ?? 1;
      if (!roundMap.has(roundNum)) {
        roundMap.set(roundNum, { number: roundNum, contributions: [], turn_requests: [], summary: summaries[roundNum] ?? "" });
      }
      roundMap.get(roundNum).turn_requests.push({
        participant_id: tr.participant_id,
        target: tr.target_participant_id ?? "",
        priority: tr.priority,
        reason: tr.reason,
      });
    }

    const rounds = Array.from(roundMap.values()).sort((a, b) => a.number - b.number);

    return {
      question: meeting?.question ?? "",
      fabric: meeting?.fabric ?? "",
      domain: meeting?.domain ?? null,
      rounds,
    };
  }

  getParticipantModel(participantId) {
    const row = this.#db
      .prepare(`SELECT provider_id, model_id FROM participants WHERE id = ? AND meeting_id = ?`)
      .get(participantId, this.#meetingId);
    if (!row || !row.provider_id || !row.model_id) return null;
    return { providerID: row.provider_id, modelID: row.model_id };
  }

  close() {
    try {
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (err) {
      dbLogger.debug("wal_checkpoint_failed", "WAL checkpoint on close failed", extractErrorInfo(err));
    }
    this.#db.close();
  }

  getDatabasePath() {
    return this.#db.filename ?? this.#db.name ?? "unknown";
  }

  /**
   * Persists per-meeting metrics snapshot.
   * @param {Object} metrics
   */
  saveMeetingMetrics(metrics) {
    try {
      this.#db.prepare(
        `INSERT OR REPLACE INTO meeting_metrics
         (meeting_id, counters, latencies, input_tokens, output_tokens, duration_ms, rounds, contributions, turn_requests, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        this.#meetingId,
        JSON.stringify(metrics.counters ?? {}),
        JSON.stringify(metrics.latencies ?? {}),
        metrics.input_tokens ?? 0,
        metrics.output_tokens ?? 0,
        metrics.duration_ms ?? 0,
        metrics.rounds ?? 0,
        metrics.contributions ?? 0,
        metrics.turn_requests ?? 0,
        isoNow(),
      );
    } catch (err) {
      dbLogger.debug("save_metrics_failed", "Failed to save meeting metrics", extractErrorInfo(err));
    }
  }

  /**
   * Returns recent meeting metrics for trend analysis.
   * @param {number} limit
   */
  getRecentMeetingMetrics(limit = 20) {
    try {
      return this.#db.prepare(
        `SELECT * FROM meeting_metrics ORDER BY created_at DESC LIMIT ?`
      ).all(limit);
    } catch {
      return [];
    }
  }

  getOpencodeSessionId() {
    try {
      const row = this.#db
        .prepare("SELECT opencode_session_id FROM meetings WHERE id = ?")
        .get(this.#meetingId);
      return row?.opencode_session_id ?? null;
    } catch {
      return null;
    }
  }

  checkpoint() {
    try {
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (err) {
      dbLogger.debug("wal_checkpoint_failed", "WAL checkpoint failed", extractErrorInfo(err));
    }
  }

  // ── Vector Storage (sqlite-vec) ─────────────────────────────────

  /**
   * Stores a text chunk and its embedding in the fabric vector index.
   * @param {number} chunkId - fabric_chunks.id
   * @param {Float32Array} embedding - embedding vector
   * @param {number} dim - embedding dimension (default: 384)
   */
  storeFabricEmbedding(chunkId, embedding, dim = 384) {
    try {
      // Ensure the vector table exists for this dimension
      this.#initVectorTable(dim);
      this.#db.prepare(
        `INSERT INTO vec_fabric_chunks_${dim}(rowid, embedding) VALUES (?, vec_f32(?))`
      ).run(chunkId, embedding);
    } catch (err) {
      dbLogger.debug("store_embedding_failed", "Failed to store fabric embedding", extractErrorInfo(err));
    }
  }

  /**
   * Stores a text chunk in the fabric_chunks table and returns its ID.
   * @param {string} content - text content
   * @param {number} round - round number
   * @param {string} source - e.g. 'round_summary', 'contribution', 'context'
   * @returns {number|null} chunk ID
   */
  storeFabricChunk(content, round, source = "round_summary") {
    try {
      const result = this.#db.prepare(
        `INSERT INTO fabric_chunks (meeting_id, round, content, source, created_at) VALUES (?, ?, ?, ?, ?)`
      ).run(this.#meetingId, round, content, source, isoNow());
      return result.lastInsertRowid;
    } catch (err) {
      dbLogger.debug("store_chunk_failed", "Failed to store fabric chunk", extractErrorInfo(err));
      return null;
    }
  }

  /**
   * Retrieves all fabric chunks for this meeting, ordered by round.
   * @returns {Array<{id: number, round: number, content: string, source: string}>}
   */
  getFabricChunks() {
    try {
      return this.#db.prepare(
        `SELECT id, round, chunk_index, content, source FROM fabric_chunks WHERE meeting_id = ? ORDER BY round ASC, chunk_index ASC`
      ).all(this.#meetingId);
    } catch {
      return [];
    }
  }

  /**
   * Performs a vector similarity search over fabric embeddings.
   * @param {Float32Array} queryEmbedding - 384-dim query vector
   * @param {number} topK - number of results
   * @param {Float32Array} queryEmbedding - query vector
   * @param {number} topK - max results
   * @param {number} dim - embedding dimension (default: 384)
   * @returns {Array<{id: number, distance: number, content: string, round: number, source: string}>}
   */
  searchFabricVectors(queryEmbedding, topK = 5, dim = 384) {
    try {
      const limit = Math.max(1, Math.floor(Number(topK) || 5));
      return this.#db.prepare(`
        SELECT v.rowid, v.distance, f.content, f.round, f.source
        FROM vec_fabric_chunks_${dim} v
        JOIN fabric_chunks f ON f.id = v.rowid AND f.meeting_id = ?
        WHERE v.embedding MATCH ? AND k = ${limit}
        ORDER BY v.distance
      `).all(this.#meetingId, queryEmbedding);
    } catch {
      return [];
    }
  }

  // ── Persona Embedding Methods ────────────────────────────────────────────

  #initPersonaVectorTable(dim = 384) {
    try {
      this.#db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_persona_embeddings_${dim} USING vec0(
          embedding float[${dim}],
          tier text
        )
      `);
    } catch (err) {
      dbLogger.warn("persona_vec_table_init_failed", "Could not create persona vector table — sqlite-vec may not be loaded", extractErrorInfo(err));
    }
  }

  /**
   * Stores a persona embedding in the persona_embeddings table and its vector.
   * @param {string} personaName
   * @param {string} tier
   * @param {string[]} tags
   * @param {string} embeddingText - the text that was embedded
   * @param {Float32Array} embedding
   * @param {number} dim
   * @returns {number|null} row ID
   */
  storePersonaEmbedding(personaName, tier, tags, embeddingText, embedding, dim = 384) {
    try {
      this.#initPersonaVectorTable(dim);
      const result = this.#db.prepare(
        `INSERT INTO persona_embeddings (meeting_id, persona_name, tier, tags, embedding_text, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(this.#meetingId, personaName, tier, JSON.stringify(tags), embeddingText, isoNow());
      const rowId = result.lastInsertRowid;
      this.#db.prepare(
        `INSERT INTO vec_persona_embeddings_${dim}(rowid, embedding, tier) VALUES (?, vec_f32(?), ?)`
      ).run(rowId, embedding, tier);
      return rowId;
    } catch (err) {
      dbLogger.debug("store_persona_embedding_failed", "Failed to store persona embedding", extractErrorInfo(err));
      return null;
    }
  }

  /**
   * Searches persona embeddings by vector similarity, filtered by tier.
   * @param {Float32Array} queryEmbedding
   * @param {string} tier
   * @param {number} topK
   * @param {number} dim
   * @returns {Array<{id: number, distance: number, persona_name: string, tier: string, tags: string, embedding_text: string}>}
   */
  searchPersonaEmbeddings(queryEmbedding, tier, topK = 5, dim = 384) {
    try {
      this.#initPersonaVectorTable(dim);
      const limit = Math.max(1, Math.floor(Number(topK) || 5));
      return this.#db.prepare(`
        SELECT v.rowid, v.distance, p.persona_name, p.tier, p.tags, p.embedding_text
        FROM vec_persona_embeddings_${dim} v
        JOIN persona_embeddings p ON p.id = v.rowid AND p.meeting_id = ?
        WHERE v.tier = ? AND v.embedding MATCH ? AND k = ${limit}
        ORDER BY v.distance
      `).all(this.#meetingId, tier, queryEmbedding);
    } catch (err) {
      dbLogger.warn("search_persona_embeddings_failed", "Persona vector search failed", extractErrorInfo(err));
      return [];
    }
  }

  /**
   * Clears all persona embeddings for this meeting.
   */
  /**
   * Returns the number of persona embeddings indexed for this meeting.
   * @returns {number}
   */
  countPersonaEmbeddings() {
    try {
      const row = this.#db.prepare(`SELECT COUNT(*) as count FROM persona_embeddings WHERE meeting_id = ?`).get(this.#meetingId);
      return row?.count ?? 0;
    } catch { /* table may not exist yet */ }
    return 0;
  }

  countPersonaVecEmbeddings(dim = 384) {
    try {
      const row = this.#db.prepare(`SELECT COUNT(*) as count FROM vec_persona_embeddings_${dim}`).get();
      return row?.count ?? 0;
    } catch { /* table may not exist yet */ }
    return 0;
  }

  clearPersonaEmbeddings() {
    try {
      this.#db.prepare(`DELETE FROM persona_embeddings WHERE meeting_id = ?`).run(this.#meetingId);
    } catch { /* table may not exist yet */ }
  }

  /**
   * Retrieves a single persona embedding by persona name.
   * @param {string} personaName
   * @param {number} dim
   * @returns {Float32Array|null}
   */
  getPersonaEmbeddingByName(personaName, dim = 384) {
    try {
      this.#initPersonaVectorTable(dim);
      const row = this.#db.prepare(`
        SELECT v.embedding
        FROM vec_persona_embeddings_${dim} v
        JOIN persona_embeddings p ON p.id = v.rowid AND p.meeting_id = ?
        WHERE p.persona_name = ?
      `).get(this.#meetingId, personaName);
      return row?.embedding ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Retrieves embeddings for multiple persona names in a single query.
   * @param {string[]} personaNames
   * @param {number} dim
   * @returns {Map<string, Float32Array>}
   */
  getPersonaEmbeddingsByNames(personaNames, dim = 384) {
    if (!personaNames || personaNames.length === 0) return new Map();
    try {
      this.#initPersonaVectorTable(dim);
      const placeholders = personaNames.map(() => '?').join(',');
      const rows = this.#db.prepare(`
        SELECT p.persona_name, v.embedding
        FROM vec_persona_embeddings_${dim} v
        JOIN persona_embeddings p ON p.id = v.rowid AND p.meeting_id = ?
        WHERE p.persona_name IN (${placeholders})
      `).all(this.#meetingId, ...personaNames);
      const map = new Map();
      for (const row of rows) {
        map.set(row.persona_name, row.embedding);
      }
      return map;
    } catch {
      return new Map();
    }
  }
}

// Re-export session index functions for backward compatibility
export { loadSessionIndex, _indexMeeting as indexMeeting, _unindexMeeting as unindexMeeting, _getDatabasesBySessionId as getDatabasesBySessionId };

export async function findMeetingBySessionId(directory, sessionId) {
  await ensureDb();
  const indexed = _getDatabasesBySessionId(sessionId);
  if (indexed.length > 0) {
    const { meetingId, dbPath } = indexed[indexed.length - 1];
    if (existsSync(dbPath)) {
      let conn = null;
      try {
        conn = new DatabaseClass(dbPath, { readonly: true });
        const row = conn
          .prepare(
            `SELECT id, question, status, round, max_rounds FROM meetings
             WHERE opencode_session_id = ?
             LIMIT 1`,
          )
          .get(sessionId);
        if (row) {
          return { meetingId: row.id, question: row.question, status: row.status, round: row.round, max_rounds: row.max_rounds, dbPath };
        }
      } catch (err) {
        const info = extractErrorInfo(err);
        dbLogger.warn("indexed_db_lookup_failed", `Indexed DB lookup failed for ${dbPath}`, info);
      } finally {
        if (conn) conn.close();
      }
    }
  }

  const meetingsDir = join(resolveLoomBaseDir(directory), "meetings");
  if (!existsSync(meetingsDir)) return null;
  await ensureDb();
  const files = readdirSync(meetingsDir).filter((f) => f.endsWith(".db"));
  for (const file of files) {
    const filePath = join(meetingsDir, file);
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
    const db = new DatabaseClass(dbPath, { readonly: true });
    try {
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

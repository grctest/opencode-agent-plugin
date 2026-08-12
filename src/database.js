import { mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { Logger, extractErrorInfo } from "./logger.js";
import { initSchema, migrateSchema } from "./database/schema.js";
import {
  loadSessionIndex,
  indexMeeting as _indexMeeting,
  unindexMeeting as _unindexMeeting,
  getDatabasesBySessionId as _getDatabasesBySessionId,
} from "./database/session-index.js";

const dbLogger = new Logger();

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

/** @type {new (path: string, options?: { readonly?: boolean }) => DBHandle} */
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

function isoNow() {
  return new Date().toISOString();
}

export class MeetingDatabase {
  #db;
  #meetingId;

  static async create(dbPath, meetingId) {
    await ensureDb();
    return new MeetingDatabase(dbPath, meetingId);
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
        `SELECT id, question, context, status, round, max_rounds, convergence, domain, warp
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
    initSchema(this.#db);
    migrateSchema(this.#db);
  }

  initializeMeeting(input) {
    const now = isoNow();
    this.#db
      .prepare(
        `INSERT INTO meetings (id, question, context, status, round, warp, max_rounds, convergence, domain, parent_session_id, opencode_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#meetingId,
        input.question,
        input.context ?? "",
        "initializing",
        input.context ?? "",
        input.maxRounds,
        input.convergence,
        input.domain ?? null,
        input.parentSessionId,
        input.opencodeSessionId,
        now,
        now,
      );

    const dbPath = this.getDatabasePath();
    _indexMeeting(dbPath, this.#meetingId, input.opencodeSessionId);

    const insertParticipant = this.#db.prepare(
      `INSERT INTO participants (id, meeting_id, name, persona, agenda, tier, provider_id, model_id, session_id, known_biases, communication_style, preferred_contribution_types)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  getWarp() {
    const row = this.#db
      .prepare("SELECT warp FROM meetings WHERE id = ?")
      .get(this.#meetingId);
    return row?.warp ?? "";
  }

  setWarp(warp) {
    this.#db
      .prepare("UPDATE meetings SET warp = ?, updated_at = ? WHERE id = ?")
      .run(warp, isoNow(), this.#meetingId);
  }

  updateMeetingDomain(meetingId, domain) {
    this.#db
      .prepare("UPDATE meetings SET domain = ?, updated_at = ? WHERE id = ?")
      .run(domain, isoNow(), meetingId);
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
      .prepare(`SELECT MAX(id) as maxId FROM orchestrator_messages`)
      .get();
    return row.maxId ?? 0;
  }

  getRound() {
    const row = this.#db
      .prepare("SELECT round FROM meetings WHERE id = ?")
      .get(this.#meetingId);
    return row?.round ?? 0;
  }

  setRound(round) {
    this.#db
      .prepare("UPDATE meetings SET round = ?, updated_at = ? WHERE id = ?")
      .run(round, isoNow(), this.#meetingId);
  }

  getStatus() {
    const row = this.#db
      .prepare("SELECT status FROM meetings WHERE id = ?")
      .get(this.#meetingId);
    return row ? row.status : "initializing";
  }

  setStatus(status) {
    this.#db
      .prepare("UPDATE meetings SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, isoNow(), this.#meetingId);
  }

  addContribution(meetingId, contribution) {
    this.#db
      .prepare(
        `INSERT INTO contributions (meeting_id, participant_id, round, type, content, target_which, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        meetingId,
        contribution.participant_id,
        contribution.round ?? this.getRound(),
        contribution.type,
        contribution.content,
        contribution.targets_which ?? null,
        new Date(contribution.timestamp).toISOString(),
      );
  }

  getContributions(meetingId) {
    const rows = this.#db
      .prepare(
        `SELECT id, participant_id, round, type, content, target_which, created_at
         FROM contributions WHERE meeting_id = ? ORDER BY id ASC`,
      )
      .all(meetingId);
    return rows.map((r) => ({
      id: r.id,
      participant_id: r.participant_id,
      round: r.round,
      content: r.content,
      type: r.type,
      targets_which: r.target_which ?? null,
      timestamp: new Date(r.created_at).getTime(),
    }));
  }

  getRecentContributions(meetingId, count) {
    const rows = this.#db
      .prepare(
        `SELECT id, participant_id, round, type, content, target_which, created_at
         FROM contributions WHERE meeting_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(meetingId, count);
    return rows.reverse().map((r) => ({
      id: r.id,
      participant_id: r.participant_id,
      round: r.round,
      content: r.content,
      type: r.type,
      targets_which: r.target_which ?? null,
      timestamp: new Date(r.created_at).getTime(),
    }));
  }

  addInterjection(meetingId, interjection) {
    this.#db
      .prepare(
        `INSERT INTO interjections (meeting_id, participant_id, target_participant_id, round, content, priority, granted, pushback, resolved, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        meetingId,
        interjection.participant_id,
        interjection.target_participant_id ?? null,
        interjection.round ?? null,
        interjection.reason,
        interjection.priority,
        interjection.granted ? 1 : 0,
        interjection.pushback ?? null,
        interjection.resolved,
        isoNow(),
      );
  }

  getInterjections(meetingId) {
    const rows = this.#db
      .prepare(
        `SELECT id, participant_id, target_participant_id, round, content as reason, priority, granted, pushback, resolved
         FROM interjections WHERE meeting_id = ? ORDER BY id ASC`,
      )
      .all(meetingId);
    return rows.map((r) => ({
      id: r.id,
      participant_id: r.participant_id,
      target_participant_id: r.target_participant_id,
      round: r.round,
      priority: r.priority,
      reason: r.reason,
      granted: r.granted === 1,
      pushback: r.pushback,
      resolved: r.resolved,
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
      .prepare("UPDATE participants SET session_id = ? WHERE id = ? AND meeting_id = ?")
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
        `SELECT id, name, persona, agenda, tier, provider_id, model_id, session_id, status, reflection, known_biases, communication_style, preferred_contribution_types
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
        `SELECT id, question, context, status, round, warp, max_rounds, convergence, domain, parent_session_id, opencode_session_id, next_speaker_id, stats, created_at
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
        `INSERT INTO artifacts (meeting_id, content, decisions, action_items, dissent, open_questions, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(meeting_id) DO UPDATE SET
           content = excluded.content,
           decisions = excluded.decisions,
           action_items = excluded.action_items,
           dissent = excluded.dissent,
           open_questions = excluded.open_questions,
           confidence = excluded.confidence,
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
        isoNow(),
      );
  }

  getArtifact(meetingId) {
    const row = this.#db
      .prepare(
        `SELECT content, decisions, action_items, dissent, open_questions, confidence, created_at
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

  getTranscriptData(meetingId) {
    const meeting = this.#db
      .prepare("SELECT question, warp, domain FROM meetings WHERE id = ?")
      .get(meetingId);

    const contributions = this.#db
      .prepare(
        `SELECT id, participant_id, round, type, content, target_which, created_at
         FROM contributions WHERE meeting_id = ? ORDER BY round ASC, id ASC`,
      )
      .all(meetingId);

    const interjections = this.#db
      .prepare(
        `SELECT id, participant_id, target_participant_id, round, content as reason, priority, granted, pushback, resolved, created_at
         FROM interjections WHERE meeting_id = ? ORDER BY id ASC`,
      )
      .all(meetingId);

    const summaries = this.getRoundSummaries(meetingId);

    const roundMap = new Map();
    for (const c of contributions) {
      if (!roundMap.has(c.round)) {
        roundMap.set(c.round, { number: c.round, contributions: [], interjections: [], summary: summaries[c.round] ?? "" });
      }
      roundMap.get(c.round).contributions.push({
        id: c.id,
        participant_id: c.participant_id,
        content: c.content,
        type: c.type,
        round: c.round,
        targets_which: c.target_which ?? null,
        timestamp: new Date(c.created_at).getTime(),
      });
    }

    for (const ij of interjections) {
      const roundNum = ij.round ?? 1;
      if (!roundMap.has(roundNum)) {
        roundMap.set(roundNum, { number: roundNum, contributions: [], interjections: [], summary: summaries[roundNum] ?? "" });
      }
      roundMap.get(roundNum).interjections.push({
        id: ij.id,
        participant_id: ij.participant_id,
        target_participant_id: ij.target_participant_id ?? null,
        priority: ij.priority,
        reason: ij.reason,
        granted: ij.granted === 1,
        pushback: ij.pushback,
        resolved: ij.resolved,
      });
    }

    const rounds = Array.from(roundMap.values()).sort((a, b) => a.number - b.number);

    return {
      question: meeting?.question ?? "",
      warp: meeting?.warp ?? "",
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
    } catch { /* ignore */ }
    this.#db.close();
  }

  getDatabasePath() {
    return this.#db.filename ?? this.#db.name ?? "unknown";
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
    } catch { /* ignore */ }
  }
}

// Re-export session index functions for backward compatibility
export { loadSessionIndex, _indexMeeting as indexMeeting, _unindexMeeting as unindexMeeting, _getDatabasesBySessionId as getDatabasesBySessionId };

export async function findMeetingBySessionId(directory, sessionId) {
  const indexed = _getDatabasesBySessionId(sessionId);
  if (indexed.length > 0) {
    const { meetingId, dbPath } = indexed[indexed.length - 1];
    if (existsSync(dbPath)) {
      const { Database: DBClass } = await import("bun:sqlite");
      let conn = null;
      try {
        conn = new DBClass(dbPath, { readonly: true });
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

  const { Database: DBClass } = await import("bun:sqlite");
  const meetingsDir = join(directory, ".opencode", "loom", "meetings");
  if (!existsSync(meetingsDir)) return null;
  const files = readdirSync(meetingsDir).filter((f) => f.endsWith(".db"));
  for (const file of files) {
    const filePath = join(meetingsDir, file);
    let conn = null;
    try {
      conn = new DBClass(filePath, { readonly: true });
      const row = conn
        .prepare(
          `SELECT id, question, status, round, max_rounds FROM meetings
           WHERE opencode_session_id = ?
           LIMIT 1`,
        )
        .get(sessionId);
      if (row) {
        conn.close();
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
  const path = join(directory, ".opencode", "loom", "meetings", `${meetingId}.db`);
  return existsSync(path) ? path : null;
}

export function deleteMeetingFiles(dbPath) {
  _unindexMeeting(dbPath);
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
  }
}

export function listMeetingFiles(directory) {
  const dir = join(directory, ".opencode", "loom", "meetings");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".db"));
}

export async function readSessionIdFromDbAsync(dbPath) {
  try {
    const { Database: DBClass } = await import("bun:sqlite");
    const db = new DBClass(dbPath, { readonly: true });
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
  const meetingsDir = join(directory, ".opencode", "loom", "meetings");
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

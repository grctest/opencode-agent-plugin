import { mkdirSync, existsSync, readdirSync, unlinkSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { extractErrorInfo } from "./logger.js";

/** @type {new (path: string, options?: { readonly?: boolean }) => DBHandle} */
let DatabaseClass = null;
let dbReady = null;

const SCHEMA_VERSION = 5;

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

  constructor(dbPath, meetingId) {
    this.#meetingId = meetingId;
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseClass(dbPath);
    this.#db = db;
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#initSchema();
    this.#migrate();
  }

  #initSchema() {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        question TEXT NOT NULL,
        context TEXT,
        status TEXT NOT NULL,
        round INTEGER NOT NULL DEFAULT 0,
        warp TEXT,
        max_rounds INTEGER NOT NULL,
        convergence TEXT NOT NULL,
        domain TEXT,
        parent_session_id TEXT,
        opencode_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        persona TEXT NOT NULL,
        agenda TEXT NOT NULL,
        tier TEXT NOT NULL,
        provider_id TEXT,
        model_id TEXT,
        session_id TEXT,
        status TEXT NOT NULL DEFAULT 'listening',
        reflection TEXT NOT NULL DEFAULT '',
        UNIQUE(meeting_id, name)
      );

      CREATE TABLE IF NOT EXISTS contributions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        participant_id TEXT NOT NULL,
        round INTEGER NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS interjections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        participant_id TEXT NOT NULL,
        target_participant_id TEXT,
        round INTEGER,
        content TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        granted INTEGER NOT NULL DEFAULT 0,
        pushback TEXT,
        resolved TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        participant_id TEXT NOT NULL,
        round INTEGER NOT NULL,
        error_type TEXT NOT NULL,
        error_message TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS error_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
        severity TEXT NOT NULL DEFAULT 'error',
        context TEXT NOT NULL,
        message TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orchestrator_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        msg_type TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_contributions_meeting_round ON contributions(meeting_id, round);
      CREATE INDEX IF NOT EXISTS idx_contributions_meeting ON contributions(meeting_id);
      CREATE INDEX IF NOT EXISTS idx_interjections_meeting ON interjections(meeting_id);
      CREATE INDEX IF NOT EXISTS idx_agent_errors_meeting ON agent_errors(meeting_id);
      CREATE INDEX IF NOT EXISTS idx_participants_meeting ON participants(meeting_id);
      CREATE INDEX IF NOT EXISTS idx_error_log_meeting ON error_log(meeting_id);
      CREATE INDEX IF NOT EXISTS idx_orchestrator_messages_meeting ON orchestrator_messages(meeting_id);
    `);
  }

  #migrate() {
    const currentVersion = this.#getSchemaVersion();

    if (currentVersion < 1) {
      this.#db.exec(`CREATE TABLE IF NOT EXISTS _loom_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      this.#db.exec(`INSERT OR REPLACE INTO _loom_meta (key, value) VALUES ('schema_version', '1')`);
      try { this.#db.exec(`ALTER TABLE participants ADD COLUMN reflection TEXT NOT NULL DEFAULT ''`); } catch { /* exists */ }
      try { this.#db.exec(`ALTER TABLE meetings ADD COLUMN opencode_session_id TEXT`); } catch { /* exists */ }
      try { this.#db.exec(`ALTER TABLE interjections ADD COLUMN round INTEGER`); } catch { /* exists */ }
    }

    if (currentVersion < 2) {
      try { this.#db.exec(`DROP TABLE IF EXISTS agent_responses`); } catch { /* ignore */ }
      try {
        this.#db.exec(`DROP TABLE IF EXISTS metadata`);
        this.#db.exec(`CREATE TABLE IF NOT EXISTS _loom_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      } catch { /* ignore */ }
      this.#db.exec(`INSERT OR REPLACE INTO _loom_meta (key, value) VALUES ('schema_version', '2')`);
    }

    if (currentVersion < 3) {
      try {
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS error_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id TEXT REFERENCES meetings(id) ON DELETE CASCADE,
            severity TEXT NOT NULL DEFAULT 'error',
            context TEXT NOT NULL,
            message TEXT NOT NULL,
            details TEXT,
            created_at TEXT NOT NULL
          )
        `);
        this.#db.exec(`CREATE INDEX IF NOT EXISTS idx_error_log_meeting ON error_log(meeting_id)`);
      } catch { /* exists */ }
      this.#db.exec(`INSERT OR REPLACE INTO _loom_meta (key, value) VALUES ('schema_version', '3')`);
    }

    if (currentVersion < 4) {
      try { this.#db.exec(`ALTER TABLE meetings ADD COLUMN domain TEXT`); } catch { /* exists */ }
      this.#db.exec(`INSERT OR REPLACE INTO _loom_meta (key, value) VALUES ('schema_version', '4')`);
    }

    if (currentVersion < 5) {
      try {
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS orchestrator_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
            msg_type TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
          )
        `);
        this.#db.exec(`CREATE INDEX IF NOT EXISTS idx_orchestrator_messages_meeting ON orchestrator_messages(meeting_id)`);
      } catch { /* exists */ }
      this.#db.exec(`INSERT OR REPLACE INTO _loom_meta (key, value) VALUES ('schema_version', '5')`);
    }
  }

  #getSchemaVersion() {
    try {
      const hasMeta = this.#db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='_loom_meta'"
      ).get();
      if (!hasMeta) return 0;
      const row = this.#db.prepare("SELECT value FROM _loom_meta WHERE key = ?").get("schema_version");
      return row ? parseInt(row.value, 10) : 0;
    } catch {
      return 0;
    }
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
    indexMeeting(dbPath, this.#meetingId, input.opencodeSessionId);

    const insertParticipant = this.#db.prepare(
      `INSERT INTO participants (id, meeting_id, name, persona, agenda, tier, provider_id, model_id, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      console.error(`[Loom ${this.#meetingId}] Failed to write error_log: ${err.message}`);
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
        `INSERT INTO contributions (meeting_id, participant_id, round, type, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        meetingId,
        contribution.participant_id,
        contribution.round ?? this.getRound(),
        contribution.type,
        contribution.content,
        new Date(contribution.timestamp).toISOString(),
      );
  }

  getContributions(meetingId) {
    const rows = this.#db
      .prepare(
        `SELECT participant_id, content, type, created_at
         FROM contributions WHERE meeting_id = ? ORDER BY id ASC`,
      )
      .all(meetingId);
    return rows.map((r) => ({
      participant_id: r.participant_id,
      content: r.content,
      type: r.type,
      targets_which: null,
      timestamp: new Date(r.created_at).getTime(),
    }));
  }

  getRecentContributions(meetingId, count) {
    const rows = this.#db
      .prepare(
        `SELECT participant_id, content, type, created_at
         FROM contributions WHERE meeting_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(meetingId, count);
    return rows.reverse().map((r) => ({
      participant_id: r.participant_id,
      content: r.content,
      type: r.type,
      targets_which: null,
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
        `SELECT participant_id, content as reason, priority, granted, pushback, resolved
         FROM interjections WHERE meeting_id = ? ORDER BY id ASC`,
      )
      .all(meetingId);
    return rows.map((r) => ({
      participant_id: r.participant_id,
      priority: r.priority,
      reason: r.reason,
      granted: r.granted === 1,
      pushback: r.pushback,
      resolved: r.resolved,
    }));
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
        `SELECT id, name, persona, agenda, tier, provider_id, model_id, session_id, status
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
      }));
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
        `SELECT participant_id, round, type, content, created_at
         FROM contributions WHERE meeting_id = ? ORDER BY round ASC, id ASC`,
      )
      .all(meetingId);

    const interjections = this.#db
      .prepare(
        `SELECT participant_id, content as reason, priority, granted, pushback, resolved, created_at
         FROM interjections WHERE meeting_id = ? ORDER BY created_at ASC`,
      )
      .all(meetingId);

    const roundMap = new Map();
    for (const c of contributions) {
      if (!roundMap.has(c.round)) {
        roundMap.set(c.round, { number: c.round, contributions: [], interjections: [], summary: "" });
      }
      roundMap.get(c.round).contributions.push({
        participant_id: c.participant_id,
        content: c.content,
        type: c.type,
        targets_which: null,
        timestamp: new Date(c.created_at).getTime(),
      });
    }

    for (const ij of interjections) {
      const roundNum = ij.round ?? 1;
      if (!roundMap.has(roundNum)) {
        roundMap.set(roundNum, { number: roundNum, contributions: [], interjections: [], summary: "" });
      }
      roundMap.get(roundNum).interjections.push({
        participant_id: ij.participant_id,
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

const sessionIndex = new Map();
let indexDir = null;

function getIndexFilePath() {
  if (!indexDir) return null;
  return join(indexDir, ".opencode", "loom", "session-index.json");
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
  } catch {
  }
}

function persistSessionIndex() {
  const filePath = getIndexFilePath();
  if (!filePath) return;
  try {
    const obj = Object.fromEntries(sessionIndex);
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
    renameSync(tmpPath, filePath);
  } catch {
  }
}

export function getDatabasesBySessionId(sessionId) {
  const entries = sessionIndex.get(sessionId);
  return entries ? [...entries] : [];
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

export async function findMeetingBySessionId(directory, sessionId) {
  const indexed = sessionIndex.get(sessionId);
  if (indexed && indexed.length > 0) {
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
        console.warn(`[Loom] Indexed DB lookup failed for ${dbPath}: ${err.message}`);
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
        indexMeeting(filePath, row.id, sessionId);
        return { meetingId: row.id, question: row.question, status: row.status, round: row.round, max_rounds: row.max_rounds, dbPath: filePath };
      }
    } catch (err) {
      console.warn(`[Loom] DB scan failed for ${filePath}: ${err.message}`);
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
  unindexMeeting(dbPath);
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
    console.warn(`[Loom] Failed to read session ID from ${dbPath}: ${err.message}`);
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

export async function cleanupOrphanDatabases(directory, activeSessionIds) {
  const meetingsDir = join(directory, ".opencode", "loom", "meetings");
  if (!existsSync(meetingsDir)) return 0;

  let cleaned = 0;
  for (const file of readdirSync(meetingsDir)) {
    if (!file.endsWith(".db")) continue;
    const dbPath = join(meetingsDir, file);
    const sessionId = await readSessionIdFromDbAsync(dbPath);
    if (sessionId && !activeSessionIds.has(sessionId)) {
      for (const suffix of ["", "-wal", "-shm"]) {
        try { unlinkSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
      }
      cleaned++;
    }
  }
  return cleaned;
}

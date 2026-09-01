import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { Logger, extractErrorInfo } from "./logger.js";
import { initSchema, runMigrations } from "./database/schema.js";
import { resolveLoomBaseDir, getMeetingDbPath } from "./paths.js";
import { ensureDb, getDatabaseClass, isoNow, resolveVecPath } from "./database/connection.js";
import { maintenanceDue, markMaintained, checkIntegrity, cleanupOldErrors, cleanupOldVectors, initVectorTable, checkpointWal, vacuumIfNeeded } from "./database/maintenance.js";
import * as meetingOps from "./database/meeting-operations.js";
import * as contribOps from "./database/contribution-operations.js";
import * as vectorOps from "./database/vector-operations.js";
import * as forumOps from "./database/forum-operations.js";
import { loadSessionIndex, indexMeeting as _indexMeeting, unindexMeeting as _unindexMeeting, getDatabasesBySessionId as _getDatabasesBySessionId } from "./database/session-index.js";
import { notifyDatabaseWrite } from "./services/write-notifier.js";

export { isoNow };
export { loadSessionIndex, _indexMeeting as indexMeeting, _unindexMeeting as unindexMeeting, _getDatabasesBySessionId as getDatabasesBySessionId };
export { findMeetingBySessionId, getDbPathForMeeting, deleteMeetingFiles, listMeetingFiles, readSessionIdFromDbAsync, deleteMeetingsBySessionId } from "./database/lookup.js";

const dbLogger = new Logger();

export class MeetingDatabase {
  #db;
  #meetingId;

  static async create(dbPath, meetingId) {
    await ensureDb();
    return new MeetingDatabase(dbPath, meetingId);
  }

  static async withTransaction(dbPath, fn, { retries = 5 } = {}) {
    await ensureDb();
    const DatabaseClass = getDatabaseClass();
    const db = new DatabaseClass(dbPath);
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        db.exec('PRAGMA foreign_keys = ON');
        db.exec('PRAGMA busy_timeout = 5000');
        db.exec('PRAGMA wal_autocheckpoint = 1000');
        db.exec('BEGIN IMMEDIATE');
        const result = await fn(db);
        db.exec('COMMIT');
        try { db.close(); } catch {}
        return result;
      } catch (err) {
        const msg = String(err?.message ?? err);
        const isBusy = /SQLITE_BUSY|database is locked|busy/i.test(msg);
        try { db.exec('ROLLBACK'); } catch {}
        if (isBusy && attempt < retries) {
          lastErr = err;
          const delay = Math.min(50 * Math.pow(2, attempt) + Math.random() * 50, 800);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        try { db.close(); } catch {}
        throw err;
      }
    }
    try { db.close(); } catch {}
    throw lastErr;
  }

  static async readParticipants(dbPath) {
    await ensureDb();
    const DatabaseClass = getDatabaseClass();
    const db = new DatabaseClass(dbPath, { readonly: true });
    try {
      return db.prepare(
        `SELECT id, name, persona, agenda, tier, provider_id, model_id FROM participants ORDER BY tier ASC`
      ).all();
    } catch (err) { throw err; } finally {
      try { db.close(); } catch {}
    }
  }

  static async readMeeting(dbPath) {
    await ensureDb();
    const DatabaseClass = getDatabaseClass();
    const db = new DatabaseClass(dbPath, { readonly: true });
    try {
      const row = db.prepare(
        `SELECT id, question, context, status, round, max_rounds, convergence, fabric
         FROM meetings LIMIT 1`
      ).get();
      return row ?? null;
    } catch (err) { throw err; } finally {
      try { db.close(); } catch {}
    }
  }

  constructor(dbPath, meetingId) {
    this.#meetingId = meetingId;
    const existedBefore = existsSync(dbPath);
    mkdirSync(dirname(dbPath), { recursive: true });
    const DatabaseClass = getDatabaseClass();
    let db;
    try {
      db = new DatabaseClass(dbPath);
      this.#db = db;
      this.#db.exec("PRAGMA foreign_keys = ON");
      this.#db.exec("PRAGMA busy_timeout = 5000");
      const jm = this.#db.prepare("PRAGMA journal_mode = WAL").get();
      if (jm?.journal_mode !== "wal") dbLogger.warn("pragma_journal_mode_fallback", `journal_mode WAL not achieved (got ${jm?.journal_mode ?? "unknown"}) — concurrency reduced`, { journal_mode: jm?.journal_mode });
      this.#db.exec("PRAGMA synchronous = NORMAL");
      this.#db.exec("PRAGMA wal_autocheckpoint = 1000");
      const vecPath = resolveVecPath();
      if (vecPath && existsSync(vecPath)) {
        try {
          this.#db.loadExtension(vecPath);
        } catch (err) {
          dbLogger.warn("sqlite_vec_load_error", "Failed to load sqlite-vec extension", extractErrorInfo(err));
        }
      } else {
        if (!vecPath) {
          dbLogger.warn("sqlite_vec_not_found", "sqlite-vec extension not found — vector search degraded to keyword fallback", { searched: 'no candidate found', candidates: 'sqlite-vec-*' });
        }
      }
      initSchema(this.#db);
      runMigrations(this.#db, { logger: dbLogger });
      initVectorTable(this.#db);
    } catch (err) {
      try { db?.close?.(); } catch {}
      try { this.#db?.close?.(); } catch {}
      throw err;
    }
    const shouldMaintain = existedBefore || process.env.LOOM_INTEGRITY_CHECK === '1'
      ? maintenanceDue(this.#db)
      : false;
    if (shouldMaintain) {
      cleanupOldErrors(this.#db);
      cleanupOldVectors(this.#db);
      if (existedBefore) {
        checkIntegrity(this.#db);
        checkpointWal(this.#db);
        vacuumIfNeeded(this.#db);
      }
      markMaintained(this.#db);
    }
  }

  #_txnSeq = 0;

  #notify(table) { notifyDatabaseWrite(this.#meetingId, table); }

  async transaction(fn) {
    const spName = `loom_txn_${++this.#_txnSeq}`;
    this.#db.exec(`SAVEPOINT ${spName}`);
    try {
      const result = await fn(this.#db);
      this.#db.exec(`RELEASE ${spName}`);
      return result;
    } catch (err) {
      try { this.#db.exec(`ROLLBACK TO ${spName}`); } catch {}
      try { this.#db.exec(`RELEASE ${spName}`); } catch {}
      throw err;
    }
  }

  initializeMeeting(input) { const r = meetingOps.initializeMeeting(this.#db, this.#meetingId, input); this.#notify("meetings"); return r; }
  upsertMeeting(input) { const r = meetingOps.upsertMeeting(this.#db, this.#meetingId, input); this.#notify("meetings"); return r; }
  insertParticipants(participants) { const r = meetingOps.insertParticipants(this.#db, this.#meetingId, participants); this.#notify("participants"); return r; }
  logError(context, message, details = null, severity = 'error') { const r = meetingOps.logError(this.#db, this.#meetingId, context, message, details, severity); this.#notify("error_log"); return r; }
  getErrorLog(meetingId) { return meetingOps.getErrorLog(this.#db, meetingId); }
  getFabric() { return meetingOps.getFabric(this.#db, this.#meetingId); }
  setFabric(fabric) { const r = meetingOps.setFabric(this.#db, this.#meetingId, fabric); this.#notify("meetings"); return r; }
  getStateOfPlay() { return meetingOps.getStateOfPlay(this.#db, this.#meetingId); }
  setStateOfPlay(stateOfPlay) { const r = meetingOps.setStateOfPlay(this.#db, this.#meetingId, stateOfPlay); this.#notify("meetings"); return r; }
  setSemanticDegraded(flag = true) { const r = meetingOps.setSemanticDegraded(this.#db, this.#meetingId, flag); this.#notify("meetings"); return r; }
  setPersistenceDegraded(flag = true) { const r = meetingOps.setPersistenceDegraded(this.#db, this.#meetingId, flag); this.#notify("meetings"); return r; }
  updateMeetingTags(meetingId, tags) { const r = meetingOps.updateMeetingTags(this.#db, meetingId, tags); this.#notify("meetings"); return r; }
  addOrchestratorMessage(msgType, role, content, round = null) { const r = meetingOps.addOrchestratorMessage(this.#db, this.#meetingId, msgType, role, content, round); this.#notify("orchestrator_messages"); return r; }
  getOrchestratorMessages(meetingId) { return meetingOps.getOrchestratorMessages(this.#db, meetingId); }
  getMaxOrchestratorMessageId() { return meetingOps.getMaxOrchestratorMessageId(this.#db, this.#meetingId); }
  getRound() { return meetingOps.getRound(this.#db, this.#meetingId); }
  setRound(round) { const r = meetingOps.setRound(this.#db, this.#meetingId, round); this.#notify("meetings"); return r; }
  setMaxRounds(maxRounds) { const r = meetingOps.setMaxRounds(this.#db, this.#meetingId, maxRounds); this.#notify("meetings"); return r; }
  getStatus() { return meetingOps.getStatus(this.#db, this.#meetingId); }
  setStatus(status) { const r = meetingOps.setStatus(this.#db, this.#meetingId, status); this.#notify("meetings"); return r; }
  setReflectingParticipants(participantIds) { const r = meetingOps.setReflectingParticipants(this.#db, this.#meetingId, participantIds); this.#notify("meetings"); return r; }
  setQueryingParticipants(participantIds) { const r = meetingOps.setQueryingParticipants(this.#db, this.#meetingId, participantIds); this.#notify("meetings"); return r; }
  setEvidenceParticipants(participantIds) { const r = meetingOps.setEvidenceParticipants(this.#db, this.#meetingId, participantIds); this.#notify("meetings"); return r; }
  setSummoningParticipants(participantIds) { const r = meetingOps.setSummoningParticipants(this.#db, this.#meetingId, participantIds); this.#notify("meetings"); return r; }
  getMeeting() { return meetingOps.getMeeting(this.#db, this.#meetingId); }
  setNextSpeaker(nextSpeakerId) { const r = meetingOps.setNextSpeaker(this.#db, this.#meetingId, nextSpeakerId); this.#notify("meetings"); return r; }
  setStats(statsJson) { const r = meetingOps.setStats(this.#db, this.#meetingId, statsJson); this.#notify("meetings"); return r; }
  getOpencodeSessionId() { return meetingOps.getOpencodeSessionId(this.#db, this.#meetingId); }

  addContribution(meetingId, contribution) { const r = contribOps.addContribution(this.#db, meetingId, contribution, () => this.getRound()); this.#notify("contributions"); return r; }
  getContributions(meetingId) { return contribOps.getContributions(this.#db, meetingId); }
  getRecentContributions(meetingId, count) { return contribOps.getRecentContributions(this.#db, meetingId, count); }
  getContributionContext(contributionId) { return contribOps.getContributionContext(this.#db, contributionId); }
  addTurnRequest(meetingId, turnRequest) { const r = contribOps.addTurnRequest(this.#db, meetingId, turnRequest); this.#notify("turn_requests"); return r; }
  ensureParticipantRow(participantId, name = participantId, tier = "mid") { const r = contribOps.ensureParticipantRow(this.#db, this.#meetingId, participantId, name, tier); this.#notify("participants"); return r; }
  addContributionWithTurnRequest(meetingId, contribution, turnRequest) { const r = contribOps.addContributionWithTurnRequest(this.#db, meetingId, contribution, turnRequest, () => this.getRound()); this.#notify("contributions"); return r; }
  getTurnRequests(meetingId) { return contribOps.getTurnRequests(this.#db, meetingId); }
  getMaxContributionId() { return contribOps.getMaxContributionId(this.#db, this.#meetingId); }
  setParticipantSessionId(participantId, sessionId) { const r = contribOps.setParticipantSessionId(this.#db, this.#meetingId, participantId, sessionId); this.#notify("participants"); return r; }
  setParticipantStatus(participantId, status) { const r = contribOps.setParticipantStatus(this.#db, this.#meetingId, participantId, status); this.#notify("participants"); return r; }
  setParticipantReflection(participantId, reflection) { const r = contribOps.setParticipantReflection(this.#db, this.#meetingId, participantId, reflection); this.#notify("participants"); return r; }
  getParticipantStatus(participantId) { return contribOps.getParticipantStatus(this.#db, this.#meetingId, participantId); }
  getAllParticipantsWithStatus() { return contribOps.getAllParticipantsWithStatus(this.#db, this.#meetingId); }
  setRoundSummary(round, summary) { const r = contribOps.setRoundSummary(this.#db, this.#meetingId, round, summary); this.#notify("rounds"); return r; }
  getRoundSummaries(meetingId) { return contribOps.getRoundSummaries(this.#db, meetingId); }
  saveArtifact(artifact) { const r = contribOps.saveArtifact(this.#db, this.#meetingId, artifact); this.#notify("artifacts"); return r; }
  getArtifact(meetingId) { return contribOps.getArtifact(this.#db, meetingId); }
  recordAgentError(meetingId, participantId, round, errorType, errorMessage, attempts) { const r = contribOps.recordAgentError(this.#db, meetingId, participantId, round, errorType, errorMessage, attempts); this.#notify("agent_errors"); return r; }
  clearAgentErrors() { const r = contribOps.clearAgentErrors(this.#db, this.#meetingId); this.#notify("agent_errors"); return r; }
  getAgentErrors(meetingId) { return contribOps.getAgentErrors(this.#db, meetingId); }
  getTranscriptData(meetingId) { return contribOps.getTranscriptData(this.#db, meetingId, (id) => this.getRoundSummaries(id)); }
  getParticipantModel(participantId) { return contribOps.getParticipantModel(this.#db, this.#meetingId, participantId); }
  saveMeetingMetrics(metrics) { const r = contribOps.saveMeetingMetrics(this.#db, this.#meetingId, metrics); this.#notify("meeting_metrics"); return r; }
  getRecentMeetingMetrics(limit = 20) { return contribOps.getRecentMeetingMetrics(this.#db, limit); }

  storeFabricEmbedding(chunkId, embedding, dim = 384) { return vectorOps.storeFabricEmbedding(this.#db, chunkId, embedding, dim); }
  storeFabricChunk(content, round, source = "round_summary", vector = null) { return vectorOps.storeFabricChunk(this.#db, this.#meetingId, content, round, source, vector); }
  getFabricChunks() { return vectorOps.getFabricChunks(this.#db, this.#meetingId); }
  searchFabricVectors(queryEmbedding, topK = 5, dim = 384, excludeRound = -1) { return vectorOps.searchFabricVectors(this.#db, this.#meetingId, queryEmbedding, topK, dim, excludeRound); }
  storePersonaEmbedding(personaName, tier, tags, embeddingText, embedding, dim = 384) { return vectorOps.storePersonaEmbedding(this.#db, this.#meetingId, personaName, tier, tags, embeddingText, embedding, dim); }
  searchPersonaEmbeddings(queryEmbedding, tier, topK = 5, dim = 384) { return vectorOps.searchPersonaEmbeddings(this.#db, this.#meetingId, queryEmbedding, tier, topK, dim); }
  countPersonaEmbeddings() { return vectorOps.countPersonaEmbeddings(this.#db, this.#meetingId); }
  countPersonaVecEmbeddings(dim = 384) { return vectorOps.countPersonaVecEmbeddings(this.#db, this.#meetingId, dim); }
  clearPersonaEmbeddings() { return vectorOps.clearPersonaEmbeddings(this.#db, this.#meetingId); }
  getPersonaEmbeddingByName(personaName, dim = 384) { return vectorOps.getPersonaEmbeddingByName(this.#db, this.#meetingId, personaName, dim); }
  getPersonaEmbeddingsByNames(personaNames, dim = 384) { return vectorOps.getPersonaEmbeddingsByNames(this.#db, this.#meetingId, personaNames, dim); }

  createForumTopic({ title, body, tags, authorId }) {
    const r = forumOps.createTopic(this.#db, this.#meetingId, { title, body, tags, authorId });
    this.#notify("forum_topics");
    return r;
  }
  listForumTopics({ tag } = {}) { return forumOps.listTopics(this.#db, this.#meetingId, { tag }); }
  getForumTopic(topicId) { return forumOps.getTopic(this.#db, this.#meetingId, topicId); }
  addForumComment(topicId, { body, authorId }) {
    const r = forumOps.addComment(this.#db, this.#meetingId, topicId, { body, authorId });
    if (r) this.#notify("forum_comments");
    return r;
  }

  close() {
    try {
      if (this.#db?.closed === true) return;
    } catch {}
    try {
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (err) {
      dbLogger.debug("wal_checkpoint_failed", "WAL checkpoint on close failed", extractErrorInfo(err));
    }
    try { this.#db.close(); } catch {}
  }

  getDatabasePath() {
    try {
      if (this.#db?.closed) return this.#db.filename ?? this.#db.name ?? "closed";
    } catch {}
    return this.#db.filename ?? this.#db.name ?? "unknown";
  }

  checkpoint() {
    try {
      if (this.#db?.closed === true) return;
    } catch {}
    try {
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (err) {
      dbLogger.debug("wal_checkpoint_failed", "WAL checkpoint failed", extractErrorInfo(err));
    }
  }
}

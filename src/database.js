import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { Logger, extractErrorInfo } from "./logger.js";
import { initSchema, runMigrations } from "./database/schema.js";
import { resolveLoomBaseDir, getMeetingDbPath } from "./paths.js";
import { ensureDb, getDatabaseClass, isoNow, resolveVecPath } from "./database/connection.js";
import { maintenanceDue, markMaintained, checkIntegrity, cleanupOldErrors, initVectorTable } from "./database/maintenance.js";
import * as meetingOps from "./database/meeting-operations.js";
import * as contribOps from "./database/contribution-operations.js";
import * as vectorOps from "./database/vector-operations.js";
import { loadSessionIndex, indexMeeting as _indexMeeting, unindexMeeting as _unindexMeeting, getDatabasesBySessionId as _getDatabasesBySessionId } from "./database/session-index.js";

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

  static async withTransaction(dbPath, fn) {
    await ensureDb();
    const DatabaseClass = getDatabaseClass();
    const db = new DatabaseClass(dbPath);
    try {
      db.exec('BEGIN IMMEDIATE');
      const result = await fn(db);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch {}
      throw err;
    } finally {
      try { db.close(); } catch {}
    }
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
    const db = new DatabaseClass(dbPath);
    this.#db = db;
    const jm = this.#db.prepare("PRAGMA journal_mode = WAL").get();
    if (jm?.journal_mode !== "wal") dbLogger.warn("pragma_journal_mode_fallback", `journal_mode WAL not achieved (got ${jm?.journal_mode ?? "unknown"}) — concurrency reduced`, { journal_mode: jm?.journal_mode });
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec("PRAGMA busy_timeout = 5000");
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
    try {
      runMigrations(this.#db, { logger: dbLogger });
    } catch (err) {
      dbLogger.error("db_migration_failed", "Database migration failed — continuing with base schema", extractErrorInfo(err));
    }
    initVectorTable(this.#db);
    const shouldMaintain = existedBefore || process.env.LOOM_INTEGRITY_CHECK === '1'
      ? maintenanceDue(this.#db)
      : false;
    if (shouldMaintain) {
      cleanupOldErrors(this.#db);
      checkIntegrity(this.#db);
      markMaintained(this.#db);
    }
  }

  async transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn(this.#db);
      this.#db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.#db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }

  initializeMeeting(input) { return meetingOps.initializeMeeting(this.#db, this.#meetingId, input); }
  upsertMeeting(input) { return meetingOps.upsertMeeting(this.#db, this.#meetingId, input); }
  insertParticipants(participants) { return meetingOps.insertParticipants(this.#db, this.#meetingId, participants); }
  logError(context, message, details = null, severity = 'error') { return meetingOps.logError(this.#db, this.#meetingId, context, message, details, severity); }
  getErrorLog(meetingId) { return meetingOps.getErrorLog(this.#db, meetingId); }
  getFabric() { return meetingOps.getFabric(this.#db, this.#meetingId); }
  setFabric(fabric) { return meetingOps.setFabric(this.#db, this.#meetingId, fabric); }
  getStateOfPlay() { return meetingOps.getStateOfPlay(this.#db, this.#meetingId); }
  setStateOfPlay(stateOfPlay) { return meetingOps.setStateOfPlay(this.#db, this.#meetingId, stateOfPlay); }
  setSemanticDegraded(flag = true) { return meetingOps.setSemanticDegraded(this.#db, this.#meetingId, flag); }
  setPersistenceDegraded(flag = true) { return meetingOps.setPersistenceDegraded(this.#db, this.#meetingId, flag); }
  updateMeetingTags(meetingId, tags) { return meetingOps.updateMeetingTags(this.#db, meetingId, tags); }
  addOrchestratorMessage(msgType, role, content, round = null) { return meetingOps.addOrchestratorMessage(this.#db, this.#meetingId, msgType, role, content, round); }
  getOrchestratorMessages(meetingId) { return meetingOps.getOrchestratorMessages(this.#db, meetingId); }
  getMaxOrchestratorMessageId() { return meetingOps.getMaxOrchestratorMessageId(this.#db, this.#meetingId); }
  getRound() { return meetingOps.getRound(this.#db, this.#meetingId); }
  setRound(round) { return meetingOps.setRound(this.#db, this.#meetingId, round); }
  setMaxRounds(maxRounds) { return meetingOps.setMaxRounds(this.#db, this.#meetingId, maxRounds); }
  getStatus() { return meetingOps.getStatus(this.#db, this.#meetingId); }
  setStatus(status) { return meetingOps.setStatus(this.#db, this.#meetingId, status); }
  setReflectingParticipants(participantIds) { return meetingOps.setReflectingParticipants(this.#db, this.#meetingId, participantIds); }
  setQueryingParticipants(participantIds) { return meetingOps.setQueryingParticipants(this.#db, this.#meetingId, participantIds); }
  setEvidenceParticipants(participantIds) { return meetingOps.setEvidenceParticipants(this.#db, this.#meetingId, participantIds); }
  setSummoningParticipants(participantIds) { return meetingOps.setSummoningParticipants(this.#db, this.#meetingId, participantIds); }
  getMeeting() { return meetingOps.getMeeting(this.#db, this.#meetingId); }
  setNextSpeaker(nextSpeakerId) { return meetingOps.setNextSpeaker(this.#db, this.#meetingId, nextSpeakerId); }
  setStats(statsJson) { return meetingOps.setStats(this.#db, this.#meetingId, statsJson); }
  getOpencodeSessionId() { return meetingOps.getOpencodeSessionId(this.#db, this.#meetingId); }

  addContribution(meetingId, contribution) { return contribOps.addContribution(this.#db, meetingId, contribution, () => this.getRound()); }
  getContributions(meetingId) { return contribOps.getContributions(this.#db, meetingId); }
  getRecentContributions(meetingId, count) { return contribOps.getRecentContributions(this.#db, meetingId, count); }
  getContributionContext(contributionId) { return contribOps.getContributionContext(this.#db, contributionId); }
  addTurnRequest(meetingId, turnRequest) { return contribOps.addTurnRequest(this.#db, meetingId, turnRequest); }
  ensureParticipantRow(participantId, name = participantId, tier = "mid") { return contribOps.ensureParticipantRow(this.#db, this.#meetingId, participantId, name, tier); }
  addContributionWithTurnRequest(meetingId, contribution, turnRequest) { return contribOps.addContributionWithTurnRequest(this.#db, meetingId, contribution, turnRequest, () => this.getRound()); }
  getTurnRequests(meetingId) { return contribOps.getTurnRequests(this.#db, meetingId); }
  getMaxContributionId() { return contribOps.getMaxContributionId(this.#db, this.#meetingId); }
  setParticipantSessionId(participantId, sessionId) { return contribOps.setParticipantSessionId(this.#db, this.#meetingId, participantId, sessionId); }
  setParticipantStatus(participantId, status) { return contribOps.setParticipantStatus(this.#db, this.#meetingId, participantId, status); }
  setParticipantReflection(participantId, reflection) { return contribOps.setParticipantReflection(this.#db, this.#meetingId, participantId, reflection); }
  getParticipantStatus(participantId) { return contribOps.getParticipantStatus(this.#db, this.#meetingId, participantId); }
  getAllParticipantsWithStatus() { return contribOps.getAllParticipantsWithStatus(this.#db, this.#meetingId); }
  setRoundSummary(round, summary) { return contribOps.setRoundSummary(this.#db, this.#meetingId, round, summary); }
  getRoundSummaries(meetingId) { return contribOps.getRoundSummaries(this.#db, meetingId); }
  saveArtifact(artifact) { return contribOps.saveArtifact(this.#db, this.#meetingId, artifact); }
  getArtifact(meetingId) { return contribOps.getArtifact(this.#db, meetingId); }
  recordAgentError(meetingId, participantId, round, errorType, errorMessage, attempts) { return contribOps.recordAgentError(this.#db, meetingId, participantId, round, errorType, errorMessage, attempts); }
  getAgentErrors(meetingId) { return contribOps.getAgentErrors(this.#db, meetingId); }
  getTranscriptData(meetingId) { return contribOps.getTranscriptData(this.#db, meetingId, (id) => this.getRoundSummaries(id)); }
  getParticipantModel(participantId) { return contribOps.getParticipantModel(this.#db, this.#meetingId, participantId); }
  saveMeetingMetrics(metrics) { return contribOps.saveMeetingMetrics(this.#db, this.#meetingId, metrics); }
  getRecentMeetingMetrics(limit = 20) { return contribOps.getRecentMeetingMetrics(this.#db, limit); }

  storeFabricEmbedding(chunkId, embedding, dim = 384) { return vectorOps.storeFabricEmbedding(this.#db, chunkId, embedding, dim); }
  storeFabricChunk(content, round, source = "round_summary", vector = null) { return vectorOps.storeFabricChunk(this.#db, this.#meetingId, content, round, source, vector); }
  getFabricChunks() { return vectorOps.getFabricChunks(this.#db, this.#meetingId); }
  searchFabricVectors(queryEmbedding, topK = 5, dim = 384, excludeRound = -1) { return vectorOps.searchFabricVectors(this.#db, this.#meetingId, queryEmbedding, topK, dim, excludeRound); }
  storePersonaEmbedding(personaName, tier, tags, embeddingText, embedding, dim = 384) { return vectorOps.storePersonaEmbedding(this.#db, this.#meetingId, personaName, tier, tags, embeddingText, embedding, dim); }
  searchPersonaEmbeddings(queryEmbedding, tier, topK = 5, dim = 384) { return vectorOps.searchPersonaEmbeddings(this.#db, this.#meetingId, queryEmbedding, tier, topK, dim); }
  countPersonaEmbeddings() { return vectorOps.countPersonaEmbeddings(this.#db, this.#meetingId); }
  countPersonaVecEmbeddings(dim = 384) { return vectorOps.countPersonaVecEmbeddings(this.#db, dim); }
  clearPersonaEmbeddings() { return vectorOps.clearPersonaEmbeddings(this.#db, this.#meetingId); }
  getPersonaEmbeddingByName(personaName, dim = 384) { return vectorOps.getPersonaEmbeddingByName(this.#db, this.#meetingId, personaName, dim); }
  getPersonaEmbeddingsByNames(personaNames, dim = 384) { return vectorOps.getPersonaEmbeddingsByNames(this.#db, this.#meetingId, personaNames, dim); }

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

  checkpoint() {
    try {
      this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (err) {
      dbLogger.debug("wal_checkpoint_failed", "WAL checkpoint failed", extractErrorInfo(err));
    }
  }
}

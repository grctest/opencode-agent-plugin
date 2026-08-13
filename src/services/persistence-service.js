import { isoNow } from "../database.js";
import { Logger } from "../logger.js";

/**
 * Handles all database persistence operations for a meeting.
 * Provides transactional guarantees for multi-write operations.
 */
export class PersistenceService {
  /** @type {import("../database.js").MeetingDatabase} */
  #db;
  /** @type {string} */
  #meetingId;
  /** @type {import("../logger.js").Logger} */
  #logger;

  /**
   * @param {MeetingDatabase} db
   * @param {string} meetingId
   */
  constructor(db, meetingId) {
    this.#db = db;
    this.#meetingId = meetingId;
    this.#logger = new Logger().forMeeting(meetingId);
  }

  /**
   * Persists the complete meeting state atomically.
   * @param {Object} sharedState
   * @param {string} nextSpeakerId
   * @param {Object} stats
   */
   async persistState(sharedState, nextSpeakerId, stats) {
    await this.#db.transaction(async (db) => {
      db.prepare("UPDATE meetings SET warp = ?, updated_at = ? WHERE id = ?")
        .run(sharedState.warp, isoNow(), this.#meetingId);
      db.prepare("UPDATE meetings SET round = ?, updated_at = ? WHERE id = ?")
        .run(sharedState.round, isoNow(), this.#meetingId);
      db.prepare("UPDATE meetings SET status = ?, updated_at = ? WHERE id = ?")
        .run(sharedState.status, isoNow(), this.#meetingId);
      db.prepare("UPDATE meetings SET next_speaker_id = ? WHERE id = ?")
        .run(nextSpeakerId ?? null, this.#meetingId);
      db.prepare("UPDATE meetings SET stats = ? WHERE id = ?")
        .run(stats ? JSON.stringify(stats) : null, this.#meetingId);
    });
   }

   /**
    * Persists max_rounds to the database.
    * @param {number} maxRounds
    */
   persistMaxRounds(maxRounds) {
     this.#db.setMaxRounds(maxRounds);
   }

  /**
   * Persists round summary.
   * @param {number} round
   * @param {string} summary
   */
  persistRoundSummary(round, summary) {
    this.#db.setRoundSummary(round, summary);
  }

  /**
   * Persists meeting artifact.
   * @param {Object} artifact
   */
  persistArtifact(artifact) {
    this.#db.saveArtifact(artifact);
  }

  /**
   * Persists participant status.
   * @param {string} participantId
   * @param {string} status
   */
  persistParticipantStatus(participantId, status) {
    this.#db.setParticipantStatus(participantId, status);
  }

  /**
   * Persists participant session ID.
   * @param {string} participantId
   * @param {string} sessionId
   */
  persistParticipantSessionId(participantId, sessionId) {
    this.#db.setParticipantSessionId(participantId, sessionId);
  }

  /**
   * Persists participant reflection.
   * @param {string} participantId
   * @param {string} reflection
   */
  persistParticipantReflection(participantId, reflection) {
    this.#db.setParticipantReflection(participantId, reflection);
  }

  /**
   * Logs an error to the database.
   * @param {string} context
   * @param {string} message
   * @param {Object} details
   * @param {string} severity
   */
  logError(context, message, details = null, severity = 'error') {
    this.#db.logError(context, message, details, severity);
  }

  /**
   * Records an agent error.
   * @param {string} participantId
   * @param {number} round
   * @param {string} errorType
   * @param {string} errorMessage
   * @param {number} attempts
   */
  recordAgentError(participantId, round, errorType, errorMessage, attempts) {
    this.#db.recordAgentError(this.#meetingId, participantId, round, errorType, errorMessage, attempts);
  }
}
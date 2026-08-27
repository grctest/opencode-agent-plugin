import { isoNow } from "../database.js";
import { Logger } from "../logger.js";

/**
 * Handles all database persistence operations for a meeting.
 * persistState() is transactional; single-row helpers are atomic by nature.
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
   * Persists the complete meeting state atomically (including max_rounds for crash consistency).
   * @param {Object} sharedState
   * @param {string} nextSpeakerId
   * @param {Object} stats
   * @param {number} [maxRounds] - when provided, persisted in same txn
   */
   async persistState(sharedState, nextSpeakerId, stats, maxRounds = null) {
    await this.#db.transaction(async (db) => {
      const now = isoNow();
      if (maxRounds != null) {
        db.prepare("UPDATE meetings SET fabric = ?, round = ?, status = ?, next_speaker_id = ?, stats = ?, max_rounds = ?, updated_at = ? WHERE id = ?")
          .run(sharedState.fabric, sharedState.round, sharedState.status, nextSpeakerId ?? null, stats ? JSON.stringify(stats) : null, maxRounds, now, this.#meetingId);
      } else {
        db.prepare("UPDATE meetings SET fabric = ?, round = ?, status = ?, next_speaker_id = ?, stats = ?, updated_at = ? WHERE id = ?")
          .run(sharedState.fabric, sharedState.round, sharedState.status, nextSpeakerId ?? null, stats ? JSON.stringify(stats) : null, now, this.#meetingId);
      }
    });
   }

   /**
    * Persists max_rounds to the database.
    * @param {number} maxRounds
    * @deprecated Use persistState with maxRounds param for atomicity; kept for compat
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
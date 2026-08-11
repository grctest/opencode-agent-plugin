/**
 * @typedef {Object} DashboardState
 * @property {string} meeting_id
 * @property {string} question
 * @property {string} context
 * @property {string} status
 * @property {number} round
 * @property {number} max_rounds
 * @property {string} convergence
 * @property {string} warp
 */

/**
 * @typedef {Object} Participant
 * @property {string} id
 * @property {string} name
 * @property {string} persona
 * @property {string} agenda
 * @property {string} tier
 * @property {string | null} provider_id
 * @property {string | null} model_id
 * @property {string | null} session_id
 */

/**
 * @typedef {Object} Contribution
 * @property {number} id
 * @property {string} participant_id
 * @property {number} round
 * @property {string} type
 * @property {string} content
 * @property {number | null} confidence
 * @property {string} created_at
 */

/**
 * @typedef {Object} Interjection
 * @property {number} id
 * @property {string} participant_id
 * @property {string | null} target_participant_id
 * @property {string} content
 * @property {number} priority
 * @property {number} granted
 * @property {string | null} pushback
 * @property {string} resolved
 * @property {string} created_at
 */

/**
 * @typedef {Object} MeetingSummary
 * @property {string} meeting_id
 * @property {string} question
 * @property {string} status
 * @property {number} round
 * @property {number} max_rounds
 * @property {string} convergence
 * @property {number} participant_count
 */

/**
 * @typedef {Object} MeetingEvent
 * @property {"state" | "contribution" | "interjection" | "participant"} type
 * @property {unknown} data
 * @property {string} timestamp
 */

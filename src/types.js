/** Participant tier — determines behavior, rights, and model selection. Any string is valid. */

/** @typedef {string} Tier */
/** @typedef {string} ProviderID */
/** @typedef {string} ModelID */
/** @typedef {any} Client */

/** Signature for sending a prompt to an LLM and receiving a text response. */
/** @typedef {(system: string, model: { providerID: ProviderID; modelID: ModelID }, message: string) => Promise<string>} PromptFn */

/** @typedef {"propose" | "challenge" | "refine" | "support" | "dissent" | "synthesize" | "question" | "interjection"} ContributionType */

/** Deliberation rights granted to a participant based on their tier. */
/**
 * @typedef {Object} TierRights
 * @property {boolean} contribute
 * @property {boolean} interject
 * @property {boolean} call_vote
 * @property {boolean} veto
 * @property {boolean} force_end
 */

/** Model configuration for a participant tier. */
/**
 * @typedef {Object} TierModelConfig
 * @property {string} model
 * @property {number} temperature
 * @property {"low" | "medium" | "high" | undefined} reasoning_effort
 */

/** Complete tier config combining model settings, behavioral guidance, and rights. */
/**
 * @typedef {Object} TierConfig
 * @property {string} model
 * @property {number} temperature
 * @property {"low" | "medium" | "high" | undefined} reasoning_effort
 * @property {string} system_prompt_addendum
 * @property {TierRights} rights
 */

/** Maps a provider/model pair to a specific tier. */
/**
 * @typedef {Object} ModelAssignment
 * @property {string} providerID
 * @property {string} modelID
 * @property {string} [modelName]
 */

/** Static configuration for a meeting participant. */
/**
 * @typedef {Object} ParticipantConfig
 * @property {string} id
 * @property {string} name
 * @property {string} persona
 * @property {string} agenda
 * @property {Tier} tier
 * @property {ModelAssignment} [model]
 * @property {string} [reason]
 * @property {string} [domain]
 */

/** A reusable persona template for composing deliberation rooms. */
/**
 * @typedef {Object} Persona
 * @property {string} name
 * @property {string} persona
 * @property {string} agenda
 * @property {string} domain
 * @property {string[]} expertise
 */

/** A single contribution from a participant during deliberation. */
/**
 * @typedef {Object} Contribution
 * @property {string} participant_id
 * @property {string} content
 * @property {ContributionType} type
 * @property {string | null} targets_which
 * @property {number} timestamp
 */

/** A request from a participant to interrupt the normal speaking order. */
/**
 * @typedef {Object} Interjection
 * @property {string} participant_id
 * @property {number} priority
 * @property {string} reason
 * @property {boolean} granted
 * @property {string | null} pushback
 * @property {"pending" | "granted" | "denied" | "contested"} resolved
 */

/** Record of a single deliberation round. */
/**
 * @typedef {Object} Round
 * @property {number} number
 * @property {Contribution[]} contributions
 * @property {Interjection[]} interjections
 * @property {string[]} token_path
 * @property {string} summary
 */

/** Transcript data reconstructed from the database for synthesis. */
/**
 * @typedef {Object} TranscriptRound
 * @property {number} number
 * @property {Contribution[]} contributions
 * @property {Interjection[]} interjections
 * @property {string} summary
 */

/** Full transcript data for the synthesizer. */
/**
 * @typedef {Object} TranscriptData
 * @property {TranscriptRound[]} rounds
 * @property {string} warp
 * @property {string} question
 */

/** An unresolved objection raised during deliberation. */
/**
 * @typedef {Object} Objection
 * @property {string} participant_id
 * @property {string} content
 * @property {boolean} unresolved
 */

/** The synthesized output of a completed deliberation. */
/**
 * @typedef {Object} Artifact
 * @property {string} content
 * @property {"markdown" | "json" | "text"} format
 * @property {string[]} decisions
 * @property {string[]} action_items
 * @property {Objection[]} dissent
 * @property {string[]} open_questions
 * @property {"high" | "medium" | "low"} confidence
 */

/** @typedef {"initializing" | "waiting_for_user" | "weaving" | "converged" | "deadlocked" | "max_rounds_reached" | "aborted" | "cancelled" | "timeout"} LoomStatus */

/** Runtime state of a participant during deliberation. */
/**
 * @typedef {Object} ParticipantState
 * @property {ParticipantConfig} config
 * @property {TierConfig} tier_config
 * @property {string} session_id
 * @property {"listening" | "speaking" | "interjecting" | "passed" | "failed"} status
 * @property {string} reflection
 * @property {number} contributions_count
 * @property {string} [reason]
 */

/** Complete runtime state of a Loom deliberation meeting. */
/**
 * @typedef {Object} LoomState
 * @property {string} id
 * @property {string} parent_session_id
 * @property {string} question
 * @property {string} context
 * @property {ParticipantState[]} participants
 * @property {string} warp
 * @property {Contribution[]} weft
 * @property {Round[]} rounds
 * @property {number} current_round
 * @property {number} max_rounds
 * @property {number} current_speaker_idx
 * @property {LoomStatus} status
 * @property {Artifact | null} artifact
 * @property {Objection[]} objections
 * @property {"consensus" | "majority" | "moderator_forces"} convergence_mode
 */

/** Output of the room composition process. */
/**
 * @typedef {Object} RoomRecommendation
 * @property {ParticipantConfig[]} participants
 * @property {number} estimated_rounds
 * @property {string} reasoning
 */

/** Parsed response from an agent after a deliberation turn. */
/**
 * @typedef {Object} AgentResponse
 * @property {string} participant_id
 * @property {string} content
 * @property {ContributionType} type
 * @property {{ priority: number; reason: string } | null} interjection
 */

/** Shared state persisted to files for cross-session communication. */
/**
 * @typedef {Object} SharedMeetingState
 * @property {string} meeting_id
 * @property {number} round
 * @property {string} warp
 * @property {string} question
 * @property {Contribution[]} contributions
 * @property {Interjection[]} interjections
 * @property {LoomStatus} status
 */

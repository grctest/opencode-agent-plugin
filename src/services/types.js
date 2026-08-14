/**
 * Shared JSDoc typedefs for the Loom service layer.
 * These are documentation-only types (no runtime code) that give editors
 * and tooling full type coverage across the services directory.
 *
 * @typedef {Object} ModelRef
 * @property {string} providerID
 * @property {string} modelID
 */

/**
 * @typedef {Object} ParticipantConfig
 * @property {string} id
 * @property {string} name
 * @property {string} persona
 * @property {string} agenda
 * @property {'junior'|'mid'|'senior'|'principal'} tier
 * @property {ModelRef} [model] - Explicit per-participant model override
 * @property {string} [model_override] - "provider/model" string override
 * @property {string} [domain]
 * @property {string[]} [domains]
 * @property {string[]} [known_biases]
 * @property {string} [communication_style]
 * @property {string[]} [preferred_contribution_types]
 */

/**
 * @typedef {Object} TierConfig
 * @property {number} temperature
 * @property {Object} rights
 * @property {boolean} rights.contribute
 * @property {boolean} rights.interject
 * @property {boolean} rights.call_vote
 * @property {boolean} rights.veto
 * @property {boolean} rights.force_end
 */

/**
 * @typedef {Object} ParticipantState
 * @property {ParticipantConfig} config
 * @property {TierConfig} tier_config
 * @property {string} session_id
 * @property {number} [session_version]
 * @property {'listening'|'speaking'|'passed'|'failed'} status
 * @property {string} reflection - Single evolving belief state (replaces prior reflection each round)
 * @property {number} contributions_count
 */

/**
 * @typedef {Object} Contribution
 * @property {number} id
 * @property {string} participant_id
 * @property {number} round
 * @property {string} type
 * @property {string} content
 * @property {string|null} targets_which
 * @property {string} created_at ISO-8601 timestamp
 */

/**
 * @typedef {Object} GovernanceDirective
 * @property {'extend_rounds'|'force_converge'|'raise_objection'|'request_topic'|'nominate_synthesizer'|'escalate'} directive
 * @property {number|string} [value]
 * @property {string} [reason]
 */

/**
 * @typedef {Object} TurnRequest
 * @property {string} participant_id
 * @property {string} target - Target participant ID or "Self"
 * @property {number} priority
 * @property {string} reason
 */

/**
 * @typedef {Object} Round
 * @property {number} number
 * @property {Contribution[]} contributions
 * @property {TurnRequest[]} turn_requests
 * @property {GovernanceDirective[]} [governance]
 * @property {string[]} token_path
 * @property {string} summary
 */

/**
 * @typedef {Object} MeetingState
 * @property {string} id
 * @property {string} question
 * @property {string} context
 * @property {ParticipantState[]} participants
 * @property {string} fabric
 * @property {Contribution[]} weave
 * @property {Round[]} rounds
 * @property {number} current_round
 * @property {number} max_rounds
 * @property {'initializing'|'weaving'|'converged'|'cancelled'|'timeout'|'max_rounds_reached'|'aborted'|'deadlocked'} status
 * @property {Object|null} artifact
 * @property {Object[]} objections
 * @property {'consensus'|'majority'|'moderator_forces'} convergence_mode
 * @property {string|null} domain
 * @property {number} next_contribution_id
 */

/**
 * @typedef {Object} AvailableModel
 * @property {string} providerID
 * @property {string} modelID
 * @property {string} name
 * @property {string} status
 * @property {{input:number, output:number}} cost
 * @property {{context:number, output:number}} limit
 * @property {boolean} reasoning
 * @property {boolean} temperature
 */

export {};

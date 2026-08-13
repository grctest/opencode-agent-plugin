import { getTierConfig } from "../shared.js";
import { Logger } from "../logger.js";

/**
 * Manages in-memory meeting state with validated transitions.
 * Encapsulates all state mutations to ensure consistency.
 */
export class StateManager {
  /** @type {Object} */
  #state;
  /** @type {import("../logger.js").Logger} */
  #logger;

  /**
   * @param {Object} initialState
   * @param {string} initialState.id
   * @param {string} initialState.question
   * @param {string} initialState.context
   * @param {Array} initialState.participants
   * @param {string} initialState.warp
   * @param {Array} initialState.weft
   * @param {Array} initialState.rounds
   * @param {number} initialState.current_round
   * @param {number} initialState.max_rounds
   * @param {number} initialState.current_speaker_idx
   * @param {string} initialState.status
   * @param {Object|null} initialState.artifact
   * @param {Array} initialState.objections
   * @param {string} initialState.convergence_mode
   * @param {string|null} initialState.domain
   * @param {number} initialState.next_contribution_id
   * @param {Object} [initialState.parent_session_id]
   * @param {Object} [initialState.opencode_session_id]
   */
  constructor(initialState) {
    this.#state = initialState;
    this.#logger = new Logger().forMeeting(initialState.id);
  }

  getState() {
    return Object.freeze({ ...this.#state });
  }

  getMutableState() {
    return this.#state;
  }

  getParticipants() {
    return this.#state.participants;
  }

  getParticipant(id) {
    return this.#state.participants.find(p => p.config.id === id);
  }

  getActiveParticipants() {
    return this.#state.participants.filter(p => p.status !== "passed" && p.status !== "failed");
  }

  getPassedCount() {
    return this.#state.participants.filter(p => p.status === "passed").length;
  }

  getActiveCount() {
    return this.getActiveParticipants().length;
  }

  getTotalParticipants() {
    return this.#state.participants.length;
  }

  getCurrentRound() {
    return this.#state.current_round;
  }

  getMaxRounds() {
    return this.#state.max_rounds;
  }

  getStatus() {
    return this.#state.status;
  }

  getWarp() {
    return this.#state.warp;
  }

  getWeft() {
    return this.#state.weft;
  }

  getRounds() {
    return this.#state.rounds;
  }

  getConvergenceMode() {
    return this.#state.convergence_mode;
  }

  getMeetingId() {
    return this.#state.id;
  }

  getQuestion() {
    return this.#state.question;
  }

  getContext() {
    return this.#state.context;
  }

  getDomain() {
    return this.#state.domain;
  }

  getNextSpeakerId() {
    return this.#state.next_speaker_id;
  }

  setNextSpeakerId(id) {
    this.#state.next_speaker_id = id ?? null;
  }

  transitionTo(status) {
    const validTransitions = {
      initializing: ["weaving", "cancelled"],
      weaving: ["converged", "cancelled", "timeout", "max_rounds_reached"],
      converged: [],
      cancelled: [],
      timeout: [],
      max_rounds_reached: [],
    };
    const current = this.#state.status;
    if (validTransitions[current] && !validTransitions[current].includes(status)) {
      this.#logger.warn("invalid_transition", `Invalid status transition: ${current} -> ${status}`);
    }
    this.#state.status = status;
    this.#logger.info("state_transition", `${current} -> ${status}`);
  }

  incrementRound() {
    this.#state.current_round++;
    this.#logger.debug("round_increment", `Round ${this.#state.current_round}`);
  }

  setMaxRounds(max) {
    this.#state.max_rounds = max;
  }

  addContribution(contribution) {
    this.#state.weft.push(contribution);
  }

  addRound(round) {
    this.#state.rounds.push(round);
  }

  setWarp(warp) {
    this.#state.warp = warp;
  }

  setArtifact(artifact) {
    this.#state.artifact = artifact;
  }

  setObjections(objections) {
    this.#state.objections = objections;
  }

  setDomain(domain) {
    this.#state.domain = domain;
  }

  setParticipantStatus(participantId, status) {
    const p = this.getParticipant(participantId);
    if (p) {
      p.status = status;
    }
  }

  setParticipantSessionId(participantId, sessionId) {
    const p = this.getParticipant(participantId);
    if (p) {
      p.session_id = sessionId;
    }
  }

  incrementParticipantContributions(participantId) {
    const p = this.getParticipant(participantId);
    if (p) {
      p.contributions_count++;
    }
  }

  addParticipantReflection(participantId, reflection) {
    const p = this.getParticipant(participantId);
    if (p) {
      if (!Array.isArray(p.reflections)) p.reflections = [];
      p.reflections.push(reflection);
      p.reflections = p.reflections.slice(-2); // MAX_REFLECTIONS
    }
  }

  getNextContributionId() {
    return ++this.#state.next_contribution_id;
  }

  buildSharedState() {
    return {
      meeting_id: this.#state.id,
      round: this.#state.current_round,
      warp: this.#state.warp,
      question: this.#state.question,
      contributions: this.#state.weft,
      status: this.#state.status,
    };
  }

  /**
   * Reorders active participants so the next speaker is first.
   * @param {string} nextSpeakerId
   */
  reorderForNextSpeaker(nextSpeakerId) {
    const active = this.getActiveParticipants();
    const idx = active.findIndex(p => p.config.id === nextSpeakerId);
    if (idx > 0) {
      const [speaker] = active.splice(idx, 1);
      // Rebuild the full participants array with reordered active participants
      const passive = this.#state.participants.filter(p => p.status === "passed" || p.status === "failed");
      this.#state.participants = [...active, ...passive];
    }
    this.#state.next_speaker_id = null;
  }
}
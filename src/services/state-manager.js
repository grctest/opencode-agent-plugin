import { getTierConfig } from "../shared.js";
import { Logger } from "../logger.js";
import { getConfig } from "../config.js";

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
   * @param {string} initialState.fabric
   * @param {Array} initialState.weave
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
    // Deep-freeze to prevent callers from mutating nested arrays/objects
    const frozen = Object.freeze({
      ...this.#state,
      participants: Object.freeze(this.#state.participants.map((p) => Object.freeze({ ...p }))),
      weave: Object.freeze([...this.#state.weave]),
      rounds: Object.freeze(this.#state.rounds.map((r) => Object.freeze({ ...r }))),
    });
    return frozen;
  }

  getMutableState() {
    this.#logger.warn("deprecated_api", "getMutableState() is deprecated — use targeted mutators instead");
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

  getFabric() {
    return this.#state.fabric;
  }

  getWeave() {
    return this.#state.weave;
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

  getStateOfPlay() {
    return this.#state.state_of_play ?? "";
  }

  getNextSpeakerId() {
    return this.#state.next_speaker_id;
  }

  setNextSpeakerId(id) {
    this.#state.next_speaker_id = id ?? null;
  }

  transitionTo(status) {
    const validTransitions = {
      initializing: ["weaving", "cancelled", "aborted"],
      weaving: ["converged", "cancelled", "timeout", "max_rounds_reached", "aborted", "deadlocked"],
      converged: [],
      cancelled: [],
      timeout: [],
      max_rounds_reached: [],
      aborted: [],
      deadlocked: [],
    };
    const current = this.#state.status;
    if (current === status) {
      this.#logger.debug("state_transition", `No-op transition (already ${status})`);
      return;
    }
    const allowed = validTransitions[current];
    if (!allowed || !allowed.includes(status)) {
      this.#logger.error("invalid_transition", `Invalid status transition rejected: ${current} -> ${status}`);
      throw new Error(`Invalid status transition: ${current} -> ${status}`);
    }
    this.#state.status = status;
    this.#logger.info("state_transition", `${current} -> ${status}`);
  }

  /**
   * Applies a status change without transition validation.
   * Reserved for explicit escape hatches (e.g. re-opening a terminal meeting).
   * @param {string} status
   */
  forceTransitionTo(status) {
    const current = this.#state.status;
    if (current === status) return;
    this.#state.status = status;
    this.#logger.info("state_transition", `${current} -> ${status} (forced)`);
  }

  incrementRound() {
    this.#state.current_round++;
    this.#logger.debug("round_increment", `Round ${this.#state.current_round}`);
  }

  setMaxRounds(max) {
    this.#state.max_rounds = max;
  }

  addContribution(contribution) {
    this.#state.weave.push(contribution);
  }

  /** Increments and returns the next contribution ID. */
  nextContributionId() {
    return ++this.#state.next_contribution_id;
  }

  /** Returns the current contribution ID without incrementing. */
  getCurrentContributionId() {
    return this.#state.next_contribution_id;
  }

  addRound(round) {
    this.#state.rounds.push(round);
  }

  /** Replaces all rounds (used during restore). */
  setRounds(rounds) {
    this.#state.rounds = rounds;
  }

  /** Updates contribution counts for all participants from a count map. */
  setParticipantContributionCounts(countMap) {
    for (const p of this.#state.participants) {
      p.contributions_count = countMap[p.config.id] ?? 0;
    }
  }

  setFabric(fabric) {
    this.#state.fabric = fabric;
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

  setStateOfPlay(stateOfPlay) {
    this.#state.state_of_play = stateOfPlay;
  }

  /**
   * Restores all mutable state properties from a database-loaded meeting.
   * Used by the orchestrator when resuming a persisted meeting.
   */
  restore({ participants, question, context, fabric, max_rounds, convergence_mode, domain, current_round, status, weave, next_contribution_id, state_of_play }) {
    if (participants !== undefined) this.#state.participants = participants;
    if (question !== undefined) this.#state.question = question;
    if (context !== undefined) this.#state.context = context;
    if (fabric !== undefined) this.#state.fabric = fabric;
    if (max_rounds !== undefined) this.#state.max_rounds = max_rounds;
    if (convergence_mode !== undefined) this.#state.convergence_mode = convergence_mode;
    if (domain !== undefined) this.#state.domain = domain;
    if (current_round !== undefined) this.#state.current_round = current_round;
    if (status !== undefined) this.#state.status = status;
    if (weave !== undefined) this.#state.weave = weave;
    if (next_contribution_id !== undefined) this.#state.next_contribution_id = next_contribution_id;
    if (state_of_play !== undefined) this.#state.state_of_play = state_of_play;
  }

  setParticipantStatus(participantId, status) {
    const p = this.getParticipant(participantId);
    if (p) {
      p.status = status;
    } else {
      this.#logger.warn("participant_not_found", `setParticipantStatus: unknown participant "${participantId}"`);
    }
  }

  setParticipantSessionId(participantId, sessionId) {
    const p = this.getParticipant(participantId);
    if (p) {
      p.session_id = sessionId;
    } else {
      this.#logger.warn("participant_not_found", `setParticipantSessionId: unknown participant "${participantId}"`);
    }
  }

  incrementParticipantContributions(participantId) {
    const p = this.getParticipant(participantId);
    if (p) {
      p.contributions_count++;
    } else {
      this.#logger.warn("participant_not_found", `incrementParticipantContributions: unknown participant "${participantId}"`);
    }
  }

  setParticipantSessionVersion(participantId, version) {
    const p = this.getParticipant(participantId);
    if (p) {
      p.session_version = version;
    } else {
      this.#logger.warn("participant_not_found", `setParticipantSessionVersion: unknown participant "${participantId}"`);
    }
  }

  addParticipantReflection(participantId, reflection) {
    const p = this.getParticipant(participantId);
    if (p) {
      if (!Array.isArray(p.reflections)) p.reflections = [];
      p.reflections.push(reflection);
      p.reflections = p.reflections.slice(-getConfig().maxReflectionsPerAgent);
    } else {
      this.#logger.warn("participant_not_found", `addParticipantReflection: unknown participant "${participantId}"`);
    }
  }

  buildSharedState() {
    return {
      meeting_id: this.#state.id,
      round: this.#state.current_round,
      fabric: this.#state.fabric,
      question: this.#state.question,
      contributions: this.#state.weave,
      status: this.#state.status,
      state_of_play: this.#state.state_of_play ?? "",
    };
  }

  /**
   * Reorders active participants so the next speaker is first.
   * @param {string} nextSpeakerId
   */
  reorderForNextSpeaker(nextSpeakerId) {
    const idx = this.#state.participants.findIndex(p => p.config.id === nextSpeakerId);
    if (idx > 0) {
      const [speaker] = this.#state.participants.splice(idx, 1);
      this.#state.participants.unshift(speaker);
    }
    this.#state.next_speaker_id = null;
  }
}
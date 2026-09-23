import { getTierConfig } from "../shared.js";
import { Logger } from "../logger.js";
import { getConfig } from "../config.js";
import { emptyAgentState } from "../state-patch.js";

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * Manages in-memory meeting state with validated transitions.
 * Encapsulates all state mutations to ensure consistency.
 */
export class StateManager {
  /** @type {Object} */
  #state;
  /** @type {import("../logger.js").Logger} */
  #logger;
  #activeTurn = null;
  #lastTurnPatch = null;

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
   * @param {Array} initialState.tags
   * @param {number} initialState.next_contribution_id
   * @param {Object} [initialState.parent_session_id]
   * @param {Object} [initialState.opencode_session_id]
   */
  constructor(initialState) {
    this.#state = initialState;
    this.#logger = new Logger().forMeeting(initialState.id);
    // SKILL.state per-agent execution states (plan §5.7): id -> AgentState.
    // Owned exclusively by each agent's own loom_state_patch calls; never shared-write.
    this.participantStates = new Map();
    this.stateDirty = new Set();
  }

  beginTurn(participantId) {
    if (this.#lastTurnPatch?.participantId === participantId) this.#lastTurnPatch = null;
    this.#activeTurn = { participantId, patchApplied: false, passRequested: false, toolCount: 0, pendingPatch: null };
  }

  endTurn() {
    if (this.#activeTurn?.pendingPatch) {
      this.#lastTurnPatch = structuredClone(this.#activeTurn.pendingPatch);
    }
    this.#activeTurn = null;
  }

  getActiveTurn() {
    return this.#activeTurn ? { ...this.#activeTurn } : null;
  }

  markTurnPatchApplied() {
    if (this.#activeTurn) this.#activeTurn.patchApplied = true;
  }

  markTurnPassRequested() {
    if (this.#activeTurn) this.#activeTurn.passRequested = true;
  }

  getTurnToolCount() {
    return this.#activeTurn?.toolCount ?? 0;
  }

  recordTurnTool() {
    if (this.#activeTurn) this.#activeTurn.toolCount += 1;
  }

  queueTurnPatch(participantId, patch) {
    if (this.#activeTurn?.participantId !== participantId || this.#activeTurn.patchApplied || this.#activeTurn.pendingPatch) return false;
    this.#activeTurn.pendingPatch = structuredClone(patch);
    return true;
  }

  getLastTurnPatch(participantId) {
    if (this.#lastTurnPatch?.participantId !== participantId) return null;
    return structuredClone(this.#lastTurnPatch);
  }

  takeLastTurnPatch(participantId) {
    if (this.#lastTurnPatch?.participantId !== participantId) return null;
    const patch = structuredClone(this.#lastTurnPatch);
    this.#lastTurnPatch = null;
    return patch;
  }

  discardLastTurnPatch(participantId) {
    if (this.#lastTurnPatch?.participantId === participantId) this.#lastTurnPatch = null;
  }

  discardActiveTurnPatch() {
    if (!this.#activeTurn) return;
    this.#activeTurn.pendingPatch = null;
    this.#activeTurn.patchApplied = false;
  }

  /** Lazily initializes and returns a clone of agent id's Σⁱ (Σ_0 when absent). */
  getParticipantState(id) {
    const existing = this.participantStates.get(id);
    if (existing) {
      const clone = structuredClone(existing);
      // A perspective query (§5.7) writes the responder's new position into the
      // legacy `reflection` field and marks the state dirty. Until the agent's
      // next loom_state_patch overwrites stance, surface that fresh position in
      // the own-state block so the one-turn lag is not a blind spot.
      if (this.stateDirty.has(id)) {
        try {
          const p = this.getParticipant(id);
          const fresh = typeof p?.reflection === "string" ? p.reflection.trim() : "";
          if (fresh) clone.stance = fresh.slice(0, 400);
        } catch {}
      }
      return clone;
    }
    // Seed from legacy reflection when available (fallback reconciliation, §5.7)
    let seed = null;
    try {
      const p = this.getParticipant(id);
      if (p?.reflection && typeof p.reflection === "string" && p.reflection.trim()) {
        seed = {
          stance: p.reflection.trim().slice(0, 400),
          established: [], contested: [], open: [], facts: [], files: [],
          version: 0, updated_round: this.#state.current_round ?? 0,
          updated_contribution_id: null, rebuilt: true,
        };
      }
    } catch {}
    if (!seed) {
      seed = emptyAgentState();
    }
    this.participantStates.set(id, structuredClone(seed));
    this._mirrorStateToParticipant(id, seed);
    return structuredClone(seed);
  }

  /** Stores a clone of agent id's Σⁱ (caller guarantees ownership). */
  setParticipantState(id, next) {
    this.participantStates.set(id, structuredClone(next));
    this.stateDirty.delete(id);
    this._mirrorStateToParticipant(id, next);
  }

  /** Mirrors stance/version/top-bullets onto the participant row for peer prompts
   *  (single position line, §5.9) and synthesis/dashboard read-views. */
  _mirrorStateToParticipant(id, state) {
    try {
      const p = this.getParticipant(id);
      if (!p || !state) return;
      p.state_stance = typeof state.stance === "string" ? state.stance : "";
      p.state_version = Number.isFinite(state.version) ? state.version : 0;
      const bullets = [
        ...(state.established ?? []).slice(0, 1),
        ...(state.contested ?? []).slice(0, 1),
        ...(state.open ?? []).slice(0, 1),
        ...(state.facts ?? []).slice(0, 1),
      ].filter(Boolean).slice(0, 4);
      p.state_bullets = bullets;
    } catch {}
  }

  /** Links Σⁱ to the contribution that produced it (post-store, best-effort). */
  linkStateToContribution(id, contributionId) {
    const s = this.participantStates.get(id);
    if (!s) return;
    s.updated_contribution_id = contributionId;
    this.participantStates.set(id, s);
  }

  /** All states with holder attribution for SoP aggregation + synthesis. */
  getAllParticipantStates() {
    const out = [];
    for (const p of this.#state.participants) {
      const s = this.participantStates.get(p.config.id);
      out.push({
        id: p.config.id,
        name: p.config.name ?? p.config.id,
        tier: p.config.tier ?? "",
        state: s ? structuredClone(s) : this.getParticipantState(p.config.id),
      });
    }
    return out;
  }

  getParticipantStateSnapshots() {
    return deepFreeze(this.#state.participants.map((p) => ({
      id: p.config.id,
      name: p.config.name ?? p.config.id,
      tier: p.config.tier ?? "",
      status: p.status ?? "",
      state: this.getParticipantState(p.config.id),
      projected: this.stateDirty.has(p.config.id),
    })));
  }

  /** Bulk-load states (resume/extension path). */
  restoreParticipantStates(list) {
    if (!Array.isArray(list)) return;
    for (const { participant_id, state } of list) {
      if (!participant_id || !state) continue;
      this.participantStates.set(participant_id, structuredClone(state));
      this._mirrorStateToParticipant(participant_id, state);
    }
  }

  /** Marks a responder dirty after a perspective answer (picked up by next patch, §5.7). */
  markStateDirty(id) {
    this.stateDirty.add(id);
  }

  isStateDirty(id) {
    return this.stateDirty.has(id);
  }

  getState() {
    const deepFreeze = (value) => {
      if (value === null || typeof value !== "object") return value;
      if (Object.isFrozen(value)) return value;
      for (const key of Object.keys(value)) {
        const v = value[key];
        if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
          deepFreeze(v);
        }
      }
      return Object.freeze(value);
    };
    const frozenParticipant = (p) => {
      const cfg = p.config && typeof p.config === "object" ? deepFreeze(structuredClone(p.config)) : p.config;
      const tierCfg = p.tier_config && typeof p.tier_config === "object" ? deepFreeze(structuredClone(p.tier_config)) : p.tier_config;
      return Object.freeze({ ...p, config: cfg, tier_config: tierCfg });
    };
    // Ensure tier_config.rights is deeply frozen if present
    const freezeTierConfig = (tc) => {
      if (!tc || typeof tc !== "object") return tc;
      const frozen = { ...tc };
      if (frozen.rights && typeof frozen.rights === "object") frozen.rights = Object.freeze({ ...frozen.rights });
      return Object.freeze(frozen);
    };
    const frozenCopy = (v) => {
      if (v === null || typeof v !== "object") return v;
      let cloned;
      try {
        cloned = structuredClone(v);
      } catch {
        cloned = JSON.parse(JSON.stringify(v));
      }
      return deepFreeze(cloned);
    };
    return Object.freeze({
      ...this.#state,
      participants: Object.freeze(this.#state.participants.map((p) => {
        const fp = frozenParticipant(p);
        // Re-freeze tier_config deeply
        if (fp.tier_config) return Object.freeze({ ...fp, tier_config: freezeTierConfig(fp.tier_config) });
        return fp;
      })),
      weave: Object.freeze([...this.#state.weave]),
      rounds: Object.freeze(this.#state.rounds.map((r) => Object.freeze({ ...r }))),
      artifact: this.#state.artifact ? frozenCopy(this.#state.artifact) : this.#state.artifact,
      objections: Array.isArray(this.#state.objections) ? Object.freeze(this.#state.objections.map((o) => Object.freeze({ ...o }))) : this.#state.objections,
      tags: Array.isArray(this.#state.tags) ? Object.freeze([...this.#state.tags]) : this.#state.tags,
      stats: this.#state.stats && typeof this.#state.stats === "object" ? frozenCopy(this.#state.stats) : this.#state.stats,
      planned_turn_order: Array.isArray(this.#state.planned_turn_order) ? Object.freeze([...this.#state.planned_turn_order]) : this.#state.planned_turn_order,
      state_of_play: this.#state.state_of_play,
    });
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

  getMeetingId() {
    return this.#state.id;
  }

  getQuestion() {
    return this.#state.question;
  }

  getContext() {
    return this.#state.context;
  }

  setContext(ctx) {
    this.#state.context = ctx ?? "";
  }

  getTags() {
    return this.#state.tags ?? [];
  }

  getStateOfPlay() {
    return this.#state.state_of_play ?? "";
  }

  // Contribution-mix steering for next round (audit 01 E3) — transient hint
  // consumed once by the next prompt phase, not persisted.
  getNextRoundSteering() {
    return this.#state._nextRoundSteering ?? "";
  }

  setNextRoundSteering(hint) {
    this.#state._nextRoundSteering = hint || "";
  }

  consumeNextRoundSteering() {
    const hint = this.#state._nextRoundSteering ?? "";
    this.#state._nextRoundSteering = "";
    return hint;
  }

  getNextSpeakerId() {
    return this.#state.next_speaker_id;
  }

  setNextSpeakerId(id) {
    this.#state.next_speaker_id = id ?? null;
  }

  getPlannedTurnOrder() {
    return this.#state.planned_turn_order ?? [];
  }

  setPlannedTurnOrder(order) {
    this.#state.planned_turn_order = order ?? [];
  }

  /**
   * Validated transition table (audit 05 LS3). Modeled explicitly so no caller
   * needs a bypass API:
   * - `weaving → weaving` is legal via the extension entry point (re-open mid-deliberation)
   * - `timeout` reachable from initializing (a stall can fire before round 1 completes)
   * - terminal states are terminal — restore() refuses them (meeting-restorer LS1)
   */
  static TRANSITIONS = {
    initializing: ["weaving", "cancelled", "aborted", "timeout"],
    weaving: ["converged", "cancelled", "timeout", "max_rounds_reached", "aborted"],
    // Extension entry point: a converged/terminal meeting explicitly re-opened
    // by extendMeeting() passes through forceTransitionTo, documented below.
    converged: [],
    cancelled: [],
    timeout: [],
    max_rounds_reached: [],
    aborted: [],
  };

  transitionTo(status) {
    const current = this.#state.status;
    if (current === status && status === "weaving") {
      // weaving → weaving self-transition (extension) is legal and a no-op here
      return;
    }
    if (current === status) {
      this.#logger.debug("state_transition", `No-op transition (already ${status})`);
      return;
    }
    const allowed = StateManager.TRANSITIONS[current];
    if (!allowed || !allowed.includes(status)) {
      this.#logger.error("invalid_transition", `Invalid status transition rejected: ${current} -> ${status}`);
      throw new Error(`Invalid status transition: ${current} -> ${status}`);
    }
    this.#state.status = status;
    this.#logger.info("state_transition", `${current} -> ${status}`);
  }

  /**
   * Applies a status change without transition validation. The ONLY sanctioned use
   * is MeetingExtender re-opening a meeting for extension (terminal → weaving);
   * everything else must go through transitionTo(). If you reach for this for any
   * other path, fix the transition table instead (audit 05 LS3).
   * @param {string} status
   */
  forceTransitionTo(status) {
    const current = this.#state.status;
    if (current === status) return;
    const allowedForced = {
      initializing: ["weaving"],
      converged: ["weaving"],
      cancelled: ["weaving"],
      timeout: ["weaving"],
      max_rounds_reached: ["weaving"],
      aborted: ["weaving"],
    };
    if (allowedForced[current]?.includes(status)) {
      this.#state.status = status;
      this.#logger.info("state_transition", `${current} -> ${status} (forced: extension entry point)`);
      return;
    }
    this.#logger.error("invalid_forced_transition", `Invalid forced transition rejected: ${current} -> ${status}`);
    throw new Error(`Invalid forced transition: ${current} -> ${status}`);
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

  getObjections() {
    return this.#state.objections ?? [];
  }

  setTags(tags) {
    this.#state.tags = tags;
  }

  setStateOfPlay(stateOfPlay) {
    this.#state.state_of_play = stateOfPlay;
  }

  /**
    * Restores all mutable state properties from a database-loaded meeting.
    * Used by the orchestrator when resuming a persisted meeting.
    * Validates status to prevent terminal→weaving bypass; caller must use forceTransitionTo for extension.
    */
  restore({ participants, question, context, fabric, max_rounds, tags, current_round, status, weave, next_contribution_id, state_of_play }) {
    if (participants !== undefined) this.#state.participants = participants;
    if (question !== undefined) this.#state.question = question;
    if (context !== undefined) this.#state.context = context;
    if (fabric !== undefined) this.#state.fabric = fabric;
    if (max_rounds !== undefined) this.#state.max_rounds = max_rounds;
    if (tags !== undefined) this.#state.tags = tags;
    if (current_round !== undefined) this.#state.current_round = current_round;
    if (status !== undefined) {
      const current = this.#state.status;
      const terminal = new Set(["converged", "cancelled", "timeout", "max_rounds_reached", "aborted"]);
      if (terminal.has(status) && current !== status) {
        // Direct terminal init is ok; terminal→weaving must go via forceTransitionTo
        if (status === "weaving" && terminal.has(current)) {
          this.#logger.error("invalid_restore", `Restore rejected terminal→weaving bypass: ${current} -> ${status} — use forceTransitionTo`);
          throw new Error(`Invalid restore: terminal ${current} -> weaving must use forceTransitionTo`);
        }
      }
      // Validate via transition table unless it's initial load (status same or from initializing)
      if (current !== status) {
        const allowed = StateManager.TRANSITIONS[current];
        if (allowed && !allowed.includes(status) && !(terminal.has(status) && current === "initializing")) {
          // Allow initial DB load to set any status, but log
          this.#logger.warn("restore_transition_unvalidated", `Restore sets ${current} -> ${status} outside transition table`);
        }
      }
      this.#state.status = status;
    }
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
      p.reflection = reflection;
    } else {
      this.#logger.warn("participant_not_found", `addParticipantReflection: unknown participant "${participantId}"`);
    }
  }

  setParticipantEmbedding(participantId, embedding) {
    const p = this.getParticipant(participantId);
    if (p) {
      p.embedding = embedding;
    } else {
      this.#logger.warn("participant_not_found", `setParticipantEmbedding: unknown participant "${participantId}"`);
    }
  }

  buildSharedState() {
    // Summary-only state inclusion (plan §5.7): counts + versions, not full bullets,
    // to avoid inflating the structuredClone per-round cost. Full states persist via DB.
    let state_patch_summary = null;
    try {
      const entries = [...this.participantStates.entries()];
      if (entries.length > 0) {
        state_patch_summary = Object.fromEntries(
          entries.map(([id, s]) => [id, { version: s?.version ?? 0, updated_round: s?.updated_round ?? 0 }]),
        );
      }
    } catch {}
    return {
      meeting_id: this.#state.id,
      round: this.#state.current_round,
      fabric: this.#state.fabric,
      question: this.#state.question,
      contributions: structuredClone(this.#state.weave),
      status: this.#state.status,
      state_of_play: this.#state.state_of_play ?? "",
      ...(state_patch_summary ? { state_patch_summary } : {}),
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
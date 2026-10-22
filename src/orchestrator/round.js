import { getConfig } from "../config.js";
import { LoomError, extractErrorInfo } from "../logger.js";
import { updateStateOfPlay, mergeStateOfPlay } from "../state-of-play.js";
import { formatForumSideThreadsSection } from "../utils/forum-digest.js";
import { mergeSettledBullet } from "../lib/settled-registry.js";
import { truncate } from "../shared.js";
import { SUMMARY_TRUNCATE_LEN } from "./constants.js";
import { isHardRateLimitError } from "../utils/retry.js";
// MeetingOrchestrator owns the round helpers' shared state (Phase 3 centralization).

/**
 * Default turn order for next round: current composition order, failed seats
 * excluded. Used when the orchestrator's summary call sets no override via
 * the orchestrator-only loom_set_turn_order tool (the old planner's own
 * fallback, minus the extra LLM call). Pure — unit-tested directly.
 * @param {Array} participants state-manager participant rows
 * @returns {string[]} ordered participant ids
 */
export function fallbackTurnOrder(participants) {
  return (participants ?? [])
    .filter((p) => p?.status !== "failed" && p?.config?.id)
    .map((p) => p.config.id);
}

/**
 * Continue a round left partial by a sudden server kill.
 *
 * Normal `runRound()` always starts a NEW round (initializeRound increments),
 * so resuming after a mid-round crash would abandon the interrupted round's
 * unspoken speakers and leave its summary permanently empty. This instead
 * re-drives the restored round-N object with only its missing speakers, then
 * finalizes it (summary + State of Play) so the record is complete.
 *
 * Pure passes leave no contribution row (only passes with tool evidence are
 * persisted), so a participant recorded as passed-but-rowless is re-prompted —
 * they simply see the turns committed since their pass.
 *
 * A round with zero durable rows (kill at round start) is restarted from
 * scratch under the same number — never skipped via a fresh increment.
 *
 * Returns true (finalized — caller should continue the weaving loop), false
 * (finalize converged the meeting — caller should synthesize now), or null
 * (no partial round — caller should run the normal loop).
 */
export async function _continueInterruptedRound() {
  const roundNum = this._stateManager.getCurrentRound();
  if (!Number.isFinite(roundNum) || roundNum <= 0) return null;
  let round = this._stateManager.getRounds().find((r) => r.number === roundNum) ?? null;
  if (round && round.summary && String(round.summary).trim()) return null; // already finalized

  // Crash landed between initializeRound's number commit (meetings.round=N)
  // and the first durable row for N — zero contributions and no summary.
  // Restart N from scratch UNDER THE SAME NUMBER (never increment): recreate
  // the shell in memory only, so no empty rounds-table row is ever persisted.
  // The normal path below then drives the full speaker list and finalizes,
  // exactly like a fresh round N.
  let freshRestart = false;
  if (!round) {
    round = { number: roundNum, contributions: [], token_path: [], summary: "" };
    this._stateManager.addRound(round);
    freshRestart = true;
    this._logger.info("resume_round_restart_empty", `Round ${roundNum} had no durable rows — restarting it from scratch under the same number`);
    try { await this._sessionManager.postProgress(`🧵 Resuming interrupted round ${roundNum} — restarting from scratch (no turns were saved).`); } catch {}
  }

  // Who has actually SPOKEN in this round?
  //
  // Only primary turns count. A peer-interaction row (loom_query /
  // loom_vote / loom_summon answers) carries the RESPONDER's id in
  // `participant_id` and the CALLER in `prompt_context.source_participant_id`
  // (see plugin/tools/query-evidence.js), so counting every row treated a
  // peer who merely answered a question as having taken its turn — and that
  // peer's real turn was then dropped from the resumed round.
  //
  // The peer-interaction types are the non-primary half of the contributions
  // table's own vocabulary (database/schema.js): contribution and pass are the
  // primary turn types.
  const PEER_INTERACTION_TYPES = new Set([
    "query_response", "perspective_response", "critique_response",
    "evidence_response", "summoned_response", "vote_response",
  ]);
  const spoken = new Set(
    (round.contributions ?? [])
      .filter((c) => !PEER_INTERACTION_TYPES.has(String(c.type ?? "")))
      .map((c) => c.participant_id),
  );
  const { activeParticipants, skipped } = this._roundInitializer.filterActiveParticipants(this._stateManager, round);
  if (skipped.length > 0) {
    try { await this._sessionManager.postProgress(`⏭️ Skipped: ${skipped.join(", ")} (inactive, no new reflections)`); } catch {}
  }
  const remaining = activeParticipants.filter((p) => !spoken.has(p.config.id));

  if (remaining.length === 0) {
    if (freshRestart) {
      // No speakers at all (everyone failed) — mirror runRound: converge
      // rather than finalizing an empty round into the record.
      this._stateManager.transitionTo("converged");
      return false;
    }
    // Everyone spoke but the finalize transaction never ran (kill OR a
    // cancel that landed while the round CLERK was summarizing — the halt
    // skips the summary write and leaves the round open, which is exactly
    // what Resume needs). The round still owes its summary: run the clerk
    // over the completed round, then finalize to write summary + SoP.
    //
    // Calling _finalizeRound directly would persist an EMPTY summary and
    // silently drop the clerk's consensus/settled-bullet work from the
    // record — the round-service path (clerk → finalize) is what a fresh
    // round would have done, so it is what the resume must do.
    this._logger.info("resume_round_finalize_only", `Round ${roundNum} fully spoken before the interruption — running the clerk, then finalizing`);
    this._notifyUpdate();
    if (this._roundService && !this.isHalted?.()) {
      try {
        const { round: clerked } = await this._roundService.runRound({
          round,
          activeParticipants: [],
          promptOrchestrator: async (system, model, message, type) => this._promptOrchestrator(system, model, message, type, round.number),
          getDefaultModel: () => this._getOrchestratorModel(),
          getFallbackModel: () => this._getAllowedFallbackModel(),
          orchestratorConfig: this._options.orchestratorConfig,
          state: this._stateManager.getState(),
        });
        round = clerked ?? round;
      } catch (err) {
        this._logger.warn("resume_round_clerk_failed", `Round ${roundNum} summary failed on resume — finalizing with the empty summary`, extractErrorInfo(err));
      }
    }
    return this._finalizeRound(round);
  }

  this._logger.info("resume_round_continue", `Resuming interrupted round ${roundNum} with ${remaining.length}/${activeParticipants.length} remaining speakers`);
  try { await this._sessionManager.postProgress(`🧵 Resuming interrupted round ${roundNum} — ${remaining.length} speaker(s) left to hear.`); } catch {}

  if (!this._roundExecutor) {
    throw new LoomError("RoundExecutor not initialized — call initialize() first", { phase: "round_execution", recoverable: false });
  }
  const { round: updatedRound } = await this._roundService.runRound({
    round,
    activeParticipants: remaining,
    promptOrchestrator: async (system, model, message, type) => this._promptOrchestrator(system, model, message, type, round.number),
    getDefaultModel: () => this._getOrchestratorModel(),
    getFallbackModel: () => this._getAllowedFallbackModel(),
    orchestratorConfig: this._options.orchestratorConfig,
    state: this._stateManager.getState(),
  });

  this._notifyUpdate();
  return this._finalizeRound(updatedRound);
}

export async function runRound() {
    const round = this._roundInitializer.initializeRound(this._stateManager, this._database, () => this._notifyUpdate());
    const { activeParticipants, skipped } = this._roundInitializer.filterActiveParticipants(this._stateManager, round);

    if (skipped.length > 0) {
      await this._sessionManager.postProgress(`⏭️ Skipped: ${skipped.join(", ")} (inactive, no new reflections)`);
    }

    if (activeParticipants.length === 0) {
      // A halted meeting keeps its cancelled status — terminal states are
      // absorbing, so transitionTo("converged") would throw.
      if (!this.isHalted?.()) this._stateManager.transitionTo("converged");
      return false;
    }

    if (!this._roundExecutor) {
      throw new LoomError("RoundExecutor not initialized — call initialize() first", { phase: "round_execution", recoverable: false });
    }

    try {
      const { round: updatedRound } = await this._roundService.runRound({
        round,
        activeParticipants,
        promptOrchestrator: async (system, model, message, type) => this._promptOrchestrator(system, model, message, type, round.number),
         getDefaultModel: () => this._getOrchestratorModel(),
         getFallbackModel: () => this._getAllowedFallbackModel(),
         orchestratorConfig: this._options.orchestratorConfig,
         state: this._stateManager.getState(),
      });

      return this._finalizeRound(updatedRound);
    } catch (err) {
      if (isHardRateLimitError(err)) {
        this._setRateLimitError?.(err);
      }
      throw err;
    }
  }

/**
 * The next round's steering hint (soft, ≤300 chars, consumed once by the next
 * round's first speaker). Pure, so it can be unit-tested directly.
 *
 * Priority: closing-round ballot nudge > decision-shaped nudge > consolidation.
 * The closing-round nudge is RATCHET-AWARE (audit D3): the synthesis doctrine
 * promises a confirmation ballot when new evidence has superseded the question
 * the room already voted on, and this hint is the only reliable channel to ask
 * for it — the agent-facing guidance only reaches the speaker of that turn, and
 * only if it happens to be the first speaker. Counting votes for the whole
 * meeting (rather than the round) is what made the old hint fire only until
 * the first ballot of the meeting, and never again.
 *
 * @returns {string|null} the hint text, or null when no nudge is warranted
 */
export function computeSteeringHint({
  roundNumber, maxRounds, votesHeld, votesThisRound, voteEnabled,
  contributionsThisRound = 0, critiqueCount = 0, hasSynthesis = false,
} = {}) {
  const closingRound = Number.isFinite(maxRounds) && Number.isFinite(roundNumber) && roundNumber >= maxRounds - 1;
  if (closingRound && voteEnabled && votesThisRound === 0) {
    return votesHeld === 0
      ? "Steering note for the next speaker (closing round): no ballot has been held. If the live disagreement is a scalar threshold or binary the room has priced, open by calling loom_vote on the discriminating question — a held tally outranks another restatement round; if a vote would change nothing, open your contribution by saying why."
      : "Steering note for the next speaker (closing round): a ballot was held earlier, but this round's evidence may have superseded it. If the question changed, re-poll the superseded question and let the fresh tally stand — the synthesis records the latest ballot, not the original; if a re-poll would change nothing, say why in your contribution instead.";
  }
  if (roundNumber >= 2 && votesHeld === 0 && contributionsThisRound > 0) {
    return "Steering note for the next speaker: two rounds in, nothing has been priced as a decision. Open with the decision-shaped move — your top option, its price (numbers + reference class), and its kill line — even if contested. A prose straw poll on the discriminating question is a valid opener.";
  }
  if (critiqueCount >= 3 && !hasSynthesis) {
    return "Steering note for the next speaker: last round had multiple disagreements with no consolidation. Please synthesize positions — cite [#id] — before opening a new challenge.";
  }
  return null;
}

export async function _finalizeRound(updatedRound) {
    // A HALTED meeting does not finalize its round. The round is deliberately
    // left OPEN (no summary row), which is what makes "Resume" able to
    // continue it: the resume path re-drives exactly the speakers who did not
    // get to speak. The State of Play is still refreshed below, so the record
    // is not stale for a meeting that is never resumed.
    const halted = this.isHalted?.() === true;
    try {
      // SKILL.state SoP read-view (plan §5.8): aggregation over per-agent Σⁱ is the
      // only path that files an agent's own positions; the type-driven full-weave
      // digest is the cold-start fallback (all states empty, flag off, or old DB)
      // and it never infers a bucket from prose. Output markdown shape is
      // unchanged for downstream consumers.
      // Settled registry (retrospective P0-2): merge the clerk's Settled bullet
      // into the meeting-level list. The clerk detects paraphrased consensus
      // semantically; exact-match state aggregation cannot (deliberation 2
      // replay: five agents, five phrasings, zero exact matches).
      //
      // The registry is consensus-tracking, never load-bearing: any failure
      // here degrades to "no settled update this round", never to a failed
      // finalization (a "no such column" on a pre-migration DB once aborted
      // a whole meeting — the write path self-heals, and this guard is the
      // second layer).
      //
      // It is merged BEFORE the State of Play is built, because the registry
      // IS the shared consensus section (audit A): the room's and the
      // synthesizer's view of "what is settled" must be the orchestrator's
      // judgement — the exact-match aggregate produced ZERO rows in every
      // recorded meeting, while the registry held 2-8 real ones.
      let settledMerge = { items: [], changed: false };
      try {
        settledMerge = mergeSettledBullet(
          this._stateManager.getSettledItems(),
          updatedRound.summary,
          updatedRound.number,
        );
        if (settledMerge.changed) {
          this._stateManager.setSettledItems(settledMerge.items);
        }
      } catch (err) {
        settledMerge = { items: [], changed: false };
        try { this._logger.warn("settled_merge_degraded", `Settled registry merge failed for round ${updatedRound.number} — continuing without settled update`, extractErrorInfo(err)); } catch {}
      }
      // Per-turn cost drops from O(T) scan to O(P × buckets).
      let newStateOfPlay = "";
      let stateCoverageComplete = false;
      try {
        const { aggregateStateOfPlay } = await import("../state-patch.js");
        const states = typeof this._stateManager.getAllParticipantStates === "function"
          ? this._stateManager.getAllParticipantStates()
          : [];
        stateCoverageComplete = states.length > 0 && states.every(({ state }) => state && (
          String(state.stance ?? "").trim() ||
          (state.established ?? []).length ||
          (state.contested ?? []).length ||
          (state.open ?? []).length ||
          (state.facts ?? []).length ||
          (state.files ?? []).length
        ));
        newStateOfPlay = aggregateStateOfPlay(
          states,
          this._stateManager.getQuestion(),
          this._stateManager.getTags(),
          { settledItems: settledMerge.items },
        );
      } catch {}
      const weave = this._stateManager.getWeave();
      // The legacy weave scan is a FALLBACK, and it files only what the
      // contribution's own type tag says it is: peer-interaction responses and
      // file references. An untyped primary turn contributes nothing to it —
      // there is no keyword classifier left to guess a bucket from prose — so
      // the condition that used to force this scan for every patch-missed turn
      // is gone. A turn that did not call loom_state_patch is not represented
      // in the State of Play; its prose is still in that round's Live block and
      // in the synthesis transcript, so nothing is lost from the record, it is
      // simply not claimed as settled.
      if (!stateCoverageComplete || !newStateOfPlay) {
        const weaveStateOfPlay = updateStateOfPlay(
          weave,
          this._stateManager.getQuestion(),
          this._stateManager.getTags(),
        );
        newStateOfPlay = mergeStateOfPlay(newStateOfPlay, weaveStateOfPlay);
      }
      // Forum read-through (post-mortem 7811b8db §8): forum content previously
      // reached nothing downstream — a write-only sink agents rationally
      // ignored when the tool was optional (0 uses in 400). Appending a bounded
      // [#T{id}]-labelled digest makes the forum a reader-backed channel: this
      // SoP ships into every agent turn, the round clerk, and the final
      // synthesis. Digest failure degrades to no section — never to a failed
      // finalization.
      try {
        const toolsCfg = this._roundExecutor?.getEffectiveAgentTools?.() ?? getConfig().agentTools;
        const forumEnabled = !!(toolsCfg?.enabled && toolsCfg?.loom?.loom_forum);
        const topics = forumEnabled
          ? this._database?.listForumTopicsForPrompt?.(5) ?? []
          : [];
        const forumSection = formatForumSideThreadsSection(topics);
        if (forumSection) newStateOfPlay = newStateOfPlay ? `${newStateOfPlay}\n\n${forumSection}` : forumSection;
      } catch {}
      this._stateManager.setStateOfPlay(newStateOfPlay);
      // Atomic: 4 writes in one SAVEPOINT — all-or-nothing
      await this._database.transaction(() => {
        // A halted round keeps NO summary: the round stays open so a resume
        // can finish it. The State of Play and the settled registry are still
        // written, so the record is never stale.
        if (!halted) this._database.setRoundSummary(updatedRound.number, updatedRound.summary, this._options?.orchestratorConfig ?? null);
        this._database.setStateOfPlay(newStateOfPlay);
        if (settledMerge.changed) this._database.setSettledItemsRaw(JSON.stringify(settledMerge.items));
      });

      if (halted) {
        // No convergence decision, no turn order, no steering: the meeting was
        // stopped, and the status is already terminal (written by cancel()).
        // Any further transitionTo() here would throw — terminal states are
        // absorbing (StateManager.TRANSITIONS).
        const spoken = updatedRound.contributions.length;
        await this._sessionManager.postProgress(
          `🛑 Round ${updatedRound.number} stopped after ${spoken} contribution${spoken !== 1 ? "s" : ""} — the run was cancelled.`
        );
        this._notifyUpdate();
        try { await this._persistState(); } catch {}
        return false;
      }

      const contribCount = updatedRound.contributions.length;
      const summaryText = updatedRound.summary ? ` | ${truncate(updatedRound.summary, SUMMARY_TRUNCATE_LEN)}` : "";
      await this._sessionManager.postProgress(
        `📋 Round ${this._stateManager.getCurrentRound()} complete — ${contribCount} contribution${contribCount !== 1 ? "s" : ""}${summaryText}`
      );

      if (this._options.onRoundComplete) {
        this._options.onRoundComplete(this._stateManager.getCurrentRound(), updatedRound.summary);
      }
      this._notifyUpdate();

      // Turn order for next round: the orchestrator's summary call above is its
      // single LLM call per round and may have set an override via the
      // orchestrator-only loom_set_turn_order tool. When it did not, fall back
      // to the current composition order (the old planner's own fallback).
      // Agents never request speaking priority.
      if (this._stateManager.getPlannedTurnOrder().length === 0) {
        const fallbackOrder = fallbackTurnOrder(this._stateManager.getParticipants());
        if (fallbackOrder.length > 0) {
          this._stateManager.setNextSpeakerId(fallbackOrder[0]);
          this._stateManager.setPlannedTurnOrder(fallbackOrder);
        }
      }

      const participants = this._stateManager.getParticipants();
      const passed = participants.filter((p) => p.status === "passed").length;
      const failed = participants.filter((p) => p.status === "failed").length;
      const active = participants.length - passed - failed;
      const allPassed = active === 0 && passed > 0 && failed === 0;
      const allFailed = active === 0 && failed > 0 && passed === 0;
      const mixedDone = active === 0 && passed > 0 && failed > 0;
      const minRounds = Math.max(1, Number(getConfig().minRounds) || 1);
      if (allPassed && this._stateManager.getCurrentRound() < minRounds) {
        for (const participant of participants) {
          if (participant.status !== "passed") continue;
          participant.status = "listening";
          this._database.setParticipantStatus(participant.config.id, "listening");
        }
        this._logger.info("minimum_rounds_reopen", `All participants passed before minRounds=${minRounds}; continuing deliberation`);
        await this._persistState();
        return true;
      }
      const exhausted = this._stateManager.getCurrentRound() >= this._stateManager.getMaxRounds() && active > 0;
      if (allPassed) {
        this._stateManager.transitionTo("converged");
        await this._persistState();
        return false;
      }
      if (allFailed || mixedDone) {
        this._stateManager.transitionTo("aborted");
        await this._persistState();
        return false;
      }
      if (exhausted) {
        this._stateManager.transitionTo("max_rounds_reached");
        await this._persistState();
        return false;
      }

      // Steering hints (soft, ≤300 chars, consumed once by next round's first
      // speaker) — see computeSteeringHint for the policy (closing-round
      // ballot nudge > decision-shaped nudge > consolidation). Conditions are
      // computed inline from round rows + weave — deliberately NOT via
      // computeMechanismMix, whose telemetry contract ("read-only, no caller
      // gates or steers") stays intact.
      const votesHeld = this._stateManager.getWeave().filter((c) => c.type === "vote_response").length;
      const votesThisRound = updatedRound.contributions.filter((c) => c.type === "vote_response").length;
      const currentRoundNum = this._stateManager.getCurrentRound();
      const maxRoundsTotal = this._stateManager.getMaxRounds?.() ?? null;
      const toolsCfg = this._roundExecutor?.getEffectiveAgentTools?.() ?? getConfig().agentTools;
      const voteEnabled = !!(toolsCfg?.enabled && toolsCfg?.loom?.loom_vote);
      const critiqueCount = updatedRound.contributions.filter((c) => c.type === "critique_response").length;
      const steeringHint = computeSteeringHint({
        roundNumber: currentRoundNum,
        maxRounds: maxRoundsTotal,
        votesHeld,
        votesThisRound,
        voteEnabled,
        contributionsThisRound: updatedRound.contributions.length,
        critiqueCount,
        hasSynthesis: updatedRound.contributions.some((c) => c.type === "synthesize"),
      });
      if (steeringHint) {
        this._stateManager.setNextRoundSteering(steeringHint);
      }

      await this._persistState();
      return true;
    } catch (err) {
      const info = extractErrorInfo(err);
      // Error taxonomy (audit 01 E2): distinguish "degrade and continue" from
      // "the finalization logic itself is broken". Never silently return false —
      // that is indistinguishable from a clean convergence.
      const persistenceFailure = this._isPersistenceError(err);
      if (persistenceFailure) {
        // Degrade: state stays in memory; the meeting can proceed to the next round.
        this._logger.error("finalize_round_degraded", `Round ${updatedRound.number} finalization degraded by persistence failure`, info);
        try {
          await this._persistState();
        } catch (persistErr) {
          this._logger.error("finalize_round_persist_failed", `Could not persist state after degradation for round ${updatedRound.number}`, extractErrorInfo(persistErr));
        }
        return true;
      }
      // State-machine or logic error: abort honestly, persist the aborted status
      // BEFORE rethrowing so the terminal status survives the unwinding (audit 05 note).
      this._logger.error("finalize_round_failed", `Failed to finalize round ${updatedRound.number}`, info);
      if (halted) {
        // The meeting was already stopped (status: cancelled). Re-throwing
        // would unwind the run with an error the user did not cause, and
        // transitionTo("aborted") would throw on its own — the status is
        // terminal and terminal states are absorbing.
        this._logger.info("finalize_round_halted", `Round ${updatedRound.number} finalization failed after the run was stopped — keeping the cancelled status`, info);
        try { await this._persistState(); } catch {}
        return false;
      }
      try {
        this._stateManager.transitionTo("aborted");
        await this._persistState();
        await this._sessionManager.postProgress(`❌ Meeting aborted — internal error while finalizing round ${updatedRound.number}: ${err.message}`, "error");
      } catch (abortErr) {
        this._logger.error("finalize_round_abort_failed", "Could not persist aborted status during finalize failure", extractErrorInfo(abortErr));
      }
      throw err;
    }
  }

export function _isPersistenceError(err) {
    if (!(err instanceof Error)) return false;
    const code = String(err.code || "");
    if (code === "SQLITE_BUSY" || code === "SQLITE_BUSY_SNAPSHOT" || code === "SQLITE_READONLY" || code === "EACCES" || code === "SQLITE_IOERR") return true;
    const msg = String(err.message || "").toLowerCase();
    return (
      /^sqlite/.test(msg) ||
      msg.includes("sqlite_busy") ||
      msg.includes("database is locked") ||
      msg.includes("database is busy") ||
      msg.includes("disk i/o") ||
      msg.includes("readonly")
    );
  }

export async function _persistState() {
    const sharedState = this._stateManager.buildSharedState();
    const stats = this._getMergedStats();
    try {
      const { withRetry, isRetryableError } = await import("../utils/retry.js");
      await withRetry(() => this._persistenceService.persistState(sharedState, this._stateManager.getNextSpeakerId(), stats, this._stateManager.getMaxRounds()), {
        maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200, retryable: isRetryableError,
      });
    } catch (err) {
      const info = extractErrorInfo(err);
      this._logger.error("persist_state_failed", "Failed to persist meeting state to database — meeting continues in-memory, DB is now divergent (will be flagged degraded)", info);
      // Flag persistence degraded so dashboard can surface it
      try {
        const { degrade } = await import("../utils/degrade.js");
        await degrade("persist.state", "persistState flagged degraded", async () => {
          this._database.setPersistenceDegraded?.(1);
        }, null);
      } catch {}
    }
   }

export function _getMergedStats() {
    const roundStats = this._roundExecutor?.getCallStats() ?? {};
    const out = { ...this._callStats };
    for (const [key, value] of Object.entries(roundStats)) {
      if (typeof out[key] === "number" && typeof value === "number") {
        out[key] = out[key] + value;
      } else {
        out[key] = value;
      }
    }
    return out;
  }

export function _logError(context, error) {
    try {
      const info = extractErrorInfo(error);
      this._logger.error(context, info.message, { stack: info.stack });
      if (this._database) {
        this._database.logError(context, info.message, { stack: info.stack });
      }
    } catch {
      // Last-resort: do not let error logging failures propagate
    }
  }

export function _notifyUpdate() {
    this._stallWatchdog.touch();
    if (this._options.onUpdate) {
      this._options.onUpdate(this._stateManager.getState());
    }
  }


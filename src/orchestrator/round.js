import { getConfig } from "../config.js";
import { LoomError, extractErrorInfo } from "../logger.js";
import { updateStateOfPlay, mergeStateOfPlay } from "../state-of-play.js";
import { mergeSettledBullet } from "../lib/settled-registry.js";
import { truncate } from "../shared.js";
import { SUMMARY_TRUNCATE_LEN } from "./constants.js";
import { isHardRateLimitError } from "../utils/retry.js";
// MeetingOrchestrator owns the round helpers' shared state (Phase 3 centralization).

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
 * Returns true (finalized — caller should continue the weaving loop), false
 * (finalize converged the meeting — caller should synthesize now), or null
 * (no partial round — caller should run the normal loop).
 */
export async function _continueInterruptedRound() {
  if (this._tokenBudgetExceeded?.()) return null;

  const roundNum = this._stateManager.getCurrentRound();
  if (!Number.isFinite(roundNum) || roundNum <= 0) return null;
  const round = this._stateManager.getRounds().find((r) => r.number === roundNum) ?? null;
  if (!round) return null;
  if (round.summary && String(round.summary).trim()) return null; // already finalized

  const spoken = new Set((round.contributions ?? []).map((c) => c.participant_id));
  const { activeParticipants, skipped } = this._roundInitializer.filterActiveParticipants(this._stateManager, round);
  if (skipped.length > 0) {
    try { await this._sessionManager.postProgress(`⏭️ Skipped: ${skipped.join(", ")} (inactive, no new reflections)`); } catch {}
  }
  const remaining = activeParticipants.filter((p) => !spoken.has(p.config.id));

  if (remaining.length === 0) {
    // Everyone spoke but the finalize transaction never ran (kill between
    // last turn commit and finalize) — just finalize to write summary + SoP.
    this._logger.info("resume_round_finalize_only", `Round ${roundNum} fully spoken before crash — finalizing without new turns`);
    this._notifyUpdate();
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
    getHighestTierModel: () => this._getOrchestratorModel(),
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
      this._stateManager.transitionTo("converged");
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
         getHighestTierModel: () => this._getOrchestratorModel(),
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

export async function _finalizeRound(updatedRound) {
    try {
      // SKILL.state SoP read-view (plan §5.8): aggregation over per-agent Σⁱ is the
      // only path that files an agent's own positions; the type-driven full-weave
      // digest is the cold-start fallback (all states empty, flag off, or old DB)
      // and it never infers a bucket from prose. Output markdown shape is
      // unchanged for downstream consumers.
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
      this._stateManager.setStateOfPlay(newStateOfPlay);
      // Settled registry (retrospective P0-2): merge the clerk's Settled bullet
      // into the meeting-level list. The clerk detects paraphrased consensus
      // semantically; exact-match state aggregation cannot (deliberation 2
      // replay: five agents, five phrasings, zero exact matches).
      // The registry is consensus-tracking, never load-bearing: any failure
      // here degrades to "no settled update this round", never to a failed
      // finalization (a "no such column" on a pre-migration DB once aborted
      // a whole meeting — the write path self-heals, and this guard is the
      // second layer).
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
      // Atomic: 4 writes in one SAVEPOINT — all-or-nothing
      await this._database.transaction(() => {
        this._database.setRoundSummary(updatedRound.number, updatedRound.summary, this._options?.orchestratorConfig ?? null);
        this._database.setStateOfPlay(newStateOfPlay);
        if (settledMerge.changed) this._database.setSettledItemsRaw(JSON.stringify(settledMerge.items));
      });

      const contribCount = updatedRound.contributions.length;
      const turnRequestCount = (updatedRound.turn_requests || []).length;
      const summaryText = updatedRound.summary ? ` | ${truncate(updatedRound.summary, SUMMARY_TRUNCATE_LEN)}` : "";
      await this._sessionManager.postProgress(
        `📋 Round ${this._stateManager.getCurrentRound()} complete — ${contribCount} contribution${contribCount !== 1 ? "s" : ""}, ${turnRequestCount} turn request${turnRequestCount !== 1 ? "s" : ""}${summaryText}`
      );

      if (this._options.onRoundComplete) {
        this._options.onRoundComplete(this._stateManager.getCurrentRound(), updatedRound.summary);
      }
      this._notifyUpdate();

      // Plan turn order for next round
      const turnRequests = updatedRound.turn_requests || [];
      if (turnRequests.length > 0) {
        const { planTurnOrder } = await import("../moderation.js");
        const orderedParticipants = await planTurnOrder({
          stateOfPlay: this._stateManager.getStateOfPlay(),
          roundSummary: updatedRound.summary || "",
          turnRequests,
          participants: this._stateManager.getParticipants(),
          promptFn: async (system, model, message) => this._promptOrchestrator(system, model, message, "turn_order", updatedRound.number),
             ...(this._options.orchestratorModel ? { getOrchestratorModel: () => this._getOrchestratorModel() } : {}),
             orchestratorConfig: this._options.orchestratorConfig,
             getHighestTierModel: () => this._getOrchestratorModel(),
        });
        
        // Store planned order for next round
        if (orderedParticipants.length > 0) {
          this._stateManager.setNextSpeakerId(orderedParticipants[0]);
          this._stateManager.setPlannedTurnOrder(orderedParticipants);
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

      const critiqueCount = updatedRound.contributions.filter((c) => c.type === "critique_response").length;
      if (critiqueCount >= 3) {
        const hasSynthesis = updatedRound.contributions.some(c => c.type === "synthesize");
        if (!hasSynthesis) {
          this._stateManager.setNextRoundSteering(
            "Steering note for the next speaker: last round had multiple disagreements with no consolidation. Please synthesize positions — cite [#id] — before opening a new challenge."
          );
        }
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
      if (key === "input_tokens" || key === "output_tokens") {
        // Sum tokens across orchestrator (incl. sub-agent + synthesis via
        // token recorder) and agent turns — spread would drop one side.
        out[key] = (Number(out[key]) || 0) + (Number(value) || 0);
      } else if (typeof out[key] === "number" && typeof value === "number") {
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


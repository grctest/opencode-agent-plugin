import { getConfig } from "../config.js";
import { LoomError, extractErrorInfo } from "../logger.js";
import { updateStateOfPlay } from "../state-of-play.js";
import { truncate } from "../shared.js";
import { SUMMARY_TRUNCATE_LEN } from "./constants.js";
// TimeBudget is owned by MeetingOrchestrator; round helpers use this._timeBudget when available (Phase 3 centralization)

export async function runRound() {
    const timeBudget = this._timeBudget;

    if (timeBudget ? timeBudget.checkTimeout() : this._checkTimeout()) {
      if (timeBudget) {
        this._stateManager.transitionTo("timeout");
        this._logger.warn("timeout", "Meeting timed out", { elapsed: Date.now() - this._startTime, limit: this._meetingTimeoutMs });
      }
      await this._sessionManager.postProgress("⏱️ Loom timed out — generating output from collected contributions.", "warn");
      return false;
    }

    const remaining = timeBudget ? timeBudget.remainingMs() : this._remainingMs();
    const isExpiredGrace = timeBudget ? timeBudget.isExpired(5000) : remaining < 5000;
    if (isExpiredGrace) {
      this._stateManager.transitionTo("timeout");
      await this._sessionManager.postProgress("⏱️ Loom timed out — generating output from collected contributions.", "warn");
      this._logger.warn("timeout", "Meeting timed out before round start", { remaining });
      return false;
    }

    const deadline = timeBudget ? timeBudget.deadline() : this._startTime + this._meetingTimeoutMs;

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

    const { round: updatedRound } = await this._roundService.runRound({
      round,
      activeParticipants,
      promptOrchestrator: async (system, model, message, type) => this._promptOrchestrator(system, model, message, type, round.number),
      getHighestTierModel: () => this._getHighestTierModel(),
      getFallbackModel: () => this._getAllowedFallbackModel(),
      state: this._stateManager.getState(),
      deadline,
    });

    return this._finalizeRound(updatedRound);
  }

export async function _finalizeRound(updatedRound) {
    try {
      const newStateOfPlay = updateStateOfPlay(
        this._stateManager.getWeave(),
        this._stateManager.getQuestion(),
        this._stateManager.getTags(),
      );
      this._stateManager.setStateOfPlay(newStateOfPlay);
      // Atomic: 3 writes in one SAVEPOINT — all-or-nothing
      await this._database.transaction(() => {
        this._database.setRoundSummary(updatedRound.number, updatedRound.summary);
        this._database.setStateOfPlay(newStateOfPlay);
        // addOrchestratorMessage for vector-index timeout is handled separately (best-effort)
      });

      try {
        await this._raceWithGuardTimer(
          this._vectorIndex.indexRound(
            updatedRound.number,
            updatedRound.summary,
            updatedRound.contributions,
          ),
          5000,
          "indexRound",
        );
      } catch (err) {
        this._logger.warn("vector_index_round_failed", `Failed to index round ${updatedRound.number} for vector search`, extractErrorInfo(err));
        try {
          this._database.addOrchestratorMessage("vector_index_timeout", "assistant", `⚠️ Vector indexing timed out for round ${updatedRound.number} — keyword fallback for that round.`, updatedRound.number);
        } catch {}
      }

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
          getHighestTierModel: () => this._getHighestTierModel(),
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

      const isChallengeLikeContent = (c) => {
        if (c.type === "challenge" || c.type === "dissent" || c.type === "critique_response") return true;
        return /\b(challenge|dissent|disagree|concern|oppose|dispute|contradict|risk|flaw|weakness)\b/i.test(String(c.content ?? ""));
      };
      const challengeLikeCount = updatedRound.contributions.filter(isChallengeLikeContent).length;
      if (challengeLikeCount >= 3) {
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
    return { ...this._callStats, ...roundStats };
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


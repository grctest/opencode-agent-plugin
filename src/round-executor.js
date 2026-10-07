import { buildQueryPrompt, buildEvidencePrompt, buildSummonPrompt, buildVotePrompt } from "./prompts/interaction-prompts.js";
import { buildAgentSystemPrompt, buildAgentUserPrompt } from "./prompts/agent.js";
import { parseAgentResponse } from "./validation.js";
import { getConfig, resolveBuiltInTools, resolveLoomTools } from "./config.js";
import { extractAgentResponse, mapToolResults, truncate, extractFileBlockTools } from "./shared.js";
import { getPersonas } from "./composer.js";
import { Logger, extractErrorInfo } from "./logger.js";
import { sanitizeForDisplay, sanitizeAgentOutput } from "./utils/sanitize.js";
import { CircuitBreaker } from "./utils/retry.js";
import { selectFallbackModel } from "./services/model-service.js";
import { loadGlobalHealth, markGlobalUnhealthy } from "./services/global-model-health.js";
import { incrementKeyedCounter, recordLatency } from "./metrics.js";
import { degrade } from "./utils/degrade.js";
import { randomUUID } from "node:crypto";
import { promptChildSession as promptChildSessionHelper, executeAgentTurn as executeAgentTurnHelper, recordFallbackFailure as recordFallbackFailureHelper, runPatchTailPhase, computePatchOutcome, TAIL_DEFERRED } from "./round-executor/agent-turn.js";
import { buildToolsMap as buildToolsMapHelper, buildToolsMapWithoutLoom as buildToolsMapWithoutLoomHelper } from "./round-executor/tools.js";

export class RoundExecutor {
  _db;
  _stateManager;
  _options;
  _sessionManager;
  _promptParent;
  _getParticipantModel;
  _logError;
  _failureCounts;
  _modelFailureTimes;
  _logger;
  _turnOrder = [];
  _callStats;
  _circuitBreaker;
  _tools;
  _availableModels;
  /** Set by the orchestrator; called when the agent turn drops blocks to fit context. */
  _onPromptTrimmed;

  constructor({ db, stateManager, options, sessionManager, promptParent, getParticipantModel, logError, tools = null, availableModels = [], directory = null }) {
    this._db = db;
    this._stateManager = stateManager;
    this._options = options;
    this._sessionManager = sessionManager;
    this._promptParent = promptParent;
    this._getParticipantModel = getParticipantModel;
    this._logError = logError;
    this._tools = tools;
    this._availableModels = availableModels;
    this._directory = directory;
    this._onPromptTrimmed = null;
    this._failureCounts = new Map();
    this._modelFailureTimes = new Map();
    this._logger = new Logger();
    this._callStats = { agent_prompts: 0, reflection_calls: 0, sub_agent_calls: 0 };
    const cbConfig = getConfig().circuitBreaker;
    this._circuitBreaker = new CircuitBreaker({
      failureThreshold: cbConfig.failureThreshold,
      resetTimeoutMs: cbConfig.resetTimeoutMs,
    });
    // Load persisted global unhealthy so this meeting respects prior trips
    try { loadGlobalHealth(directory); } catch {}
  }

  _failedInCurrentRound = 0;
  _roundSessionIds = null;
  _dbFailedThisMeeting = null;
  _queuedSpeakers = null;

  isModelHealthy(model) {
    return this._circuitBreaker.isHealthy(model);
  }

  clearBreakerHistory() {
    try { this._circuitBreaker?.clear?.(); } catch {}
    try { this._failureCounts?.clear?.(); } catch {}
    try { this._modelFailureTimes?.clear?.(); } catch {}
    this._logger.info("breaker_cleared", "Circuit breaker history cleared for extension");
  }

  getCallStats() {
    return { ...this._callStats };
  }

  /**
   * Signal that an agent-side counter moved. The orchestrator owns the single
   * `meetings.stats` row and debounces the write, so the hot-path sites
   * (`this._callStats.agent_prompts++` inside the turn helpers) call this
   * instead of writing directly — that is what makes the dashboard's
   * "LLM Calls" stat move DURING a round rather than only at its end.
   */
  _notifyCallStats() {
    try { this._options?.onCallStats?.(); } catch {}
  }

  recordAgentPrompt(n = 1) {
    this._callStats.agent_prompts += n;
    this._notifyCallStats();
  }

  recordSubAgentCall(n = 1) {
    this._callStats.sub_agent_calls += n;
    this._notifyCallStats();
  }

  getEffectiveAgentTools() {
    return this._options?.agentTools ?? this._tools ?? getConfig().agentTools;
  }

  resetRoundStats() {
    this._failedInCurrentRound = 0;
  }

  _modelKey(model) {
    if (!model?.providerID || !model?.modelID) return "unknown";
    return `${model.providerID}/${model.modelID}`;
  }

    _recordModelFailure(model) {
     // Single config read (audit 09 R3): thresholds were captured at construction;
     // re-reading here could disagree with the breaker's actual configuration.
     const state = this._circuitBreaker.recordFailure(model);
     const key = this._modelKey(model);
     if (state.failures >= this._circuitBreaker.failureThreshold) {
       // Persist globally so all concurrent meetings and future sessions see it
       try { markGlobalUnhealthy(key, this._directory); } catch {}
        this._options.onProgress?.(`⚠️ Model ${key} marked unhealthy after ${state.failures} consecutive failures — re-enable it in the dashboard Setup tab to restore.`);
       this._logger.warn("circuit_breaker", `Model ${key} marked unhealthy`, { failures: state.failures });
       // Propagate to queued speakers that haven't spoken yet
       this._reassignQueuedAgents(key);
     }
    }

   _reassignQueuedAgents(unhealthyKey) {
     const queue = this._queuedSpeakers;
     if (!queue || queue.length === 0) return;
     let reassigned = 0;
     for (const qp of queue) {
       try {
         const curModel = this._getParticipantModel(qp);
         if (!curModel) continue;
         const curKey = this._modelKey(curModel);
         if (curKey !== unhealthyKey) continue;
         // Confirm it's now unhealthy (global + local)
         if (this._circuitBreaker.isHealthy(curModel)) continue;
         const fallback = selectFallbackModel(curModel, this._availableModels, this._circuitBreaker);
         if (!fallback) {
           this._logger.warn("queued_model_no_fallback", `${qp.config.name} queued model ${curKey} unhealthy and no healthy fallback available`);
           continue;
         }
         qp.config.model = fallback;
         // Sync stateManager copy if present
         try {
           const smParts = this._stateManager.getParticipants?.() ?? [];
           const target = smParts.find((s) => s.config?.id === qp.config.id);
           if (target) target.config.model = fallback;
         } catch {}
         this._logger.info("queued_model_reassigned", `${qp.config.name} — queued model ${curKey} unhealthy, reassigned to ${this._modelKey(fallback)} before turn`, { participant: qp.config.id, from: curKey, to: this._modelKey(fallback) });
         this._options.onProgress?.(`ℹ️ ${qp.config.name}'s scheduled model ${curKey} is unhealthy — switched to ${this._modelKey(fallback)}`);
         reassigned++;
       } catch (e) {
         this._logger.warn("queued_reassign_failed", `Failed to reassign queued model for ${qp?.config?.name}`, { error: e?.message });
       }
     }
     if (reassigned > 0) incrementKeyedCounter('queued_model_reassigned', `count:${reassigned}`);
   }

  _recordModelSuccess(model) {
    this._circuitBreaker.recordSuccess(model);
  }

  /**
   * Runs the prompt phase for a round. Agents speak sequentially — each sees
   * all prior same-round contributions before responding.
   */
  async runPromptPhase(round, activeParticipants) {
    this._turnOrder = [];
    const remainingSpeakers = [...activeParticipants];
    this._queuedSpeakers = remainingSpeakers;
    const spokenOrder = []; // Track agents that have spoken this round
    // Deferred patch tails (T2) in flight: each entry settles (merge+persist)
    // independently; the round joins them all before session cleanup/summary.
    this._pendingTails = [];
    // Round-scoped sessions: one per participant per round (Option A) — cuts ~70% session churn
    this._roundSessionIds = new Map();
    try {
      const creates = await Promise.all(activeParticipants.map(async (p) => {
        try {
          const sid = await this._options.createEphemeralSession(p);
          this._sessionManager.registerSessionMeeting(sid, this._stateManager.getMeetingId());
          return [p.config.id, sid];
        } catch (e) {
          this._logger.warn("round_session_create_failed", `Failed to create round session for ${p.config.name}`, extractErrorInfo(e));
          return null;
        }
      }));
      for (const entry of creates) {
        if (entry) {
          this._roundSessionIds.set(entry[0], entry[1]);
          this._stateManager.setParticipantSessionId?.(entry[0], entry[1]);
        }
      }
        if (this._roundSessionIds.size === 0) {
         // Clean up any partially created sessions before discarding map
        await this._cleanupRoundSessions([...this._roundSessionIds.values()]);
        this._roundSessionIds = null;
      }
    } catch {
      // Ensure partial sessions are cleaned on exception
      if (this._roundSessionIds) {
        await this._cleanupRoundSessions([...this._roundSessionIds.values()]);
      }
      this._roundSessionIds = null;
    }
    try {
      while (remainingSpeakers.length > 0) {
       const batchId = randomUUID();
      const p = remainingSpeakers.shift();
      p.currentBatchId = batchId;
      this._turnOrder.push(p.config.id);
      spokenOrder.push(p);
      this._db.setParticipantStatus(p.config.id, "speaking");
      this._options.onProgress?.(`${p.config.name} (${(p.config.category ?? p.config.tier)}) is thinking...`);
      let promptRes;
      try {
        promptRes = await this._promptChildSession(p);
      } catch (e) {
        promptRes = { result: null, error: e };
      }
      // Normalize: promptChildSession now returns {result,error} but guard null/undefined from old code or thrown non-object
      if (!promptRes || typeof promptRes !== "object") {
        promptRes = { result: null, error: new Error("promptChildSession returned null/undefined") };
      }
      const { result, error } = promptRes;
      await this._handlePromptResult(p, result, round, error);
      }
      // Join deferred tails BEFORE round-session cleanup and the round
      // summary: every tail's state must be final when the clerk observes it.
      await this._settlePendingTails();
    } finally {
        if (this._roundSessionIds) {
          await this._cleanupRoundSessions([...this._roundSessionIds.values()]);
          this._roundSessionIds = null;
        }
        this._queuedSpeakers = null;
    }
  }

  async _handlePromptResult(p, result, round, error) {
    const pendingStatePatch = this._stateManager.takeLastTurnPatch?.(p.config.id) ?? null;
    if (!result || error) {
      p.status = "failed";
      this._failedInCurrentRound++;
      this._db.setParticipantStatus(p.config.id, "failed");
      this._db.recordAgentError(
        this._stateManager.getMeetingId(), p.config.id, this._stateManager.getCurrentRound(),
        "no_response", `Failed to get response after retries${error ? `: ${error.message}` : ''}`, 2,
      );
      round.token_path.push(p.config.id);
      this._options.onProgress?.(`${p.config.name} (${(p.config.category ?? p.config.tier)}) — failed to respond${error ? `: ${error.message}` : ''}, skipping`);
      this._options.onContribution?.(p.config.name, this._stateManager.getCurrentRound(), "failed_no_response");
      return;
    }

    // Check for loom_pass tool call (primary) or [PASS] text (legacy fallback)
    const loomPassCall = result.tool_calls?.find(t => t.tool === "loom_pass" && t.status !== "error");
    const isPass = loomPassCall || result.content === "[PASS]";

    if (isPass) {
      p.status = "passed";
      this._db.setParticipantStatus(p.config.id, "passed");
      round.token_path.push(p.config.id);
      
      // Extract reason from loom_pass tool call or default
      let passReason = "[PASS]";
      if (loomPassCall) {
        try {
          const out = typeof loomPassCall.output === "string" ? JSON.parse(loomPassCall.output) : loomPassCall.output;
          passReason = out?.reason ?? "passed via loom_pass";
        } catch { passReason = "passed via loom_pass"; }
      }

      // Audit-first: a pass that executed tools still persists its tool_calls
      // so the research evidence is visible in Tool use.
      if (result.tool_calls && result.tool_calls.length > 0) {
        const passId = this._stateManager.nextContributionId();
        const passContribution = {
          id: passId,
          round: this._stateManager.getCurrentRound(),
          participant_id: result.participant_id,
          content: passReason,
          type: "pass",
          targets_which: null,
          batch_id: p.currentBatchId ?? randomUUID(),
          tool_calls: result.tool_calls,
          prompt_context: result.prompt_context ?? null,
          created_at: new Date().toISOString(),
        };
        this._stateManager.addContribution(passContribution);
        round.contributions.push(passContribution);
        try {
          this._db.addContributionWithStatePatch(this._stateManager.getMeetingId(), { ...passContribution, round: this._stateManager.getCurrentRound() });
        } catch (err) {
          this._logger.warn("pass_contribution_db_failed", `Failed to persist pass tool evidence for ${p.config.name}`, extractErrorInfo(err));
        }
        this._options.onProgress?.(`${p.config.name} (${(p.config.category ?? p.config.tier)}) — passed (${result.tool_calls.length} tool call(s) preserved)`);
      } else {
        this._options.onProgress?.(`${p.config.name} (${(p.config.category ?? p.config.tier)}) — chose to pass`);
      }
      this._options.onContribution?.(p.config.name, this._stateManager.getCurrentRound(), "pass");
      return;
    }

    this._handlePipelinedResult(p, result, round, pendingStatePatch);
  }

  /**
   * Pipelined handle (T2): the turn's prose committed to the weave already by
   * phase 1 (see executeAgentTurn deferTail), so the contribution is staged
   * for immediate visibility and the tail runs concurrently with the next
   * turn. The tail merge + DB persist land before the round summary observes
   * the state (see _settlePendingTails). Outputs are identical to sequential.
   */
  _handlePipelinedResult(p, result, round, pendingStatePatch) {
    const tailCtx = result[TAIL_DEFERRED] ?? null;
    if (!tailCtx) {
      this._storeContribution(p, result, round, pendingStatePatch);
      const truncated = truncate(result.content, 120);
      this._options.onProgress?.(`${p.config.name} (${(p.config.category ?? p.config.tier)}) — ${result.type}: "${truncated}"`);
      return;
    }
    const { contribution } = this._stageContribution(p, result, round, pendingStatePatch);
    const truncated = truncate(result.content, 120);
    this._options.onProgress?.(`${p.config.name} (${(p.config.category ?? p.config.tier)}) — ${result.type}: "${truncated}"`);
    this._options.onContribution?.(p.config.name, this._stateManager.getCurrentRound(), result.type);
    const task = this._runDeferredTail(p, round, contribution, result, tailCtx, pendingStatePatch);
    if (!Array.isArray(this._pendingTails)) this._pendingTails = [];
    this._pendingTails.push(task);
  }

  /**
   * Runs one deferred tail to completion: tail LLM → merge into the staged
   * contribution (same object refs the weave holds) → apply the tail-slot
   * patch → persist. Never rejects (failures are recorded as tail outcomes,
   * exactly like the sequential path).
   */
  async _runDeferredTail(p, round, contribution, result, tailCtx, pendingStatePatch = null) {
    const pid = p.config.id;
    const host = {
      stateManager: this._stateManager,
      sessionManager: this._sessionManager,
      logger: this._logger,
      options: this._options,
      callStats: this._callStats,
      notifyCallStats: () => { try { this._notifyCallStats(); } catch {} },
    };
    try {
      const tail = await runPatchTailPhase(host, tailCtx, { useTailSlot: true });
      this._mergeTailIntoContribution(p, contribution, result, tail);
      // Atomic patch from a pre-tail take is near-impossible here (the take
      // runs before the tail completes), but thread it through when present.
      // Otherwise the tail slot becomes the atomic patch — the exact shape
      // the sequential path persists (contribution + state in one write, no
      // separate audit row), so a crash between persist and apply is
      // impossible by construction.
      let atomicStatePatch = null;
      if (pendingStatePatch?.state) {
        try {
          const nextState = structuredClone(pendingStatePatch.state);
          nextState.updated_round = this._stateManager.getCurrentRound();
          nextState.updated_contribution_id = contribution.id;
          atomicStatePatch = {
            participantId: pid,
            round: this._stateManager.getCurrentRound(),
            version: nextState.version,
            state: nextState,
            patchJson: pendingStatePatch.input ?? {},
            appliedJson: pendingStatePatch.output ?? {},
          };
        } catch {}
      }
      if (!atomicStatePatch) {
        atomicStatePatch = this._takeTailAtomic(pid, contribution);
      }
      this._persistStagedContribution(p, contribution, round, result, atomicStatePatch);
    } catch (err) {
      try {
        this._logger.warn("deferred_tail_failed", `Deferred tail for ${p.config.name} failed unexpectedly — persisting prose without tail merge`, extractErrorInfo(err));
      } catch {}
      try {
        this._persistStagedContribution(p, contribution, round, result, null);
      } catch {}
    } finally {
      try {
        if (tailCtx?.abortController && this._abortControllers) this._abortControllers.delete(tailCtx.abortController);
      } catch {}
      try {
        if (tailCtx?.deleteSession && tailCtx?.ephemeralSessionId) {
          await this._options.deleteEphemeralSession(tailCtx.ephemeralSessionId).catch((err) => {
            this._logger.warn("ephemeral_session_delete_failed", "Failed to clean up ephemeral session", extractErrorInfo(err));
          });
        }
      } catch {}
    }
  }

  /**
   * Merges tail output into the staged contribution in place: appended tail
   * tool calls, state_patch version, and prompt_context outcome fields. Same
   * values computePatchOutcome yields on the sequential path.
   */
  _mergeTailIntoContribution(p, contribution, result, tail) {
    try {
      const mappedTail = mapToolResults(tail.tailCalls ?? []);
      // Stage stores one shared array reference (contribution.tool_calls IS
      // result.tool_calls); unify defensively, then append tail calls once.
      if (!Array.isArray(contribution.tool_calls)) contribution.tool_calls = [];
      result.tool_calls = contribution.tool_calls;
      for (const t of mappedTail) contribution.tool_calls.push(t);
    } catch {}
    try {
      const { outcome, detail } = computePatchOutcome({
        patchEnabled: true,
        statePatchVersion: tail.statePatchVersion,
        loomPassCall: null,
        tailRejected: tail.tailRejected,
        tailAttempted: tail.tailAttempted,
        tailDetail: tail.tailDetail,
        finalToolResults: tail.finalToolResults,
      });
      if (tail.statePatchVersion != null) {
        result.state_patch = { version: tail.statePatchVersion };
      }
      const ctx = contribution.prompt_context;
      if (ctx && typeof ctx === "object") {
        ctx.state_patch_outcome = outcome;
        if (detail) ctx.state_patch_detail = detail;
      }
      const rctx = result.prompt_context;
      if (rctx && typeof rctx === "object") {
        rctx.state_patch_outcome = outcome;
        if (detail) rctx.state_patch_detail = detail;
      }
    } catch {}
  }

  /**
   * Shapes a completed tail slot as the atomic patch the sequential path
   * persists (contribution + state in one write, no separate audit row), so a
   * crash between persist and apply is impossible by construction. Consumes
   * the slot; returns null when the tail produced no patch.
   */
  _takeTailAtomic(pid, contribution) {
    try {
      const slot = this._stateManager.takeTailPatch?.(pid) ?? null;
      if (!slot?.state) return null;
      const nextState = structuredClone(slot.state);
      nextState.updated_round = this._stateManager.getCurrentRound();
      nextState.updated_contribution_id = contribution.id;
      return {
        participantId: pid,
        round: this._stateManager.getCurrentRound(),
        version: nextState.version,
        state: nextState,
        patchJson: slot.input ?? {},
        appliedJson: slot.output ?? {},
      };
    } catch {
      return null;
    }
  }

  /** Joins all in-flight deferred tails (all-settled; failures already recorded). */
  async _settlePendingTails() {
    const pending = this._pendingTails ?? [];
    this._pendingTails = [];
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }



  /**
   * In-memory stage of a contribution (T2): assigns the id, commits to the
   * weave/round (visible to subsequent turns' transcripts immediately), and
   * flips the seat back to listening. DB persistence happens separately so a
   * pipelined tail can overlap the next turn.
   * @returns {{ contribution, atomicStatePatch }}
   */
  _stageContribution(participant, result, round, pendingStatePatch = null) {
    const id = this._stateManager.nextContributionId();
    const safeContent = sanitizeAgentOutput(result.content);
    const batchId = participant.currentBatchId ?? randomUUID();
    const contribution = {
      id,
      round: this._stateManager.getCurrentRound(),
      participant_id: result.participant_id,
      content: safeContent,
      type: result.type,
      targets_which: null,
      batch_id: batchId,
      tool_calls: result.tool_calls ?? null,
      prompt_context: result.prompt_context ?? null,
      created_at: new Date().toISOString(),
    };
    let atomicStatePatch = null;
    if (pendingStatePatch?.state) {
      const nextState = structuredClone(pendingStatePatch.state);
      nextState.updated_round = this._stateManager.getCurrentRound();
      nextState.updated_contribution_id = id;
      atomicStatePatch = {
        participantId: participant.config.id,
        round: this._stateManager.getCurrentRound(),
        version: nextState.version,
        state: nextState,
        patchJson: pendingStatePatch.input ?? {},
        appliedJson: pendingStatePatch.output ?? {},
      };
    }

    this._stateManager.addContribution(contribution);
    round.contributions.push(contribution);
    round.token_path.push(participant.config.id);
    // Derived count: recompute from weave to avoid drift across event types
    this._stateManager.incrementParticipantContributions(participant.config.id);
    participant.status = "listening";
    this._db.setParticipantStatus(participant.config.id, "listening");
    return { contribution, atomicStatePatch };
  }

  /**
   * Durable persist of a staged contribution (T2): the atomic
   * contribution+state write plus the state-patch audit row. Runs immediately
   * for sequential turns, or at deferred-tail completion for pipelined turns —
   * either way before the round summary observes the state.
   */
  _persistStagedContribution(participant, contribution, round, result, atomicStatePatch = null) {
    let contributionPersisted = false;
    try {
      this._db.addContributionWithStatePatch(this._stateManager.getMeetingId(), {
        ...contribution,
        round: this._stateManager.getCurrentRound(),
      }, atomicStatePatch);
      contributionPersisted = true;
      if (atomicStatePatch) {
        this._stateManager.setParticipantState(participant.config.id, atomicStatePatch.state);
        this._stateManager.linkStateToContribution?.(participant.config.id, contribution.id);
      }
    } catch (err) {
      const info = extractErrorInfo(err);
      this._logger.error("contribution_db_failed", `Failed to persist ${result.type} for ${participant.config.name} — rolling back in-memory weave; meeting continues degraded`, info);
      // Atomicity: remove the just-pushed contribution from weave/round to avoid memory/DB divergence
      try {
        // Remove by id: with pipelined tails later turns may have staged
        // since, so the entry is not necessarily last.
        const weave = this._stateManager.getWeave();
        const widx = weave.findIndex((c) => c && c.id === contribution.id);
        if (widx >= 0) weave.splice(widx, 1);
        const idx = round.contributions.findIndex((c) => c.id === contribution.id);
        if (idx >= 0) round.contributions.splice(idx, 1);
        // Reconcile count
        const p = this._stateManager.getParticipant(participant.config.id);
        if (p && p.contributions_count > 0) p.contributions_count--;
      } catch {}
      try { this._db.setPersistenceDegraded(true); } catch {}
      try {
        this._db.recordAgentError(
          this._stateManager.getMeetingId(), participant.config.id, this._stateManager.getCurrentRound(),
          "contribution_persist_failed", `${err.message} — tool_calls and content not durable`, 1,
        );
      } catch {}
      if (!this._dbFailedThisMeeting) this._dbFailedThisMeeting = new Set();
      this._dbFailedThisMeeting.add(participant.config.id);
      participant.status = "failed";
      try { this._db.setParticipantStatus(participant.config.id, "failed"); } catch {}
    }

    try {
      const patchCall = (result.tool_calls ?? []).find((t) => t.tool === "loom_state_patch" && t.metadata?.applied === true);
      if (patchCall && contributionPersisted && !atomicStatePatch) {
        try { this._stateManager.linkStateToContribution?.(participant.config.id, contribution.id); } catch {}
        try {
          const v = patchCall.metadata?.version;
          if (Number.isFinite(v) && typeof this._db.addStatePatch === "function") {
            this._db.addStatePatch({
              participantId: participant.config.id,
              round: this._stateManager.getCurrentRound(),
              contributionId: contribution.id,
              version: v,
              patchJson: patchCall.input,
              appliedJson: patchCall.output,
            });
          }
        } catch {}
        try {
          const st = this._stateManager.getParticipantState?.(participant.config.id);
          if (st && typeof this._db.setParticipantState === "function") this._db.setParticipantState(participant.config.id, st);
        } catch {}
      }
    } catch {}

    // (No onContribution here: the caller fires it — at stage time for
    // pipelined turns so the room sees prose immediately, at persist time
    // for legacy sequential turns.)
  }

  /**
   * Legacy single call: stage + persist + notify. Behavior identical to the
   * pre-pipeline path; used for pass/fail/sequential turns.
   */
  _storeContribution(participant, result, round, pendingStatePatch = null) {
    const { contribution, atomicStatePatch } = this._stageContribution(participant, result, round, pendingStatePatch);
    this._persistStagedContribution(participant, contribution, round, result, atomicStatePatch);
    this._options.onContribution?.(participant.config.name, this._stateManager.getCurrentRound(), result.type);
  }
  async _promptChildSession(participant) {
    return promptChildSessionHelper.call(this, participant);
  }
  _recordFallbackFailure(participant, originalModel, fallbackModel, error) {
    return recordFallbackFailureHelper.call(this, participant, originalModel, fallbackModel, error);
  }
  async _executeAgentTurn(participant, model, timeoutMs, promptContext, opts = {}) {
    return executeAgentTurnHelper.call(this, participant, model, timeoutMs, promptContext, opts);
  }
  _buildToolsMap(config, opts = {}) {
    return buildToolsMapHelper(config, opts);
  }
  _buildToolsMapWithoutLoom(config, opts = {}) {
    return buildToolsMapWithoutLoomHelper(config, opts);
  }

  _abortControllers = new Set();

  _abortInflight() {
    for (const c of this._abortControllers) {
      try { c.abort(); } catch {}
    }
    this._abortControllers.clear();
  }

  async _cleanupRoundSessions(sessionIds) {
    // Parallel with per-session timeout 10s — increased from 3s for concurrent meeting load
    const results = await Promise.allSettled(sessionIds.map(async (sid) => {
      try {
        await Promise.race([
          this._sessionManager.deleteEphemeralSession(sid),
          new Promise((_, rej) => setTimeout(() => rej(new Error("cleanup timeout")), 10000)),
        ]);
      } catch (err) {
        // Session already deleted is success (idempotent)
        if (err?.message && /session not found|not found|404/i.test(err.message)) return;
        throw err;
      }
    }));
    let failed = 0;
    for (const r of results) if (r.status === "rejected") failed++;
    if (failed > 0) this._logger.warn("round_session_cleanup_partial", `${failed}/${sessionIds.length} round sessions failed to delete`);
    else if (results.some((r) => r.status === "fulfilled")) {
      // No warning needed on clean path — timeouts now rare at 10s
    }
  }
}

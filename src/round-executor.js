import { buildQueryPrompt, buildEvidencePrompt, buildSummonPrompt, buildVotePrompt } from "./prompts/interaction-prompts.js";
import { buildAgentSystemPrompt, buildAgentUserPrompt } from "./prompts/agent.js";
import { parseAgentResponse } from "./validation.js";
import { getConfig, resolveBuiltInTools, resolveLoomTools } from "./config.js";
import { extractAgentResponse, mapToolResults, truncate, extractFileBlockTools, getPriorityCap } from "./shared.js";
import { getPersonas } from "./composer.js";
import { Logger, extractErrorInfo } from "./logger.js";
import { sanitizeForPrompt, sanitizeForDisplay, sanitizeAgentOutput } from "./utils/sanitize.js";
import { CircuitBreaker } from "./utils/retry.js";
import { selectFallbackModel } from "./services/model-service.js";
import { incrementKeyedCounter, recordLatency } from "./metrics.js";
import { extractVoteLetter, buildTally } from "./utils/vote-tally.js";
import { degrade } from "./utils/degrade.js";
import { randomUUID } from "node:crypto";
import { promptChildSession as promptChildSessionHelper, executeAgentTurn as executeAgentTurnHelper, recordFallbackFailure as recordFallbackFailureHelper } from "./round-executor/agent-turn.js";
import { buildToolsMap as buildToolsMapHelper, buildToolsMapWithoutLoom as buildToolsMapWithoutLoomHelper } from "./round-executor/tools.js";

export { extractVoteLetter };

export class RoundExecutor {
  _db;
  _stateManager;
  _vectorIndex;
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

  constructor({ db, stateManager, vectorIndex, options, sessionManager, promptParent, getParticipantModel, logError, tools = null, availableModels = [] }) {
    this._db = db;
    this._stateManager = stateManager;
    this._vectorIndex = vectorIndex;
    this._options = options;
    this._sessionManager = sessionManager;
    this._promptParent = promptParent;
    this._getParticipantModel = getParticipantModel;
    this._logError = logError;
    this._tools = tools;
    this._availableModels = availableModels;
    this._failureCounts = new Map();
    this._modelFailureTimes = new Map();
    this._logger = new Logger();
    this._callStats = { agent_prompts: 0, reflection_calls: 0, input_tokens: 0, output_tokens: 0 };
    const cbConfig = getConfig().circuitBreaker;
    this._circuitBreaker = new CircuitBreaker({
      failureThreshold: cbConfig.failureThreshold,
      resetTimeoutMs: cbConfig.resetTimeoutMs,
    });
  }

  _failedInCurrentRound = 0;
  _deadline = null;
  _roundSessionIds = null;
  _dbFailedThisMeeting = null;

  setDeadline(deadline) {
    this._deadline = deadline;
  }

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
    if (state.failures >= this._circuitBreaker.failureThreshold) {
      this._options.onProgress?.(`⚠️ Model ${this._modelKey(model)} marked unhealthy after ${state.failures} consecutive failures. Will retry in ${this._circuitBreaker.resetTimeoutMs / 60000} minutes.`);
      this._logger.warn("circuit_breaker", `Model ${this._modelKey(model)} marked unhealthy`, { failures: state.failures });
    }
   }

  _recordModelSuccess(model) {
    this._circuitBreaker.recordSuccess(model);
  }

  _recordTokens(result) {
    const tokens = result?.data?.tokens;
    if (!tokens) return;
    this._callStats.input_tokens += tokens.input ?? 0;
    this._callStats.output_tokens += tokens.output ?? 0;
  }

  /**
   * Runs the prompt phase for a round. Agents speak sequentially — each sees
   * all prior same-round contributions before responding.
   */
  async runPromptPhase(round, activeParticipants) {
    this._turnOrder = [];
    const remainingSpeakers = [...activeParticipants];
    const spokenOrder = []; // Track agents that have spoken this round
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
        if (entry) this._roundSessionIds.set(entry[0], entry[1]);
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
    // Deadline helper that also marks skipped speakers as passed internally for accounting
    const skipped = [];
    try {
      while (remainingSpeakers.length > 0) {
      if (this._deadline && Date.now() > this._deadline - 1000) {
        this._logger.warn("deadline_exceeded", `Deadline exceeded mid-round — stopping ${remainingSpeakers.length} remaining speakers`);
        this._options.onProgress?.(`⏱️ Deadline reached — skipping remaining ${remainingSpeakers.length} speakers`);
        skipped.push(...remainingSpeakers.splice(0));
        break;
      }
      const batchId = randomUUID();
      const p = remainingSpeakers.shift();
      p.currentBatchId = batchId;
      this._turnOrder.push(p.config.id);
      spokenOrder.push(p);
      this._db.setParticipantStatus(p.config.id, "speaking");
      this._options.onProgress?.(`${p.config.name} (${p.config.tier}) is thinking...`);
      const result = await this._promptChildSession(p);
      await this._handlePromptResult(p, result, round);
      }
    } finally {
        if (skipped.length > 0) {
          for (const p of skipped) {
            try {
              this._db.recordAgentError(this._stateManager.getMeetingId(), p.config.id, this._stateManager.getCurrentRound(), "deadline_skipped", "Skipped due to meeting deadline", 0);
            } catch {}
          }
        }
        if (this._roundSessionIds) {
          await this._cleanupRoundSessions([...this._roundSessionIds.values()]);
          this._roundSessionIds = null;
        }
    }
  }

  async _handlePromptResult(p, result, round) {
    if (!result) {
      p.status = "failed";
      this._failedInCurrentRound++;
      this._db.setParticipantStatus(p.config.id, "failed");
      this._db.recordAgentError(
        this._stateManager.getMeetingId(), p.config.id, this._stateManager.getCurrentRound(),
        "no_response", "Failed to get response after retries", 2,
      );
      round.token_path.push(p.config.id);
      this._options.onProgress?.(`${p.config.name} (${p.config.tier}) — failed to respond, skipping`);
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
          this._db.addContributionWithTurnRequest(this._stateManager.getMeetingId(), { ...passContribution, round: this._stateManager.getCurrentRound() }, null);
        } catch (err) {
          this._logger.warn("pass_contribution_db_failed", `Failed to persist pass tool evidence for ${p.config.name}`, extractErrorInfo(err));
        }
        this._options.onProgress?.(`${p.config.name} (${p.config.tier}) — passed (${result.tool_calls.length} tool call(s) preserved)`);
      } else {
        this._options.onProgress?.(`${p.config.name} (${p.config.tier}) — chose to pass`);
      }
      this._options.onContribution?.(p.config.name, this._stateManager.getCurrentRound(), "pass");
      return;
    }

    this._storeContribution(p, result, round);

    const truncated = truncate(result.content, 120);
    this._options.onProgress?.(`${p.config.name} (${p.config.tier}) — ${result.type}: "${truncated}"`);
  }



  _storeContribution(participant, result, round) {
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

    this._stateManager.addContribution(contribution);
    round.contributions.push(contribution);
    round.token_path.push(participant.config.id);
    // Derived count: recompute from weave to avoid drift across event types
    this._stateManager.incrementParticipantContributions(participant.config.id);
    participant.status = "listening";
    this._db.setParticipantStatus(participant.config.id, "listening");

    // Store turn order request (replaces interjection)
    let turnRequest = null;
    if (result.request_next) {
      turnRequest = {
        participant_id: result.participant_id,
        round: this._stateManager.getCurrentRound(),
        priority: result.request_next.priority,
        reason: sanitizeForPrompt(result.request_next.reason),
      };
      if (!round.turn_requests) round.turn_requests = [];
      round.turn_requests.push(turnRequest);
    }

    // Main-turn DB insert: a failure must NOT abort the entire meeting — the
    // contribution already exists in memory. Record an agent error instead.
    try {
      this._db.addContributionWithTurnRequest(this._stateManager.getMeetingId(), {
        ...contribution,
        round: this._stateManager.getCurrentRound(),
      }, turnRequest);
    } catch (err) {
      const info = extractErrorInfo(err);
      this._logger.error("contribution_db_failed", `Failed to persist ${result.type} for ${participant.config.name} — rolling back in-memory weave; meeting continues degraded`, info);
      // Atomicity: remove the just-pushed contribution from weave/round to avoid memory/DB divergence
      try {
        const weave = this._stateManager.getWeave();
        if (weave.length > 0 && weave[weave.length - 1].id === contribution.id) {
          weave.pop();
          // Also pop from round contributions
          const idx = round.contributions.findIndex((c) => c.id === contribution.id);
          if (idx >= 0) round.contributions.splice(idx, 1);
          // Reconcile count
          const p = this._stateManager.getParticipant(participant.config.id);
          if (p && p.contributions_count > 0) p.contributions_count--;
        }
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

    this._options.onContribution?.(participant.config.name, this._stateManager.getCurrentRound(), result.type);
  }
  async _promptChildSession(participant) {
    return promptChildSessionHelper.call(this, participant);
  }
  _recordFallbackFailure(participant, originalModel, fallbackModel, error) {
    return recordFallbackFailureHelper.call(this, participant, originalModel, fallbackModel, error);
  }
  async _executeAgentTurn(participant, model, timeoutMs, promptContext) {
    return executeAgentTurnHelper.call(this, participant, model, timeoutMs, promptContext);
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

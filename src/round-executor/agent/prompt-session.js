import { buildAgentSystemPrompt, buildAgentUserPrompt } from "../../prompts/agent.js";
import { getConfig, resolveBuiltInTools, resolveLoomTools } from "../../config.js";
import { extractAgentResponse, mapToolResults, extractFileBlockTools, getPriorityCap } from "../../shared.js";
import { parseAgentResponse } from "../../validation.js";
import { sanitizeAgentOutput } from "../../utils/sanitize.js";
import { withRetry, isRetryableError } from "../../utils/retry.js";
import { selectFallbackModel } from "../../services/model-service.js";
import { incrementKeyedCounter, recordLatency } from "../../metrics.js";
import { extractErrorInfo } from "../../logger.js";
import { buildToolsMap, buildToolsMapWithoutLoom } from "../tools.js";
import { delimitContext } from "../../prompts/delimiters.js";

export async function promptChildSession(participant) {
  const prevStatus = participant.status;
  participant.status = "speaking";
  let localSucceeded = false;
  try {

  const model = this._getParticipantModel(participant);
  // Ensure per-meeting agentTools override (plan/build) is visible to prompts that call getConfig()
  try {
    const eff = this._options?.agentTools ?? this._tools;
    if (eff) globalThis.__loomAgentToolsOverride = eff;
  } catch {}
  const config = getConfig();
  const fallbackConfig = config.modelFallback;

  const baseTimeoutMsRaw = config.agentTimeoutMs;
  // 0 = no client timeout, rely on provider errors / stall watchdog (P3)
  const baseTimeoutMs = baseTimeoutMsRaw === 0 ? 0 : (Number.isFinite(baseTimeoutMsRaw) ? Math.max(10000, Math.min(600000, baseTimeoutMsRaw)) : 240000);
  const timeoutMsBase = baseTimeoutMs;
  let timeoutMs = timeoutMsBase;
  // Deadline is disabled (P1 Option A -> Infinity), so this block is now no-op for normal runs.
  // Kept for internal API where meetingTimeoutMs may be set directly.
  if (timeoutMs !== 0 && this._deadline && Number.isFinite(this._deadline) && this._deadline !== Infinity) {
    const remaining = this._deadline - Date.now();
    // Only clamp when meeting deadline is actually constraining; never punish
    // a healthy 60-120s base timeout down to 5s — that guaranteed failure for
    // tool-heavy turns (loom_query/vote/summon each need 60-90s). Use a 30s
    // floor and only shave off 1s buffer when well clear of expiry.
    if (Number.isFinite(remaining) && remaining < timeoutMsBase) {
      if (remaining <= 5000) {
        // Deadline truly imminent — allow a degraded but non-trivial window
        // rather than 5s (which always times out). Let the weaving loop's
        // deadline_exceeded guard handle skipping remaining speakers instead.
        timeoutMs = Math.max(15000, Math.min(timeoutMsBase, remaining - 500));
        this._logger.warn("deadline_clamped_floor", `${participant.config.name} — deadline ${remaining}ms remaining, using degraded ${timeoutMs}ms timeout (floor 15s)`);
      } else if (remaining < 30000) {
        timeoutMs = Math.max(20000, Math.min(timeoutMsBase, remaining - 1000));
      } else {
        timeoutMs = Math.min(timeoutMsBase, remaining - 1000);
      }
    }
  }

  const currentRound = this._stateManager.getCurrentRound();

  let recentContribs = this._stateManager.getWeave().filter((c) => c.round != null && c.round >= currentRound - 1);

  // Forum topics for prompt — most recent activity first (max created/latest comment)
  let forumTopicsForPrompt = [];
  try {
    if (this._db?.listForumTopicsForPrompt) {
      forumTopicsForPrompt = this._db.listForumTopicsForPrompt(10) ?? [];
    } else if (this._database?.listForumTopicsForPrompt) {
      forumTopicsForPrompt = this._database.listForumTopicsForPrompt(10) ?? [];
    }
  } catch {}

  const recentForPrompt = this._stateManager.getWeave().filter(
    (c) => c.round != null && c.round >= currentRound - 1 && c.type !== "vote_response" && c.type !== "reflection",
  ).slice(-20);

  const activeCountPS = (() => { try { return this._stateManager.getActiveParticipants().length; } catch { return undefined; }})();
  const systemPrompt = buildAgentSystemPrompt(participant, { activeCount: activeCountPS });
  let steeringHint = "";
  let consumedHint = "";
  // Atomic consume — hintLocked flag prevents double-consume if two promptChildSessions race
  if (!this._hintLocked) {
    this._hintLocked = true;
    try {
      const plannedFirst = this._stateManager.getPlannedTurnOrder?.()?.[0] ?? this._stateManager.getNextSpeakerId?.();
      const isFirstSpeaker = !plannedFirst || plannedFirst === participant.config.id;
      if (isFirstSpeaker) consumedHint = this._stateManager.consumeNextRoundSteering();
      steeringHint = consumedHint;
    } catch {}
    // release lock after microtask so same-round second speaker can't re-consume same hint
    queueMicrotask(() => { this._hintLocked = false; });
  }
  const userPromptBase = buildAgentUserPrompt(
    participant,
    this._stateManager.getStateOfPlay(),
    recentForPrompt,
    currentRound,
    this._stateManager.getQuestion(),
    this._stateManager.getTags(),
    this._stateManager.getContext?.() ?? "",
    forumTopicsForPrompt,
  );
  const userPrompt = steeringHint ? `${userPromptBase}\n\n${delimitContext(steeringHint, "STEERING_HINT")}` : userPromptBase;

  const promptContext = {
    type: "agent_turn",
    system_prompt: systemPrompt,
    user_prompt: userPrompt,
    state_of_play: this._stateManager.getStateOfPlay(),
    recent_contributions: recentForPrompt.map((c) => ({
      id: c.id, participant_id: c.participant_id, type: c.type,
      content: c.content, targets_which: c.targets_which,
    })),
    reflection: participant.reflection || null,
    question: this._stateManager.getQuestion(),
    tags: this._stateManager.getTags(),
    round: currentRound,
  };

  let activeModel = model;
  if (!this._circuitBreaker.isHealthy(model)) {
    this._logger.warn("model_unhealthy", `${participant.config.name} — model ${this._modelKey(model)} unhealthy, attempting fallback`);
    const fallback = selectFallbackModel(model, this._availableModels, this._circuitBreaker);
    if (!fallback) {
      const err = new Error("circuit breaker open, no fallback");
      this._logError(`model ${this._modelKey(model)} unhealthy and no fallback available`, err);
      return { result: null, error: err };
    }
    activeModel = fallback;
  }

  const maxRetries = fallbackConfig.enabled ? fallbackConfig.maxRetriesPerModel : 0;
  const lastError = { value: null };

  // Inline loom_* tools (query/evidence/vote/summon) execute SERVER-SIDE during
  // session.prompt and persist their own contributions immediately. If an attempt
  // times out or errors after those side effects landed, the retry's response will
  // not contain those ToolParts — the audit trail lives in the weave rows instead.
  const warnPossibleSideEffects = (err) => {
    this._logger.warn("attempt_failed_possible_tool_side_effects", `${participant.config.name} — attempt failed after inline loom tools may have executed; peer contributions may exist in the weave without appearing in this turn's tool_calls`, {
      participant: participant.config.id,
      round: currentRound,
      error: err?.message ?? String(err),
    });
  };

  const collectExistingLoomResults = () => {
    try {
      const weave = this._stateManager.getWeave ? this._stateManager.getWeave() : [];
      const candidates = (() => {
        const s = new Set();
        if (participant.currentBatchId) s.add(participant.currentBatchId);
        const mid = (() => { try { return this._stateManager.getMeetingId?.() ?? this._stateManager.getState?.()?.id ?? null; } catch { return null; }})();
        const rnd = currentRound;
        if (mid) {
          s.add(`inline-${mid}-${rnd}-${participant.config.id}`);
          const all = this._stateManager.getParticipants?.() ?? [];
          for (const p of all) if (p?.currentBatchId) s.add(p.currentBatchId);
          for (const p of all) s.add(`inline-${mid}-${rnd}-${p?.config?.id}`);
        }
        return s;
      })();
      const existing = weave.filter((c) => {
        if (c.round !== currentRound) return false;
        const isBatch = candidates.has(c.batch_id) || candidates.has(c.prompt_context?.source_batch_id);
        // broader fallback: same round + source_participant_id === this participant
        const isSourceMatch = c.prompt_context?.source_participant_id === participant.config.id;
        const isType = ["query_response","evidence_response","perspective_response","critique_response","vote_response","summoned_response"].includes(c.type);
        return isType && (isBatch || isSourceMatch);
      });
      return existing;
    } catch { return []; }
  };

   const trySynthesisFromExisting = async (modelForSynthesis, remainingTimeout) => {
   try {
     const existing = collectExistingLoomResults();
     if (existing.length === 0) return null;
     // If requested model is globally/per-model unhealthy, switch to best healthy for recovery
     let synthesisModel = modelForSynthesis;
     if (!this._circuitBreaker.isHealthy(synthesisModel)) {
       const alt = selectFallbackModel(synthesisModel, this._availableModels, this._circuitBreaker);
       if (alt) {
         this._logger.info("synthesis_recovery_model_switched", `Synthesis recovery for ${participant.config.name} switching from unhealthy ${this._modelKey(synthesisModel)} to ${this._modelKey(alt)}`);
         synthesisModel = alt;
       } else {
         this._logger.warn("synthesis_recovery_no_healthy", `Synthesis recovery for ${participant.config.name} — no healthy model available, proceeding with ${this._modelKey(synthesisModel)} anyway`);
       }
     }
    // Build loomOutputs text from existing contributions for synthesis (mirrors execute-turn synthesis)
    const loomOutputsRaw = existing.map((c) => {
      const src = c.prompt_context?.source_participant_id ? `batch ${c.prompt_context.source_batch_id ?? c.batch_id}` : `batch ${c.batch_id}`;
      const toolHint = c.type === "vote_response" ? "loom_vote" : c.type === "summoned_response" ? "loom_summon" : "loom_query";
      const content = (c.content ?? "").slice(0, 800);
      return `Tool ${toolHint} (${c.id}) via ${src} returned:\n${content}`;
    }).join("\n\n");
    if (!loomOutputsRaw.trim()) return null;
    // Truncate similar to execute-turn (12k)
    const loomOutputs = loomOutputsRaw.slice(0, 12000);
    const synthesisInstruction = `Loom tool results RECOVERED from earlier attempt (reused, not re-executed — ${existing.length} peer contribution(s) already persisted for batch ${participant.currentBatchId}):\n${loomOutputs}\n\nNow synthesize your final contribution incorporating these responses. Cite [#id] when referencing peer answers. Do not re-call loom_query/loom_vote/loom_summon — you have the results. Stay in character and follow OUTPUT CONTRACT.`;
    const activeCountExec = (() => { try { return this._stateManager.getActiveParticipants().length; } catch { return undefined; }})();
    const synthesisToolsMap = buildToolsMapWithoutLoom(config, { activeCount: activeCountExec });
    // Always create a fresh ephemeral session for recovery — reusing the round-scoped
    // session risks "session busy" if the timed-out prompt is still draining server-side.
    let ephemeralSessionId;
    try { ephemeralSessionId = await this._options.createEphemeralSession(participant); this._sessionManager.registerSessionMeeting(ephemeralSessionId, this._stateManager.getMeetingId()); } catch { return null; }
    const synthRemaining = (() => {
      let rem = remainingTimeout === 0 ? Infinity : remainingTimeout;
      if (this._deadline && Number.isFinite(this._deadline) && this._deadline !== Infinity) {
        const dl = this._deadline - Date.now();
        if (dl < 15000) return 0;
        rem = Math.min(rem, Math.max(15000, dl - 1000));
      }
      return rem;
    })();
    if (synthRemaining !== Infinity && synthRemaining <= 0) {
      if (ephemeralSessionId) { try { await this._options.deleteEphemeralSession(ephemeralSessionId); } catch {} try { this._sessionManager.unregisterSession(ephemeralSessionId); } catch {} }
      return null;
    }
    this._logger.info("synthesis_recovery", `Attempting synthesis recovery for ${participant.config.name} with ${existing.length} existing loom result(s)`, { batchId: participant.currentBatchId, existingCount: existing.length, remainingMs: synthRemaining });
     let result2;
    try {
      result2 = await this._sessionManager.getContract().prompt({
        sessionId: ephemeralSessionId,
        system: promptContext.system_prompt,
        model: synthesisModel,
        parts: [
          { type: "text", text: promptContext.user_prompt },
          { type: "text", text: synthesisInstruction },
        ],
        tools: synthesisToolsMap,
        toolChoice: Object.keys(synthesisToolsMap).length > 0 ? "auto" : undefined,
        timeoutMs: synthRemaining,
      });
    } finally {
      if (ephemeralSessionId) {
        try { await this._options.deleteEphemeralSession(ephemeralSessionId); } catch {}
        try { this._sessionManager.unregisterSession(ephemeralSessionId); } catch {}
      }
    }
    if (!result2.ok) {
        this._logger.warn("synthesis_recovery_failed", `Synthesis recovery prompt failed for ${participant.config.name}: ${result2.error?.message ?? "unknown"}`);
        return null;
      }
      // Reuse already-imported helpers (avoid dynamic import overhead in recovery path)
      const ear = extractAgentResponse;
      const mtr = mapToolResults;
      const gpc = getPriorityCap;
      const sanitize = sanitizeAgentOutput;
      const parseResp = parseAgentResponse;
      const { text: agentText2, toolResults: toolResults2 } = ear(result2.data);
      if (!agentText2 || agentText2.trim().length < 10) {
        this._logger.warn("synthesis_recovery_empty", `Synthesis recovery for ${participant.config.name} returned empty`);
        return null;
      }
      // Map existing loom contributions as tool_calls for audit, plus any synthesis tools
      const existingToolCalls = existing.map((c) => ({
        tool: c.type === "vote_response" ? "loom_vote" : c.type === "summoned_response" ? "loom_summon" : "loom_query",
        callID: `reused-${c.id}`,
        status: "completed",
        output: JSON.stringify({ reused: true, contributionId: c.id, type: c.type, content: (c.content ?? "").slice(0,500) }),
        title: `reused:${c.type}:${c.id}`,
        metadata: { reused: true, inline: true },
      }));
      const effective2 = mtr(toolResults2 ?? []);
      const safeContent = sanitize(agentText2);
      let response = parseResp(participant.config.id, safeContent, participant.config.tier);
      if (!response) {
        response = { participant_id: participant.config.id, content: safeContent.slice(0,5000) || "[No content after sanitization]", type: "contribution", request_next: null, query: null, evidence: null, summon: null, vote: null };
      }
      response.tool_calls = [...existingToolCalls, ...(effective2 ?? [])];
      // Extract loom_request_next if present in synthesis tool results
      try {
        for (const t of response.tool_calls) {
          if (t.tool === "loom_request_next" && t.status !== "error") {
            const inp = typeof t.input === "object" ? t.input : (t.input ? JSON.parse(t.input) : {});
            const priority = typeof inp.priority === "number" ? inp.priority : parseInt(inp.priority, 10);
            const reason = typeof inp.reason === "string" ? inp.reason : "";
            if (Number.isFinite(priority) && reason.trim().length > 0) {
              const cap = gpc(participant.config.tier);
              response.request_next = { priority: Math.min(10, Math.max(1, priority), cap), reason: reason.slice(0,200) };
              break;
            }
          }
        }
      } catch {}
      response.prompt_context = promptContext;
      this._recordModelSuccess(synthesisModel);
      this._options.onAgentComplete?.(participant.config.id, response.content);
      return response;
  } catch (e) {
      this._logger.warn("synthesis_recovery_error", `Synthesis recovery error for ${participant.config.name}: ${e.message}`, extractErrorInfo(e));
      return null;
  }
  };

  let succeeded = false;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await this._executeAgentTurn(participant, activeModel, timeoutMs, promptContext);
      succeeded = true;
      localSucceeded = true;
      if (consumedHint) consumedHint = "";
      return { result: response, error: null };
    } catch (err) {
      lastError.value = err;
      const info = extractErrorInfo(err);
      if (isRetryableError(err)) this._recordModelFailure(activeModel);
      // Always warn if side effects may exist (not just attempt>0) — check weave
      const hasExisting = collectExistingLoomResults().length > 0;
      if (attempt > 0 || err?.message === "Empty agent response" || hasExisting) warnPossibleSideEffects(err);

      // Session lifecycle errors: the round-scoped session is gone, retrying same sid is futile.
      // Delete stale round-scoped id so next attempt creates a fresh ephemeral (P4).
      if (err?.message && /session not found/i.test(err.message)) {
        this._logger.warn("session_not_found_skip", `${participant.config.name} — session not found, removing stale round session and retrying fresh`, info);
        if (this._roundSessionIds?.has(participant.config.id)) {
          const sid = this._roundSessionIds.get(participant.config.id);
          try { this._sessionManager.unregisterSession(sid); } catch {}
          this._roundSessionIds.delete(participant.config.id);
        }
        // Allow one fresh retry with same model before falling back (if retries remain)
        if (attempt < maxRetries) {
          this._logger.info("session_not_found_retry_fresh", `${participant.config.name} — will retry with fresh session`);
          // Fall through to normal retry delay logic (will create fresh session next iteration)
        } else {
          break;
        }
      }

      // Recovery: if we already have loom results for this batch, synthesize from them instead of re-executing tools
      if (hasExisting && attempt < maxRetries) {
        const remainingForRecovery = (() => {
          const effTimeout = timeoutMs === 0 ? Infinity : timeoutMs;
          if (this._deadline && Number.isFinite(this._deadline) && this._deadline !== Infinity) {
            const rem = this._deadline - Date.now();
            if (rem < 15000) return 15000;
            return Math.max(15000, Math.min(effTimeout, rem - 1000));
          }
          return effTimeout;
        })();
        const recovered = await trySynthesisFromExisting(activeModel, remainingForRecovery);
        if (recovered) {
          succeeded = true;
          localSucceeded = true;
          if (consumedHint) consumedHint = "";
          this._logger.info("synthesis_recovery_success", `${participant.config.name} recovered via synthesis from existing loom batch ${participant.currentBatchId}`);
          return { result: recovered, error: null };
        }
        // If recovery failed, fall through to normal retry with cached tool guards
        this._logger.warn("synthesis_recovery_skipped", `${participant.config.name} — recovery failed, proceeding to normal retry (loom tools will return reused results)`);
      }

      if (attempt < maxRetries) {
        let delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 8000);
        if (this._deadline && Number.isFinite(this._deadline) && this._deadline !== Infinity) {
          const remaining = this._deadline - Date.now();
          // Need at least 20s to make a retry worthwhile (tool-heavy turns need it)
          if (remaining < 20000) {
            this._logger.warn("prompt_retry_skipped_deadline", `${participant.config.name} — skipping retry, deadline imminent (${remaining}ms remaining, need 20s)`);
            break;
          }
          delay = Math.min(delay, Math.max(0, remaining - 5000));
          if (delay <= 0) {
            this._logger.warn("prompt_retry_skipped_deadline", `${participant.config.name} — skipping retry, deadline imminent`);
            break;
          }
        }
        this._logger.warn("prompt_retry", `${participant.config.name} — attempt ${attempt + 1}/${maxRetries + 1} failed on ${this._modelKey(activeModel)}, error: ${info.message}${info.statusCode ? ` (${info.statusCode})` : ''} — retrying in ${Math.round(delay)}ms`, info);
        await new Promise((r) => { const t = setTimeout(r, delay); if (t.unref) t.unref(); });
      }
    }
  }
  if (!succeeded && consumedHint) {
    this._stateManager.setNextRoundSteering(consumedHint);
  }

  if (!fallbackConfig.enabled) {
    this._recordFallbackFailure(participant, activeModel, null, lastError.value);
    return { result: null, error: lastError.value ?? new Error("no fallback enabled") };
  }

  const fallbackModel = selectFallbackModel(activeModel, this._availableModels, this._circuitBreaker);
  if (!fallbackModel) {
    this._recordFallbackFailure(participant, activeModel, null, lastError.value);
    return { result: null, error: lastError.value ?? new Error("no healthy fallback") };
  }

  this._logger.info("model_fallback", `${participant.config.name} — falling back from ${this._modelKey(activeModel)} to ${this._modelKey(fallbackModel)}`);
   this._options.onProgress?.(`⚠️ ${participant.config.name}'s model (${this._modelKey(activeModel)}) failed: ${lastError.value?.message ?? 'unknown error'} — retrying with ${this._modelKey(fallbackModel)}`);

  const fallbackAttempts = fallbackConfig.maxFallbackAttempts;
  for (let attempt = 0; attempt < fallbackAttempts; attempt++) {
    try {
      const response = await this._executeAgentTurn(participant, fallbackModel, timeoutMs, promptContext);
      response._fallback = {
        from: this._modelKey(activeModel),
        to: this._modelKey(fallbackModel),
        error: lastError.value ? extractErrorInfo(lastError.value) : "unknown",
      };
      if (lastError.value && isRetryableError(lastError.value)) {
        this._circuitBreaker.recordSuccess(activeModel);
      }
      localSucceeded = true;
      if (consumedHint) consumedHint = "";
      return response;
    } catch (err) {
      lastError.value = err;
      const info = extractErrorInfo(err);
      const isSessionNotFoundFb = err?.message && /session not found/i.test(err.message);
      // Don't trip breaker for session lifecycle errors — remove stale sid so next fallback attempt is fresh
      if (isSessionNotFoundFb) {
        this._logger.warn("session_not_found_fallback_skip", `${participant.config.name} — session not found on fallback, removing stale session`, info);
        if (this._roundSessionIds?.has(participant.config.id)) {
          const sid = this._roundSessionIds.get(participant.config.id);
          try { this._sessionManager.unregisterSession(sid); } catch {}
          this._roundSessionIds.delete(participant.config.id);
        }
        // Allow retry with fresh session if fallback attempts remain
        if (attempt + 1 < fallbackAttempts) {
          this._logger.info("session_not_found_fallback_retry_fresh", `${participant.config.name} — will retry fallback with fresh session`);
          // Fall through to fallback_retry delay logic (fresh session next iteration) — don't trip breaker
        } else {
          break;
        }
      }
      if (!isSessionNotFoundFb) {
        this._recordModelFailure(fallbackModel);
      }
      warnPossibleSideEffects(err);

      // Fallback recovery: reuse already-persisted loom batch if available
      const hasExistingFallback = collectExistingLoomResults().length > 0;
      if (hasExistingFallback && attempt + 1 < fallbackAttempts) {
        const remainingForRecoveryFb = (() => {
          const effTimeout = timeoutMs === 0 ? Infinity : timeoutMs;
          if (this._deadline && Number.isFinite(this._deadline) && this._deadline !== Infinity) {
            const rem = this._deadline - Date.now();
            if (rem < 15000) return 15000;
            return Math.max(15000, Math.min(effTimeout, rem - 1000));
          }
          return effTimeout;
        })();
        const recoveredFb = await trySynthesisFromExisting(fallbackModel, remainingForRecoveryFb);
        if (recoveredFb) {
          recoveredFb._fallback = {
            from: this._modelKey(activeModel),
            to: this._modelKey(fallbackModel),
            error: lastError.value ? extractErrorInfo(lastError.value) : "unknown",
          };
          localSucceeded = true;
          if (consumedHint) consumedHint = "";
          this._logger.info("synthesis_recovery_success_fallback", `${participant.config.name} recovered via fallback synthesis from existing loom batch ${participant.currentBatchId}`);
          return recoveredFb;
        }
      }

      if (attempt + 1 < fallbackAttempts) {
        let delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 8000);
        if (this._deadline && Number.isFinite(this._deadline) && this._deadline !== Infinity) {
          const remaining = this._deadline - Date.now();
          if (remaining < 20000) break;
          delay = Math.min(delay, Math.max(0, remaining - 5000));
          if (delay <= 0) break;
        }
        this._logger.warn("fallback_retry", `${participant.config.name} — fallback attempt ${attempt + 1}/${fallbackAttempts} failed on ${this._modelKey(fallbackModel)}, retrying in ${Math.round(delay)}ms`, info);
        await new Promise((r) => { const t = setTimeout(r, delay); if (t.unref) t.unref(); });
      }
    }
  }

  this._recordFallbackFailure(participant, activeModel, fallbackModel, lastError.value);
  return { result: null, error: lastError.value ?? new Error("all models failed") };
  } finally {
    if (!localSucceeded && participant.status === "speaking") participant.status = prevStatus;
    this._hintLocked = false;
  }
}

export function recordFallbackFailure(participant, originalModel, fallbackModel, error) {
  const info = error ? extractErrorInfo(error) : { message: "unknown error" };
  const fallbackMsg = fallbackModel
    ? `Original: ${this._modelKey(originalModel)}, Fallback: ${this._modelKey(fallbackModel)}`
    : `Model: ${this._modelKey(originalModel)}, No fallback available`;
  this._db.recordAgentError(
    this._stateManager.getMeetingId(), participant.config.id, this._stateManager.getCurrentRound(),
    "model_fallback", `${fallbackMsg} — ${JSON.stringify(info)}`, 1,
  );
  this._logger.error("model_fallback_failed", `${participant.config.name} failed on all models`, {
    original: this._modelKey(originalModel),
    fallback: fallbackModel ? this._modelKey(fallbackModel) : null,
    ...info,
  });
}


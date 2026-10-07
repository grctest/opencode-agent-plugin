import { buildAgentSystemPrompt, buildAgentUserPrompt } from "../../prompts/agent.js";
import { getConfig, resolveBuiltInTools, resolveLoomTools } from "../../config.js";
import { extractAgentResponse, mapToolResults, extractFileBlockTools } from "../../shared.js";
import { parseAgentResponse } from "../../validation.js";
import { sanitizeAgentOutput } from "../../utils/sanitize.js";
import { withRetry, isRetryableError } from "../../utils/retry.js";
import { selectFallbackModel } from "../../services/model-service.js";
import { incrementKeyedCounter, recordLatency } from "../../metrics.js";
import { extractErrorInfo } from "../../logger.js";
import { buildToolsMap, buildToolsMapWithoutLoom } from "../tools.js";
import { buildEvidenceCache } from "../../evidence-cache.js";
import { resolveContextLimit, budgetCharsFor, fitPromptToBudget } from "../../utils/context-budget.js";


export async function promptChildSession(participant) {
  const prevStatus = participant.status;
  participant.status = "speaking";
  let localSucceeded = false;
  try {

  const model = this._getParticipantModel(participant);
  const baseConfig = getConfig();
  const effectiveAgentTools = this.getEffectiveAgentTools?.() ?? this._options?.agentTools ?? this._tools ?? baseConfig.agentTools;
  const config = { ...baseConfig, agentTools: effectiveAgentTools };
  const fallbackConfig = config.modelFallback;

  const baseTimeoutMsRaw = config.agentTimeoutMs;
  // 0 = no client timeout, rely on provider errors / stall watchdog (P3).
  // Ceiling tracks CONFIG_SCHEMA max (1.8M): heavy reasoners with inline loom
  // tools legitimately run 10-20 minutes, and the sliding-deadline liveness
  // probe in SessionContract extends the budget while progress is visible.
  const baseTimeoutMs = baseTimeoutMsRaw === 0 ? 0 : (Number.isFinite(baseTimeoutMsRaw) ? Math.max(10000, Math.min(1800000, baseTimeoutMsRaw)) : 1200000);
  const timeoutMsBase = baseTimeoutMs;
  let timeoutMs = timeoutMsBase;

    const currentRound = this._stateManager.getCurrentRound();
   const forumEnabled = !!(effectiveAgentTools?.enabled && effectiveAgentTools?.loom?.loom_forum);
   const mandatoryCapabilities = effectiveAgentTools?.mandatory ?? {};

  // Forum topics for prompt — most recent activity first
  let forumTopicsForPrompt = [];
  if (forumEnabled) {
    try {
      const dbForForum = this._db ?? this._stateManager?.getDatabase?.() ?? null;
      // Prefer the single-query activity-ordered prompt path over the N+1
      // listForumTopics (one COUNT query per topic per turn) — audit A13.
      if (dbForForum && typeof dbForForum.listForumTopicsForPrompt === "function") {
        forumTopicsForPrompt = dbForForum.listForumTopicsForPrompt(10) ?? [];
      } else if (dbForForum && typeof dbForForum.listForumTopics === "function") {
        forumTopicsForPrompt = dbForForum.listForumTopics({}) ?? [];
      } else if (this._stateManager?.getWeave) {
        // Fallback: derive from contributions if DB not available (should not happen)
        forumTopicsForPrompt = [];
      }
    } catch {}
  }

  // SKILL.state O_t: latest-only observation — current-round live contributions only
  // (plan §5.1/§5.6; tightened from round >= cur-1, ≤20). Prior rounds arrive via
  // Σⁱ (own state) + shared SoP digest, never raw replay.
  const recentForPrompt = this._stateManager.getWeave().filter(
    (c) => c.round != null && c.round === currentRound && c.type !== "vote_response" && c.type !== "reflection",
  ).slice(-12);

  // SKILL.state Σⁱ_t: own carried state for this agent (plan §5.1/§5.6).
  // Fetched only when the tool is enabled — flag-off prompts stay byte-identical
  // to legacy (no MY_STATE block, no guidance lines). Follows the same effective-
  // tools resolution as buildAgentSystemPrompt (per-meeting override wins).
  let myState = null;
  try {
    if (effectiveAgentTools?.enabled && effectiveAgentTools?.loom?.loom_state_patch && typeof this._stateManager.getParticipantState === "function") {
      myState = this._stateManager.getParticipantState(participant.config.id);
    }
  } catch { myState = null; }

  // Other participants roster for loom_query target discovery — concrete ids to prevent hallucination
  let otherParticipantsForPrompt = [];
  try {
    const allPs = this._stateManager.getParticipants?.() ?? [];
    const selfId = participant.config.id;
    otherParticipantsForPrompt = allPs
      // Only queryable peers: listening/speaking. Passed/failed participants
      // are listed nowhere — the roster text promises exactly this (audit N7).
      .filter(p => p.config.id !== selfId && (p.status === "listening" || p.status === "speaking"))
      .map(p => ({
        id: p.config.id,
        name: p.config.name,
        category: p.config.category ?? p.config.tier,
        status: p.status,
        persona: typeof p.config.persona === "string" ? p.config.persona.slice(0, 120) : "",
      }))
      .slice(0, 12);
  } catch {}

  // Resolve the model this turn will actually use BEFORE assembling: the input
  // guard below sizes the prompt against THIS model's window, not the requested
  // one (a 32k fallback must not inherit a 1M window's budget).
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

  // Shared evidence cache (P5): read the meeting's tool_audit log once per turn
  // and build the (normalized query → result digest) cache the agent sees as the
  // *Prior Searches* block. Read-side only — tool_audit is written by the tool
  // hooks; this never writes. Empty on round 1 (nothing searched yet) or when the
  // DB is unavailable, so flag-off prompts stay byte-identical.
  let evidenceCache = [];
  try {
    const dbForCache = this._db ?? this._stateManager?.getDatabase?.() ?? null;
    if (dbForCache && typeof dbForCache.getToolAudits === "function") {
      evidenceCache = buildEvidenceCache(dbForCache.getToolAudits() ?? []);
    }
  } catch { evidenceCache = []; }

  const activeCountPS = (() => { try { return this._stateManager.getActiveParticipants().length; } catch { return undefined; }})();
  // Assigned-model context window for the prompt's window claim (audit 3.4).
  // Unknown models yield null and builders keep their default text unchanged.
  const participantWindow = resolveContextLimit(
    this._getParticipantModel?.(participant) ?? participant?.config?.model,
    this._availableModels,
  );
  const systemPrompt = buildAgentSystemPrompt(participant, { activeCount: activeCountPS, agentTools: effectiveAgentTools, contextWindow: participantWindow });
  let steeringHint = "";
  let consumedHint = "";
  // Atomic consume — hintLocked flag prevents double-consume if two promptChildSessions race
  if (!this._hintLocked) {
    this._hintLocked = true;
    try {
      const plannedFirst = this._stateManager.getPlannedTurnOrder?.()?.[0] ?? this._stateManager.getNextSpeakerId?.();
      const isFirstSpeaker = !plannedFirst || plannedFirst === participant.config.id;
      if (isFirstSpeaker) consumedHint = this._stateManager.consumeNextRoundSteering();
      // Cap like every other untrusted prompt block (audit X5).
      steeringHint = consumedHint.length > 300 ? consumedHint.slice(0, 300) : consumedHint;
    } catch {}
    // release lock after microtask so same-round second speaker can't re-consume same hint
    queueMicrotask(() => { this._hintLocked = false; });
  }
  // Block-aware fit (plan Part 2b): assemble, measure against THIS model's input
  // window, and sacrifice the cheapest-to-lose blocks until it fits. The system
  // prompt is untouched, so the task instruction, the state-patch contract and
  // the tool rules survive every level of degradation.
  let fitEvidence = evidenceCache;
  let fitRecent = recentForPrompt;
  let fitForum = forumTopicsForPrompt;
  let fitSop = this._stateManager.getStateOfPlay();
  // Previous round's clerk summary (rounds >=2 only) — already paid for, already
  // high quality; routed to agents instead of only the dashboard.
  let fitLastSummary = (() => {
    try {
      if (currentRound <= 1) return "";
      const rounds = this._stateManager.getRounds?.() ?? [];
      const prev = rounds.filter((r) => r.number === currentRound - 1).pop() ?? [...rounds].pop();
      return String(prev?.summary ?? "").trim();
    } catch { return ""; }
  })();

  const buildFitPrompt = () => buildAgentUserPrompt(
    participant,
    fitSop,
    fitRecent,
    currentRound,
    this._stateManager.getQuestion(),
    this._stateManager.getTags(),
    this._stateManager.getContext?.() ?? "",
    fitForum,
    otherParticipantsForPrompt,
     myState,
     forumEnabled,
     // Solo suppression: with ≤1 active participant loom_query/loom_vote are
     // removed from the tool map, so the roster must not be rendered either
     // (audit N7 — system prompt and tool map both said no, roster said yes).
     (!!(effectiveAgentTools?.enabled && effectiveAgentTools?.loom?.loom_query) && !(Number.isFinite(activeCountPS) && activeCountPS <= 1)),
     mandatoryCapabilities,
      {
        contextWindow: participantWindow,
        maxRounds: (() => { try { return this._stateManager.getMaxRounds?.(); } catch { return undefined; } })(),
        // Settled registry (F-A): all roster states for the exact-match
        // fallback, plus the meeting-level clerk-designated registry
        // (retrospective P0-2) which is the primary source.
        allStates: (() => { try { return this._stateManager.getAllParticipantStates?.() ?? []; } catch { return []; } })(),
        settledItems: (() => { try { return this._stateManager.getSettledItems?.() ?? []; } catch { return []; } })(),
       // Steering hint renders inside the builder, before the final patch line,
       // so recency keeps the mandatory call (audit P1-D). Empty = no block.
       steeringHint,
        lastRoundSummary: fitLastSummary,
        // Explicit key: the builder reads `evidenceCache`, and this is the
        // trimmable copy the fit loop empties first.
        evidenceCache: fitEvidence,
      },
   );


  // Sacrifice order. Each step is taken only if the prompt is still over budget.
  const fitSteps = [
    // 1. Prior-search evidence cache — retrieval is re-runnable; a peer can search again.
    () => { fitEvidence = []; },
    // 2. Older contributions in this round — the tail is what the live exchange needs.
    () => { fitRecent = fitRecent.slice(-Math.max(4, Math.ceil(fitRecent.length / 2))); },
    // 3. Previous round's summary — the shared SoP already carries the same ground.
    () => { fitLastSummary = ""; },
    // 4. Older forum topics — topic list is navigation aid, not evidence.
    () => { fitForum = fitForum.slice(-Math.max(1, Math.ceil(fitForum.length / 2))); },
    // 5. Oldest SoP entries — the digest is append-ordered, so the head is the
    //    superseded part; drop it at a line boundary to keep entries whole.
    () => {
      const lines = String(fitSop ?? "").split("\n");
      if (lines.length <= 4) { fitSop = ""; return; }
      fitSop = lines.slice(Math.floor(lines.length / 2)).join("\n");
    },
  ];

  const fitBudgetChars = budgetCharsFor(activeModel, this._availableModels);
  const fitted = fitPromptToBudget({
    assemble: buildFitPrompt,
    budgetChars: fitBudgetChars,
    overheadChars: systemPrompt.length,
    steps: fitSteps,
  });
  const userPrompt = fitted.value;
  if (fitted.stepsApplied > 0) {
    this._logger.info("prompt_trimmed_to_context", `Dropped ${fitted.stepsApplied} prompt block tier(s) to fit ${fitBudgetChars} chars for ${activeModel?.providerID}/${activeModel?.modelID}`, {
      participant: participant.config.id,
      model: `${activeModel?.providerID}/${activeModel?.modelID}`,
      tiersDropped: fitted.stepsApplied,
      chars: userPrompt.length,
      stillOverBudget: fitted.overBudget,
    });
    try { this._onPromptTrimmed?.(fitBudgetChars - (userPrompt.length + systemPrompt.length), activeModel); } catch {}
  }

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
    state_version: myState?.version ?? 0,
    question: this._stateManager.getQuestion(),
    tags: this._stateManager.getTags(),
    round: currentRound,
  };


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
      const content = (c.content ?? "");
      return `Tool ${toolHint} (${c.id}) via ${src} returned:\n${content}`;
    }).join("\n\n");
    if (!loomOutputsRaw.trim()) return null;
    // Lossless: the recovery synthesis parses complete peer answers.
    const loomOutputs = loomOutputsRaw;
    const synthesisInstruction = `Loom tool results RECOVERED from earlier attempt (reused, not re-executed — ${existing.length} peer contribution(s) already persisted for batch ${participant.currentBatchId}):\n${loomOutputs}\n\nNow synthesize your final contribution incorporating these responses. Cite [#id] when referencing peer answers. Do not re-call loom_query/loom_vote/loom_summon — you have the results. Stay in character and follow OUTPUT CONTRACT.`;
    const activeCountExec = (() => { try { return this._stateManager.getActiveParticipants().length; } catch { return undefined; }})();
    const synthesisToolsMap = buildToolsMapWithoutLoom(config, { activeCount: activeCountExec });
    // Always create a fresh ephemeral session for recovery — reusing the round-scoped
    // session risks "session busy" if the timed-out prompt is still draining server-side.
    let ephemeralSessionId;
    try { ephemeralSessionId = await this._options.createEphemeralSession(participant); this._sessionManager.registerSessionMeeting(ephemeralSessionId, this._stateManager.getMeetingId()); } catch { return null; }
    const synthRemaining = remainingTimeout === 0 ? Infinity : remainingTimeout;
    if (synthRemaining !== Infinity && synthRemaining <= 0) {
      if (ephemeralSessionId) { try { await this._options.deleteEphemeralSession(ephemeralSessionId); } catch {} try { this._sessionManager.unregisterSession(ephemeralSessionId); } catch {} }
      return null;
    }
    this._logger.info("synthesis_recovery", `Attempting synthesis recovery for ${participant.config.name} with ${existing.length} existing loom result(s)`, { batchId: participant.currentBatchId, existingCount: existing.length, remainingMs: synthRemaining });
     let result2;
    try {
      try { this._callStats.agent_prompts++; } catch {}
      try { this._notifyCallStats?.(); } catch {}
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
        // Recovery synthesis offers no loom tools, so no weave-growth probe;
        // heartbeat still keeps the stall watchdog alive on long recoveries.
        onHeartbeat: () => { try { this._options.onPromptActivity?.(); } catch {} },
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
        output: JSON.stringify({ reused: true, contributionId: c.id, type: c.type, content: (c.content ?? "") }),
        title: `reused:${c.type}:${c.id}`,
        metadata: { reused: true, inline: true },
      }));
      const effective2 = mtr(toolResults2 ?? []);
      const safeContent = sanitize(agentText2);
      let response = parseResp(participant.config.id, safeContent);
      if (!response) {
        response = { participant_id: participant.config.id, content: safeContent.slice(0,5000) || "[No content after sanitization]", type: "contribution", query: null, evidence: null, summon: null, vote: null };
      }
      response.tool_calls = [...existingToolCalls, ...(effective2 ?? [])];
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
   // A pass consumes no steering: hand the hint to the next speaker instead of
   // dropping the round's only steering signal (audit X5).
   const isPassResponse = (r) => Array.isArray(r?.tool_calls) && r.tool_calls.some((t) => t?.tool === "loom_pass" && t?.status !== "error");
   const settleHint = (response) => {
     if (!consumedHint) return;
     if (isPassResponse(response)) {
       try { this._stateManager.setNextRoundSteering(consumedHint); } catch {}
     }
     consumedHint = "";
   };
   this._stateManager.beginTurn?.(participant.config.id);
   for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await this._executeAgentTurn(participant, activeModel, timeoutMs, promptContext, { deferTail: true });
      succeeded = true;
      localSucceeded = true;
      settleHint(response);
      return { result: response, error: null };
     } catch (err) {
      this._stateManager.discardActiveTurnPatch?.();
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
        const recovered = await trySynthesisFromExisting(activeModel, timeoutMs === 0 ? Infinity : timeoutMs);
        if (recovered) {
          succeeded = true;
          localSucceeded = true;
          settleHint(recovered);
          this._logger.info("synthesis_recovery_success", `${participant.config.name} recovered via synthesis from existing loom batch ${participant.currentBatchId}`);
          return { result: recovered, error: null };
        }
        // If recovery failed, fall through to normal retry with cached tool guards
        this._logger.warn("synthesis_recovery_skipped", `${participant.config.name} — recovery failed, proceeding to normal retry (loom tools will return reused results)`);
      }

      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 8000);
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
      settleHint(response);
      return response;
    } catch (err) {
      this._stateManager.discardActiveTurnPatch?.();
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
        const remainingForRecoveryFb = timeoutMs === 0 ? Infinity : timeoutMs;
        const recoveredFb = await trySynthesisFromExisting(fallbackModel, remainingForRecoveryFb);
        if (recoveredFb) {
          recoveredFb._fallback = {
            from: this._modelKey(activeModel),
            to: this._modelKey(fallbackModel),
            error: lastError.value ? extractErrorInfo(lastError.value) : "unknown",
          };
          localSucceeded = true;
          settleHint(recoveredFb);
          this._logger.info("synthesis_recovery_success_fallback", `${participant.config.name} recovered via fallback synthesis from existing loom batch ${participant.currentBatchId}`);
          return recoveredFb;
        }
      }

      if (attempt + 1 < fallbackAttempts) {
        const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 8000);
        this._logger.warn("fallback_retry", `${participant.config.name} — fallback attempt ${attempt + 1}/${fallbackAttempts} failed on ${this._modelKey(fallbackModel)}, retrying in ${Math.round(delay)}ms`, info);
        await new Promise((r) => { const t = setTimeout(r, delay); if (t.unref) t.unref(); });
      }
    }
  }

  this._recordFallbackFailure(participant, activeModel, fallbackModel, lastError.value);
  return { result: null, error: lastError.value ?? new Error("all models failed") };
   } finally {
     if (!localSucceeded && participant.status === "speaking") participant.status = prevStatus;
     // N7 — the tool-call cap is PER TURN while the audit is PER ROUND, so
     // comparing a round's audited total against the cap reads as an overrun
     // that never happened. Record the per-turn high-water mark so the two are
     // never conflated in telemetry.
     this._stateManager.recordTurnToolHighWater?.();
     this._stateManager.endTurn?.();
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


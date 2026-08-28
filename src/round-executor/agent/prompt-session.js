import { buildAgentSystemPrompt, buildAgentUserPrompt } from "../../prompts/agent.js";
import { getConfig, resolveBuiltInTools, resolveLoomTools } from "../../config.js";
import { extractAgentResponse, mapToolResults, extractFileBlockTools, getPriorityCap } from "../../shared.js";
import { parseAgentResponse } from "../../validation.js";
import { sanitizeAgentOutput } from "../../utils/sanitize.js";
import { isRetryableError } from "../../utils/retry.js";
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
  const config = getConfig();
  const fallbackConfig = config.modelFallback;

  const baseTimeoutMsRaw = config.agentTimeoutMs;
  const baseTimeoutMs = Number.isFinite(baseTimeoutMsRaw) ? Math.max(10000, Math.min(600000, baseTimeoutMsRaw)) : 240000;
  const timeoutMsBase = baseTimeoutMs;
  let timeoutMs = timeoutMsBase;
  if (this._deadline) {
    const remaining = this._deadline - Date.now();
    if (remaining <= 2000) {
      timeoutMs = 5000;
    } else if (remaining < 10000) {
      timeoutMs = Math.max(5000, Math.min(timeoutMsBase, remaining - 1000));
    } else {
      timeoutMs = Math.min(timeoutMsBase, remaining - 1000);
    }
  }

  const currentRound = this._stateManager.getCurrentRound();

  let recentContribs = this._stateManager.getWeave().filter((c) => c.round != null && c.round >= currentRound - 1);
  let queryText = recentContribs.length > 0
    ? recentContribs.map((c) => c.content).join("\n")
    : this._stateManager.getQuestion();
  if (queryText.length > 4000) queryText = queryText.slice(0, 4000);
  const ragChunks = this._vectorIndex
    ? await this._vectorIndex.retrieveRelevant(queryText, 10, currentRound)
    : [];
  const ragContext = ragChunks.length > 0
    ? ragChunks.map((c) => `[Round ${c.round}] ${c.content}`).join("\n\n")
    : "";

  const recentForPrompt = this._stateManager.getWeave().filter(
    (c) => c.round != null && c.round >= currentRound - 1 && c.type !== "vote_response" && c.type !== "reflection",
  ).slice(-12);

  const systemPrompt = buildAgentSystemPrompt(participant);
  let steeringHint = "";
  let consumedHint = "";
  try {
    const plannedFirst = this._stateManager.getPlannedTurnOrder?.()?.[0] ?? this._stateManager.getNextSpeakerId?.();
    const isFirstSpeaker = !plannedFirst || plannedFirst === participant.config.id;
    if (isFirstSpeaker) consumedHint = this._stateManager.consumeNextRoundSteering();
    steeringHint = consumedHint;
  } catch {}
  const userPromptBase = buildAgentUserPrompt(
    participant,
    this._stateManager.getStateOfPlay(),
    ragContext,
    recentForPrompt,
    currentRound,
    this._stateManager.getQuestion(),
    this._stateManager.getTags(),
    this._stateManager.getContext?.() ?? "",
  );
  const userPrompt = steeringHint ? `${userPromptBase}\n\n${delimitContext(steeringHint, "STEERING_HINT")}` : userPromptBase;

  const promptContext = {
    type: "agent_turn",
    system_prompt: systemPrompt,
    user_prompt: userPrompt,
    state_of_play: this._stateManager.getStateOfPlay(),
    rag_query_text: queryText,
    rag_chunks_used: ragChunks.map((c) => `[Round ${c.round}] ${c.content}`),
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
      this._logError(`model ${this._modelKey(model)} unhealthy and no fallback available`, new Error("circuit breaker open, no fallback"));
      return null;
    }
    activeModel = fallback;
  }

  const maxRetries = fallbackConfig.enabled ? fallbackConfig.maxRetriesPerModel : 0;
  const lastError = { value: null };

  // Inline loom_* tools (query/evidence/vote/summon) execute SERVER-SIDE during
  // session.prompt and persist their own contributions immediately. If an attempt
  // times out or errors after those side effects landed, the retry's response will
  // not contain those ToolParts — the audit trail lives in the weave rows instead.
  // We surface this explicitly so "tool_results_none" after a retry is explainable.
  const warnPossibleSideEffects = (err) => {
    this._logger.warn("attempt_failed_possible_tool_side_effects", `${participant.config.name} — attempt failed after inline loom tools may have executed; peer contributions may exist in the weave without appearing in this turn's tool_calls`, {
      participant: participant.config.id,
      round: currentRound,
      error: err?.message ?? String(err),
    });
  };

  let succeeded = false;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await this._executeAgentTurn(participant, activeModel, timeoutMs, promptContext);
      succeeded = true;
      if (consumedHint) consumedHint = "";
      return response;
    } catch (err) {
      lastError.value = err;
      const info = extractErrorInfo(err);
      if (isRetryableError(err)) this._recordModelFailure(activeModel);
      if (attempt > 0 || err?.message === "Empty agent response") warnPossibleSideEffects(err);

      if (attempt < maxRetries) {
        let delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 8000);
        if (this._deadline) {
          const remaining = this._deadline - Date.now();
          delay = Math.min(delay, Math.max(0, remaining - 2000));
          if (delay <= 0) {
            this._logger.warn("prompt_retry_skipped_deadline", `${participant.config.name} — skipping retry, deadline imminent`);
            break;
          }
        }
        this._logger.warn("prompt_retry", `${participant.config.name} — attempt ${attempt + 1}/${maxRetries + 1} failed on ${this._modelKey(activeModel)}, retrying in ${Math.round(delay)}ms`, info);
        await new Promise((r) => { const t = setTimeout(r, delay); if (t.unref) t.unref(); });
      }
    }
  }
  if (!succeeded && consumedHint) {
    this._stateManager.setNextRoundSteering(consumedHint);
  }

  if (!fallbackConfig.enabled) {
    this._recordFallbackFailure(participant, activeModel, null, lastError.value);
    return null;
  }

  const fallbackModel = selectFallbackModel(activeModel, this._availableModels, this._circuitBreaker);
  if (!fallbackModel) {
    this._recordFallbackFailure(participant, activeModel, null, lastError.value);
    return null;
  }

  this._logger.info("model_fallback", `${participant.config.name} — falling back from ${this._modelKey(activeModel)} to ${this._modelKey(fallbackModel)}`);
  this._options.onProgress?.(`⚠️ ${participant.config.name}'s model (${this._modelKey(activeModel)}) failed — retrying with ${this._modelKey(fallbackModel)}`);

  const fallbackAttempts = fallbackConfig.maxFallbackAttempts;
  for (let attempt = 0; attempt < fallbackAttempts; attempt++) {
    try {
      const response = await this._executeAgentTurn(participant, fallbackModel, timeoutMs, promptContext);
      response._fallback = {
        from: this._modelKey(activeModel),
        to: this._modelKey(fallbackModel),
        error: lastError.value ? extractErrorInfo(lastError.value).message : "unknown",
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
      this._recordModelFailure(fallbackModel);
      warnPossibleSideEffects(err);

      if (attempt + 1 < fallbackAttempts) {
        let delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 8000);
        if (this._deadline) {
          const remaining = this._deadline - Date.now();
          delay = Math.min(delay, Math.max(0, remaining - 2000));
          if (delay <= 0) break;
        }
        this._logger.warn("fallback_retry", `${participant.config.name} — fallback attempt ${attempt + 1}/${fallbackAttempts} failed on ${this._modelKey(fallbackModel)}, retrying in ${Math.round(delay)}ms`, info);
        await new Promise((r) => { const t = setTimeout(r, delay); if (t.unref) t.unref(); });
      }
    }
  }

  this._recordFallbackFailure(participant, activeModel, fallbackModel, lastError.value);
  return null;
  } finally {
    if (!localSucceeded && participant.status === "speaking") participant.status = prevStatus;
  }
}

export function recordFallbackFailure(participant, originalModel, fallbackModel, error) {
  const info = error ? extractErrorInfo(error) : { message: "unknown error" };
  const fallbackMsg = fallbackModel
    ? `Original: ${this._modelKey(originalModel)}, Fallback: ${this._modelKey(fallbackModel)}`
    : `Model: ${this._modelKey(originalModel)}, No fallback available`;
  this._db.recordAgentError(
    this._stateManager.getMeetingId(), participant.config.id, this._stateManager.getCurrentRound(),
    "model_fallback", `${fallbackMsg} — ${info.message}`, 1,
  );
  this._logger.error("model_fallback_failed", `${participant.config.name} failed on all models`, {
    original: this._modelKey(originalModel),
    fallback: fallbackModel ? this._modelKey(fallbackModel) : null,
    ...info,
  });
}


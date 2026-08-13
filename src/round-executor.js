import { buildAgentSystemPrompt, buildAgentUserPrompt } from "./prompts.js";
import { generateRoundBriefs } from "./warp-manager.js";
import { parseAgentResponse } from "./validation.js";
import { withConcurrency } from "./concurrency.js";
import { getConfig } from "./config.js";
import { extractText, truncate, withTimeout, getPriorityCap, enforceWordLimit } from "./shared.js";
import { Logger, extractErrorInfo } from "./logger.js";
import { runReflectionPhase as runReflections } from "./reflection-manager.js";
import { sanitizeForPrompt, sanitizeForDisplay, sanitizeContribution } from "./utils/sanitize.js";
import { withRetry, isRetryableError, CircuitBreaker } from "./utils/retry.js";

function isTimeoutError(err) {
  return err instanceof Error && /timed out after/i.test(err.message);
}

export class RoundExecutor {
  #client;
  #directory;
  #db;
  #state;
  #options;
  #promptParent;
  #getParticipantModel;
  #logError;
  #failureCounts;
  #modelFailureTimes;
  #logger;
  #interjectionTracker;
  #turnOrder = [];
  #dirtySessions = new Set();
  #callStats;
  #circuitBreaker;

  constructor({ client, directory, db, state, options, promptParent, getParticipantModel, logError }) {
    this.#client = client;
    this.#directory = directory;
    this.#db = db;
    this.#state = state;
    this.#options = options;
    this.#promptParent = promptParent;
    this.#getParticipantModel = getParticipantModel;
    this.#logError = logError;
    this.#failureCounts = new Map();
    this.#modelFailureTimes = new Map();
    this.#logger = new Logger();
    this.#interjectionTracker = new Map();
    this.#callStats = { agent_prompts: 0, reflection_calls: 0, interjection_calls: 0 };
    const cbConfig = getConfig().circuitBreaker;
    this.#circuitBreaker = new CircuitBreaker({
      failureThreshold: cbConfig.failureThreshold,
      resetTimeoutMs: cbConfig.resetTimeoutMs,
    });
  }

  #failedInCurrentRound = 0;

  isModelHealthy(model) {
    return this.#circuitBreaker.isHealthy(model);
  }

  getCallStats() {
    return { ...this.#callStats };
  }

  resetRoundStats() {
    this.#failedInCurrentRound = 0;
  }

  #modelKey(model) {
    return `${model.providerID}/${model.modelID}`;
  }

   #recordModelFailure(model) {
    const cbConfig = getConfig().circuitBreaker;
    const state = this.#circuitBreaker.recordFailure(model);
    if (state.failures >= cbConfig.failureThreshold) {
      this.#options.onProgress?.(`⚠️ Model ${this.#modelKey(model)} marked unhealthy after ${state.failures} consecutive failures. Will retry in ${cbConfig.resetTimeoutMs / 60000} minutes.`);
      this.#logger.warn("circuit_breaker", `Model ${this.#modelKey(model)} marked unhealthy`, { failures: state.failures });
    }
   }

  #recordModelSuccess(model) {
    this.#circuitBreaker.recordSuccess(model);
  }

  /**
   * Runs the prompt phase for a round. Modes:
   * - "sequential": agents speak one at a time; each sees all prior same-round contributions
   * - "staged": small batches in turn order (partial same-round awareness, faster)
   * - "parallel": all agents at once (fastest, no same-round awareness)
   */
  async runPromptPhase(round, activeParticipants, turnMode) {
    const mode = turnMode ?? "sequential";
    this.#turnOrder = [];

    const roundBriefs = generateRoundBriefs(this.#state.warp, round);

    const speak = async (p) => {
      this.#turnOrder.push(p.config.id);
      this.#db.setParticipantStatus(p.config.id, "speaking");
      this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) is thinking...`);
      const result = await this.#promptChildSession(p, roundBriefs);
      await this.#handlePromptResult(p, result, round);
    };

    const tasks = activeParticipants.map((p) => () => speak(p));

    if (mode === "parallel") {
      for (const p of activeParticipants) {
        this.#db.setParticipantStatus(p.config.id, "speaking");
      }
      this.#options.onProgress?.(`${activeParticipants.length} participants thinking...`);
      const config = getConfig();
      const limit = Math.min(activeParticipants.length, config.maxConcurrentPrompts);
      await withConcurrency(tasks, limit);
    } else if (mode === "staged") {
      const config = getConfig();
      const batchSize = Math.max(2, config.stagedBatchSize ?? 2);
      for (let i = 0; i < tasks.length; i += batchSize) {
        const batch = tasks.slice(i, i + batchSize);
        await withConcurrency(batch.map((t) => () => t()), batch.length);
      }
    } else {
      for (const task of tasks) {
        await task();
      }
    }
  }

  async #handlePromptResult(p, result, round) {
    if (!result) {
      p.status = "failed";
      this.#failedInCurrentRound++;
      this.#db.setParticipantStatus(p.config.id, "failed");
      this.#db.recordAgentError(
        this.#state.id, p.config.id, this.#state.current_round,
        "no_response", "Failed to get response after retries", 2,
      );
      round.token_path.push(p.config.id);
      this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) — failed to respond, skipping`);
      this.#options.onContribution?.(p.config.name, this.#state.current_round, "failed_no_response");
      return;
    }

    if (result.content === "[PASS]") {
      p.status = "passed";
      this.#db.setParticipantStatus(p.config.id, "passed");
      round.token_path.push(p.config.id);
      this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) — chose to pass`);
      this.#options.onContribution?.(p.config.name, this.#state.current_round, "pass");
      return;
    }

    this.#storeContribution(p, result, round);

    if (result.governance) {
      const g = result.governance;
      this.#logger.info("governance_directive", `${p.config.name} issued governance directive`, { directive: g.directive, value: g.value });
      if (!round.governance) round.governance = [];
      round.governance.push({ participant_id: p.config.id, directive: g.directive, value: g.value ?? null });
      this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) — issued governance directive [GOVERNANCE: ${g.directive}${g.value !== undefined ? `: ${g.value}` : ""}]`);
    }

    const truncated = truncate(result.content, 120);
    this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) — ${result.type}: "${truncated}"`);
  }

  async runReflectionPhase(round, activeParticipants) {
    await runReflections(round, activeParticipants, this.#promptParent, this.#getParticipantModel, this.#db, this.#logError);
  }

  async runInterjectionPhase(round, activeParticipants) {
    const config = getConfig();
    const maxInterjections = config.maxInterjectionsPerRound ?? 2;
    const threshold = config.interjectionThresholds?.autoGrant ?? 8;
    const pendingInterjections = round.interjections.filter((ij) => ij.resolved === "pending");
    if (pendingInterjections.length === 0) return;

    pendingInterjections.sort((a, b) => b.priority - a.priority);

    let grantedCount = 0;

    for (const ij of pendingInterjections) {
      if (ij.resolved !== "pending") continue;
      if (grantedCount >= maxInterjections) {
        ij.resolved = "denied";
        continue;
      }

      const interjector = activeParticipants.find((p) => p.config.id === ij.participant_id);
      if (!interjector) {
        ij.resolved = "denied";
        continue;
      }

      const lastInterjection = this.#interjectionTracker.get(interjector.config.id);
      if (lastInterjection && lastInterjection >= round.number - 1) {
        ij.resolved = "denied";
        continue;
      }

      if (ij.priority >= threshold) {
        ij.granted = true;
        ij.resolved = "granted";
        grantedCount++;
        this.#interjectionTracker.set(interjector.config.id, round.number);
        await this.#promptInterjector(interjector, ij, round);
      } else {
        ij.resolved = "denied";
      }
    }
  }

  #storeContribution(participant, result, round) {
    const id = ++this.#state.next_contribution_id;
    const safeContent = sanitizeForPrompt(result.content);
    const contribution = {
      id,
      round: this.#state.current_round,
      participant_id: result.participant_id,
      content: safeContent,
      type: result.type,
      targets_which: null,
      timestamp: Date.now(),
    };

    this.#state.weft.push(contribution);
    round.contributions.push(contribution);
    round.token_path.push(participant.config.id);
    participant.contributions_count++;
    participant.status = "listening";
    this.#db.setParticipantStatus(participant.config.id, "listening");

    this.#db.addContribution(this.#state.id, {
      ...contribution,
      round: this.#state.current_round,
    });

    if (result.interjection) {
      const priorityCap = getPriorityCap(participant.config.tier);
      const targetParticipantId = this.#resolveInterjectionTarget(participant, result.interjection);
      const interjection = {
        participant_id: result.participant_id,
        target_participant_id: targetParticipantId,
        round: this.#state.current_round,
        priority: Math.min(result.interjection.priority, priorityCap),
        reason: sanitizeForPrompt(result.interjection.reason),
        draft: result.interjection.draft ?? null,
        granted: false,
        pushback: null,
        resolved: "pending",
      };
      round.interjections.push(interjection);
      this.#db.addInterjection(this.#state.id, interjection);
    }

    this.#options.onContribution?.(participant.config.name, this.#state.current_round, result.type);
  }

  /**
   * Resolves who an interjection targets. An explicit Target (contribution id or name) wins;
   * otherwise the interjector targets the participant immediately before them in the round's
   * turn order — deterministic in every turn mode, unlike completion order.
   */
  #resolveInterjectionTarget(interjector, interjection) {
    const explicit = interjection.target;
    if (explicit) {
      const str = explicit.trim().replace(/^#/, "").toLowerCase();
      if (/^\d+$/.test(str)) {
        const contrib = [...this.#state.weft].reverse().find((c) => c.id === parseInt(str, 10));
        if (contrib) return contrib.participant_id;
        return null;
      }
      const participant = this.#state.participants.find(
        (pp) => pp.config.name.toLowerCase() === str || pp.config.id.toLowerCase() === str,
      );
      return participant?.config.id ?? null;
    }

    const myIdx = this.#turnOrder.indexOf(interjector.config.id);
    if (myIdx > 0) {
      return this.#turnOrder[myIdx - 1];
    }
    return null;
  }

  async #promptChildSession(participant, roundBriefs) {
    participant.status = "speaking";

    if (!participant.session_id) {
      return null;
    }

    // Capture session version before prompt to detect late responses from old sessions
    const sessionVersion = participant.session_version ?? 0;

    if (this.#dirtySessions.has(participant.config.id)) {
      this.#dirtySessions.delete(participant.config.id);
      const recreated = await this.#options.recreateSession?.(participant);
      if (recreated) {
        this.#logger.info("session_recreated", `Recreated dirty session for ${participant.config.name}`);
      }
      if (!participant.session_id) return null;
    }

    const model = this.#getParticipantModel(participant);

    if (!this.#circuitBreaker.isHealthy(model)) {
      this.#logError(`model ${this.#modelKey(model)} is unhealthy, skipping`, new Error("circuit breaker open"));
      this.#logger.warn("model_unhealthy", `Skipping ${participant.config.name} — model ${this.#modelKey(model)} unhealthy`);
      return null;
    }

    const config = getConfig();
    const baseTimeoutMs = config.agentTimeoutMs;
    const totalParticipants = this.#state.participants.length;
    const timeoutReductionFactor = Math.min(this.#failedInCurrentRound / totalParticipants, 0.5);
    const timeoutMs = Math.floor(baseTimeoutMs * (1 - timeoutReductionFactor));

    const promptFn = async () => {
      // Verify session version hasn't changed (prevents late responses from old sessions)
      if ((participant.session_version ?? 0) !== sessionVersion) {
        throw new Error("Session version changed — discarding stale response");
      }

      this.#callStats.agent_prompts++;
      const result = await withTimeout(
        this.#client.session.prompt({
          path: { id: participant.session_id },
          body: {
            system: buildAgentSystemPrompt(participant),
            model,
            temperature: participant.tier_config.temperature,
            parts: [{ type: "text", text: buildAgentUserPrompt(
              participant,
              this.#state.warp,
              this.#state.weft,
              this.#state.question,
              this.#state.current_round,
              roundBriefs,
            ) }],
          },
          query: { directory: this.#directory },
        }),
        timeoutMs,
      );

      if (result.error) {
        throw new Error(result.error.message || JSON.stringify(result.error));
      }

      const content = extractText(result.data);
      if (!content) return null;

      const safeContent = sanitizeForPrompt(content);
      const response = parseAgentResponse(participant.config.id, safeContent);
      if (!response) return null;

      this.#recordModelSuccess(model);
      this.#options.onAgentComplete?.(participant.config.id, response.content);
      return response;
    };

    try {
      const adjustedMaxAttempts = Math.max(1, config.maxRetryAttempts - this.#failedInCurrentRound);
      return await withRetry(promptFn, {
        maxAttempts: adjustedMaxAttempts,
        baseDelayMs: config.retryBaseDelayMs,
        maxDelayMs: config.retryMaxDelayMs,
        jitterMs: 500,
        retryable: (err) => isRetryableError(err) || isTimeoutError(err),
        onRetry: (err, attempt, delay) => {
          if (isTimeoutError(err)) {
            this.#dirtySessions.add(participant.config.id);
            this.#logger.warn("session_dirty", `Marking ${participant.config.name}'s session dirty after timeout — will recreate before next prompt`);
          }
          this.#logger.warn("prompt_retry", `Retrying prompt for ${participant.config.name} (attempt ${attempt + 1}/${adjustedMaxAttempts})`, { delay, error: err.message });
        },
      });
    } catch (err) {
      this.#recordModelFailure(model);
      const info = extractErrorInfo(err);
      this.#db.recordAgentError(
        this.#state.id, participant.config.id, this.#state.current_round,
        "prompt_failed", info.message, config.maxRetryAttempts + 1,
      );
      this.#logger.error("participant_failed", `${participant.config.name} failed after ${config.maxRetryAttempts + 1} attempts`, info);
      return null;
    }
  }

  async #promptInterjector(interjector, ij, round) {
    interjector.status = "speaking";
    this.#db.setParticipantStatus(interjector.config.id, "speaking");
    this.#options.onProgress?.(`${interjector.config.name} (${interjector.config.tier}) — interjecting...`);

    const config = getConfig();
    const draftContent = ij.draft;

    if (draftContent && draftContent.trim().length > 0) {
      const content = enforceWordLimit(sanitizeForPrompt(draftContent.trim()), config.maxInterjectionWords);
      const contribution = {
        id: ++this.#state.next_contribution_id,
        round: this.#state.current_round,
        participant_id: interjector.config.id,
        content,
        type: "interjection",
        targets_which: ij.target_participant_id,
        timestamp: Date.now(),
      };

      this.#state.weft.push(contribution);
      round.contributions.push(contribution);
      round.token_path.push(interjector.config.id);
      interjector.contributions_count++;

      this.#db.addContribution(this.#state.id, {
        ...contribution,
        round: this.#state.current_round,
      });

      const truncated = truncate(content, 120);
      this.#options.onProgress?.(`${interjector.config.name} (${interjector.config.tier}) — interjection: "${truncated}"`);
      this.#options.onContribution?.(interjector.config.name, this.#state.current_round, "interjection");

      interjector.status = "listening";
      this.#db.setParticipantStatus(interjector.config.id, "listening");
      return;
    }

    const model = this.#getParticipantModel(interjector);
    const systemPrompt = buildAgentSystemPrompt(interjector);
    const userPrompt = `## You Interjected

You requested to interrupt with priority ${ij.priority}:
"${sanitizeForDisplay(ij.reason)}"

State your interjection now. Be direct and under 200 words.`;

    try {
      this.#callStats.interjection_calls++;
      const result = await withTimeout(
        this.#client.session.prompt({
          path: { id: interjector.session_id },
          body: { system: systemPrompt, model, temperature: interjector.tier_config.temperature, parts: [{ type: "text", text: userPrompt }] },
          query: { directory: this.#directory },
        }),
        config.agentTimeoutMs,
      );

      if (result.error) {
        throw new Error(result.error.message || JSON.stringify(result.error));
      }

      const content = extractText(result.data);
      if (!content) throw new Error("Empty interjection response");

      const safeContent = sanitizeForPrompt(content.replace(/^\[(\w+)\]\s*/, ""));
      const contribution = {
        id: ++this.#state.next_contribution_id,
        round: this.#state.current_round,
        participant_id: interjector.config.id,
        content: safeContent,
        type: "interjection",
        targets_which: ij.target_participant_id,
        timestamp: Date.now(),
      };

      this.#state.weft.push(contribution);
      round.contributions.push(contribution);
      round.token_path.push(interjector.config.id);
      interjector.contributions_count++;

      this.#db.addContribution(this.#state.id, {
        ...contribution,
        round: this.#state.current_round,
      });

      const truncated = truncate(contribution.content, 120);
      this.#options.onProgress?.(`${interjector.config.name} (${interjector.config.tier}) — interjection: "${truncated}"`);
      this.#options.onContribution?.(interjector.config.name, this.#state.current_round, "interjection");
    } catch (err) {
      const info = extractErrorInfo(err);
      this.#logError(`interjection prompt for ${interjector.config.name}`, err);
      this.#logger.warn("interjection_failed", `Interjection failed for ${interjector.config.name}`, info);
      this.#options.onProgress?.(`${interjector.config.name} (${interjector.config.tier}) — interjection failed`);
    } finally {
      interjector.status = "listening";
      this.#db.setParticipantStatus(interjector.config.id, "listening");
    }
  }
}

import { buildAgentSystemPrompt, buildAgentUserPrompt, buildPushbackPrompt } from "./prompts.js";
import { generateRoundBriefs } from "./warp-manager.js";
import { parseAgentResponse } from "./validation.js";
import { getConfig } from "./config.js";
import { extractText, truncate, withTimeout, getPriorityCap, enforceWordLimit } from "./shared.js";
import { Logger, extractErrorInfo } from "./logger.js";
import { runReflectionPhase as runReflections } from "./reflection-manager.js";
import { sanitizeForPrompt, sanitizeForDisplay } from "./utils/sanitize.js";
import { withRetry, isRetryableError, CircuitBreaker } from "./utils/retry.js";
import { incrementKeyedCounter, recordLatency } from "./metrics.js";

function isTimeoutError(err) {
  return err instanceof Error && /timed out after/i.test(err.message);
}

export class RoundExecutor {
  #client;
  #directory;
  #db;
  #stateManager;
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

  constructor({ client, directory, db, stateManager, options, promptParent, getParticipantModel, logError }) {
    this.#client = client;
    this.#directory = directory;
    this.#db = db;
    this.#stateManager = stateManager;
    this.#options = options;
    this.#promptParent = promptParent;
    this.#getParticipantModel = getParticipantModel;
    this.#logError = logError;
    this.#failureCounts = new Map();
    this.#modelFailureTimes = new Map();
    this.#logger = new Logger();
    this.#interjectionTracker = new Map();
    this.#callStats = { agent_prompts: 0, reflection_calls: 0, interjection_calls: 0, input_tokens: 0, output_tokens: 0 };
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

  /**
   * Returns the set of participant IDs whose sessions were marked dirty during
   * this round (e.g. after a timeout) and clears the internal set. The caller
   * (orchestrator) is responsible for recreating these sessions.
   */
  takeDirtySessions() {
    const ids = [...this.#dirtySessions];
    this.#dirtySessions.clear();
    return ids;
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

  #recordTokens(result) {
    const tokens = result?.data?.tokens;
    if (!tokens) return;
    this.#callStats.input_tokens += tokens.input ?? 0;
    this.#callStats.output_tokens += tokens.output ?? 0;
  }

  /**
   * Runs the prompt phase for a round. Agents speak sequentially — each sees
   * all prior same-round contributions before responding.
   */
  async runPromptPhase(round, activeParticipants) {
    this.#turnOrder = [];

    const roundBriefs = generateRoundBriefs(this.#stateManager.getWarp(), round);

    for (const p of activeParticipants) {
      this.#turnOrder.push(p.config.id);
      this.#db.setParticipantStatus(p.config.id, "speaking");
      this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) is thinking...`);
      const result = await this.#promptChildSession(p, roundBriefs);
      await this.#handlePromptResult(p, result, round);
    }
  }

  async #handlePromptResult(p, result, round) {
    if (!result) {
      p.status = "failed";
      this.#failedInCurrentRound++;
      this.#db.setParticipantStatus(p.config.id, "failed");
      this.#db.recordAgentError(
        this.#stateManager.getMeetingId(), p.config.id, this.#stateManager.getCurrentRound(),
        "no_response", "Failed to get response after retries", 2,
      );
      round.token_path.push(p.config.id);
      this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) — failed to respond, skipping`);
      this.#options.onContribution?.(p.config.name, this.#stateManager.getCurrentRound(), "failed_no_response");
      return;
    }

    if (result.content === "[PASS]") {
      p.status = "passed";
      this.#db.setParticipantStatus(p.config.id, "passed");
      round.token_path.push(p.config.id);
      this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) — chose to pass`);
      this.#options.onContribution?.(p.config.name, this.#stateManager.getCurrentRound(), "pass");
      return;
    }

    this.#storeContribution(p, result, round);

    if (result.governance) {
      const g = result.governance;
      this.#logger.info("governance_directive", `${p.config.name} issued governance directive`, { directive: g.directive, value: g.value });
      if (!round.governance) round.governance = [];
      round.governance.push({ participant_id: p.config.id, directive: g.directive, value: g.value ?? null });
      this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) — issued governance directive [GOVERNANCE: ${g.directive}${g.value !== undefined ? `: ${g.value}` : ""}]`);
      this.#db.addOrchestratorMessage("governance", "user", `[GOVERNANCE: ${g.directive}${g.value !== undefined ? `: ${g.value}` : ""}] issued by ${p.config.name}`);
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

        // Send pushback prompt to the last contributor before the interjector speaks
        const lastContributor = round.contributions.length > 0
          ? activeParticipants.find((p) => p.config.id === round.contributions[round.contributions.length - 1].participant_id)
          : null;
        if (lastContributor && lastContributor.session_id) {
          const lastContent = round.contributions[round.contributions.length - 1].content;
          await this.#sendPushbackPrompt(lastContributor, interjector, ij, lastContent);
        }

        await this.#promptInterjector(interjector, ij, round);
      } else {
        ij.resolved = "denied";
      }
    }
  }

  #storeContribution(participant, result, round) {
    const id = this.#stateManager.nextContributionId();
    const safeContent = sanitizeForPrompt(result.content);
    const contribution = {
      id,
      round: this.#stateManager.getCurrentRound(),
      participant_id: result.participant_id,
      content: safeContent,
      type: result.type,
      targets_which: null,
      created_at: new Date().toISOString(),
    };

    this.#stateManager.addContribution(contribution);
    round.contributions.push(contribution);
    round.token_path.push(participant.config.id);
    participant.contributions_count++;
    participant.status = "listening";
    this.#db.setParticipantStatus(participant.config.id, "listening");

    let interjection = null;
    if (result.interjection) {
      const priorityCap = getPriorityCap(participant.config.tier);
      const targetParticipantId = this.#resolveInterjectionTarget(participant, result.interjection);
      interjection = {
        participant_id: result.participant_id,
        target_participant_id: targetParticipantId,
        round: this.#stateManager.getCurrentRound(),
        priority: Math.min(result.interjection.priority, priorityCap),
        reason: sanitizeForPrompt(result.interjection.reason),
        draft: result.interjection.draft ?? null,
        granted: false,
        pushback: null,
        resolved: "pending",
      };
      round.interjections.push(interjection);
    }

    this.#db.addContributionWithInterjection(this.#stateManager.getMeetingId(), {
      ...contribution,
      round: this.#stateManager.getCurrentRound(),
    }, interjection);

    this.#options.onContribution?.(participant.config.name, this.#stateManager.getCurrentRound(), result.type);
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
        const contrib = [...this.#stateManager.getWeft()].reverse().find((c) => c.id === parseInt(str, 10));
        if (contrib) return contrib.participant_id;
        return null;
      }
      const participant = this.#stateManager.getParticipants().find(
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

    // Capture session version AFTER any recreation settles, so the guard
    // compares against the current (post-recreate) version.
    const sessionVersion = participant.session_version ?? 0;

    const model = this.#getParticipantModel(participant);

    if (!this.#circuitBreaker.isHealthy(model)) {
      this.#logError(`model ${this.#modelKey(model)} is unhealthy, skipping`, new Error("circuit breaker open"));
      this.#logger.warn("model_unhealthy", `Skipping ${participant.config.name} — model ${this.#modelKey(model)} unhealthy`);
      return null;
    }

    const config = getConfig();
    const baseTimeoutMs = config.agentTimeoutMs;
    const totalParticipants = this.#stateManager.getParticipants().length;
    const timeoutReductionFactor = totalParticipants > 0
      ? Math.min(this.#failedInCurrentRound / totalParticipants, 0.5)
      : 0;
    const timeoutMs = Math.floor(baseTimeoutMs * (1 - timeoutReductionFactor));

    const promptFn = async () => {
      // Verify session version hasn't changed (prevents late responses from old sessions)
      if ((participant.session_version ?? 0) !== sessionVersion) {
        throw new Error("Session version changed — discarding stale response");
      }

      this.#callStats.agent_prompts++;
      const llmStart = Date.now();
      const result = await withTimeout(
        this.#client.session.prompt({
          path: { id: participant.session_id },
          body: {
            system: buildAgentSystemPrompt(participant),
            model,
            temperature: participant.tier_config.temperature,
            parts: [{ type: "text", text: buildAgentUserPrompt(
              participant,
              this.#stateManager.getWarp(),
              this.#stateManager.getWeft(),
              this.#stateManager.getQuestion(),
              this.#stateManager.getCurrentRound(),
              roundBriefs,
            ) }],
          },
          query: { directory: this.#directory },
        }),
        timeoutMs,
      );
      const llmMs = Date.now() - llmStart;
      incrementKeyedCounter("llm_calls_by_type", "agent");
      recordLatency("llm_prompt_ms", llmMs);

      this.#recordTokens(result);

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
        this.#stateManager.getMeetingId(), participant.config.id, this.#stateManager.getCurrentRound(),
        "prompt_failed", info.message, config.maxRetryAttempts + 1,
      );
      this.#logger.error("participant_failed", `${participant.config.name} failed after ${config.maxRetryAttempts + 1} attempts`, info);
      return null;
    }
  }

  async #sendPushbackPrompt(target, interjector, interjection, lastContent) {
    const config = getConfig();
    const model = this.#getParticipantModel(target);
    const systemPrompt = buildAgentSystemPrompt(target);
    const userPrompt = buildPushbackPrompt(
      target,
      interjector.config.name,
      interjection.priority,
      lastContent,
      interjection.reason || "",
    );

    try {
      const result = await withTimeout(
        this.#client.session.prompt({
          path: { id: target.session_id },
          body: { system: systemPrompt, model, temperature: target.tier_config.temperature, parts: [{ type: "text", text: userPrompt }] },
          query: { directory: this.#directory },
        }),
        config.agentTimeoutMs,
      );

      if (result.error) return;

      const text = extractText(result.data);
      if (!text) return;

      const upper = text.toUpperCase();
      if (upper.includes("[YIELD]")) {
        interjection.resolution = "yielded";
      } else if (upper.includes("[CONTEST]")) {
        interjection.resolution = "contested";
        const reasonMatch = text.match(/\[CONTEST\]\s*(.+)/i);
        interjection.contestReason = reasonMatch?.[1] ?? "";
      }
    } catch {
      // Pushback is best-effort — if it fails, the interjection proceeds normally
    }
  }

  async #promptInterjector(interjector, ij, round) {
    interjector.status = "speaking";
    this.#db.setParticipantStatus(interjector.config.id, "speaking");
    this.#options.onProgress?.(`${interjector.config.name} (${interjector.config.tier}) — interjecting...`);

    const config = getConfig();
    const draftContent = ij.draft;

    try {
      if (draftContent && draftContent.trim().length > 0) {
        const content = enforceWordLimit(sanitizeForPrompt(draftContent.trim()), config.maxInterjectionWords);
        this.#storeInterjection(interjector, content, ij, round);
        return;
      }

      const model = this.#getParticipantModel(interjector);
      const systemPrompt = buildAgentSystemPrompt(interjector);
      const userPrompt = `## You Interjected

You requested to interrupt with priority ${ij.priority}:
"${sanitizeForDisplay(ij.reason)}"

State your interjection now. Be direct and under 200 words.`;

      this.#callStats.interjection_calls++;
      const llmStart = Date.now();
      const result = await withTimeout(
        this.#client.session.prompt({
          path: { id: interjector.session_id },
          body: { system: systemPrompt, model, temperature: interjector.tier_config.temperature, parts: [{ type: "text", text: userPrompt }] },
          query: { directory: this.#directory },
        }),
        config.agentTimeoutMs,
      );
      const llmMs = Date.now() - llmStart;
      incrementKeyedCounter("llm_calls_by_type", "interjection");
      recordLatency("llm_prompt_ms", llmMs);

      this.#recordTokens(result);

      if (result.error) {
        throw new Error(result.error.message || JSON.stringify(result.error));
      }

      const content = extractText(result.data);
      if (!content) throw new Error("Empty interjection response");

      const safeContent = sanitizeForPrompt(content.replace(/^\[(\w+)\]\s*/, ""));
      this.#storeInterjection(interjector, safeContent, ij, round);
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

  #storeInterjection(interjector, content, ij, round) {
    const contribution = {
      id: this.#stateManager.nextContributionId(),
      round: this.#stateManager.getCurrentRound(),
      participant_id: interjector.config.id,
      content,
      type: "interjection",
      targets_which: ij.target_participant_id,
      created_at: new Date().toISOString(),
    };

    this.#stateManager.addContribution(contribution);
    round.contributions.push(contribution);
    round.token_path.push(interjector.config.id);
    interjector.contributions_count++;

    this.#db.addContribution(this.#stateManager.getMeetingId(), {
      ...contribution,
      round: this.#stateManager.getCurrentRound(),
    });

    const truncated = truncate(content, 120);
    this.#options.onProgress?.(`${interjector.config.name} (${interjector.config.tier}) — interjection: "${truncated}"`);
    this.#options.onContribution?.(interjector.config.name, this.#stateManager.getCurrentRound(), "interjection");
  }
}

import { buildAgentSystemPrompt, buildAgentUserPrompt, buildReflectionPrompt, buildPushbackPrompt } from "./prompts.js";
import { generateRoundBriefs } from "./warp-manager.js";
import { parseAgentResponse } from "./validation.js";
import { withConcurrency } from "./concurrency.js";
import { getConfig } from "./config.js";
import { extractText, truncate, withTimeout, getPriorityCap } from "./shared.js";
import { Logger, extractErrorInfo } from "./logger.js";

const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_RESET_MS = 5 * 60 * 1000;

export class RoundExecutor {
  #client;
  #directory;
  #db;
  #state;
  #options;
  #promptParent;
  #getParticipantModel;
  #getHighestTierModel;
  #logError;
  #failureCounts;
  #modelFailureTimes;
  #logger;
  #interjectionTracker;
  #lastSpeakerId;
  #consecutiveProgressFailures;

  constructor({ client, directory, db, state, options, promptParent, getParticipantModel, getHighestTierModel, logError }) {
    this.#client = client;
    this.#directory = directory;
    this.#db = db;
    this.#state = state;
    this.#options = options;
    this.#promptParent = promptParent;
    this.#getParticipantModel = getParticipantModel;
    this.#getHighestTierModel = getHighestTierModel;
    this.#logError = logError;
    this.#failureCounts = new Map();
    this.#modelFailureTimes = new Map();
    this.#logger = new Logger();
    this.#interjectionTracker = new Map();
    this.#lastSpeakerId = null;
    this.#consecutiveProgressFailures = 0;
  }

  #modelKey(model) {
    return `${model.providerID}/${model.modelID}`;
  }

  #isModelHealthy(model) {
    const key = this.#modelKey(model);
    const failures = this.#failureCounts.get(key) ?? 0;
    if (failures < CIRCUIT_BREAKER_THRESHOLD) return true;

    const lastFailure = this.#modelFailureTimes.get(key);
    if (lastFailure && Date.now() - lastFailure > CIRCUIT_BREAKER_RESET_MS) {
      this.#failureCounts.delete(key);
      this.#modelFailureTimes.delete(key);
      this.#logger.info("circuit_breaker_reset", `Model ${key} circuit breaker reset after timeout`);
      return true;
    }

    return false;
  }

  #recordModelFailure(model) {
    const key = this.#modelKey(model);
    const count = (this.#failureCounts.get(key) ?? 0) + 1;
    this.#failureCounts.set(key, count);
    this.#modelFailureTimes.set(key, Date.now());
    if (count >= CIRCUIT_BREAKER_THRESHOLD) {
      this.#options.onProgress?.(`⚠️ Model ${key} marked unhealthy after ${count} consecutive failures. Will retry in ${CIRCUIT_BREAKER_RESET_MS / 60000} minutes.`);
      this.#logger.warn("circuit_breaker", `Model ${key} marked unhealthy`, { failures: count });
    }
  }

  #recordModelSuccess(model) {
    const key = this.#modelKey(model);
    if (this.#failureCounts.has(key)) {
      this.#failureCounts.delete(key);
      this.#modelFailureTimes.delete(key);
    }
  }

  async runPromptPhase(round, activeParticipants, parallel) {
    if (parallel) {
      await this.#runParallelPromptPhase(round, activeParticipants);
    } else {
      await this.#runSequentialPromptPhase(round, activeParticipants);
    }
  }

  async runReflectionPhase(round, activeParticipants) {
    const triggers = round.contributions.filter((c) => c.type === "challenge" || c.type === "dissent");
    if (triggers.length === 0) return;

    for (const trigger of triggers) {
      const triggerParticipant = activeParticipants.find((p) => p.config.id === trigger.participant_id);
      if (!triggerParticipant) continue;

      const listeners = activeParticipants.filter((p) => {
        if (p.config.id === trigger.participant_id) return false;
        if (p.status === "passed") return false;
        if (p.status === "failed") return false;
        if (p.reflection) return false;
        return true;
      });

      for (const listener of listeners) {
        const model = this.#getParticipantModel(listener);
        const prompt = buildReflectionPrompt(listener, triggerParticipant.config.name, trigger.content);

        try {
          const reflection = await this.#promptParent(
            `You are ${listener.config.name} (${listener.config.tier}). Private reflection — only you will see this.`,
            model,
            prompt
          );

          if (reflection && reflection.trim().length > 10) {
            listener.reflection = reflection.trim();
            this.#db.setParticipantReflection(listener.config.id, listener.reflection);
          }
        } catch (err) {
          const info = extractErrorInfo(err);
          this.#logError(`reflection prompt for ${listener.config.name}`, err);
          this.#logger.warn("reflection_failed", `Reflection for ${listener.config.name} failed`, info);
        }
      }
    }
  }

  async runInterjectionPhase(round, activeParticipants) {
    const config = getConfig();
    const maxInterjections = config.maxInterjectionsPerRound ?? 3;
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

      const priorityCap = getPriorityCap(interjector.config.tier);
      if (ij.priority > priorityCap) {
        ij.priority = priorityCap;
      }

      if (ij.priority >= 9) {
        ij.granted = true;
        ij.resolved = "granted";
        grantedCount++;
        this.#interjectionTracker.set(interjector.config.id, round.number);
      } else if (ij.priority >= 7) {
        const target = activeParticipants.find((p) => p.config.id === ij.target_participant_id);
        if (target) {
          const pushback = await this.#checkPushback(target, ij, round);
          if (pushback === "yield") {
            ij.granted = true;
            ij.resolved = "granted";
            grantedCount++;
            this.#interjectionTracker.set(interjector.config.id, round.number);
          } else if (pushback === "contest_wins") {
            ij.resolved = "contested";
            ij.pushback = "Speaker contested and won";
          } else {
            ij.granted = true;
            ij.resolved = "granted";
            grantedCount++;
            this.#interjectionTracker.set(interjector.config.id, round.number);
          }
        } else {
          ij.granted = true;
          ij.resolved = "granted";
          grantedCount++;
          this.#interjectionTracker.set(interjector.config.id, round.number);
        }
      } else {
        ij.resolved = "denied";
      }

      if (ij.granted) {
        await this.#promptInterjector(interjector, ij, round);
      }
    }
  }

  async #runParallelPromptPhase(round, activeParticipants) {
    this.#options.onProgress?.(`${activeParticipants.length} participants thinking...`);
    for (const p of activeParticipants) {
      this.#db.setParticipantStatus(p.config.id, "speaking");
    }

    const roundBriefs = generateRoundBriefs(this.#state.warp, round);

    const tasks = activeParticipants.map((p) => async () => {
      const result = await this.#promptChildSession(p, roundBriefs);
      return { participant: p, result };
    });

    const config = getConfig();
    const concurrencyLimit = Math.min(activeParticipants.length, config.maxConcurrentPrompts);
    const results = await withConcurrency(tasks, concurrencyLimit);

    for (const { participant: p, result } of results) {
      if (!result) {
        p.status = "failed";
        this.#db.setParticipantStatus(p.config.id, "failed");
        this.#db.recordAgentError(
          this.#state.id, p.config.id, this.#state.current_round,
          "no_response", "Failed to get response after retries", 2,
        );
        round.token_path.push(p.config.id);
        this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) — failed to respond, skipping`);
        this.#options.onContribution?.(p.config.name, this.#state.current_round, "failed_no_response");
        continue;
      }

      if (result.content === "[PASS]") {
        p.status = "passed";
        this.#db.setParticipantStatus(p.config.id, "passed");
        round.token_path.push(p.config.id);
        this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) — chose to pass`);
        this.#options.onContribution?.(p.config.name, this.#state.current_round, "pass");
        continue;
      }

      this.#storeContribution(p, result, round);
      p.reflection = "";
      this.#db.setParticipantReflection(p.config.id, "");

      const truncated = truncate(result.content, 120);
      this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) — ${result.type}: "${truncated}"`);
    }
  }

  async #runSequentialPromptPhase(round, activeParticipants) {
    const roundBriefs = generateRoundBriefs(this.#state.warp, round);
    for (const p of activeParticipants) {
      this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) is thinking...`);
      this.#db.setParticipantStatus(p.config.id, "speaking");

      let result = await this.#promptChildSession(p, roundBriefs);

      if (!result) {
        result = await this.#promptChildSession(p, roundBriefs);
      }

      if (!result) {
        this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) — failed to respond, skipping`);
        const participant = this.#state.participants.find((pp) => pp.config.id === p.config.id);
        if (participant) participant.status = "failed";
        this.#db.setParticipantStatus(p.config.id, "failed");
        this.#db.recordAgentError(
          this.#state.id, p.config.id, this.#state.current_round,
          "no_response", "Failed to get response after retries", 2,
        );
        round.token_path.push(p.config.id);
        this.#options.onContribution?.(p.config.name, this.#state.current_round, "failed_no_response");
        continue;
      }

      const participant = this.#state.participants.find((pp) => pp.config.id === result.participant_id);
      if (!participant) continue;

      if (result.content === "[PASS]") {
        participant.status = "passed";
        this.#db.setParticipantStatus(participant.config.id, "passed");
        round.token_path.push(participant.config.id);
        this.#options.onProgress?.(`${participant.config.name} (${participant.config.tier}) — chose to pass`);
        this.#options.onContribution?.(participant.config.name, this.#state.current_round, "pass");
        continue;
      }

      this.#storeContribution(participant, result, round);
      participant.reflection = "";
      this.#db.setParticipantReflection(participant.config.id, "");

      const truncated = truncate(result.content, 120);
      this.#options.onProgress?.(`${participant.config.name} (${participant.config.tier}) — ${result.type}: "${truncated}"`);
    }
  }

  #storeContribution(participant, result, round) {
    const contribution = {
      participant_id: result.participant_id,
      content: result.content,
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
    this.#lastSpeakerId = participant.config.id;

    this.#db.addContribution(this.#state.id, {
      ...contribution,
      round: this.#state.current_round,
    });

    if (result.interjection) {
      const priorityCap = getPriorityCap(participant.config.tier);
      const clampedPriority = Math.min(result.interjection.priority, priorityCap);
      const interjection = {
        participant_id: result.participant_id,
        target_participant_id: this.#lastSpeakerId ?? null,
        round: this.#state.current_round,
        priority: clampedPriority,
        reason: result.interjection.reason,
        granted: false,
        pushback: null,
        resolved: "pending",
      };
      round.interjections.push(interjection);
      this.#db.addInterjection(this.#state.id, interjection);
    }

    this.#options.onAgentComplete?.(result.participant_id, result.content);
    this.#options.onContribution?.(participant.config.name, this.#state.current_round, result.type);
  }

  async #promptChildSession(participant, roundBriefs) {
    participant.status = "speaking";

    if (!participant.session_id) {
      return null;
    }

    const model = this.#getParticipantModel(participant);

    if (!this.#isModelHealthy(model)) {
      this.#logError(`model ${this.#modelKey(model)} is unhealthy, skipping`, new Error("circuit breaker open"));
      this.#logger.warn("model_unhealthy", `Skipping ${participant.config.name} — model ${this.#modelKey(model)} unhealthy`);
      return null;
    }

    const config = getConfig();
    const maxRetries = config.maxRetryAttempts;
    const timeoutMs = config.agentTimeoutMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
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

        const response = parseAgentResponse(participant.config.id, content);
        if (!response) return null;

        this.#recordModelSuccess(model);
        this.#options.onAgentComplete?.(participant.config.id, response.content);
        return response;
      } catch (err) {
        if (attempt === maxRetries) {
          this.#recordModelFailure(model);
          const info = extractErrorInfo(err);
          this.#state.objections.push({
            participant_id: participant.config.id,
            content: `Failed after ${maxRetries + 1} attempts: ${err instanceof Error ? err.message : "unknown"}`,
            unresolved: true,
          });
          this.#logger.error("participant_failed", `${participant.config.name} failed after ${maxRetries + 1} attempts`, info);
          return null;
        }
        const delay = Math.min(
          config.retryBaseDelayMs * Math.pow(2, attempt) + Math.random() * 500,
          config.retryMaxDelayMs,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    return null;
  }

  async #checkPushback(speaker, ij, round) {
    const model = this.#getParticipantModel(speaker);
    const speakerContribution = round.contributions.filter((c) => c.participant_id === ij.target_participant_id).pop();
    const interjector = this.#state.participants.find((p) => p.config.id === ij.participant_id);
    const interjectorName = interjector ? interjector.config.name : ij.participant_id;
    const prompt = buildPushbackPrompt(speaker, interjectorName, ij.priority, speakerContribution?.content ?? "");

    try {
      const result = await this.#promptParent(
        `You are ${speaker.config.name} (${speaker.config.tier}). Someone wants to interrupt your turn.`,
        model,
        prompt
      );
      const text = result.trim();

      if (text.startsWith("[CONTEST]")) {
        return "contest_wins";
      }

      return "yield";
    } catch (err) {
      const info = extractErrorInfo(err);
      this.#logError("pushback check", err);
      this.#logger.warn("pushback_failed", `Pushback check failed for ${speaker.config.name}`, info);
      return "yield";
    }
  }

  async #promptInterjector(interjector, ij, round) {
    interjector.status = "speaking";
    this.#db.setParticipantStatus(interjector.config.id, "speaking");
    this.#options.onProgress?.(`${interjector.config.name} (${interjector.config.tier}) — interjecting...`);

    const config = getConfig();
    const draftContent = ij.draft;

    if (draftContent && draftContent.trim().length > 0) {
      const content = enforceWordLimit(draftContent.trim(), config.maxInterjectionWords);
      const contribution = {
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
      interjector.reflection = "";
      this.#db.setParticipantReflection(interjector.config.id, "");

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
"${ij.reason}"

State your interjection now. Be direct and under 200 words.`;

    try {
      const result = await withTimeout(
        this.#client.session.prompt({
          path: { id: interjector.session_id },
          body: { system: systemPrompt, model, temperature: interjector.tier_config.temperature, parts: [{ type: "text", text: userPrompt }] },
          query: { directory: this.#directory },
        }),
        120000,
      );

      if (result.error) {
        throw new Error(result.error.message || JSON.stringify(result.error));
      }

      const content = extractText(result.data);
      if (!content) throw new Error("Empty interjection response");

      const contribution = {
        participant_id: interjector.config.id,
        content: content.replace(/^\[(\w+)\]\s*/, ""),
        type: "interjection",
        targets_which: ij.target_participant_id,
        timestamp: Date.now(),
      };

      this.#state.weft.push(contribution);
      round.contributions.push(contribution);
      round.token_path.push(interjector.config.id);
      interjector.contributions_count++;
      interjector.reflection = "";
      this.#db.setParticipantReflection(interjector.config.id, "");

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

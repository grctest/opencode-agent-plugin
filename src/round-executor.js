import { buildAgentSystemPrompt, buildAgentUserPrompt, buildPushbackPrompt } from "./prompts.js";
import { generateRoundBriefs } from "./warp-manager.js";
import { parseAgentResponse } from "./validation.js";
import { withConcurrency } from "./concurrency.js";
import { getConfig } from "./config.js";
import { extractText, truncate, withTimeout, getPriorityCap, enforceWordLimit } from "./shared.js";
import { Logger, extractErrorInfo } from "./logger.js";
import { runReflectionPhase as runReflections } from "./reflection-manager.js";

const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_RESET_MS = 5 * 60 * 1000;

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
    this.#callStats = { agent_prompts: 0, reflection_calls: 0, interjection_calls: 0, pushback_calls: 0 };
  }

  getCallStats() {
    return { ...this.#callStats };
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

    const truncated = truncate(result.content, 120);
    this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) — ${result.type}: "${truncated}"`);
  }

  async runReflectionPhase(round, activeParticipants) {
    await runReflections(round, activeParticipants, this.#promptParent, this.#getParticipantModel, this.#db, this.#logError);
  }

  async runInterjectionPhase(round, activeParticipants) {
    const config = getConfig();
    const maxInterjections = config.maxInterjectionsPerRound ?? 3;
    const { autoGrant = 9, pushback = 7 } = config.interjectionThresholds ?? {};
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

      if (ij.priority >= autoGrant) {
        ij.granted = true;
        ij.resolved = "granted";
        grantedCount++;
        this.#interjectionTracker.set(interjector.config.id, round.number);
      } else if (ij.priority >= pushback) {
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

  #storeContribution(participant, result, round) {
    const id = ++this.#state.next_contribution_id;
    const contribution = {
      id,
      round: this.#state.current_round,
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
        reason: result.interjection.reason,
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

    if (this.#dirtySessions.has(participant.config.id)) {
      this.#dirtySessions.delete(participant.config.id);
      const recreated = await this.#options.recreateSession?.(participant);
      if (recreated) {
        this.#logger.info("session_recreated", `Recreated dirty session for ${participant.config.name}`);
      }
      if (!participant.session_id) return null;
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
        // Note: withTimeout rejects but cannot abort the in-flight SDK request.
        // A timed-out response is discarded here, and the session is marked dirty so it
        // gets recreated before the next prompt — a late-arriving response can never
        // contaminate a future prompt.
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

        const response = parseAgentResponse(participant.config.id, content);
        if (!response) return null;

        this.#recordModelSuccess(model);
        this.#options.onAgentComplete?.(participant.config.id, response.content);
        return response;
      } catch (err) {
        if (isTimeoutError(err)) {
          this.#dirtySessions.add(participant.config.id);
          this.#logger.warn("session_dirty", `Marking ${participant.config.name}'s session dirty after timeout — will recreate before next prompt`);
        }
        if (attempt === maxRetries) {
          this.#recordModelFailure(model);
          const info = extractErrorInfo(err);
          this.#db.recordAgentError(
            this.#state.id, participant.config.id, this.#state.current_round,
            "prompt_failed", info.message, attempt + 1,
          );
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
    const speakerContribution = round.contributions.filter((c) => c.participant_id === ij.target_participant_id).pop()
      ?? [...this.#state.weft].reverse().find((c) => c.participant_id === ij.target_participant_id);
    const interjector = this.#state.participants.find((p) => p.config.id === ij.participant_id);
    const interjectorName = interjector ? interjector.config.name : ij.participant_id;
    const prompt = buildPushbackPrompt(speaker, interjectorName, ij.priority, speakerContribution?.content ?? "", ij.reason);

    try {
      this.#callStats.pushback_calls++;
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
"${ij.reason}"

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

      const contribution = {
        id: ++this.#state.next_contribution_id,
        round: this.#state.current_round,
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

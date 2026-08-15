import { buildAgentSystemPrompt, buildAgentUserPrompt } from "./prompts.js";
import { parseAgentResponse } from "./validation.js";
import { getConfig } from "./config.js";
import { extractText, extractAgentResponse, truncate, withTimeout, enforceWordLimit } from "./shared.js";
import { Logger, extractErrorInfo } from "./logger.js";
import { runMidRoundReflections } from "./reflection-manager.js";
import { sanitizeForPrompt, sanitizeForDisplay } from "./utils/sanitize.js";
import { withRetry, isRetryableError, CircuitBreaker } from "./utils/retry.js";
import { incrementKeyedCounter, recordLatency } from "./metrics.js";

export class RoundExecutor {
  #client;
  #directory;
  #db;
  #stateManager;
  #vectorIndex;
  #options;
  #sessionManager;
  #promptParent;
  #getParticipantModel;
  #logError;
  #failureCounts;
  #modelFailureTimes;
  #logger;
  #turnOrder = [];
  #callStats;
  #circuitBreaker;
  #tools;

  constructor({ client, directory, db, stateManager, vectorIndex, options, sessionManager, promptParent, getParticipantModel, logError, tools = null }) {
    this.#client = client;
    this.#directory = directory;
    this.#db = db;
    this.#stateManager = stateManager;
    this.#vectorIndex = vectorIndex;
    this.#options = options;
    this.#sessionManager = sessionManager;
    this.#promptParent = promptParent;
    this.#getParticipantModel = getParticipantModel;
    this.#logError = logError;
    this.#tools = tools;
    this.#failureCounts = new Map();
    this.#modelFailureTimes = new Map();
    this.#logger = new Logger();
    this.#callStats = { agent_prompts: 0, reflection_calls: 0, input_tokens: 0, output_tokens: 0 };
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

  #recordTokens(result) {
    const tokens = result?.data?.tokens;
    if (!tokens) return;
    this.#callStats.input_tokens += tokens.input ?? 0;
    this.#callStats.output_tokens += tokens.output ?? 0;
  }

  /**
   * Runs the prompt phase for a round. Agents speak sequentially — each sees
   * all prior same-round contributions before responding.
   * After each challenge/dissent, agents that spoke BEFORE the challenger
   * immediately reflect on it (mid-round reflections).
   * Supports intra-round queue jumping: Priority 9+ moves agent to position 0.
   */
  async runPromptPhase(round, activeParticipants) {
    this.#turnOrder = [];
    const remainingSpeakers = [...activeParticipants];
    const spokenOrder = []; // Track agents that have spoken this round

    while (remainingSpeakers.length > 0) {
      const p = remainingSpeakers.shift();
      this.#turnOrder.push(p.config.id);
      spokenOrder.push(p);
      this.#db.setParticipantStatus(p.config.id, "speaking");
      this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) is thinking...`);
      const result = await this.#promptChildSession(p);
      await this.#handlePromptResult(p, result, round);

      // Mid-round reflections: if this agent challenged/dissented,
      // trigger reflections for agents that spoke BEFORE them
      if (result && (result.type === "challenge" || result.type === "dissent")) {
        const preChallengeAgents = spokenOrder.filter(
          (sp) => sp.config.id !== p.config.id && sp.status !== "passed" && sp.status !== "failed"
        );

        if (preChallengeAgents.length > 0) {
          // Store the challenge/dissent content and type for the reflection prompt
          p.currentContribution = result.content;
          p.currentContributionId = round.contributions[round.contributions.length - 1]?.id;
          p.currentContributionType = result.type;

          await runMidRoundReflections(round, p, preChallengeAgents, {
            client: this.#client,
            directory: this.#directory,
            sessionManager: this.#sessionManager,
            getParticipantModel: this.#getParticipantModel,
            stateManager: this.#stateManager,
            db: this.#db,
            logError: this.#logError,
          });
        }
      }

      // Intra-round queue jumping: Priority 9+ moves next speaker to position 0
      if (result?.request_next && result.request_next.priority >= 9 && remainingSpeakers.length > 0) {
        const nextRequest = result.request_next;
        const jumpIdx = remainingSpeakers.findIndex((sp) => {
          const nextResult = round.turn_requests?.find((tr) => tr.participant_id === sp.config.id);
          return nextResult && nextResult.priority >= 9;
        });
        if (jumpIdx > 0) {
          const [jumped] = remainingSpeakers.splice(jumpIdx, 1);
          remainingSpeakers.unshift(jumped);
        }
      }
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

  // Reflections now happen mid-round in runPromptPhase — no separate phase needed
  async runReflectionPhase(round, activeParticipants) {
    // No-op
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

    // Store turn order request (replaces interjection)
    let turnRequest = null;
    if (result.request_next) {
      turnRequest = {
        participant_id: result.participant_id,
        round: this.#stateManager.getCurrentRound(),
        priority: result.request_next.priority,
        reason: sanitizeForPrompt(result.request_next.reason),
        resolved: "pending",
      };
      if (!round.turn_requests) round.turn_requests = [];
      round.turn_requests.push(turnRequest);
    }

    this.#db.addContributionWithInterjection(this.#stateManager.getMeetingId(), {
      ...contribution,
      round: this.#stateManager.getCurrentRound(),
    }, turnRequest);

    this.#options.onContribution?.(participant.config.name, this.#stateManager.getCurrentRound(), result.type);
  }

  async #promptChildSession(participant) {
    participant.status = "speaking";

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

    const currentRound = this.#stateManager.getCurrentRound();

    // Build RAG context from vector index using persona-aware query
    const recentContribs = this.#stateManager.getWeave().filter((c) => c.round != null && c.round >= currentRound - 1);
    const queryText = recentContribs.length > 0
      ? recentContribs.map((c) => c.content).join("\n")
      : this.#stateManager.getQuestion();
    const ragChunks = this.#vectorIndex
      ? await this.#vectorIndex.retrieveRelevant(queryText, 5, currentRound)
      : [];
    const ragContext = ragChunks.length > 0
      ? ragChunks.map((c) => `[Round ${c.round}] ${c.content}`).join("\n\n")
      : "";

    // Golden Sandwich: recent 3-4 contributions from current + previous round
    const recentForPrompt = this.#stateManager.getWeave().filter(
      (c) => c.round != null && c.round >= currentRound - 1,
    ).slice(-4);

    const ephemeralSessionId = await this.#options.createEphemeralSession(participant);

    // Register ephemeral session → meeting mapping for tool resolution
    this.#sessionManager.registerSessionMeeting(ephemeralSessionId, this.#stateManager.getMeetingId());

    let ephemeralSessionIdToDelete = ephemeralSessionId;

    try {
      this.#callStats.agent_prompts++;
      const llmStart = Date.now();

      // Build tools map for the prompt call (only when agent tools are enabled)
      const agentToolsConfig = config.agentTools;
      const toolsMap = (agentToolsConfig?.enabled && this.#tools)
        ? this.#tools
        : {};

      const result = await withTimeout(
        this.#client.session.prompt({
          path: { id: ephemeralSessionId },
          body: {
            system: buildAgentSystemPrompt(participant),
            model,
            temperature: participant.tier_config.temperature,
            parts: [{ type: "text", text: buildAgentUserPrompt(
              participant,
              this.#stateManager.getStateOfPlay(),
              ragContext,
              recentForPrompt,
              currentRound,
              this.#stateManager.getQuestion(),
              this.#stateManager.getDomain(),
            ) }],
            tools: toolsMap,
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

      // Use extractAgentResponse to handle tool call parts
      const { text: agentText, toolResults, reasoning } = extractAgentResponse(result.data);

      // Log tool results for observability
      if (toolResults.length > 0) {
        this.#logger.info("tool_results", `${participant.config.name} used ${toolResults.length} tool(s)`, {
          tools: toolResults.map(t => ({
            tool: t.tool,
            callID: t.callID,
            hasOutput: !!t.output,
            hasError: !!t.error,
          })),
        });
      }

      // Enforce maxToolCallsPerTurn limit
      const maxToolCalls = agentToolsConfig?.maxToolCallsPerTurn ?? 5;
      if (toolResults.length > maxToolCalls) {
        this.#logger.warn("tool_call_limit", `${participant.config.name} exceeded max tool calls (${toolResults.length}/${maxToolCalls})`);
      }

      // Use the last text segment from the agent (post-tool-execution)
      if (!agentText) return null;

      const safeContent = sanitizeForPrompt(agentText);
      const response = parseAgentResponse(participant.config.id, safeContent);
      if (!response) return null;

      this.#recordModelSuccess(model);
      this.#options.onAgentComplete?.(participant.config.id, response.content);
      ephemeralSessionIdToDelete = null;
      return response;
    } catch (err) {
      this.#recordModelFailure(model);
      const info = extractErrorInfo(err);
      this.#db.recordAgentError(
        this.#stateManager.getMeetingId(), participant.config.id, this.#stateManager.getCurrentRound(),
        "prompt_failed", info.message, config.maxRetryAttempts + 1,
      );
      this.#logger.error("participant_failed", `${participant.config.name} failed after ${config.maxRetryAttempts + 1} attempts`, info);
      return null;
    } finally {
      // Unregister session mapping
      this.#sessionManager.unregisterSession(ephemeralSessionId);
      if (ephemeralSessionIdToDelete) {
        this.#options.deleteEphemeralSession(ephemeralSessionIdToDelete).catch((err) => {
          this.#logger.warn("ephemeral_session_delete_failed", "Failed to clean up ephemeral session", extractErrorInfo(err));
        });
      }
    }
  }
}

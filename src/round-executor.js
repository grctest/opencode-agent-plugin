import { buildAgentSystemPrompt, buildAgentUserPrompt, buildQueryPrompt, buildEvidencePrompt, buildSummonPrompt, buildVotePrompt } from "./prompts.js";
import { parseAgentResponse } from "./validation.js";
import { getConfig, resolveBuiltInTools } from "./config.js";
import { extractText, extractAgentResponse, mapToolResults, truncate, withTimeout } from "./shared.js";
import { Logger, extractErrorInfo } from "./logger.js";
import { runMidRoundReflections } from "./reflection-manager.js";
import { sanitizeForPrompt, sanitizeForDisplay } from "./utils/sanitize.js";
import { withRetry, isRetryableError, CircuitBreaker } from "./utils/retry.js";
import { selectFallbackModel } from "./services/model-service.js";
import { incrementKeyedCounter, recordLatency } from "./metrics.js";

/**
 * Extracts a vote letter (A, B, C, etc.) from a vote response string.
 * Looks for "[Vote: X]" pattern or falls back to first standalone capital letter.
 */
function extractVoteLetter(text) {
  if (!text) return null;
  // Look for [Vote: X] pattern
  const tagMatch = text.match(/\[Vote:\s*([A-Za-z])\]/i);
  if (tagMatch) return tagMatch[1].toUpperCase();
  // Fallback: first standalone capital letter on its own line
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[A-Za-z]$/.test(trimmed)) return trimmed.toUpperCase();
  }
  return null;
}

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
  #availableModels;

  constructor({ client, directory, db, stateManager, vectorIndex, options, sessionManager, promptParent, getParticipantModel, logError, tools = null, availableModels = [] }) {
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
    this.#availableModels = availableModels;
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

      // Directed queries: if this agent queried specific participants, execute now
      if (result?.query && result.query.targets.length > 0 && result.content !== "[PASS]") {
        const sourceContribution = round.contributions[round.contributions.length - 1];
        if (sourceContribution) {
          p.currentContribution = result.content;
          await this.executeQueries(round, p, result.query, sourceContribution.id, {
            client: this.#client,
            directory: this.#directory,
            sessionManager: this.#sessionManager,
            getParticipantModel: this.#getParticipantModel,
            stateManager: this.#stateManager,
            db: this.#db,
            callStats: this.#callStats,
          });
        }
      }

      // Evidence requests: if this agent requested evidence from specific participants
      if (result?.evidence && result.evidence.targets.length > 0 && result.content !== "[PASS]") {
        const sourceContribution = round.contributions[round.contributions.length - 1];
        if (sourceContribution) {
          p.currentContribution = result.content;
          await this.executeEvidenceRequests(round, p, result.evidence, sourceContribution.id, {
            client: this.#client,
            directory: this.#directory,
            sessionManager: this.#sessionManager,
            getParticipantModel: this.#getParticipantModel,
            stateManager: this.#stateManager,
            db: this.#db,
            callStats: this.#callStats,
          });
        }
      }

      // Persona summons: if this agent summoned an external expert
      if (result?.summon && result.content !== "[PASS]") {
        await this.executeSummons(round, p, result.summon, {
          client: this.#client,
          directory: this.#directory,
          sessionManager: this.#sessionManager,
          stateManager: this.#stateManager,
          db: this.#db,
          callStats: this.#callStats,
        });
      }

      // Vote: if this agent called a vote
      if (result?.vote && result.content !== "[PASS]") {
        const sourceContribution = round.contributions[round.contributions.length - 1];
        if (sourceContribution) {
          await this.executeVote(round, p, result.vote, sourceContribution.id, {
            client: this.#client,
            directory: this.#directory,
            sessionManager: this.#sessionManager,
            getParticipantModel: this.#getParticipantModel,
            stateManager: this.#stateManager,
            db: this.#db,
            callStats: this.#callStats,
          });
        }
      }

      // Mid-round reflections: if this agent challenged/dissented,
      // trigger reflection for the most persona-similar active participant
      if (result && (result.type === "challenge" || result.type === "dissent")) {
        const allActive = this.#stateManager.getActiveParticipants();

        if (allActive.length > 1) {
          // Store the challenge/dissent content and type for the reflection prompt
          p.currentContribution = result.content;
          p.currentContributionId = round.contributions[round.contributions.length - 1]?.id;
          p.currentContributionType = result.type;

          await runMidRoundReflections(round, p, allActive, {
            client: this.#client,
            directory: this.#directory,
            sessionManager: this.#sessionManager,
            getParticipantModel: this.#getParticipantModel,
            stateManager: this.#stateManager,
            db: this.#db,
            logError: this.#logError,
            callStats: this.#callStats,
          });
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

    const truncated = truncate(result.content, 120);
    this.#options.onProgress?.(`${p.config.name} (${p.config.tier}) — ${result.type}: "${truncated}"`);
  }

  // Reflections now happen mid-round in runPromptPhase — no separate phase needed
  async runReflectionPhase(round, activeParticipants) {
    // No-op
  }

  /**
   * Executes directed queries. When an agent embeds [QUERY: @target] in their
   * response, the target agent is prompted to respond directly to the question.
   * Each response becomes a query_response contribution in the weave.
   */
  async executeQueries(round, sourceParticipant, query, sourceContributionId, {
    client,
    directory,
    sessionManager,
    getParticipantModel,
    stateManager,
    db,
    callStats,
  }) {
    const config = getConfig();
    const timeoutMs = config.agentTimeoutMs;
    const allParticipants = stateManager.getParticipants();

    // Resolve and filter targets
    const targets = query.targets
      .map((id) => allParticipants.find((p) => p.config.id === id))
      .filter((p) => p && p.config.id !== sourceParticipant.config.id && p.status !== "failed" && p.status !== "passed");

    if (targets.length === 0) return;

    const sourceName = sourceParticipant.config.name;

    db.setQueryingParticipants(targets.map((t) => t.config.id));

    await Promise.allSettled(
      targets.map(async (target) => {
        const model = getParticipantModel(target);
        const sessionId = await sessionManager.createEphemeralSession(target);
        try {
          // Set target status to speaking while processing query
          const previousStatus = target.status;
          target.status = "speaking";
          db.setParticipantStatus(target.config.id, "speaking");

          const prompt = buildQueryPrompt(
            sourceParticipant,
            target,
            sourceParticipant.currentContribution || sourceParticipant.config.name,
            query.question,
            round.contributions,
            stateManager.getCurrentRound(),
            stateManager.getMaxRounds(),
          );

          // Build tools map for query (reduced set: webfetch, websearch, read, loom_vector_search)
          const agentToolsConfig = getConfig().agentTools;
          const queryTools = {};
          if (agentToolsConfig?.enabled) {
            const t = resolveBuiltInTools(agentToolsConfig);
            if (t.webfetch) queryTools.webfetch = true;
            if (t.websearch) queryTools.websearch = true;
            if (t.read) queryTools.read = true;
            if (agentToolsConfig.loom?.loom_vector_search) queryTools.loom_vector_search = true;
          }
          const queryToolKeys = Object.keys(queryTools);
          this.#logger.info("agent_tools_offered", `${target.config.name} offered ${queryToolKeys.length} tool(s)`, {
            participant: target.config.id,
            round: stateManager.getCurrentRound(),
            tools: queryToolKeys,
            tool_choice: queryToolKeys.length > 0 ? "auto" : "none",
          });

          const systemPrompt = `You are ${target.config.name} (${target.config.tier}). A fellow participant has directed a question to you. Respond directly and stay in character.`;
          const promptContext = {
            type: "query_response",
            system_prompt: systemPrompt,
            user_prompt: prompt,
            source_contribution_id: sourceContributionId,
            source_participant_id: sourceParticipant.config.id,
            question: query.question,
            round_contributions_used: round.contributions.slice(-4).map((c) => ({
              id: c.id, participant_id: c.participant_id, type: c.type, content: c.content,
            })),
            round: stateManager.getCurrentRound(),
          };

          const result = await withTimeout(
            client.session.prompt({
              path: { id: sessionId },
              body: {
                system: systemPrompt,
                model,
                temperature: target.tier_config.temperature,
                parts: [{ type: "text", text: prompt }],
                tools: queryTools,
                tool_choice: Object.keys(queryTools).length > 0 ? "auto" : undefined,
              },
              query: { directory },
            }),
            timeoutMs,
          );

          if (callStats) {
            callStats.reflection_calls++;
            const tokens = result?.data?.tokens;
            if (tokens) {
              callStats.input_tokens += tokens.input ?? 0;
              callStats.output_tokens += tokens.output ?? 0;
            }
          }

          if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));

          const { text, toolResults } = extractAgentResponse(result.data);

          if (!text || text.trim().length < 10) return;

          const contributionTools = mapToolResults(toolResults);

          // Create query response contribution
          const contribution = {
            id: stateManager.nextContributionId(),
            round: stateManager.getCurrentRound(),
            participant_id: target.config.id,
            content: `[Response to query from ${sourceName}]\n\n${text.trim()}`,
            type: "query_response",
            targets_which: sourceContributionId,
            tool_calls: contributionTools && contributionTools.length ? contributionTools : null,
            prompt_context: promptContext,
            created_at: new Date().toISOString(),
          };

          stateManager.addContribution(contribution);
          round.contributions.push(contribution);

          db.addContributionWithTurnRequest(stateManager.getMeetingId(), contribution, null);

          // Restore target status
          target.status = previousStatus;
          db.setParticipantStatus(target.config.id, previousStatus);

          this.#options.onProgress?.(`${target.config.name} (${target.config.tier}) — query_response to ${sourceName}`);
          this.#options.onContribution?.(target.config.name, stateManager.getCurrentRound(), "query_response");

        } catch (err) {
          const info = extractErrorInfo(err);
          this.#logError(`query response for ${target.config.name}`, err);
          this.#logger.warn("query_failed", `Query response for ${target.config.name} failed`, info);
          // Restore status on failure too
          target.status = "listening";
          db.setParticipantStatus(target.config.id, "listening");
        } finally {
          await sessionManager.deleteEphemeralSession(sessionId).catch(() => {});
        }
      }),
    );

    db.setQueryingParticipants(null);
  }

  async executeEvidenceRequests(round, sourceParticipant, evidence, sourceContributionId, {
    client,
    directory,
    sessionManager,
    getParticipantModel,
    stateManager,
    db,
    callStats,
  }) {
    const config = getConfig();
    const timeoutMs = config.agentTimeoutMs;
    const allParticipants = stateManager.getParticipants();

    const targets = evidence.targets
      .map((id) => allParticipants.find((p) => p.config.id === id))
      .filter((p) => p && p.config.id !== sourceParticipant.config.id && p.status !== "failed" && p.status !== "passed");

    if (targets.length === 0) return;

    const sourceName = sourceParticipant.config.name;

    db.setEvidenceParticipants(targets.map((t) => t.config.id));

    await Promise.allSettled(
      targets.map(async (target) => {
        const model = getParticipantModel(target);
        const sessionId = await sessionManager.createEphemeralSession(target);
        try {
          const previousStatus = target.status;
          target.status = "speaking";
          db.setParticipantStatus(target.config.id, "speaking");

          const prompt = buildEvidencePrompt(
            sourceParticipant,
            target,
            sourceParticipant.currentContribution || sourceParticipant.config.name,
            evidence.question,
            round.contributions,
            stateManager.getCurrentRound(),
            stateManager.getMaxRounds(),
          );

          // Build tools map for evidence (same as queries but with tool_choice: required)
          const agentToolsConfig = getConfig().agentTools;
          const evidenceTools = {};
          if (agentToolsConfig?.enabled) {
            const t = resolveBuiltInTools(agentToolsConfig);
            if (t.webfetch) evidenceTools.webfetch = true;
            if (t.websearch) evidenceTools.websearch = true;
            if (t.read) evidenceTools.read = true;
            if (agentToolsConfig.loom?.loom_vector_search) evidenceTools.loom_vector_search = true;
          }
          const evidenceToolKeys = Object.keys(evidenceTools);
          this.#logger.info("agent_tools_offered", `${target.config.name} offered ${evidenceToolKeys.length} tool(s) (required)`, {
            participant: target.config.id,
            round: stateManager.getCurrentRound(),
            tools: evidenceToolKeys,
            tool_choice: evidenceToolKeys.length > 0 ? "required" : "none",
          });

          const systemPrompt = `You are ${target.config.name} (${target.config.tier}). A fellow participant has requested evidence from you. You MUST use research tools to find concrete evidence. Respond with your findings and stay in character.`;
          const promptContext = {
            type: "evidence_response",
            system_prompt: systemPrompt,
            user_prompt: prompt,
            source_contribution_id: sourceContributionId,
            source_participant_id: sourceParticipant.config.id,
            question: evidence.question,
            round_contributions_used: round.contributions.slice(-4).map((c) => ({
              id: c.id, participant_id: c.participant_id, type: c.type, content: c.content,
            })),
            round: stateManager.getCurrentRound(),
          };

          const result = await withTimeout(
            client.session.prompt({
              path: { id: sessionId },
              body: {
                system: systemPrompt,
                model,
                temperature: target.tier_config.temperature,
                parts: [{ type: "text", text: prompt }],
                tools: evidenceTools,
                tool_choice: Object.keys(evidenceTools).length > 0 ? "required" : undefined,
              },
              query: { directory },
            }),
            timeoutMs,
          );

          if (callStats) {
            callStats.reflection_calls++;
            const tokens = result?.data?.tokens;
            if (tokens) {
              callStats.input_tokens += tokens.input ?? 0;
              callStats.output_tokens += tokens.output ?? 0;
            }
          }

          if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));

          const { text, toolResults } = extractAgentResponse(result.data);

          if (!text || text.trim().length < 10) return;

          const contributionTools = mapToolResults(toolResults);

          const contribution = {
            id: stateManager.nextContributionId(),
            round: stateManager.getCurrentRound(),
            participant_id: target.config.id,
            content: `[Evidence from ${target.config.name} on ${sourceName}'s ${round.contributions[round.contributions.length - 1]?.type ?? "contribution"}]\n\n${text.trim()}`,
            type: "evidence_response",
            targets_which: sourceContributionId,
            tool_calls: contributionTools && contributionTools.length ? contributionTools : null,
            prompt_context: promptContext,
            created_at: new Date().toISOString(),
          };

          stateManager.addContribution(contribution);
          round.contributions.push(contribution);

          db.addContributionWithTurnRequest(stateManager.getMeetingId(), contribution, null);

          target.status = previousStatus;
          db.setParticipantStatus(target.config.id, previousStatus);

          this.#options.onProgress?.(`${target.config.name} (${target.config.tier}) — evidence_response to ${sourceName}`);
          this.#options.onContribution?.(target.config.name, stateManager.getCurrentRound(), "evidence_response");

        } catch (err) {
          const info = extractErrorInfo(err);
          this.#logError(`evidence response for ${target.config.name}`, err);
          this.#logger.warn("evidence_failed", `Evidence response for ${target.config.name} failed`, info);
          target.status = "listening";
          db.setParticipantStatus(target.config.id, "listening");
        } finally {
          await sessionManager.deleteEphemeralSession(sessionId).catch(() => {});
        }
      }),
    );

    db.setEvidenceParticipants(null);
  }

  async executeSummons(round, sourceParticipant, summon, {
    client,
    directory,
    sessionManager,
    stateManager,
    db,
    callStats,
  }) {
    const config = getConfig();
    const timeoutMs = config.agentTimeoutMs;

    // Rate limiting
    if (!round.summons) round.summons = [];
    if (round.summons.length >= (config.maxSummonsPerRound ?? 2)) return;
    const agentSummons = round.summons.filter((s) => s.requesterId === sourceParticipant.config.id);
    if (agentSummons.length >= (config.maxSummonsPerAgent ?? 1)) return;

    // Resolve persona from loaded persona pool
    const { getPersonas } = await import("./composer.js");
    const allPersonas = getPersonas();
    let resolvedPersona = null;
    for (const tier of Object.keys(allPersonas)) {
      const match = allPersonas[tier].find(
        (p) => p.name.toLowerCase() === summon.persona_name.toLowerCase()
      );
      if (match) { resolvedPersona = { ...match, tier }; break; }
    }

    if (!resolvedPersona) {
      this.#logger.warn("summon_persona_not_found", `Persona "${summon.persona_name}" not found`);
      return;
    }

    const summonedId = `summoned_${resolvedPersona.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

    db.setSummoningParticipants([summonedId]);

    const summonedConfig = {
      config: {
        id: summonedId,
        name: resolvedPersona.name,
        tier: resolvedPersona.tier,
        persona: resolvedPersona.persona,
        expertise: resolvedPersona.expertise,
        communication_style: resolvedPersona.communication_style,
      },
      tier_config: { temperature: 0.7 },
    };

    const sessionId = await sessionManager.createEphemeralSession(summonedConfig);
    try {
      const prompt = buildSummonPrompt(
        resolvedPersona,
        sourceParticipant,
        summon.issue,
        round.contributions,
        stateManager.getCurrentRound(),
        stateManager.getMaxRounds(),
      );

      // Full tool access for summoned experts
      const agentToolsConfig = getConfig().agentTools;
      const toolsMap = {};
      if (agentToolsConfig?.enabled) {
        const t = resolveBuiltInTools(agentToolsConfig);
        if (t.webfetch) toolsMap.webfetch = true;
        if (t.websearch) toolsMap.websearch = true;
        if (t.read) toolsMap.read = true;
        if (t.bash) toolsMap.bash = true;
        if (t.glob) toolsMap.glob = true;
        if (t.grep) toolsMap.grep = true;
        if (agentToolsConfig.loom?.loom_vector_search) toolsMap.loom_vector_search = true;
      }
      const summonedToolKeys = Object.keys(toolsMap);
      this.#logger.info("agent_tools_offered", `${resolvedPersona.name} (summoned) offered ${summonedToolKeys.length} tool(s)`, {
        participant: summonedId,
        round: stateManager.getCurrentRound(),
        tools: summonedToolKeys,
        tool_choice: summonedToolKeys.length > 0 ? "auto" : "none",
      });

      // Use requester's model
      let model = null;
      try {
        const { getParticipantModel } = await import("./orchestrator.js");
        // Fallback: use a generic model lookup
      } catch {}
      // Direct model access from source participant config
      model = sourceParticipant.config.model;

      if (!model) {
        this.#logger.warn("summon_no_model", "No model available for summoned persona");
        return;
      }

      const systemPrompt = `You are ${resolvedPersona.name} (${resolvedPersona.tier}), a guest expert summoned into this deliberation. Respond in character.`;
      const promptContext = {
        type: "summoned_response",
        system_prompt: systemPrompt,
        user_prompt: prompt,
        persona_name: resolvedPersona.name,
        persona_tier: resolvedPersona.tier,
        source_participant_id: sourceParticipant.config.id,
        issue: summon.issue,
        round_contributions_used: round.contributions.slice(-4).map((c) => ({
          id: c.id, participant_id: c.participant_id, type: c.type, content: c.content,
        })),
        round: stateManager.getCurrentRound(),
      };

      const result = await withTimeout(
        client.session.prompt({
          path: { id: sessionId },
          body: {
            system: systemPrompt,
            model,
            temperature: 0.7,
            parts: [{ type: "text", text: prompt }],
            tools: toolsMap,
            tool_choice: Object.keys(toolsMap).length > 0 ? "auto" : undefined,
          },
          query: { directory },
        }),
        timeoutMs,
      );

      if (callStats) {
        callStats.reflection_calls++;
        const tokens = result?.data?.tokens;
        if (tokens) {
          callStats.input_tokens += tokens.input ?? 0;
          callStats.output_tokens += tokens.output ?? 0;
        }
      }

      if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));

      const { text, toolResults } = extractAgentResponse(result.data);

      if (!text || text.trim().length < 10) return;

      const contributionTools = mapToolResults(toolResults);

      const contribution = {
        id: stateManager.nextContributionId(),
        round: stateManager.getCurrentRound(),
        participant_id: summonedId,
        content: `[Summoned: ${resolvedPersona.name} (${resolvedPersona.tier})]\n\n${text.trim()}`,
        type: "summoned_response",
        targets_which: null,
        tool_calls: contributionTools && contributionTools.length ? contributionTools : null,
        prompt_context: promptContext,
        created_at: new Date().toISOString(),
      };

      stateManager.addContribution(contribution);
      round.contributions.push(contribution);
      round.summons.push({ requesterId: sourceParticipant.config.id, personaName: resolvedPersona.name });

      db.addContributionWithTurnRequest(stateManager.getMeetingId(), contribution, null);

      this.#options.onProgress?.(`${resolvedPersona.name} (${resolvedPersona.tier}) — summoned by ${sourceParticipant.config.name}`);
      this.#options.onContribution?.(resolvedPersona.name, stateManager.getCurrentRound(), "summoned_response");

    } catch (err) {
      const info = extractErrorInfo(err);
      this.#logError(`summon for ${resolvedPersona.name}`, err);
      this.#logger.warn("summon_failed", `Summon of ${resolvedPersona.name} failed`, info);
    } finally {
      await sessionManager.deleteEphemeralSession(sessionId).catch(() => {});
      db.setSummoningParticipants(null);
    }
  }

  async executeVote(round, sourceParticipant, vote, sourceContributionId, {
    client,
    directory,
    sessionManager,
    getParticipantModel,
    stateManager,
    db,
    callStats,
  }) {
    const config = getConfig();
    const timeoutMs = config.agentTimeoutMs;
    const allParticipants = stateManager.getParticipants();

    // Source agent always votes — extract their vote from the contribution content
    const sourceContribution = round.contributions.find((c) => c.id === sourceContributionId);
    const sourceVoteText = sourceContribution?.content ?? "";

    // All other active participants vote
    const voters = allParticipants.filter(
      (p) => p.config.id !== sourceParticipant.config.id && p.status !== "failed" && p.status !== "passed",
    );

    if (voters.length === 0) {
      // Source-only vote: record tally immediately
      const tallyContent = `[Vote Tally] ${vote.question}\nSource vote: ${sourceVoteText.slice(0, 200)}\nTotal voters: 1 (source only)`;
      const tallyContribution = {
        id: stateManager.nextContributionId(),
        round: stateManager.getCurrentRound(),
        participant_id: sourceParticipant.config.id,
        content: tallyContent,
        type: "vote_tally",
        targets_which: sourceContributionId,
        tool_calls: null,
        prompt_context: { type: "vote_tally", question: vote.question, round: stateManager.getCurrentRound() },
        created_at: new Date().toISOString(),
      };
      stateManager.addContribution(tallyContribution);
      round.contributions.push(tallyContribution);
      db.addContributionWithTurnRequest(stateManager.getMeetingId(), tallyContribution, null);
      this.#options.onProgress?.(`${sourceParticipant.config.name} — vote tally (source only)`);
      return;
    }

    db.setQueryingParticipants(voters.map((v) => v.config.id));

    const voteResponses = [];

    await Promise.allSettled(
      voters.map(async (voter) => {
        const model = getParticipantModel(voter);
        const sessionId = await sessionManager.createEphemeralSession(voter);
        try {
          const previousStatus = voter.status;
          voter.status = "speaking";
          db.setParticipantStatus(voter.config.id, "speaking");

          const prompt = buildVotePrompt(
            sourceParticipant,
            voter,
            sourceContribution || sourceParticipant.config.name,
            vote.question,
            round.contributions,
            stateManager.getCurrentRound(),
            stateManager.getMaxRounds(),
          );

          const systemPrompt = `You are ${voter.config.name} (${voter.config.tier}). A fellow participant has called a vote. Cast your vote and provide brief reasoning. Respond directly and stay in character.`;

          const promptContext = {
            type: "vote_response",
            system_prompt: systemPrompt,
            user_prompt: prompt,
            source_contribution_id: sourceContributionId,
            source_participant_id: sourceParticipant.config.id,
            question: vote.question,
            round_contributions_used: round.contributions.slice(-4).map((c) => ({
              id: c.id, participant_id: c.participant_id, type: c.type, content: c.content,
            })),
            round: stateManager.getCurrentRound(),
          };

          const result = await withTimeout(
            client.session.prompt({
              path: { id: sessionId },
              body: {
                system: systemPrompt,
                model,
                temperature: voter.tier_config.temperature,
                parts: [{ type: "text", text: prompt }],
                tools: {},
                tool_choice: "none",
              },
              query: { directory },
            }),
            timeoutMs,
          );

          if (callStats) {
            callStats.reflection_calls++;
            const tokens = result?.data?.tokens;
            if (tokens) {
              callStats.input_tokens += tokens.input ?? 0;
              callStats.output_tokens += tokens.output ?? 0;
            }
          }

          if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));

          const { text } = extractAgentResponse(result.data);

          if (!text || text.trim().length < 5) return;

          const contribution = {
            id: stateManager.nextContributionId(),
            round: stateManager.getCurrentRound(),
            participant_id: voter.config.id,
            content: `[Vote from ${voter.config.name}]\n\n${text.trim()}`,
            type: "vote_response",
            targets_which: sourceContributionId,
            tool_calls: null,
            prompt_context: promptContext,
            created_at: new Date().toISOString(),
          };

          stateManager.addContribution(contribution);
          round.contributions.push(contribution);
          voteResponses.push({ voter: voter.config.name, content: text.trim() });

          db.addContributionWithTurnRequest(stateManager.getMeetingId(), contribution, null);

          voter.status = previousStatus;
          db.setParticipantStatus(voter.config.id, previousStatus);

          this.#options.onProgress?.(`${voter.config.name} (${voter.config.tier}) — voted on poll`);
          this.#options.onContribution?.(voter.config.name, stateManager.getCurrentRound(), "vote_response");

        } catch (err) {
          const info = extractErrorInfo(err);
          this.#logError(`vote response for ${voter.config.name}`, err);
          this.#logger.warn("vote_failed", `Vote response for ${voter.config.name} failed`, info);
          voter.status = "listening";
          db.setParticipantStatus(voter.config.id, "listening");
        } finally {
          await sessionManager.deleteEphemeralSession(sessionId).catch(() => {});
        }
      }),
    );

    db.setQueryingParticipants(null);

    // Generate vote tally
    const tallyLines = [`[Vote Tally] ${vote.question}`];
    const voteCounts = {};

    // Parse source vote
    const sourceLetter = extractVoteLetter(sourceVoteText);
    if (sourceLetter) {
      voteCounts[sourceLetter] = (voteCounts[sourceLetter] || 0) + 1;
      tallyLines.push(`${sourceLetter}: 1 vote (${sourceParticipant.config.name} — source)`);
    }

    // Parse voter responses
    for (const vr of voteResponses) {
      const letter = extractVoteLetter(vr.content);
      if (letter) {
        voteCounts[letter] = (voteCounts[letter] || 0) + 1;
        const existing = tallyLines.find((l) => l.startsWith(`${letter}:`));
        if (existing) {
          const idx = tallyLines.indexOf(existing);
          tallyLines[idx] = `${letter}: ${voteCounts[letter]} votes (${existing.match(/\((.+)\)/)?.[1] ?? ""}, ${vr.voter})`;
        } else {
          tallyLines.push(`${letter}: 1 vote (${vr.voter})`);
        }
      }
    }

    const totalVoters = 1 + voteResponses.length;
    tallyLines.push(`Total voters: ${totalVoters}`);

    // Leading option
    const sorted = Object.entries(voteCounts).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0) {
      const [winner, count] = sorted[0];
      tallyLines.push(`Leading option: ${winner} (${count} votes)`);
    }

    const tallyContent = tallyLines.join("\n");
    const tallyContribution = {
      id: stateManager.nextContributionId(),
      round: stateManager.getCurrentRound(),
      participant_id: sourceParticipant.config.id,
      content: tallyContent,
      type: "vote_tally",
      targets_which: sourceContributionId,
      tool_calls: null,
      prompt_context: { type: "vote_tally", question: vote.question, votes: voteResponses, round: stateManager.getCurrentRound() },
      created_at: new Date().toISOString(),
    };
    stateManager.addContribution(tallyContribution);
    round.contributions.push(tallyContribution);
    db.addContributionWithTurnRequest(stateManager.getMeetingId(), tallyContribution, null);
    this.#options.onProgress?.(`${sourceParticipant.config.name} — vote tally: ${sorted.length > 0 ? `Winner ${sorted[0][0]}` : "no votes"}`);
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
      tool_calls: result.tool_calls ?? null,
      prompt_context: result.prompt_context ?? null,
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
      };
      if (!round.turn_requests) round.turn_requests = [];
      round.turn_requests.push(turnRequest);
    }

    this.#db.addContributionWithTurnRequest(this.#stateManager.getMeetingId(), {
      ...contribution,
      round: this.#stateManager.getCurrentRound(),
    }, turnRequest);

    this.#options.onContribution?.(participant.config.name, this.#stateManager.getCurrentRound(), result.type);
  }

  async #promptChildSession(participant) {
    participant.status = "speaking";

    const model = this.#getParticipantModel(participant);
    const config = getConfig();
    const fallbackConfig = config.modelFallback;

    const baseTimeoutMs = config.agentTimeoutMs;
    const totalParticipants = this.#stateManager.getParticipants().length;
    const timeoutReductionFactor = totalParticipants > 0
      ? Math.min(this.#failedInCurrentRound / totalParticipants, 0.5)
      : 0;
    const timeoutMs = Math.floor(baseTimeoutMs * (1 - timeoutReductionFactor));

    const currentRound = this.#stateManager.getCurrentRound();

    // Pre-compute RAG context and prompts (model-independent)
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

    const recentForPrompt = this.#stateManager.getWeave().filter(
      (c) => c.round != null && c.round >= currentRound - 1 && c.type !== "vote_response",
    ).slice(-4);

    const systemPrompt = buildAgentSystemPrompt(participant);
    const userPrompt = buildAgentUserPrompt(
      participant,
      this.#stateManager.getStateOfPlay(),
      ragContext,
      recentForPrompt,
      currentRound,
      this.#stateManager.getQuestion(),
      this.#stateManager.getTags(),
    );

    const promptContext = {
      type: "agent_turn",
      system_prompt: systemPrompt,
      user_prompt: userPrompt,
      state_of_play: this.#stateManager.getStateOfPlay(),
      rag_query_text: queryText,
      rag_chunks_used: ragChunks.map((c) => `[Round ${c.round}] ${c.content}`),
      recent_contributions: recentForPrompt.map((c) => ({
        id: c.id, participant_id: c.participant_id, type: c.type,
        content: c.content, targets_which: c.targets_which,
      })),
      reflection: participant.reflection || null,
      question: this.#stateManager.getQuestion(),
      tags: this.#stateManager.getTags(),
      round: currentRound,
    };

    // If circuit breaker already marks model unhealthy, skip straight to fallback
    let activeModel = model;
    if (!this.#circuitBreaker.isHealthy(model)) {
      this.#logger.warn("model_unhealthy", `${participant.config.name} — model ${this.#modelKey(model)} unhealthy, attempting fallback`);
      const fallback = selectFallbackModel(model, this.#availableModels, this.#circuitBreaker);
      if (!fallback) {
        this.#logError(`model ${this.#modelKey(model)} unhealthy and no fallback available`, new Error("circuit breaker open, no fallback"));
        return null;
      }
      activeModel = fallback;
    }

    const maxRetries = fallbackConfig.enabled ? fallbackConfig.maxRetriesPerModel : 0;
    const lastError = { value: null };

    // Retry loop on the original model
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.#executeAgentTurn(participant, activeModel, timeoutMs, promptContext);
        return response;
      } catch (err) {
        lastError.value = err;
        const info = extractErrorInfo(err);
        this.#recordModelFailure(activeModel);

        if (attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 8000);
          this.#logger.warn("prompt_retry", `${participant.config.name} — attempt ${attempt + 1}/${maxRetries + 1} failed on ${this.#modelKey(activeModel)}, retrying in ${Math.round(delay)}ms`, info);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    // All retries on original model exhausted — attempt fallback
    if (!fallbackConfig.enabled) {
      this.#recordFallbackFailure(participant, activeModel, null, lastError.value);
      return null;
    }

    const fallbackModel = selectFallbackModel(activeModel, this.#availableModels, this.#circuitBreaker);
    if (!fallbackModel) {
      this.#recordFallbackFailure(participant, activeModel, null, lastError.value);
      return null;
    }

    this.#logger.info("model_fallback", `${participant.config.name} — falling back from ${this.#modelKey(activeModel)} to ${this.#modelKey(fallbackModel)}`);
    this.#options.onProgress?.(`⚠️ ${participant.config.name}'s model (${this.#modelKey(activeModel)}) failed — retrying with ${this.#modelKey(fallbackModel)}`);

    const fallbackAttempts = fallbackConfig.maxFallbackAttempts;
    for (let attempt = 0; attempt <= fallbackAttempts; attempt++) {
      try {
        const response = await this.#executeAgentTurn(participant, fallbackModel, timeoutMs, promptContext);
        // Attach fallback metadata to the response
        response._fallback = {
          from: this.#modelKey(activeModel),
          to: this.#modelKey(fallbackModel),
          error: lastError.value ? extractErrorInfo(lastError.value).message : "unknown",
        };
        return response;
      } catch (err) {
        lastError.value = err;
        const info = extractErrorInfo(err);
        this.#recordModelFailure(fallbackModel);

        if (attempt < fallbackAttempts) {
          const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 8000);
          this.#logger.warn("fallback_retry", `${participant.config.name} — fallback attempt ${attempt + 1}/${fallbackAttempts + 1} failed on ${this.#modelKey(fallbackModel)}, retrying in ${Math.round(delay)}ms`, info);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    // Both original and fallback failed
    this.#recordFallbackFailure(participant, activeModel, fallbackModel, lastError.value);
    return null;
  }

  #recordFallbackFailure(participant, originalModel, fallbackModel, error) {
    const info = error ? extractErrorInfo(error) : { message: "unknown error" };
    const fallbackMsg = fallbackModel
      ? `Original: ${this.#modelKey(originalModel)}, Fallback: ${this.#modelKey(fallbackModel)}`
      : `Model: ${this.#modelKey(originalModel)}, No fallback available`;
    this.#db.recordAgentError(
      this.#stateManager.getMeetingId(), participant.config.id, this.#stateManager.getCurrentRound(),
      "model_fallback", `${fallbackMsg} — ${info.message}`, 1,
    );
    this.#logger.error("model_fallback_failed", `${participant.config.name} failed on all models`, {
      original: this.#modelKey(originalModel),
      fallback: fallbackModel ? this.#modelKey(fallbackModel) : null,
      ...info,
    });
  }

  async #executeAgentTurn(participant, model, timeoutMs, promptContext) {
    const config = getConfig();
    const currentRound = this.#stateManager.getCurrentRound();
    const ephemeralSessionId = await this.#options.createEphemeralSession(participant);
    this.#sessionManager.registerSessionMeeting(ephemeralSessionId, this.#stateManager.getMeetingId());
    let ephemeralSessionIdToDelete = ephemeralSessionId;

    try {
      this.#callStats.agent_prompts++;
      const llmStart = Date.now();

      const toolsMap = this.#buildToolsMap(config);
      const agentToolsConfig = config.agentTools;

      // Observability: surface the exact tool set offered to this session so
      // "no tools offered" vs "tools offered but unused" is distinguishable.
      const offeredTools = Object.keys(toolsMap);
      this.#logger.info("agent_tools_offered", `${participant.config.name} offered ${offeredTools.length} tool(s)`, {
        participant: participant.config.id,
        round: currentRound,
        tools: offeredTools,
        tool_choice: offeredTools.length > 0 ? "auto" : "none",
      });

      const result = await withTimeout(
        this.#client.session.prompt({
          path: { id: ephemeralSessionId },
          body: {
            system: promptContext.system_prompt,
            model,
            temperature: participant.tier_config.temperature,
            parts: [{ type: "text", text: promptContext.user_prompt }],
            tools: toolsMap,
            tool_choice: Object.keys(toolsMap).length > 0 ? "auto" : undefined,
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

      const { text: agentText, toolResults } = extractAgentResponse(result.data);

      if (toolResults.length > 0) {
        const tools = toolResults.map((t) => ({
          tool: t.tool,
          callID: t.callID,
          status: t.status ?? null,
          attempted_tool: t.attempted_tool ?? null,
          hasOutput: !!t.output,
          hasError: !!t.error,
        }));
        const attempts = tools.filter((t) => t.status === "error" || t.attempted_tool).length;
        this.#logger.info("tool_results", `${participant.config.name} used ${toolResults.length} tool(s)${attempts > 0 ? ` (${attempts} failed/attempted)` : ""}`, { tools });
      }

      const maxToolCalls = agentToolsConfig?.maxToolCallsPerTurn ?? 5;
      if (toolResults.length > maxToolCalls) {
        this.#logger.warn("tool_call_limit", `${participant.config.name} exceeded max tool calls (${toolResults.length}/${maxToolCalls})`);
      }

      if (!agentText) throw new Error("Empty agent response");

      const safeContent = sanitizeForPrompt(agentText);
      const response = parseAgentResponse(participant.config.id, safeContent);
      if (!response) throw new Error("Failed to parse agent response");

      response.tool_calls = mapToolResults(toolResults);
      if (response.tool_calls && response.tool_calls.length === 0) response.tool_calls = null;

      this.#recordModelSuccess(model);
      response.prompt_context = promptContext;
      this.#options.onAgentComplete?.(participant.config.id, response.content);
      ephemeralSessionIdToDelete = null;
      return response;
    } finally {
      this.#sessionManager.unregisterSession(ephemeralSessionId);
      if (ephemeralSessionIdToDelete) {
        this.#options.deleteEphemeralSession(ephemeralSessionIdToDelete).catch((err) => {
          this.#logger.warn("ephemeral_session_delete_failed", "Failed to clean up ephemeral session", extractErrorInfo(err));
        });
      }
    }
  }

  #buildToolsMap(config) {
    const agentToolsConfig = config.agentTools;
    const toolsMap = {};
    if (agentToolsConfig?.enabled) {
      const t = resolveBuiltInTools(agentToolsConfig);
      if (t.webfetch) toolsMap.webfetch = true;
      if (t.websearch) toolsMap.websearch = true;
      if (t.read) toolsMap.read = true;
      if (t.bash) toolsMap.bash = true;
      if (t.glob) toolsMap.glob = true;
      if (t.grep) toolsMap.grep = true;
      if (t.lsp) toolsMap.lsp = true;
      if (agentToolsConfig.loom?.loom_vector_search) toolsMap.loom_vector_search = true;
    }
    return toolsMap;
  }
}

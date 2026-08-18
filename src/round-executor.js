import { buildAgentSystemPrompt, buildAgentUserPrompt, buildQueryPrompt, buildEvidencePrompt, buildSummonPrompt } from "./prompts.js";
import { parseAgentResponse } from "./validation.js";
import { getConfig } from "./config.js";
import { extractText, extractAgentResponse, truncate, withTimeout } from "./shared.js";
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

          // Build tools map for query (same reduced set as reflections)
          const agentToolsConfig = getConfig().agentTools;
          const queryTools = {};
          if (agentToolsConfig?.enabled) {
            if (agentToolsConfig?.builtIn?.web_fetch) queryTools.web_fetch = true;
            if (agentToolsConfig?.builtIn?.web_search) queryTools.web_search = true;
            if (agentToolsConfig?.builtIn?.read) queryTools.read = true;
            if (agentToolsConfig?.loom?.loom_vector_search) queryTools.loom_vector_search = true;
          }

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

          // Create query response contribution
          const contribution = {
            id: stateManager.nextContributionId(),
            round: stateManager.getCurrentRound(),
            participant_id: target.config.id,
            content: `[Response to query from ${sourceName}]\n\n${text.trim()}`,
            type: "query_response",
            targets_which: sourceContributionId,
            tool_calls: toolResults.length > 0 ? toolResults.map(t => ({
              tool: t.tool,
              callID: t.callID,
              title: t.title ?? null,
              output: t.output ? String(t.output).slice(0, 2000) : null,
              error: t.error ? String(t.error).slice(0, 500) : null,
              metadata: t.metadata ?? null,
            })) : null,
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
            if (agentToolsConfig?.builtIn?.web_fetch) evidenceTools.web_fetch = true;
            if (agentToolsConfig?.builtIn?.web_search) evidenceTools.web_search = true;
            if (agentToolsConfig?.builtIn?.read) evidenceTools.read = true;
            if (agentToolsConfig?.loom?.loom_vector_search) evidenceTools.loom_vector_search = true;
          }

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

          const contribution = {
            id: stateManager.nextContributionId(),
            round: stateManager.getCurrentRound(),
            participant_id: target.config.id,
            content: `[Evidence from ${target.config.name} on ${sourceName}'s ${round.contributions[round.contributions.length - 1]?.type ?? "contribution"}]\n\n${text.trim()}`,
            type: "evidence_response",
            targets_which: sourceContributionId,
            tool_calls: toolResults.length > 0 ? toolResults.map(t => ({
              tool: t.tool,
              callID: t.callID,
              title: t.title ?? null,
              output: t.output ? String(t.output).slice(0, 2000) : null,
              error: t.error ? String(t.error).slice(0, 500) : null,
              metadata: t.metadata ?? null,
            })) : null,
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
        if (agentToolsConfig?.builtIn?.web_fetch) toolsMap.web_fetch = true;
        if (agentToolsConfig?.builtIn?.web_search) toolsMap.web_search = true;
        if (agentToolsConfig?.builtIn?.read) toolsMap.read = true;
        if (agentToolsConfig?.builtIn?.bash?.enabled || agentToolsConfig?.builtIn?.bash === true) toolsMap.bash = true;
        if (agentToolsConfig?.builtIn?.glob) toolsMap.glob = true;
        if (agentToolsConfig?.builtIn?.grep) toolsMap.grep = true;
        if (agentToolsConfig?.loom?.loom_vector_search) toolsMap.loom_vector_search = true;
      }

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

      const contribution = {
        id: stateManager.nextContributionId(),
        round: stateManager.getCurrentRound(),
        participant_id: summonedId,
        content: `[Summoned: ${resolvedPersona.name} (${resolvedPersona.tier})]\n\n${text.trim()}`,
        type: "summoned_response",
        targets_which: null,
        tool_calls: toolResults.length > 0 ? toolResults.map(t => ({
          tool: t.tool,
          callID: t.callID,
          title: t.title ?? null,
          output: t.output ? String(t.output).slice(0, 2000) : null,
          error: t.error ? String(t.error).slice(0, 500) : null,
          metadata: t.metadata ?? null,
        })) : null,
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
        resolved: "pending",
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

      // Build boolean filter map for the prompt call (only when agent tools are enabled)
      // SDK expects { [toolName]: boolean }, NOT the raw tool definition objects
      const agentToolsConfig = config.agentTools;
      const toolsMap = {};
      if (agentToolsConfig?.enabled) {
        const builtIn = agentToolsConfig.builtIn;
        if (builtIn?.web_fetch) toolsMap.web_fetch = true;
        if (builtIn?.web_search) toolsMap.web_search = true;
        if (builtIn?.read) toolsMap.read = true;
        if (builtIn?.bash?.enabled || builtIn?.bash === true) toolsMap.bash = true;
        if (builtIn?.glob) toolsMap.glob = true;
        if (builtIn?.grep) toolsMap.grep = true;
        if (builtIn?.lsp) toolsMap.lsp = true;
        if (agentToolsConfig.loom?.loom_vector_search) toolsMap.loom_vector_search = true;
      }

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

      const result = await withTimeout(
        this.#client.session.prompt({
          path: { id: ephemeralSessionId },
          body: {
            system: systemPrompt,
            model,
            temperature: participant.tier_config.temperature,
            parts: [{ type: "text", text: userPrompt }],
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

      response.tool_calls = toolResults.length > 0 ? toolResults.map(t => ({
        tool: t.tool,
        callID: t.callID,
        title: t.title ?? null,
        output: t.output ? String(t.output).slice(0, 2000) : null,
        error: t.error ? String(t.error).slice(0, 500) : null,
        metadata: t.metadata ?? null,
      })) : null;

      this.#recordModelSuccess(model);
      response.prompt_context = promptContext;
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

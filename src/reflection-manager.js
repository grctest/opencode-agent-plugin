import { buildReflectionPrompt } from "./prompts.js";
import { extractAgentResponse, mapToolResults, findMostSimilar } from "./shared.js";
import { getConfig, resolveBuiltInTools } from "./config.js";
import { Logger, extractErrorInfo } from "./logger.js";

const reflectionLogger = new Logger();

/**
 * Runs mid-round reflections. When a challenge or dissent is produced,
 * the most persona-similar active participant (excluding the challenger)
 * is selected to reflect on it. This creates a public contribution in
 * the weave with a visible header identifying the trigger contribution.
 *
 * @param {Object} round - Current round object
 * @param {Object} triggerParticipant - The participant who produced the challenge/dissent
 * @param {Array} activeParticipants - All active participants in the round (non-failed, non-passed)
 * @param {Object} deps - Dependencies
 */
export async function runMidRoundReflections(round, triggerParticipant, activeParticipants, {
  sessionManager,
  getParticipantModel,
  stateManager,
  db,
  logError,
  callStats,
}) {
  if (activeParticipants.length === 0) return;

  // Select top-1 reflector by persona similarity to the challenge
  // Keyword fallback when embedder unavailable — preserves reflection liveness
  function findMostSimilarByKeyword(text, participants) {
    const tokens = (text || "").toLowerCase().split(/\W+/).filter((t) => t.length > 3);
    if (tokens.length === 0) return participants[0] ?? null;
    let best = null;
    let bestScore = -1;
    for (const p of participants) {
      const hay = `${p.config.persona ?? ""} ${p.config.agenda ?? ""} ${(p.config.tags ?? []).join(" ")}`.toLowerCase();
      let score = 0;
      for (const tok of tokens) {
        if (hay.includes(tok)) score += 2;
      }
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  const { embedText, isEmbedderInitialized } = await import("./services/embedding-service.js");
  const embedderReady = isEmbedderInitialized();
  const challengeText = triggerParticipant.currentContribution;
  if (!challengeText) return;

  let listener = null;
  let best = null;
  if (embedderReady) {
    let challengeEmbedding;
    try {
      challengeEmbedding = await embedText(challengeText);
    } catch (err) {
      reflectionLogger.warn("challenge_embedding_failed", "Failed to embed challenge text for reflection targeting", extractErrorInfo(err));
    }
    if (challengeEmbedding) {
      const candidates = activeParticipants
        .filter((p) => p.config.id !== triggerParticipant.config.id && p.embedding)
        .map((p) => ({ id: p.config.id, embedding: p.embedding }));
      best = findMostSimilar(challengeEmbedding, candidates);
      if (best) {
        listener = activeParticipants.find((p) => p.config.id === best.id);
      }
    }
  }
  // Fallback: keyword similarity when embedding unavailable or no candidate
  if (!listener) {
    const keywordCandidates = activeParticipants.filter((p) => p.config.id !== triggerParticipant.config.id);
    const kwBest = findMostSimilarByKeyword(challengeText, keywordCandidates);
    if (!kwBest) {
      reflectionLogger.info("no_similar_reflector", "No participant found for reflection targeting (keyword fallback)");
      return;
    }
    listener = kwBest;
    if (!embedderReady) {
      reflectionLogger.info("reflection_target_keyword_fallback", `Reflection targeting via keyword fallback — embedder unavailable, chose ${listener.config.name}`);
    } else {
      reflectionLogger.info("reflection_target_keyword_fallback", `Reflection targeting fallback — embedding had no candidate, chose ${listener.config.name} via keywords`);
    }
  }
  if (!listener) return;

  const config = getConfig();
  const timeoutMs = config.agentTimeoutMs;
  const model = getParticipantModel(listener);

  db.setReflectingParticipants([listener.config.id]);

  const sessionId = await sessionManager.createEphemeralSession(listener);
  try {
    const prompt = buildReflectionPrompt(
      listener,
      triggerParticipant,
      triggerParticipant.currentContribution,
      round.contributions,
      stateManager.getCurrentRound(),
      stateManager.getMaxRounds(),
    );

    // Build tools map for reflection — baseline 4 plus reflection-specific extras when enabled
    const agentToolsConfig = getConfig().agentTools;
    const reflectionTools = {};
    if (agentToolsConfig?.enabled) {
      const t = resolveBuiltInTools(agentToolsConfig);
      if (t.webfetch) reflectionTools.webfetch = true;
      if (t.websearch) reflectionTools.websearch = true;
      if (t.read) reflectionTools.read = true;
      if (agentToolsConfig.loom?.loom_vector_search) reflectionTools.loom_vector_search = true;
      if (agentToolsConfig.reflection?.bash) reflectionTools.bash = true;
      if (agentToolsConfig.reflection?.glob) reflectionTools.glob = true;
      if (agentToolsConfig.reflection?.grep) reflectionTools.grep = true;
    }
    const reflectionToolKeys = Object.keys(reflectionTools);
    reflectionLogger.info("agent_tools_offered", `${listener.config.name} offered ${reflectionToolKeys.length} tool(s)`, {
      participant: listener.config.id,
      round: stateManager.getCurrentRound(),
      tools: reflectionToolKeys,
      tool_choice: reflectionToolKeys.length > 0 ? "auto" : "none",
    });

    const systemPrompt = `You are ${listener.config.name} (${listener.config.tier}) — reflecting in Loom.

Your reflection is public and citeable. Be concise (80-150 words), grounded, and in character.
- Engage the trigger’s evidence if they cited Source or [#id]; demand it if they didn’t.
- Close with: Position: [held|revised|expanded] because {one falsifiable cause}.
- Never emit <<< or >>> boundaries. Cite as Source: URL or [#id] when you use evidence.`;
    const promptContext = {
      type: "reflection",
      system_prompt: systemPrompt,
      user_prompt: prompt,
      trigger_contribution_id: triggerParticipant.currentContributionId,
      trigger_participant_id: triggerParticipant.config.id,
      trigger_type: triggerParticipant.currentContributionType,
      round_contributions_used: round.contributions.slice(-4).map((c) => ({
        id: c.id, participant_id: c.participant_id, type: c.type, content: c.content,
      })),
      round: stateManager.getCurrentRound(),
    };

    const result = await sessionManager.getContract().prompt({
      sessionId,
      system: systemPrompt,
      model,
      temperature: listener.tier_config.temperature,
      parts: [{ type: "text", text: prompt }],
      tools: reflectionTools,
      toolChoice: Object.keys(reflectionTools).length > 0 ? "auto" : undefined,
      timeoutMs,
    });

    if (callStats) {
      callStats.reflection_calls++;
      const tokens = result.tokens;
      if (tokens) {
        callStats.input_tokens += tokens.input ?? 0;
        callStats.output_tokens += tokens.output ?? 0;
      }
    }

    if (!result.ok) throw result.error;

    // Use extractAgentResponse to handle tool call parts
    const { text, toolResults } = extractAgentResponse(result.data);

    // Log tool results for observability (including failed/attempted calls)
    if (toolResults.length > 0) {
      const failures = toolResults.filter((t) => t.status === "error" || t.attempted_tool).length;
      reflectionLogger.info("reflection_tool_results", `${listener.config.name} used ${toolResults.length} tool(s) in reflection${failures > 0 ? ` (${failures} failed/attempted)` : ""}`, {
        tools: toolResults.map(t => ({
          tool: t.tool,
          callID: t.callID,
          status: t.status ?? null,
          attempted_tool: t.attempted_tool ?? null,
          hasOutput: !!t.output,
          hasError: !!t.error,
        })),
      });
    }

    if (!text || text.trim().length < 10) return;

    const contributionTools = mapToolResults(toolResults);

    // Build visible header with reflection context
    const header = `[Reflection on #${triggerParticipant.currentContributionId} [${triggerParticipant.currentContributionType.toUpperCase()}] by ${triggerParticipant.config.name} (Round ${stateManager.getCurrentRound()})]`;

    // Create a contribution object — shares batch_id with challenger's turn for atomic grouping
    const batchId = triggerParticipant.currentBatchId ?? crypto.randomUUID();
    const contribution = {
      id: stateManager.nextContributionId(),
      round: stateManager.getCurrentRound(),
      participant_id: listener.config.id,
      content: `${header}\n\n${text.trim()}`,
      type: "reflection",
      targets_which: triggerParticipant.currentContributionId,
      batch_id: batchId,
      tool_calls: contributionTools && contributionTools.length ? contributionTools : null,
      prompt_context: promptContext,
      created_at: new Date().toISOString(),
    };

    // Add to weave and round contributions
    stateManager.addContribution(contribution);
    round.contributions.push(contribution);
    listener.contributions_count = stateManager.getWeave().filter((c) => c.participant_id === listener.config.id).length;

    // Update participant's latest reflection (for next-round context, stored WITHOUT header)
    listener.reflection = text.trim();
    // Maintain rolling history (last 5) for P2.2
    if (!listener.reflectionHistory) listener.reflectionHistory = [];
    listener.reflectionHistory.push({ round: stateManager.getCurrentRound(), text: text.trim(), at: Date.now() });
    if (listener.reflectionHistory.length > 5) listener.reflectionHistory.shift();
    db.setParticipantReflection(listener.config.id, text.trim());

    // Persist contribution
    db.addContributionWithTurnRequest(stateManager.getMeetingId(), contribution, null);

    const simInfo = best ? ` (similarity: ${best.similarity.toFixed(3)})` : " (keyword fallback)";
    reflectionLogger.info("reflection_complete", `${listener.config.name} reflected on ${triggerParticipant.config.name}'s ${triggerParticipant.currentContributionType}${simInfo}`);

  } catch (err) {
    const info = extractErrorInfo(err);
    logError(`reflection prompt for ${listener.config.name}`, err);
    reflectionLogger.warn("reflection_failed", `Reflection for ${listener.config.name} failed`, info);
  } finally {
    await sessionManager.deleteEphemeralSession(sessionId).catch(() => {});
    db.setReflectingParticipants(null);
  }
}

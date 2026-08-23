import { buildQueryPrompt, buildEvidencePrompt, buildSummonPrompt, buildVotePrompt } from "../../prompts/interaction-prompts.js";
import { getConfig, resolveBuiltInTools } from "../../config.js";
import { extractAgentResponse, mapToolResults } from "../../shared.js";
import { getPersonas } from "../../composer.js";
import { extractErrorInfo } from "../../logger.js";
import { extractVoteLetter, buildTally } from "../../utils/vote-tally.js";
import { degrade } from "../../utils/degrade.js";

export async function executeQueries(round, sourceParticipant, query, sourceContributionId, {
  sessionManager,
  getParticipantModel,
  stateManager,
  db,
  callStats,
}) {
  const config = getConfig();
  const timeoutMs = config.agentTimeoutMs;
  const allParticipants = stateManager.getParticipants();

  const targets = query.targets
    .map((id) => allParticipants.find((p) => p.config.id === id))
    .filter((p) => p && p.config.id !== sourceParticipant.config.id && p.status !== "failed" && p.status !== "passed");

  if (targets.length === 0) return;

  const sourceName = sourceParticipant.config.name;

  db.setQueryingParticipants(targets.map((t) => t.config.id));

  await Promise.allSettled(
    targets.map(async (target) => {
      const model = getParticipantModel(target);
      let sessionId;
      let isRoundScoped = false;
      if (this._roundSessionIds?.has(target.config.id)) {
        sessionId = this._roundSessionIds.get(target.config.id);
        isRoundScoped = true;
      } else {
        sessionId = await sessionManager.createEphemeralSession(target);
        sessionManager.registerSessionMeeting(sessionId, stateManager.getMeetingId());
      }
      try {
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
          stateManager.getStateOfPlay(),
        );

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
        this._logger.info("agent_tools_offered", `${target.config.name} offered ${queryToolKeys.length} tool(s)`, {
          participant: target.config.id,
          round: stateManager.getCurrentRound(),
          tools: queryToolKeys,
          tool_choice: queryToolKeys.length > 0 ? "auto" : "none",
        });

        const systemPrompt = `You are ${target.config.name} (${target.config.tier}) — answering a directed query in Loom.

Be concise (2-4 sentences), grounded, and in character. Answer the specific question, not the whole deliberation.
- If answering “what was said”, prefer loom_vector_search over memory and cite [#id].
- If you don’t know, say “insufficient evidence” — do not speculate.
- Cite Source: [#id] or URL if you use evidence. Never emit <<< or >>>.`;
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

        const result = await sessionManager.getContract().prompt({
          sessionId,
          system: systemPrompt,
          model,
          temperature: target.tier_config.temperature,
          parts: [{ type: "text", text: prompt }],
          tools: queryTools,
          toolChoice: Object.keys(queryTools).length > 0 ? "auto" : undefined,
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

        const { text, toolResults } = extractAgentResponse(result.data);

        if (!text || text.trim().length < 10) {
          if (toolResults.length > 0) {
            this._logger.warn("query_short_text_with_tools", `${target.config.name} produced short/empty query answer but executed ${toolResults.length} tool(s) — storing tool-evidence-only contribution`, {
              participant: target.config.id,
              round: stateManager.getCurrentRound(),
              tools: toolResults.map(t => ({ tool: t.tool, status: t.status ?? null })),
            });
            const evidenceOnly = {
              id: stateManager.nextContributionId(),
              round: stateManager.getCurrentRound(),
              participant_id: target.config.id,
              content: `[Response to query from ${sourceName}]\n\n(insufficient response text — tool evidence preserved)`,
              type: "query_response",
              targets_which: sourceContributionId,
              batch_id: sourceParticipant.currentBatchId ?? crypto.randomUUID(),
              tool_calls: mapToolResults(toolResults),
              prompt_context: promptContext,
              created_at: new Date().toISOString(),
            };
            stateManager.addContribution(evidenceOnly);
            round.contributions.push(evidenceOnly);
            degrade("persist.contribution", "Persist contribution", () => db.addContributionWithTurnRequest(stateManager.getMeetingId(), evidenceOnly, null), null);
          }
          return;
        }

        const contributionTools = mapToolResults(toolResults);

        const contribution = {
          id: stateManager.nextContributionId(),
          round: stateManager.getCurrentRound(),
          participant_id: target.config.id,
          content: `[Response to query from ${sourceName}]\n\n${text.trim()}`,
          type: "query_response",
          targets_which: sourceContributionId,
          batch_id: sourceParticipant.currentBatchId ?? crypto.randomUUID(),
          tool_calls: contributionTools ?? [],
          prompt_context: promptContext,
          created_at: new Date().toISOString(),
        };

        stateManager.addContribution(contribution);
        round.contributions.push(contribution);
        stateManager.incrementParticipantContributions(target.config.id);

        degrade("persist.contribution", "Persist contribution", () => db.addContributionWithTurnRequest(stateManager.getMeetingId(), contribution, null), null);

        target.status = previousStatus;
        db.setParticipantStatus(target.config.id, previousStatus);

        this._options.onProgress?.(`${target.config.name} (${target.config.tier}) — query_response to ${sourceName}`);
        this._options.onContribution?.(target.config.name, stateManager.getCurrentRound(), "query_response");

      } catch (err) {
        const info = extractErrorInfo(err);
        this._logError(`query response for ${target.config.name}`, err);
        this._logger.warn("query_failed", `Query response for ${target.config.name} failed`, info);
        target.status = "listening";
        db.setParticipantStatus(target.config.id, "listening");
      } finally {
        if (!isRoundScoped) {
          sessionManager.unregisterSession(sessionId);
          await sessionManager.deleteEphemeralSession(sessionId).catch(() => {});
        }
      }
    }),
  );

  db.setQueryingParticipants(null);
}

export async function executeEvidenceRequests(round, sourceParticipant, evidence, sourceContributionId, {
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
      let sessionId;
      let isRoundScoped = false;
      if (this._roundSessionIds?.has(target.config.id)) {
        sessionId = this._roundSessionIds.get(target.config.id);
        isRoundScoped = true;
      } else {
        sessionId = await sessionManager.createEphemeralSession(target);
        sessionManager.registerSessionMeeting(sessionId, stateManager.getMeetingId());
      }
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
        this._logger.info("agent_tools_offered", `${target.config.name} offered ${evidenceToolKeys.length} tool(s) (required)`, {
          participant: target.config.id,
          round: stateManager.getCurrentRound(),
          tools: evidenceToolKeys,
          tool_choice: evidenceToolKeys.length > 0 ? "required" : "none",
        });

        const systemPrompt = `You are ${target.config.name} (${target.config.tier}) — providing evidence in Loom.

You MUST use at least one research tool. No speculation.
Structure: Finding (1 sentence) + Source (URL or [#id]) + Strength: strong|weak|inconclusive.
If inconclusive, state why (0 hits vs contradictory) and what would resolve it. 100-180 words, in character, never emit <<< or >>>.`;
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

        const result = await sessionManager.getContract().prompt({
          sessionId,
          system: systemPrompt,
          model,
          temperature: target.tier_config.temperature,
          parts: [{ type: "text", text: prompt }],
          tools: evidenceTools,
          toolChoice: Object.keys(evidenceTools).length > 0 ? "required" : undefined,
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

        const { text, toolResults } = extractAgentResponse(result.data);

        if (!text || text.trim().length < 10) {
          if (toolResults.length > 0) {
            this._logger.warn("evidence_short_text_with_tools", `${target.config.name} produced short/empty evidence answer but executed ${toolResults.length} tool(s) — storing tool-evidence-only contribution`, {
              participant: target.config.id,
              round: stateManager.getCurrentRound(),
              tools: toolResults.map(t => ({ tool: t.tool, status: t.status ?? null })),
            });
            const evidenceOnly = {
              id: stateManager.nextContributionId(),
              round: stateManager.getCurrentRound(),
              participant_id: target.config.id,
              content: `[Evidence from ${target.config.name} on ${sourceName}'s ${round.contributions[round.contributions.length - 1]?.type ?? "contribution"}]\n\n(insufficient response text — tool evidence preserved)`,
              type: "evidence_response",
              targets_which: sourceContributionId,
              batch_id: sourceParticipant.currentBatchId ?? crypto.randomUUID(),
              tool_calls: mapToolResults(toolResults),
              prompt_context: promptContext,
              created_at: new Date().toISOString(),
            };
            stateManager.addContribution(evidenceOnly);
            round.contributions.push(evidenceOnly);
            degrade("persist.contribution", "Persist contribution", () => db.addContributionWithTurnRequest(stateManager.getMeetingId(), evidenceOnly, null), null);
          }
          return;
        }

        const contributionTools = mapToolResults(toolResults);

        const contribution = {
          id: stateManager.nextContributionId(),
          round: stateManager.getCurrentRound(),
          participant_id: target.config.id,
          content: `[Evidence from ${target.config.name} on ${sourceName}'s ${round.contributions[round.contributions.length - 1]?.type ?? "contribution"}]\n\n${text.trim()}`,
          type: "evidence_response",
          targets_which: sourceContributionId,
          batch_id: sourceParticipant.currentBatchId ?? crypto.randomUUID(),
          tool_calls: contributionTools ?? [],
          prompt_context: promptContext,
          created_at: new Date().toISOString(),
        };

        stateManager.addContribution(contribution);
        round.contributions.push(contribution);
        stateManager.incrementParticipantContributions(target.config.id);

        degrade("persist.contribution", "Persist contribution", () => db.addContributionWithTurnRequest(stateManager.getMeetingId(), contribution, null), null);

        target.status = previousStatus;
        db.setParticipantStatus(target.config.id, previousStatus);

        this._options.onProgress?.(`${target.config.name} (${target.config.tier}) — evidence_response to ${sourceName}`);
        this._options.onContribution?.(target.config.name, stateManager.getCurrentRound(), "evidence_response");

      } catch (err) {
        const info = extractErrorInfo(err);
        this._logError(`evidence response for ${target.config.name}`, err);
        this._logger.warn("evidence_failed", `Evidence response for ${target.config.name} failed`, info);
        target.status = "listening";
        db.setParticipantStatus(target.config.id, "listening");
      } finally {
        if (!isRoundScoped) {
          sessionManager.unregisterSession(sessionId);
          await sessionManager.deleteEphemeralSession(sessionId).catch(() => {});
        }
      }
    }),
  );

  db.setEvidenceParticipants(null);
}


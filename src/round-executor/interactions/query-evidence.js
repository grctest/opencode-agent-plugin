import { buildQueryPrompt, buildEvidencePrompt, buildSummonPrompt, buildVotePrompt } from "../../prompts/interaction-prompts.js";
import { getConfig } from "../../config.js";
import { QUERY_MODES, researchTools } from "../../prompts/query-modes.js";
import { extractAgentResponse, mapToolResults } from "../../shared.js";
import { getPersonas } from "../../composer.js";
import { extractErrorInfo } from "../../logger.js";
import { degrade } from "../../utils/degrade.js";

function normalizeQueryItems(query) {
  // New shape: query.queries = [{target, question, mode?}]
  if (Array.isArray(query?.queries)) {
    return query.queries
      .filter((q) => q && typeof q.target === "string" && q.target.trim() && typeof q.question === "string" && q.question.trim())
      .map((q) => ({
        targetId: q.target.trim(),
        question: q.question.trim(),
        mode: QUERY_MODES[q.mode] ? q.mode : "clarify",
      }));
  }
  return [];
}

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

  const items = normalizeQueryItems(query)
    .map((q) => ({ ...q, participant: allParticipants.find((p) => p.config.id === q.targetId) }))
    .filter((q) => q.participant && q.participant.config.id !== sourceParticipant.config.id && q.participant.status !== "failed" && q.participant.status !== "passed");

  if (items.length === 0) return;

  const sourceName = sourceParticipant.config.name;

  db.setQueryingParticipants(items.map((q) => q.participant.config.id));

  await Promise.allSettled(
    items.map(async ({ participant: target, question, mode }) => {
      const meta = QUERY_MODES[mode];
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

        let prompt;
        if (mode === "evidence") {
          prompt = buildEvidencePrompt(
            sourceParticipant,
            target,
            sourceParticipant.currentContribution || sourceParticipant.config.name,
            question,
            round.contributions,
            stateManager.getCurrentRound(),
            stateManager.getMaxRounds(),
          );
        } else {
          prompt = buildQueryPrompt(
            sourceParticipant,
            target,
            sourceParticipant.currentContribution || sourceParticipant.config.name,
            question,
            round.contributions,
            stateManager.getCurrentRound(),
            stateManager.getMaxRounds(),
            stateManager.getStateOfPlay(),
            mode,
          );
        }

        const queryTools = researchTools();
        const queryToolKeys = Object.keys(queryTools);
        this._logger.info("agent_tools_offered", `${target.config.name} offered ${queryToolKeys.length} tool(s) (${mode})`, {
          participant: target.config.id,
          round: stateManager.getCurrentRound(),
          tools: queryToolKeys,
          tool_choice: queryToolKeys.length > 0 ? meta.toolChoice : "none",
          mode,
        });

        const systemPrompt = meta.systemPrompt(target);
        const promptContext = {
          type: meta.contributionType,
          mode,
          system_prompt: systemPrompt,
          user_prompt: prompt,
          source_contribution_id: sourceContributionId,
          source_participant_id: sourceParticipant.config.id,
          question,
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
          toolChoice: Object.keys(queryTools).length > 0 ? meta.toolChoice : undefined,
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
            this._logger.warn("query_short_text_with_tools", `${target.config.name} produced short/empty ${meta.contributionType} answer but executed ${toolResults.length} tool(s) — storing tool-evidence-only contribution`, {
              participant: target.config.id,
              round: stateManager.getCurrentRound(),
              tools: toolResults.map(t => ({ tool: t.tool, status: t.status ?? null })),
            });
            const evidenceOnly = {
              id: stateManager.nextContributionId(),
              round: stateManager.getCurrentRound(),
              participant_id: target.config.id,
              content: `${meta.contentPrefix(target.config.name, sourceName)}\n\n(insufficient response text — tool evidence preserved)`,
              type: meta.contributionType,
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
          content: `${meta.contentPrefix(target.config.name, sourceName)}\n\n${text.trim()}`,
          type: meta.contributionType,
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

        // Perspective answers update the responder's stored reflection — this path
        // is replacing automatic challenge/dissent reflections long-term.
        if (mode === "perspective" && text.trim()) {
          try {
            target.reflection = text.trim();
            if (!Array.isArray(target.reflectionHistory)) target.reflectionHistory = [];
            target.reflectionHistory.push({ round: stateManager.getCurrentRound(), text: text.trim(), at: Date.now() });
            if (target.reflectionHistory.length > 5) target.reflectionHistory.shift();
            db.setParticipantReflection(target.config.id, text.trim());
          } catch {}
        }

        target.status = previousStatus;
        db.setParticipantStatus(target.config.id, previousStatus);

        this._options.onProgress?.(`${target.config.name} (${target.config.tier}) — ${meta.contributionType} to ${sourceName}`);
        this._options.onContribution?.(target.config.name, stateManager.getCurrentRound(), meta.contributionType);

      } catch (err) {
        const info = extractErrorInfo(err);
        this._logError(`${meta.contributionType} for ${target.config.name}`, err);
        this._logger.warn("query_failed", `${meta.contributionType} for ${target.config.name} failed`, info);
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

/**
 * Legacy entry point — normalizes an old-shape evidence request into the unified
 * query pipeline with mode="evidence". Kept so existing facade callers keep working.
 */
export async function executeEvidenceRequests(round, sourceParticipant, evidence, sourceContributionId, deps) {
  const normalized = {
    queries: (evidence?.targets ?? []).map((target) => ({ target, question: evidence.question, mode: "evidence" })),
  };
  return executeQueries(round, sourceParticipant, normalized, sourceContributionId, deps);
}

import { buildReflectionPrompt } from "./prompts.js";
import { extractText, extractAgentResponse, withTimeout } from "./shared.js";
import { getConfig } from "./config.js";
import { Logger, extractErrorInfo } from "./logger.js";

const reflectionLogger = new Logger();

/**
 * Runs mid-round reflections. When a challenge or dissent is produced,
 * agents that spoke BEFORE the challenger/dissenter reflect on it.
 * Each reflection creates a public contribution in the weave with a visible
 * header identifying the trigger contribution.
 *
 * @param {Object} round - Current round object
 * @param {Object} triggerParticipant - The participant who produced the challenge/dissent
 * @param {Array} listeners - Agents that spoke before the trigger (subset of active participants)
 * @param {Object} deps - Dependencies
 */
export async function runMidRoundReflections(round, triggerParticipant, listeners, {
  client,
  directory,
  sessionManager,
  getParticipantModel,
  stateManager,
  db,
  logError,
  callStats,
}) {
  if (listeners.length === 0) return;

  const config = getConfig();
  const timeoutMs = config.agentTimeoutMs;

  db.setReflectingParticipants(listeners.map((l) => l.config.id));

  await Promise.allSettled(
    listeners.map(async (listener) => {
      const model = getParticipantModel(listener);
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

        // Build tools map for reflection (reduced set: web_fetch, web_search, read, loom_vector_search)
        const agentToolsConfig = getConfig().agentTools;
        const reflectionTools = {};
        if (agentToolsConfig?.enabled) {
          // Reflection tools: web_fetch, web_search, read, loom_vector_search
          // Exclude bash, glob, grep for reflection safety
          if (agentToolsConfig?.builtIn?.web_fetch) reflectionTools.web_fetch = true;
          if (agentToolsConfig?.builtIn?.web_search) reflectionTools.web_search = true;
          if (agentToolsConfig?.builtIn?.read) reflectionTools.read = true;
          if (agentToolsConfig?.loom?.loom_vector_search) reflectionTools.loom_vector_search = true;
        }

        const result = await withTimeout(
          client.session.prompt({
            path: { id: sessionId },
            body: {
              system: `You are ${listener.config.name} (${listener.config.tier}). This is your reflection on the deliberation — it will be visible to other participants.`,
              model,
              temperature: listener.tier_config.temperature,
              parts: [{ type: "text", text: prompt }],
              tools: reflectionTools,
              tool_choice: Object.keys(reflectionTools).length > 0 ? "auto" : undefined,
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

        // Use extractAgentResponse to handle tool call parts
        const { text, toolResults } = extractAgentResponse(result.data);
        
        // Log tool results for observability
        if (toolResults.length > 0) {
          reflectionLogger.info("reflection_tool_results", `${listener.config.name} used ${toolResults.length} tool(s) in reflection`, {
            tools: toolResults.map(t => ({
              tool: t.tool,
              callID: t.callID,
              hasOutput: !!t.output,
              hasError: !!t.error,
            })),
          });
        }

        if (!text || text.trim().length < 10) return;

        // Build visible header with reflection context
        const header = `[Reflection on #${triggerParticipant.currentContributionId} [${triggerParticipant.currentContributionType.toUpperCase()}] by ${triggerParticipant.config.name} (Round ${stateManager.getCurrentRound()})]`;

        // Create a contribution object
        const contribution = {
          id: stateManager.nextContributionId(),
          round: stateManager.getCurrentRound(),
          participant_id: listener.config.id,
          content: `${header}\n\n${text.trim()}`,
          type: "reflection",
          targets_which: triggerParticipant.currentContributionId,
          tool_calls: toolResults.length > 0 ? toolResults.map(t => ({
            tool: t.tool,
            callID: t.callID,
            title: t.title ?? null,
            output: t.output ? String(t.output).slice(0, 2000) : null,
            error: t.error ? String(t.error).slice(0, 500) : null,
            metadata: t.metadata ?? null,
          })) : null,
          created_at: new Date().toISOString(),
        };

        // Add to weave and round contributions
        stateManager.addContribution(contribution);
        round.contributions.push(contribution);

        // Update participant's latest reflection (for next-round context, stored WITHOUT header)
        listener.reflection = text.trim();
        db.setParticipantReflection(listener.config.id, text.trim());

        // Persist contribution
        db.addContributionWithTurnRequest(stateManager.getMeetingId(), contribution, null);

      } catch (err) {
        const info = extractErrorInfo(err);
        logError(`reflection prompt for ${listener.config.name}`, err);
        reflectionLogger.warn("reflection_failed", `Reflection for ${listener.config.name} failed`, info);
      } finally {
        await sessionManager.deleteEphemeralSession(sessionId).catch(() => {});
      }
    })
  );

  db.setReflectingParticipants(null);
}

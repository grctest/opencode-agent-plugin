import { buildReflectionPrompt } from "./prompts.js";
import { extractText, withTimeout } from "./shared.js";
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
}) {
  if (listeners.length === 0) return;

  const config = getConfig();
  const timeoutMs = config.agentTimeoutMs;

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
        );

        const result = await withTimeout(
          client.session.prompt({
            path: { id: sessionId },
            body: {
              system: `You are ${listener.config.name} (${listener.config.tier}). This is your reflection on the deliberation — it will be visible to other participants.`,
              model,
              temperature: listener.tier_config.temperature,
              parts: [{ type: "text", text: prompt }],
            },
            query: { directory },
          }),
          timeoutMs,
        );

        if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));

        const text = extractText(result.data);
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
          created_at: new Date().toISOString(),
        };

        // Add to weave and round contributions
        stateManager.addContribution(contribution);
        round.contributions.push(contribution);

        // Update participant's latest reflection (for next-round context, stored WITHOUT header)
        listener.reflection = text.trim();
        db.setParticipantReflection(listener.config.id, text.trim());

        // Persist contribution
        db.addContributionWithInterjection(stateManager.getMeetingId(), contribution, null);

      } catch (err) {
        const info = extractErrorInfo(err);
        logError(`reflection prompt for ${listener.config.name}`, err);
        reflectionLogger.warn("reflection_failed", `Reflection for ${listener.config.name} failed`, info);
      } finally {
        await sessionManager.deleteEphemeralSession(sessionId).catch(() => {});
      }
    })
  );
}

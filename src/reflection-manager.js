import { buildReflectionPrompt } from "./prompts.js";
import { Logger, extractErrorInfo } from "./logger.js";

const reflectionLogger = new Logger();

/** Stores a reflection on a participant, overwriting any previous reflection. */
function pushReflection(listener, text, db) {
  listener.reflection = text;
  db.setParticipantReflection(listener.config.id, text);
}

/**
 * Runs the reflection phase for a round. When a challenge or dissent is contributed,
 * other participants privately reflect on it. Each reflection supersedes any prior one,
 * producing a single evolving belief state.
 */
export async function runReflectionPhase(round, activeParticipants, promptParent, getParticipantModel, db, logError) {
  const triggers = round.contributions.filter((c) => c.type === "challenge" || c.type === "dissent");
  if (triggers.length === 0) return;

  for (const trigger of triggers) {
    const triggerParticipant = activeParticipants.find((p) => p.config.id === trigger.participant_id);
    if (!triggerParticipant) continue;

    const listeners = activeParticipants.filter((p) => {
      if (p.config.id === trigger.participant_id) return false;
      if (p.status === "passed") return false;
      if (p.status === "failed") return false;
      return true;
    });

    if (listeners.length === 0) continue;

    const model = getParticipantModel(listeners[0]);

    await Promise.allSettled(
      listeners.map(async (listener) => {
        const prompt = buildReflectionPrompt(listener, triggerParticipant, trigger.content, round.contributions);
        try {
          const reflection = await promptParent(
            `You are ${listener.config.name} (${listener.config.tier}). Private reflection — only you will see this.`,
            model,
            prompt
          );

          if (reflection && reflection.trim().length > 10) {
            pushReflection(listener, reflection.trim(), db);
          }
        } catch (err) {
          const info = extractErrorInfo(err);
          logError(`reflection prompt for ${listener.config.name}`, err);
          reflectionLogger.warn("reflection_failed", `Reflection for ${listener.config.name} failed`, info);
        }
      })
    );
  }
}

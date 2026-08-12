import { buildReflectionPrompt, buildBatchReflectionPrompt } from "./prompts.js";
import { Logger, extractErrorInfo } from "./logger.js";

const reflectionLogger = new Logger();
const MAX_REFLECTIONS = 2;

/** Parses a batch reflection JSON response into listener assignments, or null on failure. */
function parseBatchReflections(text, listeners) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (!parsed || !Array.isArray(parsed.reflections)) return null;
    const results = [];
    for (const entry of parsed.reflections) {
      if (!entry || typeof entry.name !== "string" || typeof entry.reflection !== "string") continue;
      if (entry.reflection.trim().length < 10) continue;
      const listener = listeners.find(
        (l) => l.config.name.toLowerCase() === entry.name.trim().toLowerCase(),
      );
      if (!listener) continue;
      results.push({ listener, text: entry.reflection });
    }
    return results.length > 0 ? results : null;
  } catch {
    return null;
  }
}

/** Stores a reflection on a participant, enforcing MAX_REFLECTIONS. */
function pushReflection(listener, text, db) {
  if (!Array.isArray(listener.reflections)) listener.reflections = [];
  listener.reflections.push(text);
  listener.reflections = listener.reflections.slice(-MAX_REFLECTIONS);
  db.setParticipantReflection(listener.config.id, JSON.stringify(listener.reflections));
}

/** Attempts batch reflection generation for all listeners in a single LLM call. Returns true on success. */
async function tryBatchReflections(triggerParticipant, trigger, listeners, model, promptParent, db) {
  try {
    const prompt = buildBatchReflectionPrompt(triggerParticipant.config.name, trigger.content, listeners);
    const raw = await promptParent(
      "You are a neutral reflection coordinator. Generate private reflections for each named participant.",
      model,
      prompt,
    );

    const reflections = parseBatchReflections(raw, listeners);
    if (!reflections) return false;

    for (const { listener, text } of reflections) {
      pushReflection(listener, text.trim(), db);
    }
    reflectionLogger.info("reflections_batched", `Batch reflections generated for ${reflections.length} listeners`);
    return true;
  } catch (err) {
    const info = extractErrorInfo(err);
    reflectionLogger.warn("reflection_batch_failed", "Batch reflection failed — falling back to per-listener", info);
    return false;
  }
}

/**
 * Runs the reflection phase for a round. When a challenge or dissent is contributed,
 * other participants privately reflect on it. Uses batch generation when possible.
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
      if ((p.reflections?.length ?? 0) >= MAX_REFLECTIONS) return false;
      return true;
    });

    if (listeners.length === 0) continue;

    const model = getParticipantModel(listeners[0]);
    const batchHandled = await tryBatchReflections(triggerParticipant, trigger, listeners, model, promptParent, db);
    if (batchHandled) continue;

    for (const listener of listeners) {
      const prompt = buildReflectionPrompt(listener, triggerParticipant.config.name, trigger.content);

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
    }
  }
}

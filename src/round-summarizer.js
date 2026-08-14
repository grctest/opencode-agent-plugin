import { getConfig } from "./config.js";
import { truncate } from "./shared.js";
import { Logger, extractErrorInfo } from "./logger.js";

const summarizerLogger = new Logger();

/**
 * Generates a summary for a completed round.
 * Uses heuristic counts first; escalates to an LLM-generated semantic summary
 * when there are conflict signals in moderator_forces mode.
 */
export async function summarizeRound(round, state, promptOrchestrator, getHighestTierModel) {
  const contribCount = round.contributions.length;
  if (contribCount === 0) return "No contributions this round.";

  const types = round.contributions.map((c) => c.type);
  const typeCounts = {};
  for (const t of types) typeCounts[t] = (typeCounts[t] ?? 0) + 1;
  const typeSummary = Object.entries(typeCounts).map(([t, c]) => `${c} ${t}`).join(", ");

  let summary = `Round contributions (${contribCount}): ${typeSummary}.`;
  if (round.turn_requests.length > 0) {
    summary += ` ${round.turn_requests.length} turn request(s).`;
  }

  const hasConflictSignals =
    round.contributions.some((c) => c.type === "challenge" || c.type === "dissent") ||
    round.turn_requests.length > 0;

  if (
    state.convergence_mode === "moderator_forces" &&
    contribCount > 2 &&
    hasConflictSignals
  ) {
    try {
      const model = getHighestTierModel();
      if (!model) throw new Error("No model available for semantic summary");
      const prompt = `Summarize this deliberation round in 2-3 sentences. What was established? What remains contested?\n\nContributions:\n${round.contributions.map((c) => `- ${c.content.slice(0, 150)}`).join("\n")}\n\nSummary:`;
      const semanticSummary = await promptOrchestrator("You are a neutral summarizer.", model, prompt, "summary");
      if (semanticSummary && semanticSummary.trim().length > 10) {
        summary = semanticSummary.trim();
      }
    } catch (err) {
      const info = extractErrorInfo(err);
      summarizerLogger.warn("summary_fallback", "Semantic summary failed — using heuristic", info);
    }
  }

  return summary;
}

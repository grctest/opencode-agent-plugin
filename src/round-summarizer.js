import { getConfig } from "./config.js";
import { truncate } from "./shared.js";
import { Logger, extractErrorInfo } from "./logger.js";

const summarizerLogger = new Logger();

// Only include contributions that represent actual positions in the deliberation
const SUMMARY_TYPES = new Set(["propose", "challenge", "refine", "support", "dissent", "synthesize", "question", "vote_tally"]);

// Strip the reflection header: "[Reflection on #N [TYPE] by Name (Round M)]\n\n"
const REFLECTION_HEADER_RE = /^\[Reflection on #\d+ \[[\w]+\] by .+?\]\s*/m;

/**
 * Extracts the reflection outcome text (header stripped) from a reflection contribution.
 */
function extractReflectionOutcome(c) {
  if (c.type !== "reflection" || !c.content) return null;
  const outcome = c.content.replace(REFLECTION_HEADER_RE, "").trim();
  return outcome.length > 0 ? outcome : null;
}

/**
 * Builds a map of reflection outcomes keyed by the target contribution ID.
 * Deduplicates: only keeps unique outcomes per target.
 */
function buildReflectionMap(contributions) {
  const map = new Map();
  for (const c of contributions) {
    if (c.type !== "reflection" || !c.targets_which) continue;
    const outcome = extractReflectionOutcome(c);
    if (!outcome) continue;
    if (!map.has(c.targets_which)) map.set(c.targets_which, []);
    const existing = map.get(c.targets_which);
    if (!existing.some((o) => o === outcome)) existing.push(outcome);
  }
  return map;
}

/**
 * Formats a contribution for the summary prompt.
 * Includes participant ID, contribution type, full content, and any reflection outcomes.
 */
function formatContribution(c, reflectionMap) {
  const typeTag = c.type.toUpperCase();
  const lines = [`- [#${c.id}] ${c.participant_id} [${typeTag}]: ${c.content}`];
  const reflections = reflectionMap.get(c.id);
  if (reflections && reflections.length > 0) {
    // Take the first (most relevant) reflection outcome
    lines.push(`  ↳ Reflected: ${reflections[0]}`);
  }
  return lines.join("\n");
}

/**
 * Generates a summary for a completed round.
 * Uses heuristic counts as the baseline; always escalates to an LLM-generated
 * semantic summary for rounds with substantive contributions.
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

  try {
    const model = getHighestTierModel();
    if (!model) throw new Error("No model available for semantic summary");

    // Filter to only substantive contributions (no reflections, query responses, etc.)
    const summaryContributions = round.contributions.filter((c) => SUMMARY_TYPES.has(c.type));

    // Build reflection outcome map and format contributions
    const reflectionMap = buildReflectionMap(round.contributions);
    const formattedContributions = summaryContributions
      .map((c) => formatContribution(c, reflectionMap))
      .join("\n\n");

    if (formattedContributions.trim().length === 0) {
      return summary;
    }

    const prompt = `Summarize this deliberation round. What was established? What remains contested?

## Question
${state.question || "(no question provided)"}

## Round ${round.number || "?"} Contributions
${formattedContributions}

## Instructions
Focus on:
1. What decisions or positions were established
2. What specific points remain contested and who holds each side
3. Any new information or evidence introduced

Provide your summary in this format:
- **Established:** {what was decided or agreed}
- **Contested:** {what remains disputed and by whom}
- **Open:** {unresolved questions or next decisions needed}`;

    const semanticSummary = await promptOrchestrator("You are a neutral summarizer.", model, prompt, "summary");
    if (semanticSummary && semanticSummary.trim().length > 10) {
      summary = semanticSummary.trim();
    }
  } catch (err) {
    const info = extractErrorInfo(err);
    summarizerLogger.warn("summary_fallback", "Semantic summary failed — using heuristic", info);
  }

  return summary;
}

import { getConfig } from "./config.js";
import { truncate } from "./shared.js";
import { Logger, extractErrorInfo } from "./logger.js";

const summarizerLogger = new Logger();

// Only include contributions that represent actual positions in the deliberation
// evidence_response included when tool-backed; reflections / query_response handled via hint
const SUMMARY_TYPES = new Set(["propose", "challenge", "refine", "support", "dissent", "synthesize", "question", "vote_tally", "evidence_response"]);

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
 * Generates a summary for a completed round using LLM-based summarization.
 * Always attempts LLM summarization; throws on failure instead of falling back to placeholder.
 */
export async function summarizeRound(round, state, promptOrchestrator, getHighestTierModel, getFallbackModel) {
  const contribCount = round.contributions.length;
  if (contribCount === 0) return "No contributions this round.";

  // Try primary model, then fallback
  const model = getHighestTierModel() ?? (getFallbackModel ? getFallbackModel() : null);
  if (!model) throw new Error("No model available for semantic summary — check model assignment");

  // Filter to only substantive contributions; keep evidence_response only when tool-backed
  const summaryContributions = round.contributions.filter((c) => {
    if (!SUMMARY_TYPES.has(c.type)) return false;
    if (c.type === "evidence_response" && !(c.tool_calls && c.tool_calls.length > 0)) return false;
    return true;
  });

  // Build reflection outcome map and format contributions
  const reflectionMap = buildReflectionMap(round.contributions);
  const formattedContributions = summaryContributions
    .map((c) => formatContribution(c, reflectionMap))
    .join("\n\n");

  // Adapt prompt based on whether we have substantive contributions
  const hasSubstantiveContent = formattedContributions.trim().length > 0;

  // Collect evidence signals for richer summary — ordered by tool strength, max 4
  const evidenceContribs = round.contributions
    .filter(c => c.type === "evidence_response" || c.type === "query_response" || (c.tool_calls && c.tool_calls.length > 0))
    .sort((a, b) => {
      const strengthScore = (c) => {
        const s = String(c.content).toLowerCase();
        if (s.includes("strength: strong")) return 3;
        if (s.includes("strength: weak")) return 2;
        if (s.includes("inconclusive")) return 1;
        return c.tool_calls ? 2 : 1;
      };
      return strengthScore(b) - strengthScore(a);
    });
  const evidenceHint = evidenceContribs.length > 0
    ? `\n## Evidence / Tool Signals (do not invent — use only if cited)\n${evidenceContribs.slice(0, 4).map(c => `- [#${c.id}] ${c.participant_id}: ${c.content.slice(0, 180)}${c.tool_calls ? ` [tools: ${c.tool_calls.map(t=>t.tool).join(',')}]` : ""}`).join("\n")}`
    : "";

  const prompt = hasSubstantiveContent
    ? `You are a concise deliberation clerk. Summarize round ${round.number || "?"} in 60-90 words — no preamble, phrase-style bullets. Prefer longer deliberation nuance over terse collapse. Preserve numbers verbatim — do not round or invent.

## Question
${state.question || "(no question provided)"}

## Round ${round.number || "?"} Contributions
${formattedContributions}
${evidenceHint}

## Output — exactly 4 bullets, each one line:

- **Established:** {1-2 decisions/proposals that gained support, with holder [#id] }
- **Contested:** {what remains disputed and who holds each side — name holders [#id]}
- **Evidence:** {any tool or vec-grounded evidence introduced this round, with Source or [#id]; or “None”}
- **Open:** {unresolved questions or next decision needed}

Rules: cite [#id] when attributing. Keep Contested holders explicit. Evidence bullet must distinguish “None” from “weak/inconclusive”. Preserve numbers verbatim — do not round, estimate, or invent figures not in contributions.`
    : `Summarize this deliberation round. The round contained ${contribCount} contribution(s) but no substantive positions were staked.

## Question
${state.question || "(no question provided)"}

## Round ${round.number || "?"}
Contribution types: ${round.contributions.map((c) => c.type).join(", ")}
Turn requests: ${round.turn_requests.length}
${evidenceHint}

## Instructions
Provide 60-90 word summary with 4 bullets (Established / Contested / Evidence / Open) noting no substantive deliberation but mentioning contribution types and any turn requests.`;

  const semanticSummary = await promptOrchestrator("You are a concise deliberation clerk. 60-90 words. No preamble. Use short phrases, not sentences. Preserve numbers verbatim — do not round or invent.", model, prompt, "summary");

  if (semanticSummary && semanticSummary.trim().length > 0) {
    return semanticSummary.trim();
  }

  // If LLM returned empty response, throw to make the failure visible
  throw new Error("LLM returned empty summary response");
}

import { getConfig } from "./config.js";
import { truncate } from "./shared.js";
import { Logger, extractErrorInfo } from "./logger.js";
import { SUBSTANTIVE_TYPES } from "./utils/contribution-types.js";

const summarizerLogger = new Logger();
const SUMMARY_TYPES = SUBSTANTIVE_TYPES;

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
 * The orchestrator path retries empty responses; if the LLM still yields no
 * text, degrades to a deterministic contributions digest instead of throwing —
 * one flaky response must not kill the whole deliberation.
 */
export async function summarizeRound(round, state, promptOrchestrator, getHighestTierModel, getFallbackModel) {
  const contribCount = round.contributions.length;
  if (contribCount === 0) return "No contributions this round.";

  // Try primary model, then fallback
  const model = getHighestTierModel() ?? (getFallbackModel ? getFallbackModel() : null);
  if (!model) throw new Error("No model available for semantic summary — check model assignment");

  // Filter to only substantive contributions; keep evidence_response only when tool-backed; exclude passes
  const summaryContributions = round.contributions.filter((c) => {
    if (c.type === "pass") return false;
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

  // Collect evidence signals for richer summary — ordered by tool strength, max 6
  const evidenceContribs = round.contributions
    .filter(c => c.type === "evidence_response" || c.type === "query_response" || c.type === "critique_response" || (c.tool_calls && c.tool_calls.length > 0))
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
    ? `\n## Evidence / Tool Signals (do not invent — use only if cited)\n${evidenceContribs.slice(0, 6).map(c => `- [#${c.id}] ${c.participant_id}: ${c.content.slice(0, 350)}${c.tool_calls ? ` [tools: ${c.tool_calls.map(t=>t.tool).join(',')}]` : ""}`).join("\n")}`
    : "";

  // Detect mode for summary shape
  const isCodeRound = formattedContributions.includes("file=") || formattedContributions.includes("```") || (state.tags || []).some(t => /engineering|code|programming/i.test(t));

  const prompt = hasSubstantiveContent
    ? `You are a thorough deliberation clerk. Summarize round ${round.number || "?"} in 180-350 words — sentence style, human-readable first. Concise but thorough; preserve nuance, don't yap. Preserve numbers verbatim — do not round or invent.

## Question
${state.question || "(no question provided)"}

## Round ${round.number || "?"} Contributions
${formattedContributions}
${evidenceHint}

## Output — 4-5 bullets, each 1-3 sentences (human-readable, then auditable):

- **Established:** What gained support this round, with holder [#id] and why it matters (1-2 sentences)
- **Contested:** What remains disputed — name holders and their distinct positions [#id]; map the spectrum, don’t collapse to “disagreement”
- **Evidence:** Tool or vec-grounded evidence introduced (Source or [#id] with Strength: strong/weak/inconclusive); or “None — no new evidence this round” — never emit vec: / vec round traces, use State-of-Play or [#id]
- **Open:** Unresolved questions and what would resolve them (missing evidence / decision needed)
${isCodeRound ? `- **Code/Files:** Files touched or proposed (file=src/...), diffs status, and test/verification notes` : ""}

Rules: cite [#id] once per bullet when attributing (grouped, not per clause). Keep Contested holders explicit. Evidence must distinguish “None” from “weak/inconclusive”. Never emit vec: / vec round traces — use [#id] or State-of-Play. Preserve numbers verbatim — do not round, estimate, or invent figures not in contributions. Concise but thorough.`
    : `Summarize this deliberation round. The round contained ${contribCount} contribution(s) but no substantive positions were staked.

## Question
${state.question || "(no question provided)"}

## Round ${round.number || "?"}
Contribution types: ${round.contributions.map((c) => c.type).join(", ")}
Turn requests: ${round.turn_requests.length}
${evidenceHint}

## Instructions
Provide 180-350 word summary with 4-5 bullets (Established / Contested / Evidence / Open / Code if applicable) noting no substantive deliberation but mentioning contribution types and any turn requests. Sentence style, human-readable. Preserve numbers verbatim.`;

  const semanticSummary = await promptOrchestrator("You are a thorough deliberation clerk. 180-350 words. Sentence style, human-readable, concise but thorough. Preserve numbers verbatim — do not round or invent. Never emit vec: traces.", model, prompt, "summary");

  if (semanticSummary && semanticSummary.trim().length > 0) {
    return semanticSummary.trim();
  }

  // Degrade gracefully: keep the round auditable with a deterministic digest
  // rather than failing the meeting over a transient empty LLM response.
  const turnRequestCount = Array.isArray(round.turn_requests) ? round.turn_requests.length : 0;
  const digestBullets = summaryContributions.slice(0, 10).map((c) =>
    `- [#${c.id}] ${c.participant_id} [${String(c.type).toUpperCase()}]: ${truncate(c.content ?? "", 300)}`
  );
  if (digestBullets.length === 0) {
    digestBullets.push(`- No substantive positions staked (${contribCount} contribution(s): ${round.contributions.map((c) => c.type).join(", ")})`);
  }
  digestBullets.push(`- Turn requests: ${turnRequestCount}`);

  summarizerLogger.warn(
    "summary_degraded",
    `Round ${round.number || "?"} LLM summary empty after retries — using deterministic digest`,
    { round: round.number, contribCount, turnRequests: turnRequestCount },
  );

  return ["(Degraded summary — LLM returned empty response)", ...digestBullets].join("\n");
}

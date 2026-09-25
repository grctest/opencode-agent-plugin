import { getConfig } from "./config.js";
import { truncate } from "./shared.js";
import { Logger, extractErrorInfo } from "./logger.js";
import { SUBSTANTIVE_TYPES } from "./utils/contribution-types.js";
import { renderMyStateMarkdown, STATE_PATCH_CAPS } from "./state-patch.js";
import { sanitizeForPrompt } from "./utils/sanitize.js";
import { delimitContext, escapeDelimiters } from "./prompts/delimiters.js";
import { getSummaryGuidance, orchestratorContextPolicy, getSummaryBand } from "./orchestrator/models.js";
import { buildRoundContext } from "./prompts/blocks.js";
import { sanitizeForDisplay } from "./utils/sanitize.js";

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

function safeStateText(value, maxLength) {
  return escapeDelimiters(sanitizeForPrompt(String(value ?? "").replace(/\s+/g, " "), maxLength));
}

function formatAgentStateSnapshot(entry) {
  const id = safeStateText(entry?.id, 120) || "unknown";
  const name = safeStateText(entry?.name ?? id, 200) || id;
  const tier = safeStateText(entry?.tier, 40) || "unknown";
  const status = safeStateText(entry?.status, 40) || "unknown";
  const source = entry?.state ?? {};
  const state = {
    stance: safeStateText(source.stance, STATE_PATCH_CAPS.stanceMax),
    established: Array.isArray(source.established) ? source.established.slice(0, STATE_PATCH_CAPS.buckets).map((item) => safeStateText(item, STATE_PATCH_CAPS.bulletMax)) : [],
    contested: Array.isArray(source.contested) ? source.contested.slice(0, STATE_PATCH_CAPS.buckets).map((item) => safeStateText(item, STATE_PATCH_CAPS.bulletMax)) : [],
    open: Array.isArray(source.open) ? source.open.slice(0, STATE_PATCH_CAPS.buckets).map((item) => safeStateText(item, STATE_PATCH_CAPS.bulletMax)) : [],
    facts: Array.isArray(source.facts) ? source.facts.slice(0, STATE_PATCH_CAPS.buckets).map((item) => safeStateText(item, STATE_PATCH_CAPS.bulletMax)) : [],
    files: Array.isArray(source.files) ? source.files.slice(0, STATE_PATCH_CAPS.buckets).map((item) => safeStateText(item, STATE_PATCH_CAPS.fileMax)) : [],
  };
  const version = Number.isFinite(source.version) ? source.version : 0;
  const updatedRound = Number.isFinite(source.updated_round) ? source.updated_round : 0;
  const projection = entry?.projected ? " (effective projection from a same-round perspective response; not yet committed)" : "";
  const header = `- **${name}** — ${id}; ${tier}; ${status}; state v${version}; updated round ${updatedRound}${projection}`;
  const hasState = state.stance || state.established.length || state.contested.length || state.open.length || state.facts.length || state.files.length;
  if (!hasState) return `${header}\n  (no state content)`;
  const body = renderMyStateMarkdown(state).split("\n").map((line) => `  ${line}`).join("\n");
  return `${header}\n${body}`;
}

export function buildAgentStatesContext(participantStates) {
  if (!Array.isArray(participantStates) || participantStates.length === 0) {
    return "\n## Current Agent States\n_(No current state snapshots available.)_";
  }
  const body = participantStates.map(formatAgentStateSnapshot).join("\n\n");
  // Same 4 kB bound as the synthesis path's Agent States block (audit C1/4.1) —
  // the two blocks share a name and content but previously had different bounds.
  const capped = body.length > 4000 ? `${body.slice(0, 4000)}\n…[further agent states omitted — see DB]` : body;
  return `\n## Current Agent States\n\n_These are bounded, per-agent projections, not a shared transcript. Attribute every state claim to its named holder._\n${delimitContext(capped, "AGENT_STATES")}`;
}

export function buildRoundSummarySystem(orchestratorConfig = {}) {
  const band = getSummaryBand(orchestratorConfig);
  return `You are a thorough deliberation clerk. ${band.words} words. Sentence style, human-readable, concise but thorough. Preserve numbers verbatim — do not round or invent. Never emit vec: traces.

${getSummaryGuidance(orchestratorConfig)}`;
}

export function filterRoundSummaryContributions(contributions = []) {
  return contributions.filter((c) => {
    if (c.type === "pass") return false;
    if (!SUMMARY_TYPES.has(c.type)) return false;
    if (c.type === "evidence_response" && !(c.tool_calls && c.tool_calls.length > 0)) return false;
    return true;
  });
}

export function buildRoundSummaryUser(round, state, participantStates = [], orchestratorConfig = {}, opts = {}) {
  const contribCount = round.contributions.length;
  const summaryContributions = filterRoundSummaryContributions(round.contributions);
  // Style-driven budget and word band (audit O1/O7/Step 6): the summaryStyle
  // option changes what the clerk sees, not just what it is told to prefer.
  const policy = orchestratorContextPolicy(orchestratorConfig, "summary");
  const band = getSummaryBand(orchestratorConfig);

  // Build reflection outcome map and format contributions, budgeted explicitly:
  // select by evidence strength, emit chronologically, cap each line (audit C1/4.1).
  const reflectionMap = buildReflectionMap(round.contributions);
  const CONTRIB_BUDGET = policy.budget;
  const scored = summaryContributions.map((c) => {
    const s = String(c.content ?? "").toLowerCase();
    const strength = s.includes("strength: strong") ? 3
      : ((c.tool_calls && c.tool_calls.length > 0) || s.includes("strength: weak")) ? 2
      : s.includes("inconclusive") ? 1 : 0;
    return { c, line: truncate(formatContribution(c, reflectionMap), 1200), strength };
  });
  const picked = new Set();
  let used = 0;
  for (const item of [...scored].sort((a, b) => b.strength - a.strength)) {
    if (used + item.line.length > CONTRIB_BUDGET) continue;
    used += item.line.length;
    picked.add(item.c);
  }
  const omittedCount = scored.length - picked.size;
  const formattedContributions = scored
    .filter((item) => picked.has(item.c))
    .map((item) => item.line)
    .join("\n\n") +
    (omittedCount > 0 ? `\n\n…[${omittedCount} further contribution(s) omitted — states + evidence signals retained]` : "");

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
    ? `\n## Evidence / Tool Signals (do not invent — use only if cited)\n${evidenceContribs.slice(0, 6).map(c => `- [#${c.id}] ${c.participant_id}: ${truncate(c.content ?? "", 350)}${c.tool_calls ? ` [tools: ${c.tool_calls.map(t=>t.tool).join(',')}]` : ""}`).join("\n")}`
    : "";

  const stateHint = buildAgentStatesContext(participantStates);

  // Round-position awareness, reused verbatim from the agent-side helper so the
  // clerk adapts emphasis exactly as agents do (audit O9/Step 5).
  const maxRounds = Number.isFinite(opts.maxRounds) && opts.maxRounds > 0 ? opts.maxRounds : null;
  const roundContextLine = maxRounds
    ? `\nRound: ${buildRoundContext(round.number ?? 1, maxRounds)}\n`
    : "";
  // Participant roster: id + activity only, never tier — seniority plays no
  // part in orchestrator decisions.
  const roster = Array.isArray(opts.roster) ? opts.roster.filter((p) => p && p.id) : [];
  const rosterBlock = roster.length > 0
    ? `\n## Participants (activity)\n${roster.map((p) => `- ${sanitizeForDisplay(String(p.id), 60)} — ${Number(p.contributions_count ?? 0)} contributions${p.status === "passed" ? " [passed]" : ""}`).join("\n")}\n`
    : "";
  // State-of-Play excerpt so "newly established vs already carried" is
  // decidable from prior-round outcomes, not just positions (audit O9/Step 5).
  const sopExcerpt = opts.stateOfPlay
    ? `\n## State of Play (prior rounds — what was already established)\n${delimitContext(sanitizeForDisplay(String(opts.stateOfPlay), 600), "PRIOR_STATE_OF_PLAY")}\n`
    : "";
  // Turn requests with priorities: the clerk should note pending procedural
  // state, not just substantive positions (audit O9/Step 5).
  const turnRequests = Array.isArray(opts.turnRequests) ? opts.turnRequests : [];
  const requestsBlock = turnRequests.length > 0
    ? `\n## Turn Requests (for next round)\n${turnRequests.slice(0, 8).map((r) => `- ${sanitizeForDisplay(String(r.participant_id ?? "?"), 60)} P${Number(r.priority) || "?"}: ${sanitizeForDisplay(String(r.reason ?? ""), 120)}`).join("\n")}\n`
    : "";

  // Detect mode for summary shape
  const isCodeRound = formattedContributions.includes("file=") || formattedContributions.includes("```") || (state.tags || []).some(t => /engineering|code|programming/i.test(t));

  return hasSubstantiveContent
    ? `You are a thorough deliberation clerk. Summarize round ${round.number || "?"} in ${band.words} words — sentence style, human-readable first. Concise but thorough; preserve nuance, don't yap. Preserve numbers verbatim — do not round or invent.

## Question
${state.question || "(no question provided)"}
${roundContextLine}${rosterBlock}${sopExcerpt}
## Round ${round.number || "?"} Contributions
${formattedContributions}
${evidenceHint}${requestsBlock}${stateHint}

## Output — 4-5 bullets, each 1-3 sentences (human-readable, then auditable):

- **Established:** What gained support this round, with holder [#id] and why it matters (1-2 sentences)
- **Contested:** What remains disputed — name holders and their distinct positions [#id]; map the spectrum, don’t collapse to “disagreement”
- **Evidence:** Tool or vec-grounded evidence introduced (Source or [#id] with Strength: strong/weak/inconclusive); or “None — no new evidence this round” — never emit vec: / vec round traces, use State-of-Play or [#id]
- **Open:** Unresolved questions and what would resolve them (missing evidence / decision needed)
${isCodeRound ? `- **Code/Files:** Files touched or proposed (file=src/...), diffs status, and test/verification notes` : ""}

Rules: Agent States are remembered positions and standing context, not independent evidence. Attribute them to the named holder. Use uncited state only as context; place it under Evidence only when an explicit Source: or [#id] resolves to a listed contribution or tool signal. Distinguish newly established support from claims already carried in state, and do not add a separate Agent States bullet. Cite [#id] once per bullet when attributing (grouped, not per clause). Keep Contested holders explicit. Evidence must distinguish “None” from “weak/inconclusive”. Never emit vec: / vec round traces — use [#id] or State-of-Play. Preserve numbers verbatim — do not round, estimate, or invent figures not in contributions. Concise but thorough.`
    : `Summarize this deliberation round. The round contained ${contribCount} contribution(s) but no substantive positions were staked.

## Question
${state.question || "(no question provided)"}
${roundContextLine}${rosterBlock}
## Round ${round.number || "?"}
Contribution types: ${round.contributions.map((c) => c.type).join(", ")}
Turn requests: ${round.turn_requests.length}
${evidenceHint}${stateHint}

## Instructions
Provide ${band.words} word summary with 4-5 bullets (Established / Contested / Evidence / Open / Code if applicable) noting no substantive deliberation but mentioning contribution types and any turn requests. Agent States are remembered positions and standing context, not independent evidence; attribute them to their named holder and do not add a separate Agent States bullet. Use uncited state only as context, and place it under Evidence only when an explicit Source: or [#id] resolves to a listed contribution or tool signal. Sentence style, human-readable. Preserve numbers verbatim.`;
}

/**
 * Generates a summary for a completed round using LLM-based summarization.
 * The orchestrator path retries empty responses; if the LLM still yields no
 * text, degrades to a deterministic contributions digest instead of throwing —
 * one flaky response must not kill the whole deliberation.
 */
export async function summarizeRound(round, state, promptOrchestrator, getHighestTierModel, getFallbackModel, participantStates = [], orchestratorConfig = {}, summaryOpts = {}) {
  const contribCount = round.contributions.length;
  if (contribCount === 0) return "No contributions this round.";

  // Try primary model, then fallback
  const model = getHighestTierModel() ?? (getFallbackModel ? getFallbackModel() : null);
  if (!model) throw new Error("No model available for semantic summary — check model assignment");

  const summaryContributions = filterRoundSummaryContributions(round.contributions);
  const prompt = buildRoundSummaryUser(round, state, participantStates, orchestratorConfig, summaryOpts);
  const semanticSummary = await promptOrchestrator(buildRoundSummarySystem(orchestratorConfig), model, prompt, "summary");

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

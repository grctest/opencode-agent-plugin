import { getConfig } from "./config.js";
import { truncate, truncateAtSentence } from "./shared.js";
import { Logger, extractErrorInfo } from "./logger.js";
import { SUBSTANTIVE_TYPES } from "./utils/contribution-types.js";
import { renderMyStateMarkdown, STATE_PATCH_CAPS } from "./state-patch.js";
import { sanitizeForPrompt } from "./utils/sanitize.js";
import { delimitContext, escapeDelimiters } from "./prompts/delimiters.js";
import { getSummaryGuidance, orchestratorContextPolicy, getSummaryBand, getTurnOrderGuidance, ORCHESTRATOR_SUMMARY_ALWAYS, ORCHESTRATOR_SUMMARY_CODE_BULLET } from "./orchestrator/models.js";
import { incrementKeyedCounter, recordLatency, recordMeetingCall, recordMeetingLatency } from "./metrics.js";
import { buildRoundContext } from "./prompts/blocks.js";
import { readSoPSectionItems, SOP_SECTIONS } from "./state-of-play.js";
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
 * Includes participant ID + display NAME, contribution type, full content, and any reflection outcomes.
 *
 * The name is rendered with the id because the clerk contract asks the clerk to
 * pair every [#id] with the holder's NAME in its bullets: asking for a name the
 * model must look up two hops away (id → roster → name) under transcript
 * pressure produces raw ids or invented names (the B2 lesson — structure binds
 * where prose rules don't). The name comes in with the roster (round-service
 * threads `p.config.name`); absent, fall back to the raw id as before.
 */
export function formatContribution(c, reflectionMap = new Map(), nameMap = null) {
  const typeTag = c.type.toUpperCase();
  const rawId = String(c.participant_id ?? "?");
  const name = sanitizeForDisplay(String(nameMap?.get?.(rawId) ?? ""), 60);
  const holder = name && name !== rawId ? `${name} (${rawId})` : rawId;
  const lines = [`- [#${c.id}] ${holder} [${typeTag}]: ${c.content}`];
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
  const category = safeStateText(entry?.category ?? entry?.tier, 40) || "unknown";
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
  const header = `- **${name}** — ${id}; ${category}; ${status}; state v${version}; updated round ${updatedRound}${projection}`;
  const hasState = state.stance || state.established.length || state.contested.length || state.open.length || state.facts.length || state.files.length;
  if (!hasState) return `${header}\n  (no state content)`;
  const body = renderMyStateMarkdown(state).split("\n").map((line) => `  ${line}`).join("\n");
  return `${header}\n${body}`;
}

export function buildAgentStatesContext(participantStates) {
  if (!Array.isArray(participantStates) || participantStates.length === 0) {
    return "\n## Current Agent States\n_(No current state snapshots available.)_";
  }
  // Per-agent truncation: never cut a snapshot in half. Include whole agent
  // blocks until the 4 kB budget is exhausted, then note the omitted agents.
  const blocks = participantStates.map(formatAgentStateSnapshot);
  let body = "";
  const included = [];
  for (const b of blocks) {
    const candidate = body ? `${body}\n\n${b}` : b;
    if (candidate.length <= 4000) {
      body = candidate;
      included.push(true);
    } else {
      included.push(false);
    }
  }
  const omitted = blocks.length - included.filter(Boolean).length;
  if (omitted > 0) {
    body = `${body}\n\n…[${omitted} further agent state(s) omitted — see DB]`;
  }
  if (!body) body = blocks[0]?.slice(0, 4000) ?? "";
  return `\n## Current Agent States\n\n_These are bounded, per-agent projections, not a shared transcript. Attribute every state claim to its named holder._\n${delimitContext(body, "AGENT_STATES")}`;
}

export function buildRoundSummarySystem(orchestratorConfig = {}, maxRounds = null) {
  const band = getSummaryBand(orchestratorConfig);
  return `You are a thorough deliberation clerk. ${band.words} words. Sentence style, human-readable, concise but thorough. Preserve numbers verbatim — do not round or invent. Never emit vec: traces.

${getSummaryGuidance(orchestratorConfig, maxRounds)}`;
}

export function filterRoundSummaryContributions(contributions = []) {
  return contributions.filter((c) => {
    if (c.type === "pass") return false;
    if (!SUMMARY_TYPES.has(c.type)) return false;
    if (c.type === "evidence_response" && !(c.tool_calls && c.tool_calls.length > 0)) return false;
    return true;
  });
}

// Peer engagement regex: plain `[#id]` citations, tolerant of legacy `[#T{id}]`
// thread cites in STORED meeting prose (the deleted forum side-channel; kept so
// old contributions still count as engagement without resurrecting anything).
const PEER_CITATION_RE = /\[#T?\d+\]/;

/**
 * P7 — Citation engagement check: returns plain (non-response) contributions
 * that contain no peer [#id] citation. Response types (query/evidence/critique/
 * perspective/summoned) are excluded — they are inherently peer-engaged by
 * construction. Passes and vote responses are excluded as non-substantive.
 */
export function findUncitedPlainContributions(contributions = []) {
  return contributions.filter((c) => {
    if (c.type === "pass" || c.type === "vote_response") return false;
    if (c.type !== "contribution" && !["propose", "refine", "support", "synthesize", "question"].includes(c.type)) return false;
    return !PEER_CITATION_RE.test(String(c.content ?? ""));
  });
}

// N8 — engagement metrics the clerk check and the artifact both read. A
// coverage number that is not computed is a number nobody can improve: the
// 1355a723 audit measured 0.929 coverage, 50% peer-uncited plain
// contributions and 13 self-cites, and none of it was in force anywhere.
const PLAIN_TYPES = new Set(["contribution", "propose", "refine", "support", "synthesize", "question"]);

/**
 * Peer-engagement ledger for a set of contributions: how many plain
 * contributions engage no peer, how many citations point at the author, and
 * how much of the weave the artifact actually cites.
 * @param {Array} weave
 * @param {string} [artifactText] when given, coverage is measured against it
 * @returns {{plain_contributions: number, peer_uncited: number, self_cites: number, coverage: number, uncited_ids: number[]}}
 */
export function computeEngagementMetrics(weave = [], artifactText = "") {
  const plain = weave.filter((c) => PLAIN_TYPES.has(c.type));
  const uncited = findUncitedPlainContributions(plain);
  let selfCites = 0;
  for (const c of weave) {
    for (const m of String(c.content ?? "").matchAll(/\[#(\d+)\]/g)) {
      if (String(m[1]) === String(c.id)) selfCites++;
    }
  }
  const counted = weave.filter((c) => c.type !== "pass");
  const covered = artifactText
    ? new Set([...artifactText.matchAll(/\[#(\d+)\]/g)].map((m) => m[1]))
    : null;
  const uncitedIds = covered
    ? counted.filter((c) => !covered.has(String(c.id))).map((c) => Number(c.id))
    : [];
  return {
    plain_contributions: plain.length,
    peer_uncited: uncited.length,
    self_cites: selfCites,
    coverage: covered && counted.length > 0
      ? Math.round(((counted.length - uncitedIds.length) / counted.length) * 1000) / 1000
      : null,
    uncited_ids: uncitedIds,
  };
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
  // id → display NAME for the contribution lines (the roster threads it;
  // Agent-State snapshots fill gaps for seats the roster lost). The clerk is
  // asked to pair every [#id] with the holder's NAME, so the name must be
  // resolvable on-screen — a two-hop lookup under transcript pressure renders
  // raw ids or invented names instead.
  const nameMap = new Map();
  for (const p of Array.isArray(opts.roster) ? opts.roster : []) {
    if (p?.id && p?.name) nameMap.set(String(p.id), String(p.name));
  }
  for (const s of Array.isArray(participantStates) ? participantStates : []) {
    if (s?.id && s?.name && !nameMap.has(String(s.id))) nameMap.set(String(s.id), String(s.name));
  }
  const CONTRIB_BUDGET = policy.budget;
  const scored = summaryContributions.map((c) => {
    const s = String(c.content ?? "").toLowerCase();
    const strength = s.includes("strength: strong") ? 3
      : ((c.tool_calls && c.tool_calls.length > 0) || s.includes("strength: weak")) ? 2
      : s.includes("inconclusive") ? 1 : 0;
    return { c, line: truncateAtSentence(formatContribution(c, reflectionMap, nameMap), 1200), strength };
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
    ? `\nRound: ${buildRoundContext(round.number ?? 1, maxRounds, { hasPriorContributions: true, settledCount: opts.settledCount })}\n`
    : "";
  // Participant roster: id + activity only, never category — categories play no
  // part in orchestrator decisions.
  const roster = Array.isArray(opts.roster) ? opts.roster.filter((p) => p && p.id) : [];
  // Orchestrator-only turn-order override: the summary call is the
  // orchestrator's single LLM call per round, so the order for next round
  // travels with it instead of costing a second planning call. The order the
  // orchestrator set LAST round stands until it changes it — this is the
  // orchestrator's decision, and the default is only what happens when it
  // makes none.
  //
  // The wording matters: the previous version said "default rotation stands…
  // omit it to keep the default" in three places (here, the tool description
  // and the architecture doc), and the orchestrator therefore almost never
  // acted — in the recorded 10-round meeting the same participant opened every
  // round, taking the steering hint and the opening duties each time. The
  // order is the orchestrator's to set; the block now says so, tells it WHEN to
  // set one, and shows it the speaking order so the pattern is visible
  // (audit D).
  const turnOrderBlock = roster.length > 0
    ? `\n## Next-round turn order (orchestrator's call)\nYou decide who speaks next. The order you set last round stands until this round's evidence warrants a change — call loom_set_turn_order ONCE with the full ordered participant ids (from ## Participants below; unknown ids are dropped, missing seats appended). Set one whenever the roster shows a voice that has spoken least, a claim that needs a defender next, or a position that must be tested before the room converges. Order preference: ${getTurnOrderGuidance(orchestratorConfig)}\n`
    : "";
  const rosterBlock = roster.length > 0
    ? `\n## Participants (activity)\n${roster.map((p) => {
      // The speaking flags make the round's order visible to the only agent
      // that can act on it (audit D): "spoke first" is the framing slot, and
      // it also takes the steering hint every round.
      const spoke = p?.spoke_this_round === true ? " · spoke this round" : "";
      const first = p?.spoke_first === true ? " · spoke FIRST this round" : "";
      return `- ${sanitizeForDisplay(String(p.id), 60)} — ${Number(p.contributions_count ?? 0)} contributions${spoke}${first}${p.status === "passed" ? " [passed]" : ""}`;
    }).join("\n")}\n`
    : "";
  // State-of-Play excerpt so "newly established vs already carried" is
  // decidable from prior-round outcomes, not just positions (audit O9/Step 5).
  // Whole ITEMS, not a character slice: the SoP opens with `## Question` and
  // `## Tags`, so a 600-char cut usually carried the question and cut the
  // consensus section mid-bullet — the clerk then judged "newly established"
  // against a half-line that read as complete (audit C2). The same
  // whole-unit convention the transcript builder uses.
  const sopExcerpt = opts.stateOfPlay
    ? (() => {
        const items = [
          ...readSoPSectionItems(opts.stateOfPlay, SOP_SECTIONS.agreed).slice(0, 4),
          ...readSoPSectionItems(opts.stateOfPlay, SOP_SECTIONS.disagreements).slice(0, 2),
        ]
          .map((item) => `- ${sanitizeForDisplay(item.replace(/\n/g, " ").trim(), 200)}`)
          .filter((line) => line !== "- ");
        if (items.length === 0) return "";
        return `\n## State of Play (prior rounds — what was already established)\n${delimitContext(items.join("\n"), "PRIOR_STATE_OF_PLAY")}\n`;
      })()
    : "";
  // P7 — Citation engagement: report plain contributions that have no peer
  // [#id] citation so the clerk can flag isolated contributions.
  const uncitedPlains = findUncitedPlainContributions(round.contributions);
  const uncitedBlock = uncitedPlains.length > 0
    ? `\n## Peer-Uncited Plain Contributions (P7 — no [#id] engagement)\n${uncitedPlains.map((c) => {
      const name = String(nameMap.get(String(c.participant_id ?? "")) ?? "");
      const holder = name && name !== String(c.participant_id ?? "") ? `${name} (${c.participant_id ?? "?"})` : String(c.participant_id ?? "?");
      return `- [#${c.id}] ${sanitizeForDisplay(holder, 60)}: ${sanitizeForDisplay(truncate(String(c.content ?? ""), 200), 200)}`;
    }).join("\n")}\n\n_These contributions engage no peer via [#id]. Note them in the summary so the room can address the isolation._\n`
    : "";

  // Detect mode for summary shape
  const isCodeRound = formattedContributions.includes("file=") || formattedContributions.includes("```") || (state.tags || []).some(t => /engineering|code|programming/i.test(t));

  return hasSubstantiveContent
    ? `You are a thorough deliberation clerk. Summarize round ${round.number || "?"} in ${band.words} words — sentence style, human-readable first. Concise but thorough; preserve nuance, don't yap. Preserve numbers verbatim — do not round or invent.

## Question
${state.question || "(no question provided)"}
${roundContextLine}${rosterBlock}${turnOrderBlock}${sopExcerpt}
## Round ${round.number || "?"} Contributions
${formattedContributions}
${uncitedBlock}${evidenceHint}${stateHint}

## Output — ${band.shape}

${band.bullets.join("\n")}
${isCodeRound && !band.bullets.some((b) => b.includes("Code/Files")) ? ORCHESTRATOR_SUMMARY_CODE_BULLET : ""}

${ORCHESTRATOR_SUMMARY_ALWAYS}

Rules: Agent States are remembered positions and standing context, not independent evidence. Attribute them to the named holder. Use uncited state only as context; place it under Evidence only when an explicit Source: or [#id] resolves to a listed contribution or tool signal. Distinguish newly established support from claims already carried in state, and do not add a separate Agent States bullet. Pair every [#id] with the holder's NAME at its first mention in the bullet (Ada [#9] — the contribution lines above carry both); grouped bare repeats are fine. Keep Contested holders explicit. Evidence must distinguish “None” from “weak/inconclusive”. Never emit vec: / vec round traces — use [#id] or State-of-Play. Preserve numbers verbatim — do not round, estimate, or invent figures not in contributions. When this round carries two or more mutually overlapping thresholds, projections, or repeated numeric tables, consolidate under Established/Contested: name the single live version (or the tiered ladder they compose) and mark older ones superseded by [#id] — do not list four gates as if parallel. Concise but thorough.`
    : `Summarize this deliberation round. The round contained ${contribCount} contribution(s) but no substantive positions were staked.

## Question
${state.question || "(no question provided)"}
${roundContextLine}${rosterBlock}${turnOrderBlock}
## Round ${round.number || "?"}
Contribution types: ${round.contributions.map((c) => c.type).join(", ")}
${evidenceHint}${stateHint}

## Instructions
Provide a ${band.words} word summary — 2-3 bullets, one line each — noting that no substantive deliberation happened and listing the contribution types. Agent States are remembered positions and standing context, not independent evidence; attribute them to their named holder and do not add a separate Agent States bullet. Use uncited state only as context, and place it under Evidence only when an explicit Source: or [#id] resolves to a listed contribution or tool signal. Sentence style, human-readable. Preserve numbers verbatim.`;
}

/**
 * Generates a summary for a completed round using LLM-based summarization.
 * The orchestrator path retries empty responses; if the LLM still yields no
 * text, degrades to a deterministic contributions digest instead of throwing —
 * one flaky response must not kill the whole deliberation.
 */
export async function summarizeRound(round, state, promptOrchestrator, getDefaultModel, getFallbackModel, participantStates = [], orchestratorConfig = {}, summaryOpts = {}) {
  const contribCount = round.contributions.length;
  if (contribCount === 0) return "No contributions this round.";
  const maxRounds = Number.isFinite(summaryOpts?.maxRounds) && summaryOpts.maxRounds > 0
    ? summaryOpts.maxRounds
    : (Number.isFinite(state?.max_rounds) && state.max_rounds > 0 ? state.max_rounds : null);

  // Try primary model, then fallback
  const model = getDefaultModel() ?? (getFallbackModel ? getFallbackModel() : null);
  if (!model) throw new Error("No model available for semantic summary — check model assignment");

  const summaryContributions = filterRoundSummaryContributions(round.contributions);
  const prompt = buildRoundSummaryUser(round, state, participantStates, orchestratorConfig, summaryOpts);
  const summaryStart = Date.now();
  const semanticSummary = await promptOrchestrator(buildRoundSummarySystem(orchestratorConfig, maxRounds), model, prompt, "summary");
  const summaryMs = Date.now() - summaryStart;
  incrementKeyedCounter("llm_calls_by_type", "summary");
  recordLatency("summary_ms", summaryMs);
  try {
    const mid = state?.id ?? null;
    if (mid) { recordMeetingCall(mid, "summary"); recordMeetingLatency(mid, "summary_ms", summaryMs); }
  } catch {}

  if (semanticSummary && semanticSummary.trim().length > 0) {
    return semanticSummary.trim();
  }

  // Degrade gracefully: keep the round auditable with a deterministic digest
  // rather than failing the meeting over a transient empty LLM response.
  const digestBullets = summaryContributions.slice(0, 10).map((c) =>
    `- [#${c.id}] ${c.participant_id} [${String(c.type).toUpperCase()}]: ${truncate(c.content ?? "", 300)}`
  );
  if (digestBullets.length === 0) {
    digestBullets.push(`- No substantive positions staked (${contribCount} contribution(s): ${round.contributions.map((c) => c.type).join(", ")})`);
  }

  summarizerLogger.warn(
    "summary_degraded",
    `Round ${round.number || "?"} LLM summary empty after retries — using deterministic digest`,
    { round: round.number, contribCount },
  );

  return ["(Degraded summary — LLM returned empty response)", ...digestBullets].join("\n");
}

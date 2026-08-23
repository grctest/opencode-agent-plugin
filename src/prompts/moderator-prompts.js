import { sanitizeForDisplay } from "../utils/sanitize.js";
import { escapeDelimiters, delimitContext } from "./delimiters.js";

 /** Builds a prompt for the moderator to plan turn order for the next round. */
export function buildTurnOrderPrompt(stateOfPlay, roundSummary, turnRequests, participants) {
  const safeStateOfPlay = escapeDelimiters(sanitizeForDisplay(stateOfPlay, 2000));
  const safeRoundSummary = escapeDelimiters(sanitizeForDisplay(roundSummary, 1000));

  const requestsList = turnRequests.map((r) => {
    const p = participants.find((pp) => pp.config.id === r.participant_id);
    const name = p?.config.name ?? r.participant_id;
    const tier = p?.config.tier ?? "mid";
    const hint = r.type ? ` (${r.type})` : "";
    const toolHint = r.hasEvidence ? " [evidence]" : "";
    return `  - ${r.participant_id} (${name}, ${tier}${hint}${toolHint}): Priority ${r.priority} — "${sanitizeForDisplay(r.reason, 100)}"`;
  }).join("\n");

  const participantsList = participants
    .filter((p) => p.status !== "failed")
    .map((p) => {
      const cnt = p.contributions_count ?? 0;
      const didPass = p.status === "passed" ? " [passed last round]" : "";
      const hasReflect = p.reflection ? " [has reflection]" : "";
      return `  - ${p.config.id} (${p.config.name}, ${p.config.tier}, ${cnt} contribs${didPass}${hasReflect})`;
    })
    .join("\n");

  return `You are the turn order planner for a multi-agent deliberation. Favor longer, richer deliberation — give diverse voices room. Avoid starvation.

## Current State of Play
${safeStateOfPlay || "(No state of play yet)"}

## Last Round Summary
${safeRoundSummary || "(First round)"}

## Agent Turn Requests (priority already capped by tier)
${requestsList || "(No requests — use default order)"}

## Active Participants
${participantsList}

## Task
Return a JSON array of participant IDs ordered by who should speak first to push deliberation forward thoroughly.

Ranking doctrine (in order):
1. Strong evidence-backed challenges/requests first — tool output with Strength: strong or [#id] citation signals substance; weak/inconclusive does not outrank a substantive propose
2. Higher priority requests next (intrinsic urgency)
3. Proposals introducing a new distinct option before refinements/supports of an existing one
4. Anti-starvation: anyone who spoke last without new reflection/evidence is demoted one rank
5. Tie-break: (a) who spoke least recently, then (b) seniority principal > senior > mid > junior > civilian

Constraints:
- Include every active participant exactly once
- Consider State of Play to avoid immediate circular re-litigation (same 2 speakers challenge↔challenge without third voice = circular)
- If no requests, return participants in current order

Respond with ONLY a JSON array: ["id1", "id2", "id3"]`;
}

/** Builds a prompt for the moderator to rule on deadlocks, circular arguments, or force convergence. */
export function buildModeratorPrompt(situation, currentRound, maxRounds, totalContributions, recentContributions, previousRulings = [], stateOfPlay = "") {
  const safeSituation = escapeDelimiters(sanitizeForDisplay(situation, 500));
  const contributionsList = delimitContext(recentContributions.map((c) => {
    const budget = (c.type === "challenge" || c.type === "dissent" || c.type === "evidence_response") ? 220 : 140;
    const snippet = c.content ? sanitizeForDisplay(c.content.slice(0, budget)) : "(no content)";
    const evidenceTag = (c.tool_calls && c.tool_calls.length > 0) ? ` [tools:${c.tool_calls.map(t=>t.tool).join(',')}]` : "";
    return `  - [${c.type ?? "?"}] ${c.participant_id ?? "?"}${evidenceTag}: ${snippet}`;
  }).join("\n") || "(none)", "RECENT_CONTRIBUTIONS");

  const relevantRulings = previousRulings.length > 10 ? previousRulings.slice(-10) : previousRulings;
  const rulingsSection = relevantRulings.length > 0
    ? `\n## Your Previous Rulings (for consistency — don’t contradict without new evidence)\n${relevantRulings.map((r, i) => `  ${i + 1}. Round ${r.round}: ${escapeDelimiters(sanitizeForDisplay(r.decision, 120))} → ${escapeDelimiters(sanitizeForDisplay(r.next_speaker, 60))}${r.reason ? ` — ${escapeDelimiters(sanitizeForDisplay(r.reason, 120))}` : ""}`).join("\n")}\n`
    : "";

  const stateOfPlaySection = stateOfPlay
    ? `\n## Current State of Play\n${escapeDelimiters(sanitizeForDisplay(stateOfPlay, 2000))}\n\nUse this to score NEW_INFO: if last round’s points already appear in Agreements/Decisions with no new evidence, NEW_INFO=0. A legitimate dispute has unresolved Disagreements/Open Questions that need more voices.\n`
    : "";

  return `You are the MODERATOR — process governor, not participant. You do not contribute domain opinions. You govern flow. Default bias: KEEP DELIBERATING. Only converge when deliberation is genuinely exhausted — this group prefers thorough over terse.

## Governance Doctrine (longer deliberation default)

Favor thoroughness over speed. The group values dissent and edge cases. Only cut off when NEW_INFO is truly zero.

## Rubric — score 0-2 each

- NEW_INFO: Does last round introduce evidence/tool output or a distinct option not already in State-of-Play Decisions/Agreements? 0=none, 1=one new angle, 2=multiple new evidence/options
- ENTRENCHMENT: Are the same 2 participants exchanging challenge↔challenge/dissent without a third voice or new evidence? 0=diverse, 1=mild repetition, 2=entrenched loop
- COVERAGE: Have ≥70% of active participants contributed meaningfully this round (not just [PASS])? 0=sparse, 1=partial, 2=broad
- DISSENT_DEPTH: Is there substantive unresolved Disagreements/Open Questions that deserve more voices before synthesis? 0=shallow/none, 1=one real dispute, 2=multiple substantive disputes

Ruling policy (bias toward continue):
- converge (next_speaker: synthesize) ONLY if NEW_INFO=0 AND COVERAGE≥1 AND (ENTRENCHMENT≥1 OR DISSENT_DEPTH=0) AND round ≥ minRounds
- break (next_speaker: <active_id>) if ENTRENCHMENT=2 — redirect to the under-heard voice or the holder of the uncovered dissent
- otherwise continue

${rulingsSection}
${stateOfPlaySection}## Situation Flagged by Heuristics
${safeSituation}

## Deliberation State
Round: ${currentRound}/${maxRounds} (minRounds enforced externally — you may still return synthesize, it will be deferred)
Contributions so far: ${totalContributions}
Recent contributions (last up to 7):
${contributionsList}

## Respond With Your Ruling — EXACT FORMAT REQUIRED
<ruling>
decision: <one sentence: continue | redirect to <name> | converge>
next_speaker: <participant_id or "synthesize" or "continue">
reason: <one sentence referencing rubric scores, e.g. "NEW_INFO 0, ENTRENCHMENT 2, COVERAGE 2 — entrenched loop between X and Y without new evidence">
</ruling>

IMPORTANT: Respond ONLY with the <ruling> block. No other text. next_speaker must be one of: continue, synthesize, or an active participant_id. If you return synthesize before minRounds, it will be deferred.`;
}

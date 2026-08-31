import { sanitizeForDisplay } from "../utils/sanitize.js";
import { escapeDelimiters } from "./delimiters.js";

/** Builds a prompt for the turn order planner to order participants for the next round. */
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

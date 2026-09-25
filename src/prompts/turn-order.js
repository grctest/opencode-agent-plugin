import { sanitizeForDisplay } from "../utils/sanitize.js";
import { escapeDelimiters } from "./delimiters.js";
import { getTurnOrderGuidance, orchestratorContextPolicy } from "../orchestrator/models.js";

/** Builds a prompt for the turn order planner to order participants for the next round. */
export function buildTurnOrderPrompt(stateOfPlay, roundSummary, turnRequests, participants, orchestratorConfig = {}) {
  const safeStateOfPlay = escapeDelimiters(sanitizeForDisplay(stateOfPlay, 2000));
  const safeRoundSummary = escapeDelimiters(sanitizeForDisplay(roundSummary, 1000));

  // No tier/seniority anywhere in this prompt by design: tiers are setup-phase
  // labels differentiating persona purpose, and seniority plays no part in
  // turn-order decisions. Ordering is by evidence, urgency, and recency only.
  const requestsList = turnRequests.map((r) => {
    const p = participants.find((pp) => pp.config.id === r.participant_id);
    const name = p?.config.name ?? r.participant_id;
    const hint = r.type ? ` (${r.type})` : "";
    const toolHint = r.hasEvidence ? " [evidence]" : "";
    return `  - ${r.participant_id} (${name}${hint}${toolHint}): Priority ${r.priority} — "${sanitizeForDisplay(r.reason, 100)}"`;
  }).join("\n");

  const participantsList = participants
    .filter((p) => p.status !== "failed")
    .map((p) => {
      const cnt = p.contributions_count ?? 0;
      const didPass = p.status === "passed" ? " [passed last round]" : "";
      const hasPosition = p.state_stance ? " [stance]" : (p.reflection ? " [has reflection]" : "");
      return `  - ${p.config.id} (${p.config.name}, ${cnt} contribs${didPass}${hasPosition})`;
    })
    .join("\n");

  // Policy-driven context composition (audit O1/Step 6): the turnOrderPolicy
  // option changes what the planner sees, not just what it is told to prefer.
  const policy = orchestratorContextPolicy(orchestratorConfig, "turn_order");
  const evidenceBlock = policy.evidenceBlock ? (() => {
    const flagged = (turnRequests || []).filter((r) => r.hasEvidence);
    const keyFacts = String(stateOfPlay || "").split("## Key Facts")[1]?.split("##")[0] ?? "";
    const factLines = keyFacts.split("\n").filter((l) => l.trim().startsWith("-")).slice(0, 3).join("\n");
    const lines = [
      ...flagged.slice(0, 4).map((r) => `  - ${r.participant_id} [evidence]: "${sanitizeForDisplay(r.reason, 200)}"`),
      ...(factLines ? [`  SoP Key Facts:\n${factLines}`] : []),
    ];
    return lines.length > 0 ? `\n## Evidence Signals (evidence_first policy)\n${lines.join("\n")}\n` : "";
  })() : "";
  const recencyBlock = policy.recencyBlock ? (() => {
    const rows = participants
      .filter((p) => p.status !== "failed")
      .map((p) => ({ id: p.config.id, cnt: p.contributions_count ?? 0, passed: p.status === "passed" }))
      .sort((a, b) => a.cnt - b.cnt || String(a.id).localeCompare(String(b.id)));
    return `\n## Participation (quietest first — anti_starvation policy)\n${rows.map((r) => `  - ${r.id} — ${r.cnt} contribs${r.passed ? " [passed]" : ""}`).join("\n")}\n`;
  })() : "";

  return `Respond with ONLY a JSON array of participant IDs, e.g. ["id1", "id2", "id3"].

You are the turn order planner for a multi-agent deliberation. Favor longer, richer deliberation — give diverse voices room. Avoid starvation.

## Current State of Play
${safeStateOfPlay || "(No state of play yet)"}

## Last Round Summary
${safeRoundSummary || "(First round)"}

## Agent Turn Requests (priority 1-10, same scale for every participant)
${requestsList || "(No requests — use default order)"}

## Active Participants
${participantsList}
${evidenceBlock}${recencyBlock}
## Task
Return a JSON array of participant IDs ordered by who should speak first to push deliberation forward thoroughly.

Ranking doctrine (in order):
1. Strong evidence-backed challenges/requests first — tool output with Strength: strong or [#id] citation signals substance; weak/inconclusive does not outrank a substantive propose
2. Higher priority requests next (intrinsic urgency)
3. Proposals introducing a new distinct option before refinements/supports of an existing one
4. Anti-starvation: anyone who spoke last without new reflection/evidence is demoted one rank
5. Tie-break: (a) who spoke least recently, then (b) fewer contributions this meeting, then (c) participant id (lexical, for determinism) — never seniority

Operator behavior: ${getTurnOrderGuidance(orchestratorConfig)}

Constraints:
- Include every active participant exactly once
- Consider State of Play to avoid immediate circular re-litigation (same 2 speakers challenge↔challenge without third voice = circular)
- If no requests, return participants in current order

Respond with ONLY a JSON array: ["id1", "id2", "id3"]`;
}

import { sanitizeForDisplay } from "../utils/sanitize.js";
import { escapeDelimiters, delimitContext } from "./delimiters.js";
import { LENGTH_LIMITS, windowLabel } from "./constants.js";
import { getOrchestratorDecisionSentence } from "../orchestrator/models.js";

export function detectTaskMode(question, tags = []) {
  const q = (question || "").toLowerCase();
  const tagStr = (tags || []).join(" ").toLowerCase();
  const combined = q + " " + tagStr;
  const codeSignals = [
    /\breact\b/, /\bnext\.js\b/, /\btsx\b/, /\btypescript\b/,
    /\bsrc\//, /\.tsx\b/, /\.ts\b/, /\.js\b/, /\.jsx\b/,
    /\bfile\s*=\s*src\//, /\bfile\s*=\s*\w+\//,
    /in this folder/, /in my project/, /how would you.*fix/, /propose.*fix/, /implement\b/, /refactor\b/,
    /\bbug\b/, /\berror\b/, /\bstack\b/, /\brepro\b/, /\brefactor\b/, /\bhook\b/, /\bhydration\b/, /\bdiff\b/, /\btest\b.*\bfile\b/,
    /\bwrite\b.*\bfile\b/, /\bedit\b/, /\bcodebase\b/, /\brepo\b/
  ];
  const hits = codeSignals.filter(rx => rx.test(combined)).length;
  if (hits >= 1 && combined.includes("src/")) return "code-analysis";
  if (hits >= 2) return "code-analysis";
  if (tagStr.includes("engineering") && (q.includes("file") || q.includes("code") || q.includes("project") || q.includes("repo"))) return "code-analysis";
  return "conversational";
}

/** Builds a prompt for synthesizing the final deliberation artifact from all contributions. */
export function buildSynthesisPrompt(question, transcript, participants = [], tags = [], stateOfPlay = "", objections = [], userContext = "", opts = {}) {
  const mode = detectTaskMode(question, tags);
  const isCode = mode === "code-analysis";
  const windowNote = `${windowLabel(opts.contextWindow) ?? "200k"} window`;
  const safeQuestion = escapeDelimiters(sanitizeForDisplay(question, 20000));
  // Large window: 24k transcript budget, no cost cutting — truncations are anti-timeout only
  let safeTranscript = sanitizeForDisplay(transcript, 24000);
  const wasTruncated = transcript && transcript.length > 24000;
  safeTranscript = delimitContext(escapeDelimiters(safeTranscript + (wasTruncated ? "\n…[transcript truncated — earliest rounds summarized, latest rounds fuller; full weave available in State of Play + DB]" : "")), "TRANSCRIPT");
  // No tier anywhere in this prompt by design: tiers are setup-phase labels
  // differentiating persona purpose, and seniority plays no part in synthesis
  // decisions. Activity and standing are what matter.
  const participantsSection = participants.length > 0
    ? `\n## Participants (activity)\n${participants.map((p) => `- ${escapeDelimiters(sanitizeForDisplay(p.config.name, 80))}: ${p.contributions_count} contributions${p.status === "failed" ? " [failed]" : p.status === "passed" ? " [passed late]" : ""}`).join("\n")}\n`
    : "";

  const tagContext = tags?.length > 0 ? escapeDelimiters(tags.join(", ")) : null;

  const stateOfPlaySection = stateOfPlay
    ? `\n## State of Play (Final — PRIMARY source)\n${escapeDelimiters(sanitizeForDisplay(stateOfPlay, 20000))}\n`
    : "";

  const unresolvedObjections = (objections ?? []).filter((o) => o.unresolved);
  // Stale (keyword-overlap, not re-raised) is neither live dissent nor genuinely
  // resolved — keep it out of both buckets and render it distinctly (audit D12).
  const staleObjections = (objections ?? []).filter((o) => !o.unresolved && o.stale);
  const resolvedObjections = (objections ?? []).filter((o) => !o.unresolved && !o.stale);
  const objectionsSection = unresolvedObjections.length > 0
    ? `\n## Unresolved Dissent (map each in Dissenting Views with holder + [#id] — dissent is valuable, not a failure)\n${unresolvedObjections.map((o) => `- ${escapeDelimiters(sanitizeForDisplay(o.content, 600))} (holder: ${escapeDelimiters(sanitizeForDisplay(o.participant_id ?? "unknown", 80))})`).join("\n")}\n`
    : "";
  const resolvedSection = resolvedObjections.length > 0
    ? `\n## Resolved Concerns (do NOT re-list as dissent)\n${resolvedObjections.map((o) => `- ${escapeDelimiters(sanitizeForDisplay(o.content, 600))} (resolved)`).join("\n")}\n`
    : "";
  const staleSection = staleObjections.length > 0
    ? `\n## Stale Concerns (raised earlier, not re-raised — background context, NOT live dissent and NOT resolved)\n${staleObjections.map((o) => `- ${escapeDelimiters(sanitizeForDisplay(o.content, 600))} (stale)`).join("\n")}\n`
    : "";

  // Detect build vs plan for live-edit guidance: explicit flag wins (derived from
  // the effective tools the meeting ran with), tags only as legacy fallback (audit D5).
  const isBuildMode = opts.buildMode ?? (tags || []).some(t => /build|write|edit/i.test(t)) ?? false;
  const buildNote = isCode
    ? (isBuildMode ? " (BUILD mode — live file edits were allowed; note which files were actually written vs proposed)" : " (PLAN mode — read-only: propose diffs; mark live edits as Proposed)")
    : "";
  const modeNote = isCode
    ? `\n## Mode: Code-Analysis${buildNote}\nYou are synthesizing a code collaboration. Include concrete Proposed Fix diffs with file= paths. Novel synthesized fixes are allowed when marked “Proposed — synthesized from [#id]”. If live edits occurred, note file= and verification (tests). Thoroughness welcome — ${windowNote}.\n`
    : `\n## Mode: Conversational (open-ended)\nDissent is fine — do not force a single Decision if deliberation left a spectrum. Prefer mapping positions with evidence — map the spectrum AND commit to the rule that resolves it (Decision Rule below). Thoroughness welcome — ${windowNote}.\n`;

  const userContextSection = userContext
    ? `\n## Original User Context (from the person who asked)\n${delimitContext(escapeDelimiters(sanitizeForDisplay(userContext, 20000)), "USER_CONTEXT")}\n`
    : "";

  const groundingRule = isCode
    ? `1. **Grounding:** Group citations per evidence block — cite once as [#id] or State-of-Play or Source: https://… per block. If you synthesize a novel fix/code not present verbatim, mark it “Proposed — synthesized from [#id]” and keep it. Do not invent file contents not read via tool; if no file was read, qualify as “Proposed (unverified — no tool read)”. Never emit vec: round / vec round / [Round X vec — those are internal retrieval traces. Don’t spam [#id] per sentence; one grouped cite per block. The Agent States block (if present) is positions-only, never evidence — state bullets without a [#id] trail are unattributed positions, not findings.\n`
    : `1. **Grounding:** Group citations per paragraph/block — cite once as [#id] or State-of-Play or Source: https://… per block. If you synthesize a novel conclusion, mark it “Proposed — synthesized from [#id]” and keep it. Do not invent numbers/dates unsupported by transcript/State-of-Play. Do not reference files, diffs, or code you have not seen in the transcript. Never emit vec: / vec round — use [#id] or State-of-Play instead. Don’t spam citations. The Agent States block (if present) is positions-only, never evidence — state bullets without a [#id] trail are unattributed positions, not findings.\n`;

  // Section budgets derive from LENGTH_LIMITS (audit X4/3.6) — the prompt text
  // and the constants cannot drift apart again.
  const L = LENGTH_LIMITS;
  const lengthSection = isCode
    ? `## Length — concise but thorough (${windowNote} — verbose welcome, yapping not)
- Executive Summary: ${L.synthesisExecutive} words — human-first, no citations, plain narrative (concise)
- Decision / Synthesis: ${L.synthesisDecision} words — direct answer OR spectrum table if no consensus; group citations per block; table cells concise (Evidence 30-35w max + one cite, Tradeoff 30-35w max)
- Reasoning: ${L.synthesisReasoning} words — 4-8 bullets, who argued what + evidence + tradeoff, group cites; deduplicate vs Decision table (map vs narrative)
- Proposed Fix: ${L.synthesisProposedFix} words — Files: \`path\` + diffs \`\`\`tsx file=src/...\`\`\` + why, mark Proposed if synthesized, note live edits vs proposals, include tests
- Action Items: ${L.synthesisActionItems} words — verbs with owners or “proposed: X → handoff to @role” + block cites; distribute owners, max 2 per holder (may be “None — see Proposed Fix”)
- Open Questions: ${L.synthesisOpenQuestions} words — why remains + suggested probe
- Confidence: ${L.synthesisConfidence} words — one word + rubric justification (High may have dissent if bounded and grounded)
Total 1600-3500 words welcome; concise but thorough — preserve numbers/code verbatim, no invented figures.\n`
    : `## Length — concise but thorough (${windowNote} — verbose welcome, yapping not)
- Executive Summary: ${L.synthesisExecutive} words — human-first, no citations, plain narrative (concise, scannable)
- Decision / Synthesis: ${L.synthesisDecision} words — one paragraph OR spectrum table if no consensus; group citations per block; table cells concise (Evidence 30-35w + one grouped cite, Tradeoff 30-35w)
- Reasoning: ${L.synthesisReasoning} words — 4-8 bullets, each who argued what + evidence + tradeoff, group cites; DEDUPLICATE vs Decision — Decision maps positions, Reasoning explains why they emerged/diverged, do not copy-paste numbers verbatim thrice
- Action Items: ${L.synthesisActionItems} words — verbs with owners or “proposed: X → handoff to @role” + block cites; distribute owners (max 2 per holder unless justified)
- Open Questions: ${L.synthesisOpenQuestions} words — why remains + suggested probe/next step
- Confidence: ${L.synthesisConfidence} words — one word + rubric justification
Total 1500-3500 words welcome; concise but thorough — preserve numbers verbatim, no invented figures.\n`;

  const requiredSections = isCode
    ? `## Required Sections — output these exact headings in this order, even if empty (write “None” where appropriate)

## Executive Summary
Human-first plain narrative (no citations). 2-4 sentences: what was asked, what the deliberation found, and the key tradeoff/next step. For code: also state files touched and whether live edits occurred.

## Decision
If convergent: one-paragraph direct answer citing key [#id]s (grouped per block, no vec: leak). If divergent / open-ended: write “No single decision — spectrum below” then map options in a table | Option | Holder(s) | Evidence (30-35w + one grouped cite) | Tradeoff (30-35w) | — still cite [#id]s per option. Tables MUST include the GFM delimiter row as the second line (| --- | --- | --- | --- |) or they will not render. Preserve numbers verbatim. Dissent does not force a decision. Keep cells concise, not paragraphs.

## Decision Rule
Required when there is no single Decision above. State the rule that WILL resolve the spectrum — Trigger, Order, Owner, Date, Default, Re-pricing. If a single Decision was reached above, write "None — decided above."

**Ladder atomicity:** Trigger, order, owner, full date, and re-pricing conditions form ONE atomic object — the vote that adopts a ladder assigns all five or adopts nothing. Never record a partial ladder (a trigger with no owner, or an owner with no date, is not a rule).

- **Trigger:** cite the LATEST consolidated thresholds with [#id] refs to the consolidating contribution. If the room resolved conflicting thresholds into a single gate or a tiered structure, record the resolved form — do NOT blend earlier proposals. If no consolidation happened, record the disagreement explicitly ("threshold contested: [#id] says X, [#id] says Y — unresolved").
- **Order:** the sequence of steps or checks in the ladder, in the order they fire.
- **Owner:** a specific named participant from the Participants list who evaluates the trigger — or "unassigned — owner TBD". "Proposed:" is not an owner.
- **Date:** the full date (year included) by which the decision must be made.
- **Default:** what happens if the trigger never fires.
- **Re-pricing:** what new information changes the default before the trigger.

## Reasoning
4-8 bullets or short paragraphs. Each bullet references who argued what and on what evidence. Show tradeoffs and synthesis between views. Group cites per block. DEDUPLICATE: do not repeat Decision table numbers verbatim; reference rows (“see Position B Evidence”) and explain divergence/synthesis. Preserve numbers verbatim only when new.

## Proposed Fix
Files involved + diffs with \`\`\`tsx file=src/...\`\`\` blocks. Mark any novel synthesized snippet “Proposed — synthesized from [#id]”. Note live edits (BUILD) vs proposals (PLAN). Preserve code verbatim; do not invent file contents not read.

## Action Items
- {verb} {what} — owner: {name or “proposed: X → handoff to @role”} — block cite [#id]
(Empty → “None — see Proposed Fix.”) Distribute owners; max 2 per holder.

## Open Questions
- {question that remains} — why it remains (missing evidence / unresolved tradeoff) — how to resolve`
    : `## Required Sections — output these exact headings in this order, even if empty (write “None” where appropriate)

## Executive Summary
Human-first plain narrative (no citations). 2-4 sentences: what was asked, what the deliberation found, and the key open tradeoff. Write for a busy human scanning — concise.

## Decision
If convergent: one-paragraph direct answer citing key [#id]s (grouped per block, never vec:). If divergent / open-ended: write “No single decision — spectrum below” then present a table | Position | Holder(s) | Evidence (30-35w max + one grouped cite) | Tradeoff (30-35w max) | — still cite [#id]s per row. Tables MUST include the GFM delimiter row as the second line (| --- | --- | --- | --- |) or they will not render. Preserve numbers verbatim. Do not force consensus; mapping the disagreement is a valid outcome. Keep cells concise.

## Decision Rule
Required when there is no single Decision above. State the rule that WILL resolve the spectrum — Trigger, Order, Owner, Date, Default, Re-pricing. If a single Decision was reached above, write "None — decided above."

**Ladder atomicity:** Trigger, order, owner, full date, and re-pricing conditions form ONE atomic object — the vote that adopts a ladder assigns all five or adopts nothing. Never record a partial ladder (a trigger with no owner, or an owner with no date, is not a rule).

- **Trigger:** cite the LATEST consolidated thresholds with [#id] refs to the consolidating contribution. If the room resolved conflicting thresholds into a single gate or a tiered structure, record the resolved form — do NOT blend earlier proposals. If no consolidation happened, record the disagreement explicitly ("threshold contested: [#id] says X, [#id] says Y — unresolved").
- **Order:** the sequence of steps or checks in the ladder, in the order they fire.
- **Owner:** a specific named participant from the Participants list who evaluates the trigger — or "unassigned — owner TBD". "Proposed:" is not an owner.
- **Date:** the full date (year included) by which the decision must be made.
- **Default:** what happens if the trigger never fires.
- **Re-pricing:** what new information changes the default before the trigger.

## Reasoning
4-8 bullets or short paragraphs. Each bullet references who argued what and on what evidence. Show tradeoffs and how views synthesize or diverge. Group cites per block. DEDUPLICATE vs Decision: Decision maps positions, Reasoning explains why they emerged/diverged — do not copy-paste Evidence numbers thrice; reference Decision rows when possible.

## Action Items
- {verb} {what} — owner: {name or “proposed: X → handoff to @role”} — block cite [#id]
(Empty → “None — deliberation surfaced no actionable consensus; see Open Questions for next step.”) Distribute owners; max 2 per holder unless justified.

## Open Questions
- {question that remains} — why it remains (missing evidence / unresolved tradeoff) — suggested next probe or experiment`;

  return `You are the synthesis auditor. The deliberation is complete. Produce the final artifact — human-readable FIRST, then citation-grounded detail. Thoroughness welcome; dissent is valuable, not a failure.
${modeNote}
## Original Question
${safeQuestion}
${tagContext ? `\n## Tags (topic)\n${tagContext}\n` : ""}
${userContextSection}${stateOfPlaySection}${objectionsSection}${resolvedSection}${staleSection}
## Deliberation Transcript (supporting detail — cite [#id] when using it)
${safeTranscript}
${participantsSection}
## Synthesis Doctrine

You are not a participant. You are an auditor. Every claim you make must be traceable, but human readability comes first.
${opts.decisionPosture ? `\nOperator decision posture: ${getOrchestratorDecisionSentence({ decisionPosture: opts.decisionPosture }).replace(/^Decision posture: /, "").replace(/\.$/, "")}. This is emphasis only — it is outranked by every numbered rule below.\n` : ""}
${groundingRule}2. **No invention:** Do not invent numbers, dates, costs, tool results, or participant positions not in transcript/State-of-Play. If evidence conflicts, state both and set Confidence accordingly. For code, do not invent file contents not read via tool.
3. **Actionability:** Action Items are verbs with owners or “proposed owner: …” if unattributed. ‘Verify’ and ‘track’ are not action items unless they name what changes when they complete.
4. **Open-ended discipline:** Do NOT force a single Decision if transcript shows spectrum. “No single decision — spectrum below” + table is correct. Mapping disagreement is a success.
5. **Versioned base tables:** When a recurring number set (leaderboard, standings, win totals) is published as a versioned base table (e.g. “leaderboard v1” with season length, per-team/driver wins, sources, as-of round), later contributions cite that version or publish the next version with a diff line. Cite only the LATEST version — never mix figures from different versions. If versions conflict, state both and set Confidence accordingly.
6. **Ratchet votes:** A ballot is never final against new evidence. If later contributions supersede a voted question — new data, a corrected figure, a changed premise — record the vote as re-opened and state which evidence re-opened it. When new evidence has emerged since the last ballot, the final round closes with a confirmation ballot on the superseded question; record its outcome, not just the original tally.
7. **No naked numbers:** Before finishing, scan your draft for every percentage and rate. Each must carry (n, window, source) — sample size, the time/scope window it covers, and where it came from ([#id], State-of-Play, or Source:). A rate with n<10 may illustrate but never licenses a conclusion — label it "n=X, illustrative only" or strike it. A number you cannot attribute to the transcript/State-of-Play is removed or explicitly flagged as unverified; never let a bare "%" or "X per season" stand on its own.
8. **Calibration sheet for gate ladders:** When you record a Decision Rule with trigger thresholds, each trigger must ship with its calibration — the base rate, historical precedent, or data that justifies the number, or the cheap test that would measure it. If the room never calibrated a trigger, record it as "uncalibrated — needs base rate" rather than presenting it as a working gate; a threshold justified two rounds after authorship is not calibrated.

${lengthSection}
${requiredSections}

## Confidence
One word: High | Medium | Low — then 1-2 sentence justification referencing the rubric:

- High = thorough exploration (≥60% participation or rich evidence) AND claims grounded in [#id]/State-of-Play or marked Proposed
- Medium = solid participation but some gaps (missing evidence, thin tool grounding, or unresolved key tradeoff)
- Low = thin participation, many failures/passes, or key claims ungrounded / invented

**Split name vs number:** when the decision rests on a numeric estimate, state confidence separately for the NAME (the qualitative conclusion) and the NUMBER (the quantitative estimate) — e.g. "Name: High; Number: Medium". When the numeric band straddles the decision threshold, degrade to threshold analysis (state the band and what evidence would move it) instead of publishing a point estimate.

## Negative Example (do NOT do this)
## Executive Summary
We should migrate to JWT because everyone agreed.  ← BAD: no nuance, forces consensus
## Decision
We should migrate to JWT because everyone agreed.  ← BAD: no citations, vague consensus claim
${isCode ? "\n## Negative Example (code) — do NOT do this\n## Proposed Fix\nFix hydration by editing layout.tsx.  ← BAD: no file=, no ``` block, no Proposed marking\n" : ""}

## Good Fragment (abstract, domain-free)
## Executive Summary
Deliberation split between incremental rollout (safer, slower) and big-bang (faster, riskier). Evidence favors incremental on reversibility; dissent on speed remains bounded — next step is Q1 pilot vs spike comparison.
## Decision
No single decision — spectrum below:
| Position | Holder(s) | Evidence | Tradeoff |
| A: Incremental | Staff Lead [#4] | maintainability, reversibility | slower time-to-value |
| B: JWT big-bang | Founder [#5] | 10ms latency | SOC2 revocation risk |
## Reasoning
- **Staff Lead (senior, [#4])** proposed B citing maintainability — built on [#2] cost numbers. **Security Engineer (mid, [#5])** challenged revocation, then reflected [#14] accepting short-lived tokens with rotation. Tradeoff: speed vs auditability.
${isCode ? "\n## Good Fragment (code-analysis)\n## Proposed Fix\n- Files: `src/app/layout.tsx:18` — hydration mismatch from client-only hook (read in [#4])\n- Diff: ```tsx file=src/app/layout.tsx\n  // Proposed — synthesized from [#4][#7]\n  'use client';\n  import { useEffect, useState } from 'react';\n  // guard hydration: only render after mount\n  ```\n  Why: [#4] read src/app/layout.tsx via read tool; [#7] challenge on useEffect stale closure. [#9] evidence via grep. Tests: `npm test` hydration case.\n" : ""}
`;
}

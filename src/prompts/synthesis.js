import { sanitizeForDisplay } from "../utils/sanitize.js";
import { escapeDelimiters, delimitContext } from "./delimiters.js";

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
export function buildSynthesisPrompt(question, transcript, participants = [], tags = [], stateOfPlay = "", objections = [], userContext = "") {
  const mode = detectTaskMode(question, tags);
  const isCode = mode === "code-analysis";
  const safeQuestion = escapeDelimiters(sanitizeForDisplay(question, 20000));
  // Large window: 24k transcript budget, no cost cutting — truncations are anti-timeout only
  let safeTranscript = sanitizeForDisplay(transcript, 24000);
  const wasTruncated = transcript && transcript.length > 24000;
  safeTranscript = delimitContext(escapeDelimiters(safeTranscript + (wasTruncated ? "\n…[transcript truncated — earliest rounds summarized, latest rounds fuller; full weave available in State of Play + DB]" : "")), "TRANSCRIPT");
  const participantsSection = participants.length > 0
    ? `\n## Participants (activity)\n${participants.map((p) => `- ${escapeDelimiters(sanitizeForDisplay(p.config.name, 80))} (${p.config.tier}): ${p.contributions_count} contributions${p.status === "failed" ? " [failed]" : p.status === "passed" ? " [passed late]" : ""}`).join("\n")}\n`
    : "";

  const tagContext = tags?.length > 0 ? escapeDelimiters(tags.join(", ")) : null;

  const stateOfPlaySection = stateOfPlay
    ? `\n## State of Play (Final — PRIMARY source)\n${escapeDelimiters(sanitizeForDisplay(stateOfPlay, 20000))}\n`
    : "";

  const unresolvedObjections = (objections ?? []).filter((o) => o.unresolved);
  const resolvedObjections = (objections ?? []).filter((o) => !o.unresolved);
  const objectionsSection = unresolvedObjections.length > 0
    ? `\n## Unresolved Dissent (map each in Dissenting Views with holder + [#id] — dissent is valuable, not a failure)\n${unresolvedObjections.map((o) => `- ${escapeDelimiters(sanitizeForDisplay(o.content, 600))} (holder: ${escapeDelimiters(sanitizeForDisplay(o.participant_id ?? "unknown", 80))})`).join("\n")}\n`
    : "";
  const resolvedSection = resolvedObjections.length > 0
    ? `\n## Resolved Concerns (do NOT re-list as dissent)\n${resolvedObjections.map((o) => `- ${escapeDelimiters(sanitizeForDisplay(o.content, 600))} (resolved)`).join("\n")}\n`
    : "";

  // Detect build vs plan for live-edit guidance (passed via tags or participant context)
  const isBuildMode = (tags || []).some(t => /build|write|edit/i.test(t)) || false;
  const buildNote = isCode
    ? (isBuildMode ? " (BUILD mode — live file edits were allowed; note which files were actually written vs proposed)" : " (PLAN mode — read-only: propose diffs; mark live edits as Proposed)")
    : "";
  const modeNote = isCode
    ? `\n## Mode: Code-Analysis${buildNote}\nYou are synthesizing a code collaboration. Include concrete Proposed Fix diffs with file= paths. Novel synthesized fixes are allowed when marked “Proposed — synthesized from [#id]”. If live edits occurred, note file= and verification (tests). Thoroughness welcome — 200k window.\n`
    : `\n## Mode: Conversational (open-ended)\nDissent is fine — do not force a single Decision if deliberation left a spectrum. Prefer mapping positions with evidence. Thoroughness welcome — 200k window.\n`;

  const userContextSection = userContext
    ? `\n## Original User Context (from the person who asked)\n${delimitContext(escapeDelimiters(sanitizeForDisplay(userContext, 20000)), "USER_CONTEXT")}\n`
    : "";

  const groundingRule = isCode
    ? `1. **Grounding:** Group citations per evidence block — cite once as [#id] or State-of-Play or Source: https://… per block. If you synthesize a novel fix/code not present verbatim, mark it “Proposed — synthesized from [#id]” and keep it. Do not invent file contents not read via tool; if no file was read, qualify as “Proposed (unverified — no tool read)”. Never emit vec: round / vec round / [Round X vec — those are internal retrieval traces. Don’t spam [#id] per sentence; one grouped cite per block.\n`
    : `1. **Grounding:** Group citations per paragraph/block — cite once as [#id] or State-of-Play or Source: https://… per block. If you synthesize a novel conclusion, mark it “Proposed — synthesized from [#id]” and keep it. Do not invent numbers/dates unsupported by transcript/State-of-Play. Never emit vec: / vec round — use [#id] or State-of-Play instead. Don’t spam citations.\n`;

  const lengthSection = isCode
    ? `## Length — concise but thorough (200k window — verbose welcome, yapping not)
- Executive Summary: 120-180 words — human-first, no citations, plain narrative (concise)
- Decision / Synthesis: 150-350 words — direct answer OR spectrum table if no consensus; group citations per block; table cells concise (Evidence 30-35w max + one cite, Tradeoff 30-35w max)
- Reasoning: 350-600 words — 4-8 bullets, who argued what + evidence + tradeoff, group cites; deduplicate vs Decision table (map vs narrative)
- Proposed Fix: 300-700 words — Files: \`path\` + diffs \`\`\`tsx file=src/...\`\`\` + why, mark Proposed if synthesized, note live edits vs proposals, include tests
- Action Items: 120-300 words — verbs with owners or “proposed: X → handoff to @role” + block cites; distribute owners, max 2 per holder (may be “None — see Proposed Fix”)
- Dissenting Views: 120-300 words — each holder + [#id] + one-line evidence; merge duplicates from same holder on same evidence; high dissent fine
- Open Questions: 100-200 words — why remains + suggested probe
- Confidence: 40-80 words — one word + rubric justification (High may have dissent if bounded and grounded)
Total 1600-3500 words welcome; concise but thorough — preserve numbers/code verbatim, no invented figures.\n`
    : `## Length — concise but thorough (200k window — verbose welcome, yapping not)
- Executive Summary: 120-180 words — human-first, no citations, plain narrative (concise, scannable)
- Decision / Synthesis: 150-350 words — one paragraph OR spectrum table if no consensus; group citations per block; table cells concise (Evidence 30-35w + one grouped cite, Tradeoff 30-35w)
- Reasoning: 300-600 words — 4-8 bullets, each who argued what + evidence + tradeoff, group cites; DEDUPLICATE vs Decision — Decision maps positions, Reasoning explains why they emerged/diverged, do not copy-paste numbers verbatim thrice
- Action Items: 120-300 words — verbs with owners or “proposed: X → handoff to @role” + block cites; distribute owners (max 2 per holder unless justified)
- Dissenting Views: 120-300 words — each holder + [#id] + one-line evidence; merge duplicate dissents from same holder on same evidence into one entry with combined [#ids]
- Open Questions: 100-200 words — why remains + suggested probe/next step
- Confidence: 40-80 words — one word + rubric justification
Total 1500-3500 words welcome; concise but thorough — preserve numbers verbatim, no invented figures.\n`;

  const requiredSections = isCode
    ? `## Required Sections — output these exact headings in this order, even if empty (write “None” where appropriate)

## Executive Summary
Human-first plain narrative (no citations). 2-4 sentences: what was asked, what the deliberation found, and the key tradeoff/next step. For code: also state files touched and whether live edits occurred.

## Decision
If convergent: one-paragraph direct answer citing key [#id]s (grouped per block, no vec: leak). If divergent / open-ended: write “No single decision — spectrum below” then map options in a table | Option | Holder(s) | Evidence (30-35w + one grouped cite) | Tradeoff (30-35w) | — still cite [#id]s per option. Preserve numbers verbatim. Dissent does not force a decision. Keep cells concise, not paragraphs.

## Reasoning
4-8 bullets or short paragraphs. Each bullet references who argued what and on what evidence. Show tradeoffs and synthesis between views. Group cites per block. DEDUPLICATE: do not repeat Decision table numbers verbatim; reference rows (“see Position B Evidence”) and explain divergence/synthesis. Preserve numbers verbatim only when new.

## Proposed Fix
Files involved + diffs with \`\`\`tsx file=src/...\`\`\` blocks. Mark any novel synthesized snippet “Proposed — synthesized from [#id]”. Note live edits (BUILD) vs proposals (PLAN). Preserve code verbatim; do not invent file contents not read.

## Action Items
- {verb} {what} — owner: {name or “proposed: X → handoff to @role”} — block cite [#id]
(Empty → “None — see Proposed Fix.”) Distribute owners; max 2 per holder.

## Dissenting Views
Each dissent on its own line: **{Holder}** ({tier}): {view} — [#id] + one-line evidence summary (30w). Merge duplicates from same holder on same evidence into one entry with combined [#ids]. If none, “None — all converged.”
Unresolved Objections above must appear here. High dissent is fine — map it, don’t suppress.

## Open Questions
- {question that remains} — why it remains (missing evidence / unresolved tradeoff) — how to resolve`
    : `## Required Sections — output these exact headings in this order, even if empty (write “None” where appropriate)

## Executive Summary
Human-first plain narrative (no citations). 2-4 sentences: what was asked, what the deliberation found, and the key open tradeoff. Write for a busy human scanning — concise.

## Decision
If convergent: one-paragraph direct answer citing key [#id]s (grouped per block, never vec:). If divergent / open-ended: write “No single decision — spectrum below” then present a table | Position | Holder(s) | Evidence (30-35w max + one grouped cite) | Tradeoff (30-35w max) | — still cite [#id]s per row. Preserve numbers verbatim. Do not force consensus; mapping the disagreement is a valid outcome. Keep cells concise.

## Reasoning
4-8 bullets or short paragraphs. Each bullet references who argued what and on what evidence. Show tradeoffs and how views synthesize or diverge. Group cites per block. DEDUPLICATE vs Decision: Decision maps positions, Reasoning explains why they emerged/diverged — do not copy-paste Evidence numbers thrice; reference Decision rows when possible.

## Action Items
- {verb} {what} — owner: {name or “proposed: X → handoff to @role”} — block cite [#id]
(Empty → “None — deliberation surfaced no actionable consensus; see Open Questions for next step.”) Distribute owners; max 2 per holder unless justified.

## Dissenting Views
Each dissent on its own line: **{Holder}** ({tier}): {view} — [#id] + one-line evidence summary (≤30w). Merge duplicate dissents from same holder on same evidence into one entry with combined [#ids].
If none, write “None — all active participants converged or passed.”
Unresolved Objections above must appear here. Multiple dissents are fine and do not preclude High confidence if each is well-bounded.

## Open Questions
- {question that remains} — why it remains (missing evidence / unresolved tradeoff) — suggested next probe or experiment`;

  return `You are the synthesis auditor. The deliberation is complete. Produce the final artifact — human-readable FIRST, then citation-grounded detail. Thoroughness welcome; dissent is valuable, not a failure.
${modeNote}
## Original Question
${safeQuestion}
${tagContext ? `\n## Tags (topic)\n${tagContext}\n` : ""}
${userContextSection}${stateOfPlaySection}${objectionsSection}${resolvedSection}
## Deliberation Transcript (supporting detail — cite [#id] when using it)
${safeTranscript}
${participantsSection}
## Synthesis Doctrine

You are not a participant. You are an auditor. Every claim you make must be traceable, but human readability comes first.

${groundingRule}2. **Attribution:** Every Dissenting View must name holder + [#id] + one-line evidence. Unresolved Objections above are mandatory dissent — include them. Group cites per block.
3. **No invention:** Do not invent numbers, dates, costs, tool results, or participant positions not in transcript/State-of-Play. If evidence conflicts, state both and set Confidence accordingly. For code, do not invent file contents not read via tool.
4. **Resolved ≠ dissent:** Items in Resolved Concerns must NOT reappear as Dissenting Views.
5. **Actionability:** Action Items are verbs with owners or “proposed owner: …” if unattributed.
6. **Open-ended discipline:** Do NOT force a single Decision if transcript shows spectrum. “No single decision — spectrum below” + table is correct. Mapping disagreement is a success.

${lengthSection}
${requiredSections}

## Confidence
One word: High | Medium | Low — then 1-2 sentence justification referencing the rubric:

- High = thorough exploration (≥60% participation or rich evidence) AND claims grounded in [#id]/State-of-Play or marked Proposed; dissent may be High if each view is well-bounded with evidence
- Medium = solid participation but some gaps (missing evidence, thin tool grounding, or unresolved key tradeoff)
- Low = thin participation, many failures/passes, or key claims ungrounded / invented

Dissent alone does NOT cap confidence. Cite which condition you met.

## Negative Example (do NOT do this)
## Executive Summary
We should migrate to JWT because everyone agreed.  ← BAD: no nuance, forces consensus
## Decision
We should migrate to JWT because everyone agreed.  ← BAD: no citations, vague consensus claim
## Dissenting Views
None  ← BAD when transcript has dissent
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

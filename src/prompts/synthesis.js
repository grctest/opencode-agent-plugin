import { sanitizeForDisplay } from "../utils/sanitize.js";
import { escapeDelimiters, delimitContext } from "./delimiters.js";

export function detectTaskMode(question, tags = []) {
  const q = (question || "").toLowerCase();
  const tagStr = (tags || []).join(" ").toLowerCase();
  const combined = q + " " + tagStr;
  const codeSignals = [
    /\breact\b/, /\bnext\.js\b/, /\btsx\b/, /\btypescript\b/,
    /\bsrc\//, /\.tsx\b/, /\.ts\b/, /\.js\b/, /\.jsx\b/,
    /in this folder/, /in my project/, /how would you.*fix/, /propose.*fix/,
    /\bbug\b/, /\berror\b/, /\bstack\b/, /\brepro\b/, /\brefactor\b/, /\bhook\b/, /\bhydration\b/
  ];
  const hits = codeSignals.filter(rx => rx.test(combined)).length;
  if (hits >= 2) return "code-analysis";
  if (tagStr.includes("engineering") && (q.includes("file") || q.includes("code") || q.includes("project"))) return "code-analysis";
  return "conversational";
}

/** Builds a prompt for synthesizing the final deliberation artifact from all contributions. */
export function buildSynthesisPrompt(question, transcript, participants = [], tags = [], stateOfPlay = "", objections = [], userContext = "") {
  const mode = detectTaskMode(question, tags);
  const isCode = mode === "code-analysis";
  const safeQuestion = escapeDelimiters(sanitizeForDisplay(question, 20000));
  const safeTranscript = delimitContext(escapeDelimiters(sanitizeForDisplay(transcript, 8000)), "TRANSCRIPT");
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
    ? `\n## Unresolved Dissent (must appear in Dissenting Views with holder + [#id])\n${unresolvedObjections.map((o) => `- ${escapeDelimiters(sanitizeForDisplay(o.content, 600))} (holder: ${escapeDelimiters(sanitizeForDisplay(o.participant_id ?? "unknown", 80))})`).join("\n")}\n`
    : "";
  const resolvedSection = resolvedObjections.length > 0
    ? `\n## Resolved Concerns (do NOT re-list as dissent)\n${resolvedObjections.map((o) => `- ${escapeDelimiters(sanitizeForDisplay(o.content, 600))} (resolved)`).join("\n")}\n`
    : "";

  const modeNote = isCode
    ? `\n## Mode: Code-Analysis (read-only)\nYou are synthesizing a react/project coding analysis. Include concrete Proposed Fix diffs with file= paths. Novel synthesized fixes are allowed when marked “Proposed — synthesized from [#id]”.\n`
    : `\n## Mode: Conversational\n`;

  const userContextSection = userContext
    ? `\n## Original User Context (from the person who asked)\n${delimitContext(escapeDelimiters(sanitizeForDisplay(userContext, 20000)), "USER_CONTEXT")}\n`
    : "";

  const groundingRule = isCode
    ? `1. **Grounding:** Prefer citing [#id] or State-of-Play. If you synthesize a novel fix/code not present verbatim, mark it “Proposed — synthesized from [#id]” and keep it. Do not invent file contents not read via tool; if no file was read, qualify as “Proposed (unverified — no tool read)”.\n`
    : `1. **Grounding:** Prefer citing [#id] or State-of-Play. If you synthesize a novel conclusion, mark it “Proposed — synthesized from [#id]” and keep it. Do not invent numbers/dates unsupported by transcript/State-of-Play.\n`;

  const lengthSection = isCode
    ? `## Length — per-section budget (code-analysis, allow diffs)

- Decision: 80-120 words — one paragraph, cites [#id]s
- Reasoning: 150-250 words — 3-7 bullets, who argued what + evidence + tradeoff, cite [#id] or State-of-Play
- Proposed Fix: 150-350 words — Files: \`path\` + diffs \`\`\`tsx file=src/...\`\`\` + why, mark Proposed if synthesized
- Action Items: 80-120 words — verbs with owners or “proposed: X” + cites (may be “None — see Proposed Fix”)
- Dissenting Views: 80-120 words — each holder + [#id] (Unresolved Objections mandatory)
- Open Questions: 60-90 words — why remains (missing evidence / tradeoff)
- Confidence: 20-40 words — one word + rubric justification
Total 700-1200 words welcome; preserve numbers and code verbatim — do not round or invent figures not in transcript/SoP.\n`
    : `## Length — per-section budget (stay within, prefer thoroughness within budget)

- Decision: 80-120 words — one paragraph, cites [#id]s
- Reasoning: 150-250 words — 3-7 bullets, each who argued what + evidence + tradeoff, cite [#id] or State-of-Play
- Action Items: 80-120 words — verbs with owners or “proposed: X” + cites
- Dissenting Views: 80-120 words — each holder + [#id] (Unresolved Objections mandatory)
- Open Questions: 60-90 words — why remains (missing evidence / tradeoff)
- Confidence: 20-40 words — one word + rubric justification
Total 500-900 words welcome; preserve numbers verbatim — do not round or invent figures not in transcript/SoP.\n`;

  const requiredSections = isCode
    ? `## Required Sections — output these exact headings in this order, even if empty (write “None”)

## Decision
One-paragraph direct answer to the Original Question, citing key [#id]s. Preserve numbers verbatim.

## Reasoning
3-7 bullets or short paragraphs. Each bullet should reference who argued what and on what evidence. Show tradeoffs considered. Cite [#id] or State-of-Play. Preserve numbers verbatim.

## Proposed Fix
Files involved + diffs with \`\`\`tsx file=src/...\`\`\` blocks. Mark any novel synthesized snippet “Proposed — synthesized from [#id]”. Preserve code verbatim; do not invent file contents not read.

## Action Items
- {verb} {what} — owner: {name or “proposed: X”} — cites [#id]
(Empty → “None — see Proposed Fix.”)

## Dissenting Views
Each dissent on its own line: **{Holder}** ({tier}): {view} — [#id]
If none, write “None — all active participants converged or passed.”
Unresolved Objections above must appear here.

## Open Questions
- {question that remains} — why it remains (missing evidence / unresolved tradeoff)`
    : `## Required Sections — output these exact headings in this order, even if empty (write “None”)

## Decision
One-paragraph direct answer to the Original Question, citing key [#id]s. Preserve numbers verbatim.

## Reasoning
3-7 bullets or short paragraphs. Each bullet should reference who argued what and on what evidence. Show tradeoffs considered. Cite [#id] or State-of-Play. Preserve numbers verbatim.

## Action Items
- {verb} {what} — owner: {name or “proposed: X”} — cites [#id]
(Empty → “None — deliberation surfaced no actionable consensus.”)

## Dissenting Views
Each dissent on its own line: **{Holder}** ({tier}): {view} — [#id]
If none, write “None — all active participants converged or passed.”
Unresolved Objections above must appear here.

## Open Questions
- {question that remains} — why it remains (missing evidence / unresolved tradeoff)`;

  return `You are the synthesis auditor. The deliberation is complete. Produce the final artifact — comprehensive, citation-grounded, open-ended for both conversational and code-analysis tasks.
${modeNote}
## Original Question
${safeQuestion}
${tagContext ? `\n## Tags (topic)\n${tagContext}\n` : ""}
${userContextSection}${stateOfPlaySection}${objectionsSection}${resolvedSection}
## Deliberation Transcript (supporting detail — cite [#id] when using it)
${safeTranscript}
${participantsSection}
## Synthesis Doctrine

You are not a participant. You are an auditor. Every claim you make must be traceable.

${groundingRule}2. **Attribution:** Every Dissenting View must name holder + [#id]. Unresolved Objections above are mandatory dissent — include them.
3. **No invention:** Do not invent numbers, dates, costs, tool results, or participant positions not in transcript/State-of-Play. If evidence conflicts, state both and set Confidence accordingly. For code, do not invent file contents not read via tool.
4. **Resolved ≠ dissent:** Items in Resolved Concerns must NOT reappear as Dissenting Views.
5. **Actionability:** Action Items are verbs with owners or “proposed owner: …” if unattributed.

${lengthSection}
${requiredSections}

## Confidence
One word: High | Medium | Low — then 1 sentence justification referencing the rubric:

- High = ≥70% active participants contributed meaningfully AND 0 unresolved objections AND at least one tool- or vec-grounded claim
- Medium = broad participation with 1 dissent, or majority participation with some passes
- Low = significant disagreement remains, or many participants failed/passed, or key claims are ungrounded

Cite rubric condition you met.

## Negative Example (do NOT do this)
## Decision
We should migrate to JWT because everyone agreed.  ← BAD: no citations, vague consensus claim
## Dissenting Views
None  ← BAD when transcript has [CHALLENGE] entries
${isCode ? "\n## Negative Example (code) — do NOT do this\n## Proposed Fix\nFix hydration by editing layout.tsx.  ← BAD: no file=, no ``` block, no Proposed marking\n" : ""}

## Good Fragment (abstract, domain-free)
## Decision
Adopt option B (incremental rollout of X) — [#4][#7] converged on risk/reversibility over speed. [#9]’s cost analysis (Source: https://… ) supports Q1 pilot.
## Reasoning
- **Staff Lead (senior, [#4])** proposed B citing maintainability; **Security Engineer (mid, [#5])** challenged revocation, then reflected [#14] accepting short-lived tokens with rotation.
${isCode ? "\n## Good Fragment (code-analysis)\n## Proposed Fix\n- Files: `src/app/layout.tsx:18` — hydration mismatch from client-only hook\n- Diff: ```tsx file=src/app/layout.tsx\n  // Proposed — synthesized from [#4][#7]\n  'use client';\n  import { useEffect, useState } from 'react';\n  // guard hydration: only render after mount\n  ```\n  Why: [#4] read src/app/layout.tsx via read tool; [#7] challenge on useEffect stale closure. [#9] evidence via grep.\n" : ""}
`;
}

function supplementMissingSections(text, missingSections) {
  const note = `> **Note:** The synthesizer did not generate the following sections: ${missingSections.join(", ")}. Consider reviewing the raw deliberation transcript for additional context.`;
  return `${text}\n\n${note}`;
}

/** Derives a confidence level (high/medium/low) based on deliberation quality signals. */
export function deriveConfidence(weave, dissentCount, totalParticipants = 0, activeParticipants = 0) {
  const totalContribs = weave.length;
  if (totalContribs === 0) return "low";

  const challengeRatio =
    weave.filter((c) => c.type === "challenge" || c.type === "dissent").length /
    Math.max(totalContribs, 1);

  const participationRate = totalParticipants > 0 ? activeParticipants / totalParticipants : 1;

  if (dissentCount === 0 && challengeRatio < 0.3 && participationRate >= 0.5) return "high";
  if (dissentCount <= 1 && challengeRatio < 0.5 && participationRate >= 0.33) return "medium";
  return "low";
}

/** Parses the Confidence section as a single High/Medium/Low value — anchored to heading, avoids "Highly". */
export function parseConfidence(text) {
  const tail = text.slice(-800);
  const match = tail.match(/##\s*Confidence\b[^#]*?\b(High|Medium|Low)\b/i);
  if (match) return match[1].toLowerCase();
  return null;
}

/** Validates that all required sections exist in the synthesis output (case-insensitive). Returns warnings for missing ones.
 * Core 3 (Decision, Reasoning, Confidence) always required. Action Items / Proposed Fix: at least one must be present.
 * Dissenting Views and Open Questions remain required for both conversational and code-analysis modes (may be "None").
 */
export function validateSynthesisSections(text) {
  const coreRequired = ["Decision", "Reasoning", "Confidence"];
  const atLeastOneOf = [["Action Items", "Proposed Fix"]];
  const alwaysRequired = ["Dissenting Views", "Open Questions"];
  const lower = text.toLowerCase();
  const warnings = [];
  for (const section of coreRequired) {
    if (!lower.includes(`## ${section.toLowerCase()}`)) {
      warnings.push(section);
    }
  }
  for (const section of alwaysRequired) {
    if (!lower.includes(`## ${section.toLowerCase()}`)) {
      warnings.push(section);
    }
  }
  for (const group of atLeastOneOf) {
    const hasOne = group.some(s => lower.includes(`## ${s.toLowerCase()}`));
    if (!hasOne) {
      // Prefer Action Items as canonical, but accept Proposed Fix
      warnings.push(group[0]);
    }
  }
  return warnings;
}

/** Extracts list items from a named section of a markdown document. */
export function extractSection(text, sectionName) {
  const lines = text.split("\n");
  const results = [];
  let inSection = false;
  let paragraph = "";

  const flushParagraph = () => {
    const trimmed = paragraph.trim();
    if (trimmed && !trimmed.startsWith("## ")) {
      results.push(trimmed);
    }
    paragraph = "";
  };

  for (const line of lines) {
    if (line.startsWith("## ") && line.toLowerCase().includes(sectionName.toLowerCase())) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith("## ")) {
      flushParagraph();
      inSection = false;
      continue;
    }
    if (!inSection) continue;

    if (line.trim().startsWith("- ")) {
      flushParagraph();
      results.push(line.trim().slice(2));
    } else if (/^\d+\./.test(line.trim())) {
      flushParagraph();
      results.push(line.trim().replace(/^\d+\.\s*/, ""));
    } else if (line.trim() === "") {
      flushParagraph();
    } else {
      paragraph += (paragraph ? " " : "") + line.trim();
    }
  }
  flushParagraph();

  return results;
}

const NEUTRAL_SYNTHESIZER_SYSTEM = `You are a synthesis auditor, not a participant. You are neutral to all agendas — including the synthesizer persona you may have borrowed.

Rules:
1. Prefer citing [#id] or State-of-Play for every Decision and Action Item. If you synthesize a novel fix/code not present verbatim, mark it “Proposed — synthesized from [#id]” and keep it. Do not invent file contents not read via tool; if no file was read, qualify as “Proposed (unverified — no tool read)”.
2. Every Dissenting View must name holder (name + tier) and [#id]. Unresolved Objections are mandatory dissent.
3. Do not invent numbers, dates, costs, tool results, or participant positions not in transcript/State-of-Play. If evidence conflicts, state both and set Confidence accordingly. For code, do not invent file contents not read via tool.
4. Resolved Concerns must NOT reappear as Dissenting Views.
5. Never emit <<< or >>> delimiters. Be comprehensive (500-900 conversational, 700-1200 code-analysis welcome); prefer thoroughness over brevity. Preserve code and numbers verbatim.`;

/** Post-processes raw synthesis text into the final artifact: objections, missing-section notes, confidence, structured fields. */
export function finalizeSynthesis(artifactText, transcriptData, participants, objections) {
  const unresolvedObjections = (objections ?? []).filter((o) => o.unresolved);
  const resolvedObjections = (objections ?? []).filter((o) => !o.unresolved);
  const objectionsText = unresolvedObjections.map((o) => `- ${o.content}`).join("\n");
  const resolvedText = resolvedObjections.map((o) => `- ${o.content} (resolved)`).join("\n");
  
  // Collect refusals from the transcript
  const weave = transcriptData.rounds.flatMap((r) => r.contributions);
  const refusals = weave.filter((c) => c.type === "refuse");
  const refusalsText = refusals.map((r) => {
    const p = participants.find((pp) => pp.config.id === r.participant_id);
    return `${p?.config.name ?? r.participant_id}: ${r.content}`;
  }).join("\n");
  
  let finalOutput = artifactText;
  
  if (objectionsText) {
    finalOutput = `${finalOutput}\n\n## Unresolved Objections\n${objectionsText}`;
  }
  if (resolvedText) {
    finalOutput = `${finalOutput}\n\n## Resolved Concerns\n${resolvedText}`;
  }
  
  if (refusalsText) {
    finalOutput = `${finalOutput}\n\n## Refusals\n${refusalsText}`;
  }

  const missingSections = validateSynthesisSections(finalOutput);
  if (missingSections.length > 0) {
    finalOutput = supplementMissingSections(finalOutput, missingSections);
  }

  // Grounded synthesis check (audit 18 PV6): every Decision line must cite
  // at least one [#id] present in the transcript. Ungrounded lines are flagged
  // rather than silently dropped — cheap hallucination guard.
  const weaveIds = new Set(weave.map((c) => String(c.id)));
  const decisions = extractSection(finalOutput, "Decision");
  const ungrounded = decisions.filter((line) => {
    const cites = [...line.matchAll(/\[#(\d+)\]/g)].map((m) => m[1]);
    return cites.length === 0 || cites.every((id) => !weaveIds.has(id));
  });
  if (ungrounded.length > 0) {
    finalOutput += `\n\n## Needs Verification\nThe following Decision lines lack a valid [#id] citation to the transcript and should be verified before acting:\n${ungrounded.map((l) => `- ${l}`).join("\n")}`;
  }

  const parsedConfidence = parseConfidence(finalOutput);
  const activeParticipants = participants.filter((p) => p.status !== "failed").length;
  const heuristicConfidence = deriveConfidence(weave, unresolvedObjections.length, participants.length, activeParticipants);
  const confidence = parsedConfidence ?? heuristicConfidence;

  const artifact = {
    content: finalOutput,
    format: "markdown",
    decisions: extractSection(finalOutput, "Decision"),
    action_items: extractSection(finalOutput, "Action Items"),
    proposed_fix: extractSection(finalOutput, "Proposed Fix"),
    files_involved: extractSection(finalOutput, "Files Involved"),
    dissent: unresolvedObjections,
    refusals: refusals.map(r => ({
      participant_id: r.participant_id,
      content: r.content,
    })),
    open_questions: extractSection(finalOutput, "Open Questions"),
    confidence,
  };

  return { artifact, output: finalOutput };
}

export { NEUTRAL_SYNTHESIZER_SYSTEM };

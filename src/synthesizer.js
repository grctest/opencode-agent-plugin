function supplementMissingSections(text, missingSections) {
  const note = `> **Note:** The synthesizer did not generate the following sections: ${missingSections.join(", ")}. Consider reviewing the raw deliberation transcript for additional context.`;
  return `${text}\n\n${note}`;
}

/** Derives a confidence level (high/medium/low) based on deliberation quality signals. */
export function deriveConfidence(weave, dissentCount, totalParticipants = 0, activeParticipants = 0) {
  const totalContribs = weave.length;
  if (totalContribs === 0) return "low";

  const challengeWordsRe = /\b(challenge|dissent|disagree|concern|oppose|object|critique|dispute|contradict|refuse)\b/i;
  function isChallengeLike(c) {
    if (c.type === "challenge" || c.type === "dissent" || c.type === "critique_response") return true;
    const content = (c.content || "").toLowerCase();
    return challengeWordsRe.test(content);
  }
  const challengeRatio =
    weave.filter(isChallengeLike).length /
    Math.max(totalContribs, 1);

  const participationRate = totalParticipants > 0 ? activeParticipants / totalParticipants : 1;

  if (dissentCount === 0 && challengeRatio < 0.3 && participationRate >= 0.5) return "high";
  if (dissentCount <= 1 && challengeRatio < 0.5 && participationRate >= 0.33) return "medium";
  return "low";
}

/** Parses the Confidence section — anchors to the Confidence heading block to avoid picking a stray High in body. */
export function parseConfidence(text) {
  // Find the Confidence section block, then search for the confidence word inside it
  const sectionRe = /^#{2,}\s*Confidence\b([\s\S]*?)(?=^#{2,}\s|\z)/im;
  const secMatch = text.match(sectionRe);
  const searchScope = secMatch ? secMatch[1] : text;
  // Look for the confidence word on its own line or as a label (avoid matching "High risk" in body unless it's the answer)
  const lineMatch = searchScope.match(/^\s*(High|Medium|Low)\s*$/im);
  if (lineMatch) return lineMatch[1].toLowerCase();
  // Fallback: first occurrence inside the Confidence block
  const anyMatch = searchScope.match(/\b(High|Medium|Low)\b/i);
  return anyMatch ? anyMatch[1].toLowerCase() : null;
}

/** Validates that all required sections exist in the synthesis output (case-insensitive). Returns warnings for missing ones.
 * Core 3 (Decision, Reasoning, Confidence) always required. Action Items / Proposed Fix: at least one must be present.
 * Dissenting Views and Open Questions remain required for both conversational and code-analysis modes (may be "None").
 */
export function validateSynthesisSections(text) {
  const coreRequired = ["Decision", "Reasoning", "Confidence"];
  const atLeastOneOf = [["Action Items", "Proposed Fix"]];
  const alwaysRequired = ["Dissenting Views", "Open Questions"];
  const warnings = [];
  function hasSection(section) {
    const esc = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^#{2,}\\s*${esc}\\b`, "im");
    return re.test(text);
  }
  for (const section of coreRequired) {
    if (!hasSection(section)) {
      warnings.push(section);
    }
  }
  for (const section of alwaysRequired) {
    if (!hasSection(section)) {
      warnings.push(section);
    }
  }
  for (const group of atLeastOneOf) {
    const hasOne = group.some(s => hasSection(s));
    if (!hasOne) {
      // Prefer Action Items as canonical, but accept Proposed Fix
      warnings.push(group[0]);
    }
  }
  return warnings;
}

/** Extracts list items from a named section of a markdown document — accepts ## or ###. */
export function extractSection(text, sectionName) {
  const lines = text.split("\n");
  const results = [];
  let inSection = false;
  let paragraph = "";
  const isHeading = (l) => /^#{2,}\s/.test(l);

  const flushParagraph = () => {
    const trimmed = paragraph.trim();
    if (trimmed && !isHeading(trimmed)) {
      results.push(trimmed);
    }
    paragraph = "";
  };

  const headerMatches = (line, name) => {
    if (!isHeading(line)) return false;
    return line.replace(/^#{2,}\s*/, "").toLowerCase().includes(name.toLowerCase());
  };

  for (const line of lines) {
    if (headerMatches(line, sectionName)) {
      inSection = true;
      continue;
    }
    if (inSection && isHeading(line)) {
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

  // Grounded synthesis check: every Decision line must cite at least one [#id] in weave.
  // Skip lines inside fenced code blocks (track fence state, not just delimiter line).
  const weaveIds = new Set(weave.map((c) => String(c.id)));
  const decisions = extractSection(finalOutput, "Decision");
  let inFence = false;
  const ungrounded = decisions.filter((line) => {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) { inFence = !inFence; return false; }
    if (inFence) return false;
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

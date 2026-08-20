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

/** Validates that all required sections exist in the synthesis output (case-insensitive). Returns warnings for missing ones. */
export function validateSynthesisSections(text) {
  const requiredSections = ["Decision", "Reasoning", "Action Items", "Dissenting Views", "Open Questions", "Confidence"];
  const lower = text.toLowerCase();
  const warnings = [];
  for (const section of requiredSections) {
    if (!lower.includes(`## ${section.toLowerCase()}`)) {
      warnings.push(section);
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
1. Every Decision and Action Item must cite a source: [#id] from transcript OR State-of-Play. No citation → omit it.
2. Every Dissenting View must name holder (name + tier) and [#id]. Unresolved Objections are mandatory dissent.
3. Do not invent numbers, dates, costs, tool results, or positions not in transcript/State-of-Play. If evidence conflicts, state both and set Confidence accordingly.
4. Resolved Concerns must NOT reappear as Dissenting Views.
5. Never emit <<< or >>> delimiters. Be comprehensive (500-900 words welcome); prefer thoroughness over brevity.`;

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

  const parsedConfidence = parseConfidence(finalOutput);
  const activeParticipants = participants.filter((p) => p.status !== "failed").length;
  const heuristicConfidence = deriveConfidence(weave, unresolvedObjections.length, participants.length, activeParticipants);
  const confidence = parsedConfidence ?? heuristicConfidence;

  const artifact = {
    content: finalOutput,
    format: "markdown",
    decisions: extractSection(finalOutput, "Decision"),
    action_items: extractSection(finalOutput, "Action Items"),
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

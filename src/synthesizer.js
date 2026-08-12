import { buildSynthesisPrompt } from "./prompts.js";
import { formatTranscriptFromData } from "./warp-manager.js";

function supplementMissingSections(text, missingSections) {
  const note = `> **Note:** The synthesizer did not generate the following sections: ${missingSections.join(", ")}. Consider reviewing the raw deliberation transcript for additional context.`;
  return `${text}\n\n${note}`;
}

/** Derives a confidence level (high/medium/low) based on deliberation quality signals. */
export function deriveConfidence(weft, dissentCount, totalParticipants = 0, activeParticipants = 0) {
  const totalContribs = weft.length;
  if (totalContribs === 0) return "low";

  const challengeRatio =
    weft.filter((c) => c.type === "challenge" || c.type === "dissent").length /
    Math.max(totalContribs, 1);

  const participationRate = totalParticipants > 0 ? activeParticipants / totalParticipants : 1;

  if (dissentCount === 0 && challengeRatio < 0.3 && participationRate >= 0.5) return "high";
  if (dissentCount <= 1 && challengeRatio < 0.5 && participationRate >= 0.33) return "medium";
  return "low";
}

/** Parses the Confidence section as a single High/Medium/Low value. */
export function parseConfidence(text) {
  const match = text.match(/##\s*Confidence[\s\S]*?(High|Medium|Low)/i);
  if (match) return match[1].toLowerCase();
  return null;
}

/** Validates that all required sections exist in the synthesis output. Returns warnings for missing ones. */
export function validateSynthesisSections(text) {
  const requiredSections = ["Decision", "Reasoning", "Action Items", "Dissenting Views", "Open Questions", "Confidence"];
  const warnings = [];
  for (const section of requiredSections) {
    if (!text.includes(`## ${section}`)) {
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
    if (line.startsWith("## ") && line.includes(sectionName)) {
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

const NEUTRAL_SYNTHESIZER_SYSTEM = `You are a neutral deliberation analyst. Your only job is to fairly represent all perspectives from the deliberation, without favoring any participant's agenda. You synthesize diverse viewpoints into a clear, balanced, actionable output.`;

/** Produces the final artifact from database transcript data (for child session synthesis). */
export async function synthesizeFromData(transcriptData, participants, objections, synthesizer, promptFn, getModel) {
  const transcript = formatTranscriptFromData(transcriptData, participants);
  const model = getModel(synthesizer);

  const detectedDomain = transcriptData.domain || null;
  const userPrompt = buildSynthesisPrompt(transcriptData.question, transcript, participants, detectedDomain);

  let artifactText;
  try {
    artifactText = await promptFn(
      NEUTRAL_SYNTHESIZER_SYSTEM,
      model,
      userPrompt,
    );
  } catch (err) {
    console.error(`[Loom] Synthesis LLM call failed: ${err instanceof Error ? err.message : String(err)}. Falling back to contribution dump.`);
    const contributions = transcriptData.rounds.flatMap((r) => r.contributions);
    artifactText = `# Deliberation Output\n\n${contributions.map((c) => `- ${c.content}`).join("\n")}`;
  }

  const unresolvedObjections = objections.filter((o) => o.unresolved);
  const objectionsText = unresolvedObjections.map((o) => `- ${o.content}`).join("\n");
  let finalOutput = objectionsText
    ? `${artifactText}\n\n## Unresolved Objections\n${objectionsText}`
    : artifactText;

  const missingSections = validateSynthesisSections(finalOutput);
  if (missingSections.length > 0) {
    finalOutput = supplementMissingSections(finalOutput, missingSections);
  }

  const weft = transcriptData.rounds.flatMap((r) => r.contributions);
  const parsedConfidence = parseConfidence(finalOutput);
  const activeParticipants = participants.filter((p) => p.status !== "failed").length;
  const heuristicConfidence = deriveConfidence(weft, unresolvedObjections.length, participants.length, activeParticipants);
  const confidence = parsedConfidence ?? heuristicConfidence;

  const artifact = {
    content: finalOutput,
    format: "markdown",
    decisions: extractSection(finalOutput, "Decision"),
    action_items: extractSection(finalOutput, "Action Items"),
    dissent: unresolvedObjections,
    open_questions: extractSection(finalOutput, "Open Questions"),
    confidence,
  };

  return { artifact, output: finalOutput };
}

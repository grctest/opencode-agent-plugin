import { buildSynthesisPrompt } from "./prompts.js";
import { formatTranscriptFromData } from "./warp-manager.js";

/**
 * @typedef {Object} SynthesisResult
 * @property {import("./types.js").Artifact} artifact
 * @property {string} output
 */

/** Derives a confidence level (high/medium/low) based on dissent count and challenge ratio. */
export function deriveConfidence(weft, dissentCount) {
  const totalContribs = weft.length;
  const challengeRatio =
    weft.filter((c) => c.type === "challenge" || c.type === "dissent").length /
    Math.max(totalContribs, 1);

  if (dissentCount === 0 && challengeRatio < 0.3) return "high";
  if (dissentCount <= 1 && challengeRatio < 0.5) return "medium";
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

/** Produces the final artifact from database transcript data (for child session synthesis). */
export async function synthesizeFromData(transcriptData, participants, objections, synthesizer, promptFn, getModel) {
  const transcript = formatTranscriptFromData(transcriptData, participants);
  const model = getModel(synthesizer);
  const userPrompt = buildSynthesisPrompt(transcriptData.question, transcript, participants);

  let artifactText;
  try {
    artifactText = await promptFn(
      `You are ${synthesizer.config.name} (${synthesizer.config.tier}). Synthesize the final output.\n\n${synthesizer.tier_config.system_prompt_addendum}`,
      model,
      userPrompt,
    );
  } catch {
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
     finalOutput += `\n\n> ⚠ Synthesizer did not provide: ${missingSections.join(", ")}. This may indicate incomplete deliberation.`;
   }

   const weft = transcriptData.rounds.flatMap((r) => r.contributions);
   const parsedConfidence = parseConfidence(finalOutput);
   const heuristicConfidence = deriveConfidence(weft, unresolvedObjections.length);
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

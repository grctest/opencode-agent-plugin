import { buildSynthesisPrompt } from "./prompts.js";
import { formatTranscript, formatTranscriptFromData } from "./warp-manager.js";
import { deriveConfidence, extractSection } from "./artifact.js";

/**
 * @typedef {Object} SynthesisResult
 * @property {import("./types.js").Artifact} artifact
 * @property {string} output
 */

/** Produces the final deliberation artifact by prompting the synthesizer agent. */
export async function synthesize(question, rounds, weft, participants, objections, synthesizer, promptFn, getModel) {
  const transcript = formatTranscript(rounds, participants);
  const model = getModel(synthesizer);
  const userPrompt = buildSynthesisPrompt(question, transcript, participants);

  let artifactText;
  try {
    artifactText = await promptFn(
      `You are ${synthesizer.config.name} (${synthesizer.config.tier}). Synthesize the final output.\n\n${synthesizer.tier_config.system_prompt_addendum}`,
      model,
      userPrompt,
    );
  } catch {
    artifactText = `# Deliberation Output\n\n${weft.map((c) => `- ${c.content}`).join("\n")}`;
  }

  const unresolvedObjections = objections.filter((o) => o.unresolved);
  const objectionsText = unresolvedObjections.map((o) => `- ${o.content}`).join("\n");
  const finalOutput = objectionsText
    ? `${artifactText}\n\n## Unresolved Objections\n${objectionsText}`
    : artifactText;

  const confidence = deriveConfidence(weft, unresolvedObjections.length);

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
  const finalOutput = objectionsText
    ? `${artifactText}\n\n## Unresolved Objections\n${objectionsText}`
    : artifactText;

  const weft = transcriptData.rounds.flatMap((r) => r.contributions);
  const confidence = deriveConfidence(weft, unresolvedObjections.length);

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

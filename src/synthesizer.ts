import type { ParticipantState, Contribution, Round, Objection } from "./types.js";
import type { PromptFn } from "./types.js";
import { buildSynthesisPrompt } from "./prompts.js";
import { formatTranscript } from "./warp-manager.js";
import { deriveConfidence, extractSection } from "./artifact.js";
import type { Artifact } from "./types.js";

export interface SynthesisResult {
  artifact: Artifact;
  output: string;
}

/** Produces the final deliberation artifact by prompting the synthesizer agent. */
export async function synthesize(
  question: string,
  rounds: Round[],
  weft: Contribution[],
  participants: ParticipantState[],
  objections: Objection[],
  synthesizer: ParticipantState,
  promptFn: PromptFn,
  getModel: (p: ParticipantState) => { providerID: string; modelID: string },
): Promise<SynthesisResult> {
  const transcript = formatTranscript(rounds, participants);
  const model = getModel(synthesizer);
  const userPrompt = buildSynthesisPrompt(question, transcript, participants);

  let artifactText: string;
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

  const artifact: Artifact = {
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

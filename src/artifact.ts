import type { Artifact, Objection, ParticipantState, Contribution, Round, PromptFn } from "./types.js";
import { buildSynthesisPrompt } from "./prompts.js";
import { formatTranscript } from "./warp-compaction.js";
import { splitModel } from "./tiers.js";

export async function generateArtifact(
  question: string,
  rounds: Round[],
  weft: Contribution[],
  participants: ParticipantState[],
  objections: Objection[],
  currentRound: number,
  synthesizer: ParticipantState,
  promptFn: PromptFn,
): Promise<{ artifact: Artifact; output: string }> {
  const transcript = formatTranscript(rounds, participants);
  const systemPrompt = `You are ${synthesizer.config.name} (${synthesizer.config.tier}). Your role is to synthesize the final deliberation output.

${synthesizer.tier_config.system_prompt_addendum}`;
  const userPrompt = buildSynthesisPrompt(question, transcript, participants);

  let artifactText: string;
  try {
    artifactText = await promptFn(systemPrompt, splitModel(synthesizer.tier_config.model), userPrompt);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    artifactText = `# Deliberation Output\n\nThe deliberation completed with ${weft.length} contributions across ${currentRound} rounds.\n\nSynthesis failed: ${message}\n\n## Raw Transcript\n${transcript}`;
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

export function deriveConfidence(
  weft: Contribution[],
  dissentCount: number,
): "high" | "medium" | "low" {
  const totalContribs = weft.length;
  const challengeRatio =
    weft.filter((c) => c.type === "challenge" || c.type === "dissent").length /
    Math.max(totalContribs, 1);

  if (dissentCount === 0 && challengeRatio < 0.3) return "high";
  if (dissentCount <= 1 && challengeRatio < 0.5) return "medium";
  return "low";
}

export function extractSection(text: string, sectionName: string): string[] {
  const lines = text.split("\n");
  const results: string[] = [];
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

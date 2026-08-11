import { buildSynthesisPrompt } from "./prompts.js";
import { formatTranscriptFromData } from "./warp-manager.js";
import { synthesizeFromData } from "./synthesizer.js";
import { extractText } from "./shared.js";

export class SynthesisCoordinator {
  #client;
  #directory;
  #sessionManager;

  constructor(client, directory, sessionManager) {
    this.#client = client;
    this.#directory = directory;
    this.#sessionManager = sessionManager;
  }

  selectSynthesizer(participants) {
    return (
      participants.find((p) => p.config.tier === "principal" && p.status !== "failed") ??
      participants.find((p) => p.config.tier === "senior" && p.status !== "failed") ??
      participants.find((p) => p.status !== "failed") ??
      participants[participants.length - 1]
    );
  }

  async run(transcriptData, participants, objections, synthesizer, getParticipantModel, onStart, onComplete) {
    if (!synthesizer) return "No participants available for synthesis.";

    if (onStart) onStart();
    await this.#sessionManager.postProgress("🔄 Synthesizing final output...");

    let artifactText;
    try {
      const synthSessionId = await this.#sessionManager.createSynthesizerSession(synthesizer);
      artifactText = await this.promptSynthesizerSession(synthSessionId, synthesizer, transcriptData, getParticipantModel);
    } catch (err) {
      this.#sessionManager.postProgress(`Synthesis session failed: ${err.message}`);
      artifactText = this.fallbackSynthesis(transcriptData);
    }

    const result = await synthesizeFromData(
      transcriptData,
      participants,
      objections,
      synthesizer,
      async () => artifactText,
      getParticipantModel,
    );

    await this.#sessionManager.postProgress("✅ Synthesis complete");

    if (onComplete) onComplete(result.output);
    return result.output;
  }

  async promptSynthesizerSession(sessionId, synthesizer, transcriptData, getParticipantModel) {
    const model = getParticipantModel(synthesizer);
    const transcript = formatTranscriptFromData(transcriptData, synthesizer);
    const userPrompt = buildSynthesisPrompt(transcriptData.question, transcript);

    const result = await this.#client.session.prompt({
      path: { id: sessionId },
      body: {
        system: `You are ${synthesizer.config.name} (${synthesizer.config.tier}). Synthesize the final output.\n\n${synthesizer.tier_config.system_prompt_addendum}`,
        model,
        parts: [{ type: "text", text: userPrompt }],
      },
      query: { directory: this.#directory },
    });

    if (result.error) {
      throw new Error(result.error.message || JSON.stringify(result.error));
    }

    const text = extractText(result.data);
    if (!text) {
      throw new Error("Synthesizer returned empty response");
    }
    return text;
  }

  fallbackSynthesis(transcriptData) {
    const contributions = transcriptData.rounds.flatMap((r) => r.contributions);
    const proposals = contributions.filter((c) => c.type === "propose" || c.type === "refine");
    const supports = contributions.filter((c) => c.type === "support");
    const challenges = contributions.filter((c) => c.type === "challenge" || c.type === "dissent");
    const questions = contributions.filter((c) => c.type === "question");

    let output = `## Decision\nSynthesis generation encountered an error. The following represents the key points from the deliberation.\n\n`;
    output += `## Key Proposals\n${proposals.map((c) => `- ${c.content}`).join("\n")}\n\n`;
    if (challenges.length > 0) {
      output += `## Dissenting Views\n${challenges.map((c) => `- ${c.content}`).join("\n")}\n\n`;
    }
    if (questions.length > 0) {
      output += `## Open Questions\n${questions.map((c) => `- ${c.content}`).join("\n")}\n\n`;
    }
    output += `## Confidence\nMedium (synthesis incomplete due to error)`;

    return output;
  }
}

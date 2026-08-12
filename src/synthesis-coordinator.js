import { buildSynthesisPrompt } from "./prompts.js";
import { formatTranscriptFromData } from "./warp-manager.js";
import { synthesizeFromData, validateSynthesisSections } from "./synthesizer.js";
import { extractText } from "./shared.js";
import { extractErrorInfo } from "./logger.js";

const MAX_SYNTHESIS_RETRIES = 2;
const REQUIRED_SECTIONS = ["Decision", "Reasoning", "Action Items", "Dissenting Views", "Open Questions", "Confidence"];

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
      artifactText = await this.#promptWithRetry(synthSessionId, synthesizer, transcriptData, getParticipantModel, participants);
    } catch (err) {
      const info = extractErrorInfo(err);
      await this.#sessionManager.postProgress(`Synthesis session failed: ${info.message}`);
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

  async #promptWithRetry(sessionId, synthesizer, transcriptData, getParticipantModel, allParticipants) {
    const model = getParticipantModel(synthesizer);
    const transcript = formatTranscriptFromData(transcriptData, allParticipants);
    const detectedDomain = transcriptData.domain || null;
    let additionalFeedback = "";

    for (let attempt = 0; attempt <= MAX_SYNTHESIS_RETRIES; attempt++) {
      const userPrompt = buildSynthesisPrompt(transcriptData.question, transcript, [], detectedDomain) + additionalFeedback;

      const result = await this.#client.session.prompt({
        path: { id: sessionId },
        body: {
          system: `You are a neutral deliberation analyst. Your only job is to fairly represent all perspectives from the deliberation, without favoring any participant's agenda. You synthesize diverse viewpoints into a clear, balanced, actionable output.`,
          model,
          temperature: synthesizer.tier_config.temperature,
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

      const missing = validateSynthesisSections(text);
      if (missing.length === 0 || attempt === MAX_SYNTHESIS_RETRIES) {
        return text;
      }

      additionalFeedback = `\n\nYour previous response was missing these required sections: ${missing.join(", ")}. Please include ALL of the following sections in your response: ${REQUIRED_SECTIONS.join(", ")}.`;
    }
  }

  async promptSynthesizerSession(sessionId, synthesizer, transcriptData, getParticipantModel) {
    return this.#promptWithRetry(sessionId, synthesizer, transcriptData, getParticipantModel);
  }

  fallbackSynthesis(transcriptData) {
    const contributions = transcriptData.rounds.flatMap((r) => r.contributions);
    const proposals = contributions.filter((c) => c.type === "propose" || c.type === "refine");
    const supports = contributions.filter((c) => c.type === "support");
    const challenges = contributions.filter((c) => c.type === "challenge" || c.type === "dissent");
    const questions = contributions.filter((c) => c.type === "question");

    let output = `## Decision\nSynthesis generation encountered an error. The following represents the key points from the deliberation.\n\n`;
    output += `## Reasoning\nFallback synthesis was used due to an error in the synthesis session.\n\n`;
    output += `## Action Items\n- Review the key proposals below\n- Re-run synthesis if needed\n\n`;
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

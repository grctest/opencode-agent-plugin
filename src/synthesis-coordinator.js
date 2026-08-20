import { buildSynthesisPrompt } from "./prompts.js";
import { formatFinalRoundTranscript } from "./fabric-manager.js";
import { finalizeSynthesis, validateSynthesisSections, NEUTRAL_SYNTHESIZER_SYSTEM } from "./synthesizer.js";
import { getConfig } from "./config.js";
import { extractErrorInfo } from "./logger.js";
import { incrementKeyedCounter, recordLatency } from "./metrics.js";

const MAX_CRITIQUE_RETRIES = 2;
const REQUIRED_SECTIONS = ["Decision", "Reasoning", "Action Items", "Dissenting Views", "Open Questions", "Confidence"];

export class SynthesisCoordinator {
  #sessionManager;

  constructor(sessionManager) {
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

  async run(transcriptData, participants, objections, synthesizer, getParticipantModel, onStart, onComplete, stateOfPlay = "") {
    if (!synthesizer) {
      return { output: "No participants available for synthesis.", artifact: null };
    }

    if (onStart) onStart();
    await this.#sessionManager.postProgress("🔄 Synthesizing final output...");

    let artifactText;
    try {
      const synthSessionId = await this.#sessionManager.createSynthesizerSession(synthesizer);
      const model = getParticipantModel(synthesizer);
      const transcript = formatFinalRoundTranscript(transcriptData, participants);
      artifactText = await this.#promptWithRetry(synthSessionId, synthesizer, transcriptData, transcript, model, participants, stateOfPlay, objections);
      // Second pass: have the synthesizer audit its own work against the transcript.
      artifactText = await this.#critique(synthSessionId, artifactText, transcript, model, synthesizer, participants);
    } catch (err) {
      const info = extractErrorInfo(err);
      await this.#sessionManager.postProgress(`Synthesis session failed: ${info.message}`);
      artifactText = this.fallbackSynthesis(transcriptData, stateOfPlay);
    }

    const result = finalizeSynthesis(artifactText, transcriptData, participants, objections);

    await this.#sessionManager.postProgress("✅ Synthesis complete");

    if (onComplete) onComplete(result.output);
    return result;
  }

  async #promptWithRetry(sessionId, synthesizer, transcriptData, transcript, model, allParticipants, stateOfPlay = "", objections = []) {
    let additionalFeedback = "";
    const maxRetries = getConfig().synthesisMaxRetries;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const userPrompt =
        buildSynthesisPrompt(transcriptData.question, transcript, allParticipants, transcriptData.tags ?? [], stateOfPlay, objections) +
        additionalFeedback;

      const llmStart = Date.now();
      const result = await this.#sessionManager.getContract().prompt({
        sessionId,
        system: NEUTRAL_SYNTHESIZER_SYSTEM,
        model,
        temperature: synthesizer.tier_config.temperature,
        parts: [{ type: "text", text: userPrompt }],
        timeoutMs: getConfig().synthesisTimeoutMs,
      });
      const llmMs = Date.now() - llmStart;
      incrementKeyedCounter("llm_calls_by_type", "synthesis");
      recordLatency("synthesis_ms", llmMs);

      if (!result.ok) {
        throw result.error;
      }

      const text = result.text;
      if (!text) {
        throw new Error("Synthesizer returned empty response");
      }

      const missing = validateSynthesisSections(text);
      if (missing.length === 0 || attempt === maxRetries) {
        return text;
      }

      additionalFeedback = `\n\nYour previous response was missing these required sections: ${missing.join(", ")}. Please include ALL of the following sections in your response: ${REQUIRED_SECTIONS.join(", ")}.`;
    }
  }

  /** Second-pass audit: the synthesizer reviews its draft for misrepresentation, then fixes (one cycle). */
  async #critique(sessionId, text, transcript, model, synthesizer, allParticipants) {
    let critiquePrompt = `You are a neutral deliberation analyst reviewing your own synthesis.

Review the draft below against the deliberation transcript for:
1. Misattributed views (a point credited to the wrong participant)
2. Invented points not present in the deliberation
3. Significant dissent that was omitted from "Dissenting Views"
4. Decisions or action items not supported by any contribution

If corrections are needed, output the FULL revised synthesis with ALL required sections:
## Decision
## Reasoning
## Action Items
## Dissenting Views
## Open Questions
## Confidence

If the draft is accurate and complete, respond with exactly: [NO_CHANGES]

Draft synthesis:
${text.slice(0, 6000)}`;

    for (let attempt = 0; attempt < MAX_CRITIQUE_RETRIES; attempt++) {
      try {
        const result = await this.#sessionManager.getContract().prompt({
          sessionId,
          system: NEUTRAL_SYNTHESIZER_SYSTEM,
          model,
          temperature: synthesizer.tier_config.temperature,
          parts: [{ type: "text", text: critiquePrompt }],
          timeoutMs: getConfig().synthesisTimeoutMs,
        });

        if (!result.ok) throw result.error;
        const text2 = result.text;
        if (!text2 || !text2.trim()) return text;

        if (/^\[NO_CHANGES\]\s*$/i.test(text2.trim())) {
          return text;
        }

        const missing = validateSynthesisSections(text2);
        if (missing.length === 0) {
          return text2;
        }
        // If the revision dropped sections, re-prompt the SAME draft with feedback
        const feedback = `\n\nYour revised synthesis was missing these required sections: ${missing.join(", ")}. Output the FULL revised synthesis with ALL sections: ${REQUIRED_SECTIONS.join(", ")}.`;
        critiquePrompt = `${critiquePrompt}\n\nFeedback: ${feedback}`;
      } catch (err) {
        const info = extractErrorInfo(err);
        await this.#sessionManager.postProgress(`Synthesis critique failed: ${info.message}. Using the original draft.`);
        return text;
      }
    }
    return text;
  }

  fallbackSynthesis(transcriptData, stateOfPlay = "") {
    if (stateOfPlay) {
      return `## Decision
Synthesis session failed. The following State of Play represents the
consolidated deliberation state at the time of failure.

## Reasoning
Fallback: State of Play used as primary artifact. This captures the key
decisions, agreements, disagreements, and open questions from the deliberation.

## Action Items
- Review the Decisions and Open Questions below
- Re-run synthesis for a full structured artifact

${stateOfPlay}

## Confidence
Low (synthesis incomplete — State of Play fallback)`;
    }

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

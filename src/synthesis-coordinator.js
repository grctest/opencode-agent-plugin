import { buildSynthesisPrompt } from "./prompts/synthesis.js";
import { formatFinalRoundTranscript } from "./state-of-play.js";
import { finalizeSynthesis, validateSynthesisSections, NEUTRAL_SYNTHESIZER_SYSTEM } from "./synthesizer.js";
import { getConfig } from "./config.js";
import { TUNING } from "./config/defaults.js";
import { extractErrorInfo } from "./logger.js";
import { incrementKeyedCounter, recordLatency } from "./metrics.js";
import { withRetry, isRetryableError } from "./utils/retry.js";

function getMaxCritiqueRetries() { try { return getConfig()?.tuning?.MAX_CRITIQUE_RETRIES ?? TUNING.MAX_CRITIQUE_RETRIES; } catch { return TUNING.MAX_CRITIQUE_RETRIES; } }
// Core required: Executive Summary + Reasoning + Confidence; Decision optional when open-ended (see validateSynthesisSections)
// Action Items / Proposed Fix group — at least one must be present
const REQUIRED_SECTIONS = ["Executive Summary", "Reasoning", "Confidence", "Dissenting Views", "Open Questions"];
const REQUIRED_ACTION_GROUP = ["Action Items", "Proposed Fix"];

export class SynthesisCoordinator {
  #sessionManager;

  constructor(sessionManager) {
    this.#sessionManager = sessionManager;
  }

  selectSynthesizer(participants) {
    const nonFailed = participants.filter((p) => p.status !== "failed");
    if (nonFailed.length === 0) return null;
    return (
      nonFailed.find((p) => p.config.tier === "principal") ??
      nonFailed.find((p) => p.config.tier === "senior") ??
      nonFailed[0]
    );
  }

  async run(transcriptData, participants, objections, synthesizer, getParticipantModel, onStart, onComplete, stateOfPlay = "", userContext = "") {
    if (!synthesizer) {
      return { output: "No participants available for synthesis.", artifact: null };
    }

    if (onStart) onStart();
    await this.#sessionManager.postProgress("🔄 Synthesizing final output...");

    let artifactText;
    let synthSessionId = null;
    try {
      synthSessionId = await this.#sessionManager.createSynthesizerSession(synthesizer);
      const model = getParticipantModel(synthesizer);
      const transcript = formatFinalRoundTranscript(transcriptData, participants);
      artifactText = await this.#promptWithRetry(synthSessionId, synthesizer, transcriptData, transcript, model, participants, stateOfPlay, objections, userContext);
      artifactText = await this.#critique(synthSessionId, artifactText, transcript, transcriptData, model, synthesizer, participants);
    } catch (err) {
      const info = extractErrorInfo(err);
      await this.#sessionManager.postProgress(`Synthesis session failed: ${info.message}`, "error");
      artifactText = this.fallbackSynthesis(transcriptData, stateOfPlay);
    } finally {
      if (synthSessionId) {
        try { await this.#sessionManager.deleteEphemeralSession(synthSessionId); } catch {}
      }
    }

    const result = finalizeSynthesis(artifactText, transcriptData, participants, objections);

    await this.#sessionManager.postProgress("✅ Synthesis complete");

    if (onComplete) onComplete(result.output);
    return result;
  }

  async #promptWithRetry(sessionId, synthesizer, transcriptData, transcript, model, allParticipants, stateOfPlay = "", objections = [], userContext = "") {
    let additionalFeedback = "";
    const rawMaxRetries = getConfig().synthesisMaxRetries;
    const maxRetries = Number.isFinite(rawMaxRetries) ? rawMaxRetries : 1;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const userPrompt =
        buildSynthesisPrompt(transcriptData.question, transcript, allParticipants, transcriptData.tags ?? [], stateOfPlay, objections, userContext) +
        additionalFeedback;

      const llmStart = Date.now();
      const result = await withRetry(async () => {
        const r = await this.#sessionManager.getContract().prompt({
          sessionId,
          system: NEUTRAL_SYNTHESIZER_SYSTEM,
          model,
          temperature: synthesizer.tier_config.temperature,
          parts: [{ type: "text", text: userPrompt }],
          timeoutMs: getConfig().synthesisTimeoutMs,
        });
        if (!r.ok) throw r.error;
        return r;
      }, { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2000, retryable: isRetryableError });
      const llmMs = Date.now() - llmStart;
      incrementKeyedCounter("llm_calls_by_type", "synthesis");
      recordLatency("synthesis_ms", llmMs);

      const text = result.text;
      if (!text) {
        throw new Error("Synthesizer returned empty response");
      }

      const missing = validateSynthesisSections(text);
      if (missing.length === 0 || attempt === maxRetries) {
        return text;
      }

      const missingNote = missing.includes("Action Items")
        ? `${missing.join(", ")} (for code-analysis, Proposed Fix may satisfy Action Items)`
        : missing.join(", ");
      const requiredNote = `${REQUIRED_SECTIONS.join(", ")} plus at least one of ${REQUIRED_ACTION_GROUP.join(" / ")}`;
      additionalFeedback = `\n\nYour previous response was missing these required sections: ${missingNote}. Please include ALL of the following sections in your response: ${requiredNote}.`;
    }
  }

  /** Second-pass audit: the synthesizer reviews its draft for grounding, then fixes. */
  async #critique(sessionId, text, transcript, transcriptData, model, synthesizer, allParticipants) {
    // Backward compat: if caller passes model as 3rd arg, shift
    if (typeof transcriptData === "object" && transcriptData !== null && "providerID" in transcriptData) {
      // transcriptData is actually model, shift args
      allParticipants = synthesizer;
      synthesizer = model;
      model = transcriptData;
      transcriptData = null;
    }
    const chunkText = (t, lim) => {
      if (t.length <= lim) return [t];
      // Prefer splitting at section boundaries; if still >lim, hard chunk
      const parts = t.split(/\n(?=##\s)/);
      const chunks = [];
      let cur = "";
      for (const p of parts) {
        if ((cur + "\n" + p).length > lim && cur) { chunks.push(cur); cur = p; }
        else cur = cur ? cur + "\n" + p : p;
      }
      if (cur) chunks.push(cur);
      // Hard-split any oversized chunk
      const out = [];
      for (const c of chunks) {
        if (c.length <= lim) out.push(c);
        else for (let i=0;i<c.length;i+=lim) out.push(c.slice(i,i+lim));
      }
      return out;
    };
    const draftChunks = chunkText(text, 8000);
    const draftForPrompt = draftChunks.length === 1
      ? draftChunks[0]
      : draftChunks.map((c,i)=>`--- Draft chunk ${i+1}/${draftChunks.length} ---\n${c}`).join("\n\n");
    // Build transcript snippet — thorough, not tiny: include unresolved dissent fully + file mentions + last 2 rounds fuller
    let transcriptSnippet = "";
    try {
      if (transcriptData && Array.isArray(transcriptData.rounds) && transcriptData.rounds.length > 0) {
        const rounds = transcriptData.rounds;
        const lastTwo = rounds.slice(-2);
        const earlier = rounds.slice(0, -2);
        const contested = [];
        const fileMentions = [];
        for (const r of earlier) {
          for (const c of (r.contributions || [])) {
            if (c.type === "challenge" || c.type === "dissent" || c.type === "critique_response" || c.type === "perspective_response") contested.push(c);
            if (/(?:file\s*=\s*[^\s]+\.\w+|src\/[^\s]+\.\w+|\b\w+\.(?:tsx|ts|js|jsx)\b|```)/i.test(String(c.content))) fileMentions.push(c);
          }
        }
        // Top 4 contested, 4 file mentions — thoroughness
        const topContested = contested.slice(-4);
        const topFiles = fileMentions.slice(-4);
        const parts = [];
        if (topContested.length > 0) {
          parts.push(`### Most contested earlier (top 4)\n` + topContested.map(c => `- [#${c.id}] ${c.participant_id} [${c.type}]: ${String(c.content).slice(0, 400)}`).join("\n"));
        }
        if (topFiles.length > 0) {
          parts.push(`### File mentions earlier (top 4)\n` + topFiles.map(c => `- [#${c.id}] ${c.participant_id} [${c.type}]: ${String(c.content).slice(0, 400)}`).join("\n"));
        }
        // Last two rounds fuller — 400 chars each contribution
        const lastTwoText = lastTwo.map(r => {
          const cs = (r.contributions || []).map(c => `- [#${c.id}] ${c.participant_id} [${c.type}]: ${String(c.content).slice(0, 400)}`).join("\n");
          return `### Round ${r.number} (last)\n${cs || "(no contributions)"}`;
        }).join("\n\n");
        parts.push(lastTwoText);
        const combined = parts.join("\n\n");
        transcriptSnippet = combined.slice(0, 12000);
        // Fallback to head if combined empty
        if (!transcriptSnippet.trim()) transcriptSnippet = transcript.slice(0, 12000);
      } else {
        transcriptSnippet = transcript.slice(0, 12000);
      }
    } catch {
      transcriptSnippet = transcript.slice(0, 12000);
    }

    let critiquePrompt = `You are a synthesis auditor reviewing your own synthesis for grounding. You prefer longer, thorough deliberation — do not suppress dissent to fake consensus. Support both conversational and code-analysis (plan/build) tasks. Dissent is valuable. Concise but thorough.

Audit checklist (be strict but human-first):
1. Grounding: any Decision/Action Item/Proposed Fix block lacking a grouped [#id]/State-of-Play/Source cite nor marked “Proposed — synthesized from [#id]” — those must be marked or cited. Grouped per block is fine; don’t demand per-sentence. Never allow vec: / vec round traces.
2. Attribution: is every Dissenting View credited to correct holder + [#id] + one-line evidence? Merge duplicates from same holder on same evidence (combine [#ids]). Any omitted significant dissent — retrieve and add.
3. Invention: any number, date, cost, tool result, or file content not in transcript/State-of-Play nor marked Proposed?
4. Support: any Decision/Action Item/Proposed Fix not supported by at least one contribution or Proposed marking — mark Proposed or cite.
5. Resolved vs Dissent: if Resolved Concerns exists, ensure none reappear as dissent and each resolved is ≤30w summary, not full critique dump.
6. Confidence: does Confidence justification match rubric? High may have bounded dissent if thorough + grounded — dissent alone is not Low.
7. Human-first: does Executive Summary exist and read cleanly without citation spam? Are Decision table cells concise (Evidence 30-35w + one cite, Tradeoff 30-35w), not paragraphs? Is Reasoning deduplicated vs Decision (not copy-paste)?
8. Citation hygiene: no vec: / vec round / [Round X vec] leaked; one grouped cite per block, not spam.

Transcript excerpt for grounding check (thorough slice — top 4 contested + top 4 file mentions + last 2 rounds fuller):
${transcriptSnippet}

If corrections are needed, output the FULL revised synthesis with ALL required sections in order:
## Executive Summary
## Decision
## Reasoning
${text.toLowerCase().includes("proposed fix") || (transcriptData && String(transcriptData.question||"").toLowerCase().match(/react|src\/|\.tsx|\.ts|bug|in this folder|code/)) ? "## Proposed Fix\n## Action Items\n" : "## Action Items\n"}## Dissenting Views
## Open Questions
## Confidence

If the draft is accurate, grounded, human-readable, and complete, respond with exactly: [NO_CHANGES]

Draft synthesis${draftChunks.length>1?` (${draftChunks.length} chunks)`: ""}:
${draftForPrompt}`;

    for (let attempt = 0; attempt < getMaxCritiqueRetries(); attempt++) {
      try {
        const result = await withRetry(async () => {
          const r = await this.#sessionManager.getContract().prompt({
            sessionId,
            system: NEUTRAL_SYNTHESIZER_SYSTEM,
            model,
            temperature: synthesizer.tier_config.temperature,
            parts: [{ type: "text", text: critiquePrompt }],
            timeoutMs: getConfig().synthesisTimeoutMs,
          });
          if (!r.ok) throw r.error;
          return r;
        }, { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2000, retryable: isRetryableError });
        const text2 = result.text;
        if (!text2 || !text2.trim()) return text;

        if (/^\[NO_CHANGES\]\s*$/i.test(text2.trim())) {
          return text;
        }

        const missing = validateSynthesisSections(text2);
        if (missing.length === 0) {
          return text2;
        }
        // If the revision dropped sections, re-prompt the SAME draft with feedback (group-aware)
        const missingNote2 = missing.includes("Action Items")
          ? `${missing.join(", ")} (Proposed Fix may satisfy Action Items for code-analysis)`
          : missing.join(", ");
        const feedback = `\n\nYour revised synthesis was missing these required sections: ${missingNote2}. Output the FULL revised synthesis with ALL sections: ${REQUIRED_SECTIONS.join(", ")} plus ${REQUIRED_ACTION_GROUP.join(" / ")}.`;
        critiquePrompt = `${critiquePrompt}\n\nFeedback: ${feedback}`;
      } catch (err) {
        const info = extractErrorInfo(err);
        await this.#sessionManager.postProgress(`Synthesis critique failed: ${info.message}. Using the original draft.`, "warn");
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

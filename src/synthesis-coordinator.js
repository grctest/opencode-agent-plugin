import { buildSynthesisPrompt, detectTaskMode } from "./prompts/synthesis.js";
import { formatFinalRoundTranscript } from "./state-of-play.js";
import { finalizeSynthesis, validateSynthesisSections, NEUTRAL_SYNTHESIZER_SYSTEM, SYNTHESIS_SECTION_CONTRACT } from "./synthesizer.js";
import { getConfig } from "./config.js";
import { TUNING } from "./config/defaults.js";
import { LoomError, extractErrorInfo } from "./logger.js";
import { incrementKeyedCounter, recordLatency } from "./metrics.js";
import { withRetry, isRetryableError } from "./utils/retry.js";
import { SUBSTANTIVE_TYPES } from "./utils/contribution-types.js";
import { buildOrchestratorInstruction, getSynthesisGuidance, normalizeOrchestratorConfig } from "./orchestrator/models.js";

function getMaxCritiqueRetries() { try { return getConfig()?.tuning?.MAX_CRITIQUE_RETRIES ?? TUNING.MAX_CRITIQUE_RETRIES; } catch { return TUNING.MAX_CRITIQUE_RETRIES; } }
// Section requirements derive from the single contract table in synthesizer.js
// (audit D10) — prompt text and repair feedback cannot drift apart.
const REQUIRED_SECTIONS = [...SYNTHESIS_SECTION_CONTRACT.core, ...SYNTHESIS_SECTION_CONTRACT.always];
const REQUIRED_ACTION_GROUP = [...SYNTHESIS_SECTION_CONTRACT.actionGroup];

export function buildOrchestratorSynthesisSystem(config = {}) {
  // Scoped operator block (role + custom only; posture lives in the user-prompt
  // doctrine) injected here because synthesis bypasses _promptOrchestrator and
  // calls the contract directly — this remains the single injection point for
  // this path, so the verbatim duplication is gone (audit O2/Step 1).
  const instruction = buildOrchestratorInstruction(config, "synthesis");
  const body = `${NEUTRAL_SYNTHESIZER_SYSTEM}\n\n${getSynthesisGuidance(config)}`;
  return instruction ? `${instruction}\n\n${body}` : body;
}

/**
 * Clamps technical_audit to a code-free variant on non-code questions (audit
 * O8/Step 3): the file-centric framing otherwise invites fabricated file
 * references that the conversational grounding rule does not forbid.
 */
export function getEffectiveSynthesisStyle(config = {}, question, tags = []) {
  const style = normalizeOrchestratorConfig(config).synthesisStyle;
  if (style === "technical_audit" && detectTaskMode(question, tags) !== "code-analysis") {
    return "technical_audit_conversational";
  }
  return style;
}

export class SynthesisCoordinator {
  #sessionManager;
  #orchestratorConfig;

  constructor(sessionManager, orchestratorConfig = {}) {
    this.#sessionManager = sessionManager;
    this.#orchestratorConfig = orchestratorConfig;
  }

  #orchestratorSynthesisSystem(config = this.#orchestratorConfig) {
    return buildOrchestratorSynthesisSystem(config);
  }

  async run({ transcriptData, participants, objections, model, onStart, onComplete, stateOfPlay = "", userContext = "" }) {
    if (!model?.providerID || !model?.modelID) {
      throw new LoomError("No orchestrator model available for final synthesis", { phase: "synthesis", recoverable: false });
    }

    if (onStart) onStart();
    await this.#sessionManager.postProgress("🔄 Synthesizing final output...");

    let artifactText;
    let synthSessionId = null;
    try {
      synthSessionId = await this.#sessionManager.createOrchestratorSynthesisSession();
      const transcript = formatFinalRoundTranscript(transcriptData, participants);
      // Effective style: technical_audit is clamped to its code-free variant on
      // non-code questions (audit O8). Threaded through draft + critique.
      const effectiveConfig = {
        ...this.#orchestratorConfig,
        synthesisStyle: getEffectiveSynthesisStyle(this.#orchestratorConfig, transcriptData.question, transcriptData.tags),
      };
      artifactText = await this.#promptWithRetry(synthSessionId, transcriptData, transcript, model, participants, stateOfPlay, objections, userContext, effectiveConfig);
      artifactText = await this.#critique(synthSessionId, artifactText, transcript, transcriptData, model, participants, effectiveConfig);
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

  async #promptWithRetry(sessionId, transcriptData, transcript, model, allParticipants, stateOfPlay = "", objections = [], userContext = "", effectiveConfig = this.#orchestratorConfig) {
    let additionalFeedback = "";
    const rawMaxRetries = getConfig().synthesisMaxRetries;
    const maxRetries = Number.isFinite(rawMaxRetries) ? rawMaxRetries : 1;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const userPrompt =
        buildSynthesisPrompt(transcriptData.question, transcript, allParticipants, transcriptData.tags ?? [], stateOfPlay, objections, userContext, { buildMode: transcriptData.buildMode, decisionPosture: effectiveConfig?.decisionPosture }) +
        additionalFeedback;

      const llmStart = Date.now();
      const result = await withRetry(async () => {
        const r = await this.#sessionManager.getContract().prompt({
          sessionId,
          system: this.#orchestratorSynthesisSystem(effectiveConfig),
          model,
          parts: [{ type: "text", text: userPrompt }],
          timeoutMs: getConfig().synthesisTimeoutMs,
        });
         if (!r.ok) throw r.error;
         this.#sessionManager.recordTokens?.(r.tokens);
         return r;
      }, { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2000, retryable: isRetryableError });
      const llmMs = Date.now() - llmStart;
      incrementKeyedCounter("llm_calls_by_type", "synthesis");
      recordLatency("synthesis_ms", llmMs);

      const text = result.text;
      if (!text) {
        throw new Error("Orchestrator synthesis returned empty response");
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
  async #critique(sessionId, text, transcript, transcriptData, model, allParticipants, effectiveConfig = this.#orchestratorConfig) {
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
             if (c.type === "challenge" || c.type === "dissent" || c.type === "critique_response" || c.type === "perspective_response" || /\b(challenge|dissent|disagree|concern|oppose|dispute|contradict|risk|flaw|weakness)\b/i.test(String(c.content ?? ""))) contested.push(c);
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

    // No style-framing sentence here: the 8-point checklist below is the
    // substantive instruction, and re-asserting the framing would compete with
    // it for attention (audit O11). The effective style already governs the draft.
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

Transcript excerpt for grounding check (thorough slice — top 4 contested + top 4 file mentions + last 2 rounds fuller).
Note: this excerpt is partial — the author saw the full transcript. Flag only issues visible in this excerpt; do not invent problems in rounds you cannot see (audit D3).
${transcriptSnippet}

If corrections are needed, output the FULL revised synthesis with ALL required sections in order:
## Executive Summary
## Decision
## Reasoning
${text.toLowerCase().includes("proposed fix") || detectTaskMode(transcriptData?.question, transcriptData?.tags) === "code-analysis" ? "## Proposed Fix\n## Action Items\n" : "## Action Items\n"}## Dissenting Views
## Open Questions
## Confidence

If the draft is accurate, grounded, human-readable, and complete, respond with exactly: [NO_CHANGES]

Draft synthesis${draftChunks.length>1?` (${draftChunks.length} chunks)`: ""}:
${draftForPrompt}`;

    // Track the best revision seen: a better-but-incomplete revision on the final
    // attempt must not be silently discarded in favour of the original (audit D2).
    let best = text;
    let bestMissing = validateSynthesisSections(text).length;
    let prevMissing = bestMissing;
    for (let attempt = 0; attempt < getMaxCritiqueRetries(); attempt++) {
      try {
        const result = await withRetry(async () => {
          const r = await this.#sessionManager.getContract().prompt({
            sessionId,
            system: this.#orchestratorSynthesisSystem(effectiveConfig),
            model,
            parts: [{ type: "text", text: critiquePrompt }],
            timeoutMs: getConfig().synthesisTimeoutMs,
          });
           if (!r.ok) throw r.error;
           this.#sessionManager.recordTokens?.(r.tokens);
          return r;
        }, { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2000, retryable: isRetryableError });
        const text2 = result.text;
        if (!text2 || !text2.trim()) return best;

        if (/^\[NO_CHANGES\]\s*$/i.test(text2.trim())) {
          return text;
        }

        const missing = validateSynthesisSections(text2);
        if (missing.length < bestMissing) {
          best = text2;
          bestMissing = missing.length;
        }
        if (missing.length === 0) {
          return text2;
        }
        // No progress across attempts — stop burning full-prompt calls (audit D2).
        if (attempt > 0 && missing.length >= prevMissing) {
          break;
        }
        prevMissing = missing.length;
        // If the revision dropped sections, re-prompt the SAME draft with feedback (group-aware)
        const missingNote2 = missing.includes("Action Items")
          ? `${missing.join(", ")} (Proposed Fix may satisfy Action Items for code-analysis)`
          : missing.join(", ");
        const feedback = `\n\nYour revised synthesis was missing these required sections: ${missingNote2}. Output the FULL revised synthesis with ALL sections: ${REQUIRED_SECTIONS.join(", ")} plus ${REQUIRED_ACTION_GROUP.join(" / ")}.`;
        critiquePrompt = `${critiquePrompt}\n\nFeedback: ${feedback}`;
      } catch (err) {
        const info = extractErrorInfo(err);
        await this.#sessionManager.postProgress(`Synthesis critique failed: ${info.message}. Using the original draft.`, "warn");
        return best;
      }
    }
    return best;
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

    // Primary turns are untyped "contribution" — legacy propose/refine/challenge
    // filters match zero rows on any modern meeting, rendering an empty artifact
    // (audit D6). Filter on the live substantive set and classify by keywords,
    // mirroring collectObjections, with per-bullet bounds so one long
    // contribution cannot produce a multi-kB "fallback".
    const contributions = transcriptData.rounds.flatMap((r) => r.contributions);
    const substantive = contributions.filter((c) => c.type !== "pass" && (SUBSTANTIVE_TYPES.has(c.type) || c.type === "contribution"));
    const oneLine = (c, max = 300) => String(c.content ?? "").replace(/\s+/g, " ").trim().slice(0, max);
    const proposals = substantive.filter((c) => /\bwe should\b|\bpropose\b|\bdecision\b|\badopt\b/i.test(String(c.content ?? ""))).slice(0, 8);
    const challenges = substantive.filter((c) => c.type === "critique_response" || /\bchallenge\b|\bdissent\b|\bdisagree\b|\bconcern\b|\boppose\b|\brisk\b|\bflaw\b|\bweakness\b/i.test(String(c.content ?? ""))).slice(0, 8);
    const questions = substantive.filter((c) => /\?\s*$/.test(String(c.content ?? "").trim())).slice(0, 8);

    let output = `## Decision\nSynthesis generation encountered an error. The following represents the key points from the deliberation.\n\n`;
    output += `## Reasoning\nFallback synthesis was used due to an error in the synthesis session.\n\n`;
    output += `## Action Items\n- Review the key proposals below\n- Re-run synthesis if needed\n\n`;
    output += `## Key Proposals\n${proposals.map((c) => `- ${oneLine(c)}`).join("\n")}\n\n`;
    if (challenges.length > 0) {
      output += `## Dissenting Views\n${challenges.map((c) => `- ${oneLine(c)}`).join("\n")}\n\n`;
    }
    if (questions.length > 0) {
      output += `## Open Questions\n${questions.map((c) => `- ${oneLine(c)}`).join("\n")}\n\n`;
    }
    output += `## Confidence\nMedium (synthesis incomplete due to error)`;

    return output;
  }
}

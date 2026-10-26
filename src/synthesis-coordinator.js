import { buildSynthesisPrompt, resolveTaskMode } from "./prompts/synthesis.js";
import { formatFinalRoundTranscript } from "./state-of-play.js";
import { finalizeSynthesis, validateSynthesisSections, buildNeutralSynthesizerSystem, SYNTHESIS_SECTION_CONTRACT } from "./synthesizer.js";
import { getConfig } from "./config.js";
import { TUNING } from "./config/defaults.js";
import { LoomError, extractErrorInfo } from "./logger.js";
import { incrementKeyedCounter, recordLatency, recordMeetingCall, recordMeetingLatency } from "./metrics.js";
import { withRetry, isRetryableError } from "./utils/retry.js";
import { SUBSTANTIVE_TYPES } from "./utils/contribution-types.js";
import { computeEngagementMetrics, findUncitedPlainContributions } from "./round-summarizer.js";
import { buildOrchestratorInstruction, getSynthesisGuidance, normalizeOrchestratorConfig } from "./orchestrator/models.js";

function getMaxCritiqueRetries() { try { return getConfig()?.tuning?.MAX_CRITIQUE_RETRIES ?? TUNING.MAX_CRITIQUE_RETRIES; } catch { return TUNING.MAX_CRITIQUE_RETRIES; } }
// Section requirements derive from the single contract table in synthesizer.js
// (audit D10) — prompt text and repair feedback cannot drift apart.
const REQUIRED_SECTIONS = [...SYNTHESIS_SECTION_CONTRACT.core, ...SYNTHESIS_SECTION_CONTRACT.always];
const REQUIRED_ACTION_GROUP = [...SYNTHESIS_SECTION_CONTRACT.actionGroup];

/**
 * N8 — peer-engagement ledger for the synthesis prompt: the plain
 * contributions that engage no peer, with their ids, so the auditor can close
 * each one by citing, synthesizing, or naming it superseded.
 * @param {{rounds?: Array<{contributions?: Array}>}} transcriptData
 */
export function computeEngagementLedger(transcriptData) {
  const weave = (transcriptData?.rounds ?? []).flatMap((r) => r.contributions ?? []);
  const metrics = computeEngagementMetrics(weave);
  return {
    ...metrics,
    uncited_plain_ids: findUncitedPlainContributions(weave).map((c) => c.id),
  };
}

export function buildOrchestratorSynthesisSystem(config = {}, contextWindow = null) {
  // Scoped operator block (role + custom only; posture lives in the user-prompt
  // doctrine) injected here because synthesis bypasses _promptOrchestrator and
  // calls the contract directly — this remains the single injection point for
  // this path, so the verbatim duplication is gone (audit O2/Step 1).
  const instruction = buildOrchestratorInstruction(config, "synthesis");
  const body = `${buildNeutralSynthesizerSystem(contextWindow)}\n\n${getSynthesisGuidance(config)}`;
  return instruction ? `${instruction}\n\n${body}` : body;
}

/**
 * Clamps technical_audit to a code-free variant on non-code questions (audit
 * O8/Step 3): the file-centric framing otherwise invites fabricated file
 * references that the conversational grounding rule does not forbid.
 */
export function getEffectiveSynthesisStyle(config = {}, question, tags = [], taskMode) {
  const style = normalizeOrchestratorConfig(config).synthesisStyle;
  if (style === "technical_audit" && resolveTaskMode(question, tags, { taskMode }) !== "code-analysis") {
    return "technical_audit_conversational";
  }
  return style;
}

export class SynthesisCoordinator {
  #sessionManager;
  #orchestratorConfig;
  #runMeetingId = null;
  // The orchestrator model's real context window, resolved by the caller.
  // Both the system prompt and the user prompt announce it, so the
  // synthesizer never writes to a budget it does not have (audit C3).
  #contextWindow = null;
  // The character budget for the synthesis transcript, derived from the
  // orchestrator model's context window.
  #transcriptBudgetChars = null;
  // The meeting's halt signal. A synthesis that is already in flight when the
  // user cancels must die with it — otherwise "Cancel run" would still leave
  // two LLM calls running.
  #haltSignal = null;

  constructor(sessionManager, orchestratorConfig = {}) {
    this.#sessionManager = sessionManager;
    this.#orchestratorConfig = orchestratorConfig;
  }

  /**
   * Bind the synthesis prompts to the meeting's halt signal.
   * @param {AbortSignal|null} signal
   */
  setHaltSignal(signal) {
    this.#haltSignal = signal ?? null;
  }

  /** True when the meeting has been stopped on purpose. */
  #halted() {
    return !!this.#haltSignal?.aborted;
  }

  #orchestratorSynthesisSystem(config = this.#orchestratorConfig) {
    return buildOrchestratorSynthesisSystem(config, this.#contextWindow);
  }

  async run({ transcriptData, participants, model, onStart, onComplete, stateOfPlay = "", userContext = "", onActivity = null, meetingId = null, contextWindow = null, transcriptBudgetChars = null }) {
    this.#runMeetingId = meetingId ?? null;
    this.#contextWindow = Number.isFinite(contextWindow) ? contextWindow : null;
    // The transcript budget is the MODEL'S WINDOW (audit B), not a constant:
    // the old fixed 24k characters cut the final round first and left the
    // synthesizer seeing 7% of a ten-round deliberation.
    this.#transcriptBudgetChars = Number.isFinite(transcriptBudgetChars) && transcriptBudgetChars > 0
      ? transcriptBudgetChars
      : null;
    if (!model?.providerID || !model?.modelID) {
      throw new LoomError("No orchestrator model available for final synthesis", { phase: "synthesis", recoverable: false });
    }

    if (onStart) onStart();
    await this.#sessionManager.postProgress("🔄 Synthesizing final output...");
    // Heartbeat while synthesis pends: proves the meeting is alive so the
    // stall watchdog never kills a legal long synthesis (no weave-growth
    // probe here — synthesis has no inline tools, wall clock + touch apply).
    const heartbeat = typeof onActivity === "function" ? onActivity : null;

    let artifactText;
    let synthSessionId = null;
    // Effective style: technical_audit is clamped to its code-free variant on
    // non-code questions (audit O8). Threaded through draft + critique, and
    // into the final artifact validation (audit B4) — so it is built BEFORE
    // the try block, not inside it.
    const effectiveConfig = {
      ...this.#orchestratorConfig,
      synthesisStyle: getEffectiveSynthesisStyle(this.#orchestratorConfig, transcriptData.question, transcriptData.tags, transcriptData.taskMode),
    };
    try {
      synthSessionId = await this.#sessionManager.createOrchestratorSynthesisSession();
      const transcript = formatFinalRoundTranscript(transcriptData, participants, { budgetChars: this.#transcriptBudgetChars ?? undefined });
      artifactText = await this.#promptWithRetry(synthSessionId, transcriptData, transcript, model, participants, stateOfPlay, userContext, effectiveConfig, heartbeat);
      artifactText = await this.#critique(synthSessionId, artifactText, transcript, transcriptData, model, participants, effectiveConfig, heartbeat);
    } catch (err) {
      const info = extractErrorInfo(err);
      await this.#sessionManager.postProgress(`Synthesis session failed: ${info.message}`, "error");
      artifactText = this.fallbackSynthesis(transcriptData, stateOfPlay);
    } finally {
      if (synthSessionId) {
        try { await this.#sessionManager.deleteEphemeralSession(synthSessionId); } catch {}
      }
    }

    const result = finalizeSynthesis(artifactText, transcriptData, participants, {
      synthesisStyle: effectiveConfig?.synthesisStyle,
    });
    // The deliverable states its own provenance (audit H): the reader can see
    // how much deliberation it rests on, whether a ballot was held, and what
    // fraction of the room it represents. Every number is already known here —
    // the coverage figure was computed by finalizeSynthesis and hidden in the
    // artifact JSON, where no reader would ever see it.
    const withProvenance = this.#appendProvenance(result, transcriptData, participants);

    await this.#sessionManager.postProgress("✅ Synthesis complete");

    if (onComplete) onComplete(withProvenance.output);
    return withProvenance;
  }

  /**
   * Appends a factual provenance footer to the artifact (audit H).
   *
   * Deliberate, deterministic, and short: the deliberation's scale (rounds,
   * contributions, participants), whether a BALLOT was held — two of the three
   * recorded meetings held none, and the reader could not tell that a
   * Decision Rule was prose rather than a tally — and the share of the room's
   * contributions the artifact actually cites. A deliverable that states its
   * own coverage is worth more than one that quietly implies completeness.
   */
  #appendProvenance(result, transcriptData, participants) {
    try {
      const weave = (transcriptData?.rounds ?? []).flatMap((r) => r.contributions ?? []);
      const substantive = weave.filter((c) => c.type !== "pass");
      const ballotRows = weave.filter((c) => c.type === "vote_response");
      const ballots = ballotRows.length;
      const votes = new Set(ballotRows.map((c) => c.batch_id ?? c.id)).size;
      const coverage = result?.artifact?.engagement?.coverage;
      const bits = [
        `${(transcriptData?.rounds ?? []).length} round${(transcriptData?.rounds ?? []).length === 1 ? "" : "s"}`,
        `${substantive.length} contribution${substantive.length === 1 ? "" : "s"}`,
        `${(participants ?? []).length} participant${(participants ?? []).length === 1 ? "" : "s"}`,
        ballots > 0
          ? `${votes} vote${votes === 1 ? "" : "s"} held (${ballots} ballot${ballots === 1 ? "" : "s"})`
          : "no ballot held",
      ];
      if (Number.isFinite(coverage)) {
        bits.push(`${Math.round(coverage * 100)}% of contributions cited in this artifact`);
      }
      const footer = `\n\n---\n*Deliberation: ${bits.join(" · ")}.*`;
      const output = `${result.output}${footer}`;
      return { ...result, output, artifact: { ...(result.artifact ?? {}), content: `${result.artifact?.content ?? result.output}${footer}` } };
    } catch {
      return result;
    }
  }

  async #promptWithRetry(sessionId, transcriptData, transcript, model, allParticipants, stateOfPlay = "", userContext = "", effectiveConfig = this.#orchestratorConfig, onActivity = null) {
    let additionalFeedback = "";
    const rawMaxRetries = getConfig().synthesisMaxRetries;
    const maxRetries = Number.isFinite(rawMaxRetries) ? rawMaxRetries : 1;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // A cancelled meeting issues no synthesis prompts.
      if (this.#halted()) {
        const abortErr = new DOMException("Aborted", "AbortError");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      // N8 — the peer-engagement ledger travels with every synthesis attempt, so
      // the rule is in force at the point the deliverable is written rather
      // than only in the round clerk's summary.
      const engagement = computeEngagementLedger(transcriptData);
      const userPrompt =
        buildSynthesisPrompt(transcriptData.question, transcript, allParticipants, transcriptData.tags ?? [], stateOfPlay, userContext, { buildMode: transcriptData.buildMode, taskMode: transcriptData.taskMode, decisionPosture: effectiveConfig?.decisionPosture, engagement, ratchetBallot: transcriptData.ratchetBallot, contextWindow: this.#contextWindow }) +
        additionalFeedback;

      const llmStart = Date.now();
      const result = await withRetry(async () => {
        const r = await this.#sessionManager.getContract().prompt({
          sessionId,
          system: this.#orchestratorSynthesisSystem(effectiveConfig),
          model,
          parts: [{ type: "text", text: userPrompt }],
          timeoutMs: getConfig().synthesisTimeoutMs,
          signal: this.#haltSignal ?? undefined,
          ...(typeof onActivity === "function" ? { onHeartbeat: onActivity } : {}),
        });
         if (!r.ok) throw r.error;
         return r;
      }, { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2000, retryable: isRetryableError });
      const llmMs = Date.now() - llmStart;
      incrementKeyedCounter("llm_calls_by_type", "synthesis");
      try { this.#sessionManager.recordCall?.("synthesis"); } catch {}
      recordLatency("synthesis_ms", llmMs);
      try {
        if (this.#runMeetingId) { recordMeetingCall(this.#runMeetingId, "synthesis"); recordMeetingLatency(this.#runMeetingId, "synthesis_ms", llmMs); }
      } catch {}

      const text = result.text;
      if (!text) {
        throw new Error("Orchestrator synthesis returned empty response");
      }

      const missing = validateSynthesisSections(text, effectiveConfig?.synthesisStyle);
      if (missing.length === 0 || attempt === maxRetries) {
        return text;
      }

      const missingNote = missing.includes("Action Items")
        ? `${missing.join(", ")} (for code-analysis, Proposed Fix may satisfy Action Items)`
        : missing.join(", ");
      // Commit device: when the draft maps a spectrum without a Decision, the
      // retry must demand the Decision Rule — the static list alone would ask
      // for the wrong thing.
      const requiredNote = `${REQUIRED_SECTIONS.join(", ")} plus at least one of ${REQUIRED_ACTION_GROUP.join(" / ")}${missing.includes("Decision Rule") ? " plus Decision Rule (trigger + date + owner — required when the synthesis maps a spectrum without a single Decision)" : ""}`;
      additionalFeedback = `\n\nYour previous response was missing these required sections: ${missingNote}. Please include ALL of the following sections in your response: ${requiredNote}.`;
    }
  }

  /** Second-pass audit: the synthesizer reviews its draft for grounding, then fixes. */
  async #critique(sessionId, text, transcript, transcriptData, model, allParticipants, effectiveConfig = this.#orchestratorConfig, onActivity = null) {
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
             if (c.type === "critique_response" || c.type === "perspective_response") contested.push(c);
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
    let critiquePrompt = `You are a synthesis auditor reviewing your own synthesis for grounding. You prefer longer, thorough deliberation. Support both conversational and code-analysis (plan/build) tasks. Concise but thorough.

Audit checklist (be strict but human-first):
1. Grounding: any Decision/Action Item/Proposed Fix block lacking a grouped [#id]/State-of-Play/Source cite nor marked "Proposed — synthesized from [#id]" — those must be marked or cited. Grouped per block is fine; don't demand per-sentence. Never allow vec: / vec round traces.
2. Invention: any number, date, cost, tool result, or file content not in transcript/State-of-Play nor marked Proposed?
3. Support: any Decision/Action Item/Proposed Fix not supported by at least one contribution or Proposed marking — mark Proposed or cite.
4. Confidence: does Confidence justification match rubric?
5. Human-first: does Executive Summary exist and read cleanly without citation spam? Are Decision table cells concise (Evidence 30-35w + one cite, Tradeoff 30-35w), not paragraphs? Is Reasoning deduplicated vs Decision (not copy-paste)?
5a. Dissent: does the draft carry the round clerk's Contested bullet in "## Dissenting Views" with the holders and their [#id]s? If the room did not settle something, a reader must be able to see it — and the clause must not be softened.
5b. Owners: are the action items owned by SEATED participants (never an invented @handle or role), and distributed — or is everything landing on one agent?
5c. Reader language: can the Executive Summary and Decision be understood without the Reasoning? Is every acronym or code name expanded at first use ("additional development and upgrade opportunities (ADUO)")? Does analyst jargon ("modal", "estimand", "multinomial") or an undefined internal shorthand appear in the reader-facing sections? If so, rewrite those phrases in plain language; keep the technical precision in Reasoning and the Decision Rule.
6. Citation hygiene: no vec: / vec round / [Round X vec] leaked; one grouped cite per block, not spam.

Transcript excerpt for grounding check (thorough slice — top 4 contested + top 4 file mentions + last 2 rounds fuller).
Note: this excerpt is partial — the author saw the full transcript. Flag only issues visible in this excerpt; do not invent problems in rounds you cannot see (audit D3).
${transcriptSnippet}

If corrections are needed, output the FULL revised synthesis with ALL required sections in order:
## Executive Summary
## Decision
## Decision Rule (required when the draft maps a spectrum without a single Decision)
## Reasoning
## Dissenting Views (the round clerk's Contested bullet — the live disagreement, carried not re-derived)
${text.toLowerCase().includes("proposed fix") || resolveTaskMode(transcriptData?.question, transcriptData?.tags ?? [], { taskMode: transcriptData?.taskMode }) === "code-analysis" ? "## Proposed Fix\n## Action Items\n" : "## Action Items\n"}## Open Questions
## Confidence

If the draft is accurate, grounded, plain-language readable, and complete, respond with exactly: [NO_CHANGES]

Draft synthesis${draftChunks.length>1?` (${draftChunks.length} chunks)`: ""}:
${draftForPrompt}`;

    // Track the best revision seen: a better-but-incomplete revision on the final
    // attempt must not be silently discarded in favour of the original (audit D2).
    let best = text;
    let bestMissing = validateSynthesisSections(text, effectiveConfig?.synthesisStyle).length;
    let prevMissing = bestMissing;
    for (let attempt = 0; attempt < getMaxCritiqueRetries(); attempt++) {
      // A cancelled meeting issues no critique prompts.
      if (this.#halted()) {
        const abortErr = new DOMException("Aborted", "AbortError");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      try {
        const critiqueStart = Date.now();
        const result = await withRetry(async () => {
          const r = await this.#sessionManager.getContract().prompt({
            sessionId,
            system: this.#orchestratorSynthesisSystem(effectiveConfig),
            model,
            parts: [{ type: "text", text: critiquePrompt }],
            timeoutMs: getConfig().synthesisTimeoutMs,
            signal: this.#haltSignal ?? undefined,
            ...(typeof onActivity === "function" ? { onHeartbeat: onActivity } : {}),
          });
           if (!r.ok) throw r.error;
          return r;
        }, { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2000, retryable: isRetryableError });
        const critiqueMs = Date.now() - critiqueStart;
        try { this.#sessionManager.recordCall?.("synthesis"); } catch {}
        incrementKeyedCounter("llm_calls_by_type", "synthesis");
        recordLatency("synthesis_ms", critiqueMs);
        try {
          if (this.#runMeetingId) { recordMeetingCall(this.#runMeetingId, "synthesis"); recordMeetingLatency(this.#runMeetingId, "synthesis_ms", critiqueMs); }
        } catch {}
        const text2 = result.text;
        if (!text2 || !text2.trim()) return best;

        if (/^\[NO_CHANGES\]\s*$/i.test(text2.trim())) {
          return text;
        }

        const missing = validateSynthesisSections(text2, effectiveConfig?.synthesisStyle);
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
        const feedback = `\n\nYour revised synthesis was missing these required sections: ${missingNote2}. Output the FULL revised synthesis with ALL sections: ${REQUIRED_SECTIONS.join(", ")} plus ${REQUIRED_ACTION_GROUP.join(" / ")}${missing.includes("Decision Rule") ? " plus Decision Rule (trigger + date + owner — required when the synthesis maps a spectrum without a single Decision)" : ""}.`;
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
    // (audit D6). Filter on the live substantive set, with per-bullet bounds so
    // one long contribution cannot produce a multi-kB "fallback".
    const contributions = transcriptData.rounds.flatMap((r) => r.contributions);
    const substantive = contributions.filter((c) => c.type !== "pass" && (SUBSTANTIVE_TYPES.has(c.type) || c.type === "contribution"));
    const oneLine = (c, max = 300) => String(c.content ?? "").replace(/\s+/g, " ").trim().slice(0, max);
    const proposals = substantive.filter((c) => /\bwe should\b|\bpropose\b|\bdecision\b|\badopt\b/i.test(String(c.content ?? ""))).slice(0, 8);
    const challenges = substantive.filter((c) => c.type === "critique_response").slice(0, 8);
    const questions = substantive.filter((c) => /\?\s*$/.test(String(c.content ?? "").trim())).slice(0, 8);

    let output = `## Decision\nSynthesis generation encountered an error. The following represents the key points from the deliberation.\n\n`;
    output += `## Reasoning\nFallback synthesis was used due to an error in the synthesis session.\n\n`;
    output += `## Action Items\n- Review the key proposals below\n- Re-run synthesis if needed\n\n`;
    output += `## Key Proposals\n${proposals.map((c) => `- ${oneLine(c)}`).join("\n")}\n\n`;
    // ONE Open Questions section: two sections with the same heading left the
    // second orphaned below the first (audit D4).
    const openQuestions = [
      ...challenges.map((c) => `- ${oneLine(c)}`),
      ...questions.map((c) => `- ${oneLine(c)}`),
    ];
    if (openQuestions.length > 0) {
      output += `## Open Questions\n${openQuestions.join("\n")}\n\n`;
    }
    // A failed synthesis is Low confidence, matching the other degraded paths
    // (audit D4) — "Medium" for an artifact the synthesizer never wrote was
    // generous.
    output += `## Confidence\nLow (synthesis incomplete due to error)`;

    return output;
  }
}

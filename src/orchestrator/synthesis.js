import { getConfig } from "../config.js";
import { TUNING } from "../config/defaults.js";
import { LoomError, extractErrorInfo } from "../logger.js";
import { getMetricsSnapshot, getMeetingDegradedReasons, recordMeetingDegradedReason } from "../metrics.js";
import { collectObjections } from "../objection-collector.js";
import { computeMechanismMix } from "../utils/contribution-types.js";
import { reconcileNumericalConflicts } from "../synthesizer.js";

/**
 * N9 — round-budget floor, first half: make the closing round measurable.
 * Returns `{ final_span_ms, median_span_ms, ratio, below_floor }` over the
 * recorded round spans. A final round under `floorRatio` of the median is
 * flagged rather than tolerated silently: in 1355a723 the round that produced
 * the meeting's best contribution and the closing ballot ran at 29% of the
 * peak and two of three participants never patched.
 * @param {Array<{number: number, span_ms?: number}>} rounds
 * @param {number} [floorRatio=0.6]
 */
export function measureRoundBudget(rounds = [], floorRatio = 0.6) {
  const spans = (rounds ?? [])
    .filter((r) => Number.isFinite(r?.span_ms) && r.span_ms > 0)
    .map((r) => r.span_ms);
  if (spans.length < 2) return { final_span_ms: spans.at(-1) ?? null, median_span_ms: null, ratio: null, below_floor: false };
  const sorted = [...spans].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  const finalSpan = spans.at(-1);
  const ratio = median > 0 ? Math.round((finalSpan / median) * 1000) / 1000 : null;
  return { final_span_ms: finalSpan, median_span_ms: median, ratio, below_floor: ratio !== null && ratio < floorRatio };
}

/**
 * N9 — round-budget floor, second half: guarantee a patch opportunity before
 * synthesis regardless of elapsed time. The patch is the agent's memory for the
 * room's next deliberation; a closing round that runs short must not be the
 * reason a participant's reasoning is lost. Participants who did not patch in
 * the final round get one bounded, patch-only turn each. Nothing is required
 * of them: an empty or skipped patch is fine, and no contribution is expected.
 *
 * @returns {Promise<{attempted: number, patched: number, failed: number}>}
 */
export async function runFinalRoundPatchGrace() {
  const timeoutMs = (() => {
    try { return Number(getConfig()?.tuning?.FINAL_ROUND_PATCH_GRACE_MS ?? TUNING.FINAL_ROUND_PATCH_GRACE_MS); } catch { return TUNING.FINAL_ROUND_PATCH_GRACE_MS; }
  })();
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { attempted: 0, patched: 0, failed: 0 };
  if (this._cancelled) return { attempted: 0, patched: 0, failed: 0 };

  const finalRound = this._stateManager.getCurrentRound();
  const participants = this._stateManager.getParticipants().filter((p) => p?.status !== "failed" && p?.status !== "passed");
  const weave = this._stateManager.getWeave();
  // Who already patched in the final round? A state written in an earlier
  // round is carried, so the test is the patch's round, not its existence.
  const patchedInFinal = new Set(
    weave
      .filter((c) => c.round === finalRound)
      .map((c) => c.participant_id),
  );

  let attempted = 0;
  let patched = 0;
  let failed = 0;
  for (const p of participants) {
    if (patchedInFinal.has(p.config.id)) continue;
    if (this._cancelled) break;
    const model = (() => { try { return this._getParticipantModel?.(p) ?? null; } catch { return null; } })();
    if (!model) { failed++; continue; }
    attempted++;
    try {
      const res = await this._sessionManager.runEphemeralPrompt(p, {
        system: `You are ${p.config.name} (${p.config.tier}). The deliberation is closing. Call loom_state_patch ONCE with anything from your last turn worth carrying forward (stance, and any established/contested/open/facts bullets you still rely on). If there is nothing new, do not call it. Do not write prose, do not argue, do not re-litigate — this is your private notes only.`,
        model,
        parts: [{ type: "text", text: "Closing the deliberation. Save anything worth remembering, or skip if there is nothing." }],
        tools: { loom_state_patch: true },
        timeoutMs,
      }, this._meetingId);
      if (res?.ok) patched++;
      else failed++;
    } catch (err) {
      failed++;
      this._logger.warn("final_round_patch_grace_failed", `Patch grace failed for ${p.config.name}`, extractErrorInfo(err));
    }
  }
  if (attempted > 0) {
    this._logger.info("final_round_patch_grace", `Patch grace: ${patched}/${attempted} participants patched before synthesis (${failed} failed)`, { round: finalRound, attempted, patched, failed });
  }
  return { attempted, patched, failed };
}

export async function _synthesize() {
    const participants = this._stateManager.getParticipants();
    const currentRound = this._stateManager.getCurrentRound();
    const maxRounds = this._stateManager.getMaxRounds();
    const failed = participants.filter((p) => p.status === "failed").length;
    const partialDeliberation = failed > 0;

    // N9 — round-budget floor, before anything else: the closing round gets a
    // guaranteed patch opportunity and its span is measured against the
    // median. Both are cheap, and both happen while there is still a meeting
    // to patch for.
    this._roundBudget = measureRoundBudget(this._stateManager.getRounds());
    if (this._roundBudget.below_floor) {
      this._logger.warn("final_round_below_floor", `Final round ran at ${Math.round((this._roundBudget.ratio ?? 0) * 100)}% of the median round (${this._roundBudget.final_span_ms}ms vs ${this._roundBudget.median_span_ms}ms) — the closing round is a deadline, not a round`);
      try { recordMeetingDegradedReason(this._meetingId, "final_round_below_floor"); } catch {}
    }
    try {
      this._finalPatchGrace = await this.runFinalRoundPatchGrace?.();
      const { attempted, failed: graceFailed } = this._finalPatchGrace ?? {};
      if (attempted > 0 && graceFailed > 0) {
        try { recordMeetingDegradedReason(this._meetingId, "final_round_patch_grace_failed"); } catch {}
      }
    } catch (err) {
      this._logger.warn("final_round_patch_grace_failed", "Closing patch grace failed — synthesis continues", extractErrorInfo(err));
    }

    const weave = this._stateManager.getWeave();
    const substantiveForSynthesis = weave.filter((c) => {
      const t = String(c.type ?? "");
      if (t === "pass") return false;
      const txt = String(c.content ?? "").trim();
      return txt !== "";
    });
    const stateOfPlay = this._stateManager.getStateOfPlay();
    if (substantiveForSynthesis.length === 0 && !String(stateOfPlay ?? "").trim()) {
      const reason = failed > 0
        ? `All ${participants.length} participants encountered errors during the deliberation.`
        : `All ${participants.length} participants chose to pass. This may indicate the question was unclear or participants had nothing to add.`;
      const output = `# Deliberation Output\n\n## Decision\nNo output could be generated — no substantive contributions were received.\n\n## Reasoning\n${reason}\n\n## Action Items\n- Check model connectivity and retry\n- Rephrase the question with more specific context\n- Add participants with more targeted expertise\n\n## Confidence\nLow (no contributions received)`;
      this._saveArtifact({ content: output, format: "markdown", decisions: [], action_items: [], open_questions: [], confidence: "low" });
      await this._sessionManager.postProgress(failed > 0 ? "⚠️ All participants failed — no contributions to synthesize." : "ℹ️ All participants passed — no contributions to synthesize.");
      this._logger.warn("no_contributions", `No contributions to synthesize (failed: ${failed}, passed: ${participants.length - failed})`);
      await this._persistState();
      return output;
    }

    const orchestratorModel = this._getOrchestratorModel();
    if (!orchestratorModel) {
      throw new LoomError("No orchestrator model available for final synthesis", { phase: "synthesis", recoverable: false });
    }
    this._logger.info("orchestrator_synthesis_model", `Final synthesis assigned to orchestrator model ${orchestratorModel.providerID}/${orchestratorModel.modelID}`, {
      meetingId: this._meetingId,
      requested: this._options?.orchestratorModel ? `${this._options.orchestratorModel.providerID}/${this._options.orchestratorModel.modelID}` : null,
      actual: `${orchestratorModel.providerID}/${orchestratorModel.modelID}`,
    });
    const transcriptData = this._database.getTranscriptData(this._meetingId);
    // getTranscriptData returns only { question, fabric, rounds } — thread the
    // meeting tags through so mode detection and the Tags block are live, and
    // derive build mode from the effective tools the meeting actually ran with
    // rather than from tags (audit D5).
    transcriptData.tags = this._stateManager.getTags() ?? [];
    try {
      const at = this._roundExecutor?.getEffectiveAgentTools?.() ?? getConfig()?.agentTools;
      transcriptData.buildMode = !!(at?.enabled && (at?.buildMode === true || at?.builtIn?.write === true || at?.builtIn?.edit === true));
    } catch { transcriptData.buildMode = false; }

    const objections = collectObjections({
      rounds: this._stateManager.getRounds(),
      participants: this._stateManager.getParticipants(),
    });
    this._stateManager.setObjections(objections);

    // P10 — pre-synthesis reconciliation pass: collectObjections is the
    // natural hook — objections and numerical conflicts are both pre-synthesis
    // scans of the weave. The authoritative report is recomputed inside
    // finalizeSynthesis (which owns the artifact); here we surface the
    // round-headroom signal before synthesis begins.
    try {
      const reconciliation = reconcileNumericalConflicts(this._stateManager.getWeave());
      if (reconciliation.reserveRoundRecommended) {
        this._logger.warn("reconciliation_reserve_round", reconciliation.reserveRoundReason);
      }
    } catch { /* non-fatal — reconciliation is advisory */ }

    let result;
    try {
      result = await this._synthesisCoordinator.run({
        transcriptData,
        participants: this._stateManager.getParticipants(),
        objections,
        model: orchestratorModel,
        onStart: () => {
          if (this._options.onSynthesisStart) this._options.onSynthesisStart();
        },
        onComplete: (output) => {
          if (this._options.onSynthesisComplete) this._options.onSynthesisComplete(output);
          this._notifyUpdate();
        },
        stateOfPlay,
        userContext: this._stateManager.getContext?.() ?? "",
      });
    } catch (err) {      const message = err instanceof Error ? err.message : String(err);
      this._logger.error("synthesis_failed", `Synthesis failed — persisting degraded artifact: ${message}`);
      await this._sessionManager.postProgress(`⚠️ Synthesis failed (${message}) — degraded artifact persisted.`, "error");
      const degraded = `# Deliberation Output\n\n## Decision\nSynthesis could not be completed (${message}).\n\n## Reasoning\nThe meeting reached its end state but the synthesis step failed. The full transcript is preserved for review.\n\n## Action Items\n- Retry synthesis with the meeting data\n- Review the transcript tab for the full deliberation\n\n## Confidence\nLow (synthesis interrupted)`;
      result = {
        output: degraded,
        artifact: { content: degraded, format: "markdown", decisions: [], action_items: [], open_questions: [], confidence: "low" },
      };
    }

    // Synthesis LLM calls are recorded per-call via SessionManager call
    // recorder (draft + critique passes in SynthesisCoordinator), not as a
    // flat +1 here — a single synthesis runs 2+ prompts.
    await this._persistState();

    // Append partial-deliberation footnote if agents failed before completing all rounds
    let finalOutput = result.output;
    if (partialDeliberation) {
      const footnote = `\n\n---\n**Note:** Deliberation ended early — ${failed} of ${participants.length} participants failed (completed ${currentRound - 1} of ${maxRounds} rounds). Synthesis is based on available contributions only.`;
      finalOutput += footnote;
      // Also patch the artifact content
      if (result.artifact) {
        result.artifact.content = (result.artifact.content || result.output) + footnote;
      }
    }

    this._saveArtifact(result.artifact ?? { content: finalOutput, format: "markdown", decisions: [], action_items: [], open_questions: [], confidence: null });
    this._saveMeetingMetrics();
    return finalOutput;
  }

/**
 * Synthesis-only completion for a meeting whose rounds are all persisted but
 * whose artifact row was never written (kill landed between the terminal
 * status persist and saveArtifact). Runs the normal synthesis path without
 * executing any further rounds, then re-applies the original terminal status
 * (restore forces in-memory status to weaving, and _synthesize persists that
 * via _persistState — without this step finish would regress terminal state).
 */
  export async function finishSynthesis(originalStatus) {
  const output = await this._synthesize();
  try {
    const valid = ["converged", "cancelled", "timeout", "max_rounds_reached", "aborted"];
    if (valid.includes(originalStatus) && this._stateManager.getStatus() !== originalStatus) {
      this._stateManager.transitionTo(originalStatus);
      await this._persistState();
    }
  } catch (err) {
    this._logger.warn("finish_status_restore_failed", `Could not re-apply terminal status ${originalStatus} after finish`, extractErrorInfo(err));
  }
  return output;
}

/**
 * P14 — a meeting is unmeasurable when every cost counter is zero: no tokens
 * recorded AND no latency samples. Quality gates must never grade on empty
 * telemetry, so this flag travels with the metrics row and the quality
 * telemetry.
 */
export function isCostTelemetryUnmeasurable(stats) {
  const s = stats ?? {};
  const tokens = (Number(s.input_tokens) || 0) + (Number(s.output_tokens) || 0);
  if (tokens > 0) return false;
  const lat = s.latencies ?? {};
  for (const bucket of Object.values(lat)) {
    if (bucket && Number(bucket.count) > 0) return false;
  }
  return true;
}

/** Summarizes latency buckets ({count, avg, p50, p95, max}) for the quality telemetry. */
function summarizeLatencies(latencies) {
  const out = {};
  for (const [bucket, stats] of Object.entries(latencies ?? {})) {
    if (!stats) continue;
    out[bucket] = {
      count: Number(stats.count) || 0,
      avg: Number(stats.avg) || 0,
      p50: Number(stats.p50) || 0,
      p95: Number(stats.p95) || 0,
      max: Number(stats.max) || 0,
    };
  }
  return out;
}

export function _computeQualityTelemetry(stats = {}) {
    try {
      const weave = this._stateManager.getWeave();
      const byType = {};
      for (const c of weave) {
        byType[c.type] = (byType[c.type] ?? 0) + 1;
      }
      const participants = this._stateManager.getParticipants();
      const contributors = new Set(weave.map((c) => c.participant_id));
      const objections = this._stateManager.getObjections?.() ?? [];
      const unresolved = objections.filter((o) => o.unresolved);
      // P14 — surface token/latency accounting in the quality telemetry
      const inputTokens = Number(stats.input_tokens) || 0;
      const outputTokens = Number(stats.output_tokens) || 0;
      // N6 — a meeting's health is the union of "the counters are empty" and
      // "something was refused". `cost_unmeasurable` stays for compatibility;
      // `meeting_degraded_reasons` is the general form.
      const degradedReasons = new Set(getMeetingDegradedReasons(this._stateManager.getMeetingId?.() ?? this._meetingId ?? ""));
      if (isCostTelemetryUnmeasurable(stats)) degradedReasons.add("cost_unmeasurable");
      return {
        contributions_by_type: byType,
        unresolved_objections: unresolved.length,
        total_objections: objections.length,
        participants: participants.length,
        contributors: contributors.size,
        participation_ratio: participants.length > 0 ? Math.round((contributors.size / participants.length) * 100) / 100 : 0,
        votes_held: byType.vote_response ?? 0,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        latencies: summarizeLatencies(stats.latencies),
        cost_unmeasurable: isCostTelemetryUnmeasurable(stats),
        // N7 — the cap is per turn, the audit is per round. Reporting the
        // per-turn high-water mark beside the round total is what stops a
        // reader from calling a healthy meeting an overrun.
        tool_calls: {
          max_in_a_turn: this._stateManager.getMaxToolCallsInATurn?.() ?? 0,
          cap_per_turn: Number(getConfig()?.agentTools?.maxToolCallsPerTurn) || 12,
        },
        // N9 — the closing round measured against the median of the others.
        round_budget: this._roundBudget ?? null,
        final_patch_grace: this._finalPatchGrace ?? null,
        // N12 — mechanism mix, per round. Visibility, never a constraint:
        // whether a ballot-heavy round was a good trade is not decidable from
        // one meeting, so it is measured, not legislated.
        mechanism_mix: computeMechanismMix(weave, this._stateManager.getObjections?.() ?? []),
        meeting_degraded_reasons: [...degradedReasons].sort(),
      };
    } catch {
      return null;
    }
  }

export function _saveArtifact(artifact) {
    // Stamp the effective orchestrator config so the artifact is attributable
    // to the options that shaped it (audit O13/Step 7).
    if (artifact && typeof artifact === "object" && !artifact.orchestrator_config) {
      artifact.orchestrator_config = this._options?.orchestratorConfig ?? null;
    }
    this._stateManager.setArtifact(artifact);
    if (this._database) {
      this._database.saveArtifact(artifact);
    }
  }

export function _saveMeetingMetrics() {
    if (!this._database) return;
    try {
      const stats = this._getMergedStats();
      const weave = this._stateManager.getWeave();
      const allTurnRequests = this._stateManager.getRounds().flatMap((r) => r.turn_requests);
      // Durable degradation/observability counters (audit 07 EH3): the process-wide
      // degrade/retry/breaker events are snapshotted into the per-meeting row so
      // they survive restart and are visible in trend queries.
      let processCounters = {};
      let latencies = {};
      try {
        const snapshot = getMetricsSnapshot();
        processCounters = {
          degradation_events: snapshot.counters.degradation_events ?? {},
          retry_events: snapshot.counters.retry_events ?? {},
          breaker_events: snapshot.counters.breaker_events ?? {},
          // N6 — refusal reasons, counted where the refusal happened.
          meeting_degraded_reasons: snapshot.counters.meeting_degraded_reasons ?? {},
        };
        // P14 — surface real latency telemetry: the process-wide snapshot
        // carries the llm_prompt_ms / synthesis_ms buckets recorded via
        // recordLatency; the old hardcoded {} reported empty latencies for
        // every meeting.
        latencies = snapshot.latencies ?? {};
      } catch { /* metrics unavailable — keep going */ }
      this._database.saveMeetingMetrics({
        counters: { ...stats, ...processCounters, quality: this._computeQualityTelemetry(stats) },
        latencies,
         input_tokens: stats.input_tokens ?? 0,
         output_tokens: stats.output_tokens ?? 0,
         duration_ms: Date.now() - this._startTime,
         rounds: this._stateManager.getCurrentRound(),
         contributions: weave.length,
         turn_requests: allTurnRequests.length,
      });
    } catch { /* non-critical */ }
  }


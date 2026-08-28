import { getConfig } from "../config.js";
import { extractErrorInfo } from "../logger.js";
import { getMetricsSnapshot } from "../metrics.js";
import { collectObjections } from "../objection-collector.js";
import { getHighestTierModel } from "../services/model-service.js";

export async function _synthesize() {
    const participants = this._stateManager.getParticipants();
    const active = participants.filter((p) => p.status !== "failed").length;
    const allFailed = active === 0;
    if (allFailed) {
      const output = `# Deliberation Output\n\n## Decision\nNo output could be generated — all participants failed to respond.\n\n## Reasoning\nAll ${participants.length} participants encountered errors during the deliberation.\n\n## Action Items\n- Check model connectivity and retry\n- Verify provider authentication\n\n## Confidence\nLow (no contributions received)`;
      this._saveArtifact({ content: output, format: "markdown", decisions: [], action_items: [], dissent: [], open_questions: [], confidence: "low" });
      await this._sessionManager.postProgress("⚠️ All participants failed — no synthesis possible.", "error");
      this._logger.error("all_failed", "All participants failed — no synthesis possible");
      await this._persistState();
      return output;
    }

    const weave = this._stateManager.getWeave();
    const substantiveForSynthesis = weave.filter((c) => {
      const t = String(c.type ?? "");
      if (t === "pass") return false;
      const txt = String(c.content ?? "").trim();
      return txt !== "" && txt !== "[PASS]";
    });
    if (substantiveForSynthesis.length === 0) {
      const output = `# Deliberation Output\n\n## Decision\nNo output could be generated — all participants passed without contributing.\n\n## Reasoning\nAll ${participants.length} participants chose to pass. This may indicate the question was unclear or participants had nothing to add.\n\n## Action Items\n- Rephrase the question with more specific context\n- Add participants with more targeted expertise\n\n## Confidence\nLow (no contributions received)`;
      this._saveArtifact({ content: output, format: "markdown", decisions: [], action_items: [], dissent: [], open_questions: [], confidence: "low" });
      await this._sessionManager.postProgress("ℹ️ All participants passed — no contributions to synthesize.");
      this._logger.warn("all_passed", "All participants passed — no contributions to synthesize");
      await this._persistState();
      return output;
    }

    const synthesizer = this._synthesisCoordinator.selectSynthesizer(this._stateManager.getParticipants());
    const transcriptData = this._database.getTranscriptData(this._meetingId);

    const objections = collectObjections({
      rounds: this._stateManager.getRounds(),
      participants: this._stateManager.getParticipants(),
    });
    this._stateManager.setObjections(objections);

    let result;
    try {
      result = await this._synthesisCoordinator.run(
        transcriptData,
        this._stateManager.getParticipants(),
        objections,
        synthesizer,
        (p) => this._getParticipantModel(p, true),
        () => {
          if (this._options.onSynthesisStart) this._options.onSynthesisStart();
        },
        (output) => {
          if (this._options.onSynthesisComplete) this._options.onSynthesisComplete(output);
          this._notifyUpdate();
        },
        this._stateManager.getStateOfPlay(),
        // User context reaches synthesis directly (audit 01 P8)
        this._stateManager.getContext?.() ?? "",
      );
    } catch (err) {      const message = err instanceof Error ? err.message : String(err);
      this._logger.error("synthesis_failed", `Synthesis failed — persisting degraded artifact: ${message}`);
      await this._sessionManager.postProgress(`⚠️ Synthesis failed (${message}) — degraded artifact persisted.`, "error");
      const degraded = `# Deliberation Output\n\n## Decision\nSynthesis could not be completed (${message}).\n\n## Reasoning\nThe meeting reached its end state but the synthesis step failed. The full transcript is preserved for review.\n\n## Action Items\n- Retry synthesis with the meeting data\n- Review the transcript tab for the full deliberation\n\n## Confidence\nLow (synthesis interrupted)`;
      result = {
        output: degraded,
        artifact: { content: degraded, format: "markdown", decisions: [], action_items: [], dissent: [], open_questions: [], confidence: "low" },
      };
    }

    this._callStats.synthesis++;
    await this._persistState();
    this._saveArtifact(result.artifact ?? { content: result.output, format: "markdown", decisions: [], action_items: [], dissent: [], open_questions: [], confidence: null });
    this._saveMeetingMetrics();
    return result.output;
  }

export function _computeQualityTelemetry() {
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
      return {
        contributions_by_type: byType,
        challenges: byType.challenge ?? 0,
        dissents: byType.dissent ?? 0,
        unresolved_objections: unresolved.length,
        total_objections: objections.length,
        participants: participants.length,
        contributors: contributors.size,
        participation_ratio: participants.length > 0 ? Math.round((contributors.size / participants.length) * 100) / 100 : 0,
        votes_held: byType.vote_response ?? 0,
      };
    } catch {
      return null;
    }
  }

export function _saveArtifact(artifact) {
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
      try {
        const snapshot = getMetricsSnapshot();
        processCounters = {
          degradation_events: snapshot.counters.degradation_events ?? {},
          retry_events: snapshot.counters.retry_events ?? {},
          breaker_events: snapshot.counters.breaker_events ?? {},
        };
      } catch { /* metrics unavailable — keep going */ }
      this._database.saveMeetingMetrics({
        counters: { ...stats, ...processCounters, quality: this._computeQualityTelemetry() },
        latencies: {},
         input_tokens: stats.input_tokens ?? 0,
         output_tokens: stats.output_tokens ?? 0,
         duration_ms: Date.now() - this._startTime,
         rounds: this._stateManager.getCurrentRound(),
         contributions: weave.length,
         turn_requests: allTurnRequests.length,
       });
    } catch { /* non-critical */ }
  }


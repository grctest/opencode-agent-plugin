/**
 * MeetingOrchestrator — composition root.
 *
 * Delegates to focused helpers under src/orchestrator/* and services/*. Thin
 * forwarders bind orchestrator context so helpers can access services/state.
 * Constants are canonical in src/constants.js (re-exported here for compat).
 */

import { getConfig } from "./config.js";
import { getMeetingDbPath } from "./paths.js";
import { MeetingDatabase } from "./database.js";
import { SessionManager } from "./session-manager.js";
import { Logger, LoomError, extractErrorInfo } from "./logger.js";
import { getMetricsSnapshot, recordMeetingDegradedReason } from "./metrics.js";
import { truncate } from "./shared.js";
import { TERMINAL_STATUSES } from "./constants.js";
import { restoreStateFromDb } from "./meeting-restorer.js";

import { StateManager } from "./services/state-manager.js";
import { PersistenceService } from "./services/persistence-service.js";


import { SynthesisCoordinator } from "./synthesis-coordinator.js";
import { updateStateOfPlay } from "./state-of-play.js";
import { RoundService } from "./services/round-service.js";
import { RoundExecutor } from "./round-executor.js";
import { StallWatchdog } from "./services/stall-watchdog.js";
import { RoundInitializer } from "./services/round-initializer.js";
import { MeetingExtender } from "./services/meeting-extender.js";
import { getPersonas } from "./composer.js";
import * as weavingHelpers from "./orchestrator/weaving.js";
import * as roundHelpers from "./orchestrator/round.js";
import * as synthesisHelpers from "./orchestrator/synthesis.js";
import * as modelsHelpers from "./orchestrator/models.js";
import * as initHelpers from "./orchestrator/init.js";
import { clear as clearUsageLimit, reportFromError as reportUsageLimitFromError } from "./services/usage-limit-monitor.js";

export { SUMMARY_TRUNCATE_LEN, MAX_ORCHESTRATOR_MESSAGES } from "./constants.js";

/**
 * Debounce for the mid-round `meetings.stats` flush that keeps the dashboard's
 * "LLM Calls" counter live. A single agent turn fires several counter sites in
 * quick succession; this collapses them into one row update.
 */
const STATS_FLUSH_DEBOUNCE_MS = 1000;

export class MeetingOrchestrator {
  _meetingId;
  _stateManager;
  _persistenceService;
  _synthesisCoordinator;
  _roundService;
  _roundInitializer;
  _meetingExtender;
  _stallWatchdog;
  _options;
  _client;
  _directory;
  _parentSessionId;
  _database = null;
  _roundExecutor = null;
  _cancelled = false;
  _closed = false;
  /**
   * The meeting-level HALT signal.
   *
   * `_cancelled` means "stop at the next round boundary" (the stall watchdog
   * uses it: the round finishes, then the meeting times out and synthesizes).
   * The halt signal means "stop NOW" — the user pressed Cancel run. It is
   * sticky by construction: once aborted it stays aborted, so a turn that
   * starts AFTER the cancellation is dead on arrival instead of quietly
   * issuing a fresh prompt.
   */
  _haltController = new AbortController();
  _halted = false;
  _startTime = 0;
  _sessionManager = null;
  _logger = null;
  _orchestratorMessages = [];
  _resume = false;
  _callStats = { orchestrator: 0, summary: 0, synthesis: 0 };
  _availableModels = [];
  _rateLimitError = null;
  _rateLimitRetryAt = null;
  _statsFlushTimer = null;

  constructor(options) {
    this._meetingId = options.meetingId ?? crypto.randomUUID();
    this._resume = options.resume === true;
    this._options = options;
    this._client = options.client;
    this._directory = options.directory;
    this._parentSessionId = options.parentSessionId;
    this._availableModels = options.availableModels ?? [];

    this._logger = new Logger().forMeeting(this._meetingId);

    const initialState = {
      id: this._meetingId,
      parent_session_id: options.parentSessionId,
      question: options.question,
      context: options.context,
      participants: options.participants.map((p) => ({
        config: p,
        session_id: "",
        status: "listening",
        session_version: 0,
        reflection: "",
        contributions_count: 0,
      })),
      fabric: options.context,
      weave: [],
      rounds: [],
      current_round: 0,
      max_rounds: options.maxRounds,
      current_speaker_idx: 0,
      status: "initializing",
      artifact: null,
      tags: options.tags ?? [],
      next_contribution_id: 0,
      state_of_play: "",
    };

    this._stateManager = new StateManager(initialState);
    this._roundInitializer = new RoundInitializer();
    this._meetingExtender = new MeetingExtender();
    this._stallWatchdog = new StallWatchdog({
      onStall: () => {
        this._cancelled = true;
        this._sessionManager?.postProgress("⏱️ No activity detected for a while — stopping the deliberation.", "warn");
      },
      logger: this._logger,
    });
  }

   getDbPath() {
    return getMeetingDbPath(this._directory, this._meetingId);
  }

  getMeetingId() {
    return this._meetingId;
  }

  getState() {
    return this._stateManager.getState();
  }

   getOrchestratorMessages() {
    return [...this._orchestratorMessages];
  }

  /**
   * Public model resolver for inline loom_* tool paths (query/evidence/vote/summon).
   * Reuses the participant's assigned (left-sidebar) model; falls back within the
   * enabled-model allowlist only. Plugin tools call engine.getParticipantModel.
   */

  /**
   * A prompt was trimmed to fit its model's input window (SessionContract backstop,
   * or the agent turn's own block-aware trim). Recorded as a degradation so a
   * silently-shortened context is visible rather than inferred from output.
   */
  _recordPromptTrim(charsTrimmed, model) {
    try {
      recordMeetingDegradedReason(this._meetingId, "prompt_trimmed_to_context");
      this._callStats.prompt_trims = (this._callStats.prompt_trims ?? 0) + 1;
      this._logger.info(
        "prompt_trimmed_to_context",
        `Trimmed ${charsTrimmed} chars to fit ${model?.providerID}/${model?.modelID}`,
        { model: `${model?.providerID}/${model?.modelID}`, charsTrimmed }
      );
      this._scheduleStatsFlush?.();
    } catch { /* telemetry must never break a prompt */ }
  }

  /**
   * A provider refused a request for input reasons rather than throttling:
   * `context_overflow` (the per-model guard under-shot) or
   * `token_budget_exhausted` (the provider's own token credit is gone). Recorded
   * as a degradation, not a halt — the meeting keeps deliberating and a different
   * model may still serve the turn.
   */
  _recordInputRejection(classification, model) {
    const type = classification?.type;
    if (!type) return;
    try {
      recordMeetingDegradedReason(this._meetingId, `provider_${type}`);
      this._logger.warn("provider_input_rejected", `Provider rejected request: ${type} (model ${model?.providerID}/${model?.modelID})`, {
        model: `${model?.providerID}/${model?.modelID}`,
        classification: type,
      });
    } catch { /* telemetry must never break a prompt */ }
  }

  /**
   * The per-model context guard was skipped because the model's window is
   * unknown (resolveContextLimit returned null). This is the fail-open branch
   * — the prompt ships unguarded. Recorded as a degradation so the skip is
   * visible in metrics and can be counted across meetings.
   */
  _recordGuardSkip(reason, model) {
    try {
      recordMeetingDegradedReason(this._meetingId, `guard_skipped_${reason}`);
      this._callStats.guard_skips = (this._callStats.guard_skips ?? 0) + 1;
      this._logger.warn("context_guard_skipped", `Context guard skipped: ${reason} (model ${model?.providerID}/${model?.modelID})`, {
        model: `${model?.providerID}/${model?.modelID}`,
        reason,
      });
      this._scheduleStatsFlush?.();
    } catch { /* telemetry must never break a prompt */ }
  }

  /**
   * Persist the merged call counters so the dashboard's "LLM Calls" stat
   * tracks real call volume DURING a round.
   *
   * `_persistState()` is the only other writer of `meetings.stats`, and every
   * one of its call sites sits at a round boundary (finalize/synthesis), so
   * without this the stat sat frozen for an entire round. Each counter site
   * calls this instead of writing directly; the timer debounces the burst of
   * calls a single turn produces into one row update.
   */
  _scheduleStatsFlush() {
    if (this._statsFlushTimer || !this._database) return;
    const timer = setTimeout(() => {
      this._statsFlushTimer = null;
      // A later _persistState() writes the same merged counters transactionally
      // with round/status/fabric; this only fills the gap between boundaries.
      if (this._closed) return;
      try {
        this._database.setStats(JSON.stringify(this._getMergedStats()));
      } catch (err) {
        // Never let a best-effort stat flush disturb the deliberation.
        this._logger.warn("stats_flush_failed", "Could not persist call stats mid-round", extractErrorInfo(err));
      }
    }, STATS_FLUSH_DEBOUNCE_MS);
    if (timer.unref) timer.unref();
    this._statsFlushTimer = timer;
  }

  _flushStatsNow() {
    if (this._statsFlushTimer) { clearTimeout(this._statsFlushTimer); this._statsFlushTimer = null; }
    if (!this._database || this._closed) return;
    try {
      this._database.setStats(JSON.stringify(this._getMergedStats()));
    } catch {}
  }

  getParticipantModel(participant, fallbackOnError = false) {
    return this._getParticipantModel(participant, fallbackOnError);
  }

  getStateManager() {
    return this._stateManager;
  }

  getSessionManager() {
    return this._sessionManager;
  }

  getDatabase() {
    return this._database;
  }

  getRoundExecutor() {
    return this._roundExecutor;
  }

  /**
   * The meeting-level halt signal. Aborted once, stays aborted — this is what
   * makes "Cancel run" sticky: every prompt that starts after the cancellation
   * is aborted on arrival instead of quietly issuing a fresh call.
   */
  getHaltSignal() {
    return this._haltController?.signal ?? null;
  }

  /** True once the user has stopped the run (as opposed to a stall). */
  isHalted() {
    return this._halted === true;
  }

  /**
   * Stop the run NOW — the user pressed "Cancel run".
   *
   * The old cancel() only flipped an in-memory flag and aborted the
   * controllers that happened to be registered at that instant. The turn's
   * retry loop then started a FRESH turn with a fresh, un-aborted controller
   * and the meeting carried on weaving. This version:
   *
   *  - aborts the sticky halt signal, so any later prompt dies on arrival;
   *  - aborts the in-flight turn immediately;
   *  - writes the terminal status right away, so the database and the
   *    dashboard say "cancelled" now rather than at the next round boundary.
   *
   * @param {{ persistStatus?: boolean }} [opts] persistStatus:false keeps the
   *   meeting's status untouched — used by the process-exit path, where a
   *   killed meeting must stay resumable.
   */
  cancel(opts = {}) {
    const persistStatus = opts.persistStatus !== false;
    this._cancelled = true;
    this._halted = true;
    try { this._haltController?.abort(); } catch {}
    try { this._roundExecutor?._abortInflight?.(); } catch {}
    // The meeting may already be terminal while the run is still winding
    // down (cancel during the synthesis / the post-synthesis passes): the
    // status is as terminal as "cancelled" would make it, and terminal states
    // are absorbing — transitionTo would only log an "invalid transition"
    // ERROR the user cannot act on (observed: "max_rounds_reached ->
    // cancelled" on every click after the final round summary). Read the
    // status FIRST and only transition when it is still live.
    if (persistStatus) {
      let currentStatus = null;
      try { currentStatus = this._stateManager?.getStatus?.() ?? null; } catch {}
      if (currentStatus === null || currentStatus === "initializing" || currentStatus === "weaving" || !TERMINAL_STATUSES.has(currentStatus)) {
        try {
          this._stateManager.transitionTo("cancelled");
        } catch (err) {
          this._logger.debug("cancellation_status_unchanged", "Meeting already had a terminal status — cancel kept it", extractErrorInfo(err));
        }
        try { if (this._database) this._persistState?.(); } catch {}
      } else {
        this._logger.info("cancelled_terminal_meeting", `Meeting was already ${currentStatus} — the stop aborted the in-flight call and changed no status`);
      }
    }
    this._logger.info("cancellation", "Loom cancelled by user — aborting in-flight turn");
  }

  /**
   * Clear the halt. Extension re-opens a stopped meeting, so the sticky abort
   * signal is replaced with a fresh one and the round executor is told about
   * it — otherwise the first turn after the extension would be born aborted.
   */
  resetHalt() {
    this._halted = false;
    this._cancelled = false;
    try { this._haltController = new AbortController(); } catch {}
    try { this._roundExecutor?.setHaltSignal?.(this._haltController?.signal ?? null); } catch {}
    try { this._synthesisCoordinator?.setHaltSignal?.(this._haltController?.signal ?? null); } catch {}
    // Resume/extend re-opens the meeting: drop any account-wide usage-limit
    // block so a user who just subscribed (or waited out the daily reset) can
    // retry immediately. If the server is still limited, the next
    // session.status event re-arms the monitor within one attempt.
    try { clearUsageLimit("resume"); } catch {}
  }

  /**
   * Stop the run because opencode reported a hard account usage limit
   * (free_tier_limit / account_rate_limit). Same abort semantics as cancel()
   * — sticky halt, in-flight prompts aborted — but the terminal status is
   * `rate_limited` so the dashboard shows the RateLimitBanner CTA and the
   * meeting stays resumable after the limit resets (or after Subscribe).
   *
   * @param {{ type?: string, message?: string, retryAfterMs?: number|null, action?: object }} [classification]
   */
  haltForUsageLimit(classification = null) {
    if (this._closed) return;
    this._halted = true;
    this._cancelled = true;
    try { this._haltController?.abort(); } catch {}
    try { this._roundExecutor?._abortInflight?.(); } catch {}

    const rateLimitClassification = classification?.type
      ? {
          type: classification.type,
          message: classification.message ?? "Usage limit reached",
          retryAfterMs: classification.retryAfterMs ?? null,
          action: classification.action ?? null,
        }
      : (this._rateLimitError?.rateLimitClassification ?? null);
    if (!rateLimitClassification) return;

    // Synthetic error carries the classification so _setRateLimitError and
    // isHardRateLimitError agree on shape.
    const err = new Error(rateLimitClassification.message || "Usage limit reached");
    err.name = "UsageLimitError";
    err.status = 429;
    err.rateLimitClassification = rateLimitClassification;
    this._setRateLimitError(err);

    const actionLink = rateLimitClassification.action?.link;
    try {
      this._sessionManager?.postProgress(
        `⏸️ ${rateLimitClassification.message}${actionLink ? ` — ${actionLink}` : ""}`,
        "warn",
      );
    } catch {}
    this._logger.warn(
      "usage_limit_halted",
      `Meeting halted for hard usage limit (${rateLimitClassification.type}) — in-flight prompts aborted, resume stays available after reset or Subscribe`,
      { type: rateLimitClassification.type, message: rateLimitClassification.message },
    );
  }

  /**
   * Stop the run without writing a terminal status.
   *
   * Used when the PROCESS is going away (exit, SIGINT, plugin dispose). The
   * meeting must stay in "weaving" so the dashboard's crash recovery can
   * resume it — writing "cancelled" here would turn every killed process into
   * a deliberately-stopped meeting.
   */
  softCancel() {
    this.cancel({ persistStatus: false });
  }

    async close() {
    if (this._closed) return;
    this._closed = true;
    this._cancelled = true;
    // Land any debounced mid-round stat write before the handle goes away, so
    // the final LLM-call total is not lost by a pending timer.
    if (this._statsFlushTimer) { clearTimeout(this._statsFlushTimer); this._statsFlushTimer = null; }
    try {
      if (this._database) this._database.setStats(JSON.stringify(this._getMergedStats()));
    } catch {}
    // Abort in-flight LLM prompts by signalling cancellation to round executor if it exposes an abort
    try { this._roundExecutor?._abortInflight?.(); } catch {}
    try { this._stallWatchdog?.stop(); } catch {}
    try {
      if (this._sessionManager) {
        try { await this._sessionManager.deleteOrchestratorSession(); } catch {}
      }
    } catch {}
    try {
      if (this._database) {
        this._logger.info("close", "Closing meeting database");
        try { this._database.close(); } catch {}
      }
    } catch (err) {
      this._logger.error("close_failed", "Failed to close database", extractErrorInfo(err));
    } finally {
      this._database = null;
      this._sessionManager = null;
      this._roundExecutor = null;
    }
  }

  _checkRateLimitError() {
    if (this._rateLimitError) {
      const classification = this._rateLimitError.rateLimitClassification;
      if (classification && (classification.type === "free_tier_limit" || classification.type === "account_rate_limit")) {
        if (classification.retryAfterMs && Date.now() >= this._rateLimitRetryAt) {
          this._rateLimitError = null;
          this._rateLimitRetryAt = null;
          this._clearRateLimitState();
          return null;
        }
        return this._rateLimitError;
      }
    }
    return null;
  }

  _setRateLimitError(error) {
    const classification = error.rateLimitClassification;
    if (!classification) return;
    // Arm the account-wide monitor so other meetings / later prompts fail fast
    // even if this error was first seen by only one session.
    try { reportUsageLimitFromError(error); } catch {}
    this._rateLimitError = error;
    this._rateLimitRetryAt = classification.retryAfterMs
      ? Date.now() + classification.retryAfterMs
      : null;
    this._persistRateLimitState();
  }

  _persistRateLimitState() {
    if (!this._database || !this._stateManager) return;
    try {
      const state = this._stateManager.getState();
      const classification = this._rateLimitError?.rateLimitClassification;
      if (!classification) {
        state.rate_limit_state = null;
      } else {
        state.rate_limit_state = {
          type: classification.type,
          message: classification.message,
          retryAfterMs: classification.retryAfterMs,
          retryAt: this._rateLimitRetryAt ? new Date(this._rateLimitRetryAt).toISOString() : null,
          action: classification.action,
          timestamp: new Date().toISOString(),
        };
      }
      this._stateManager.transitionTo("rate_limited");
      this._database.setRateLimitState?.(state.rate_limit_state ? JSON.stringify(state.rate_limit_state) : null);
    } catch {}
  }

  _clearRateLimitState() {
    if (!this._stateManager) return;
    try {
      const state = this._stateManager.getState();
      state.rate_limit_state = null;
      // Persist the clear too — otherwise the dashboard's meeting row keeps
      // rate_limit_state after the auto-expiry timer fires (or after Resume).
      try { this._database?.setRateLimitState?.(null); } catch {}
      if (this._stateManager.getStatus() === "rate_limited") {
        this._stateManager.transitionTo("weaving");
      }
    } catch {}
  }

  _haltForRateLimit(error) {
    const classification = error.rateLimitClassification;
    if (!classification) return false;
    try {
      this._sessionManager?.postProgress(
        `⏸️ ${classification.message}${classification.action?.link ? ` — ${classification.action.link}` : ""}`,
        "warn"
      );
    } catch {}
    this._persistRateLimitState();
    if (classification.retryAfterMs && classification.retryAfterMs > 0) {
      setTimeout(() => {
        if (!this._cancelled && !this._closed) {
          this._clearRateLimitState();
          this._notifyUpdate();
        }
      }, classification.retryAfterMs);
    }
    return true;
  }

  // Thin forwarders — bound to orchestrator instance so helpers can access this.* services.
  _modelList() { return modelsHelpers._modelList.call(this); }
   _getDefaultModel() { return modelsHelpers._getDefaultModel.call(this); }
   _getOrchestratorModel() { return modelsHelpers._getOrchestratorModel.call(this); }
   _getAllowedFallbackModel() { return modelsHelpers._getAllowedFallbackModel.call(this); }
   _getParticipantModel(participant, fallbackOnError = false) { return modelsHelpers._getParticipantModel.call(this, participant, fallbackOnError); }
   async _promptOrchestrator(system, model, message, type, round) { return modelsHelpers._promptOrchestrator.call(this, system, model, message, type, round); }
   async initialize() { return initHelpers.initialize.call(this); }
   async runMeeting() { return weavingHelpers.runMeeting.call(this); }
   async extendMeeting(newPrompt, additionalRounds) { return weavingHelpers.extendMeeting.call(this, newPrompt, additionalRounds); }
   async resumeMeeting() { return weavingHelpers.resumeMeeting.call(this); }
   async _runWeavingLoop() { return weavingHelpers._runWeavingLoop.call(this); }
    _raceWithGuardTimer(promise, timeoutMs, label) { return weavingHelpers._raceWithGuardTimer.call(this, promise, timeoutMs, label); }
   async runRound() { return roundHelpers.runRound.call(this); }
   async _continueInterruptedRound() { return roundHelpers._continueInterruptedRound.call(this); }
   async _finalizeRound(round) { return roundHelpers._finalizeRound.call(this, round); }
   _isPersistenceError(err) { return roundHelpers._isPersistenceError.call(this, err); }
   async _persistState() { return roundHelpers._persistState.call(this); }
   _getMergedStats() { return roundHelpers._getMergedStats.call(this); }
   _logError(context, error) { return roundHelpers._logError.call(this, context, error); }
   _notifyUpdate() { return roundHelpers._notifyUpdate.call(this); }
  async _synthesize(options) { return synthesisHelpers._synthesize.call(this, options); }
  // N9 — the closing round's patch grace and its span measurement.
  async runFinalRoundPatchGrace() { return synthesisHelpers.runFinalRoundPatchGrace.call(this); }
  async finishSynthesis(originalStatus, options) { return synthesisHelpers.finishSynthesis.call(this, originalStatus, options); }
    _computeQualityTelemetry(stats) { return synthesisHelpers._computeQualityTelemetry.call(this, stats); }
   _saveArtifact(artifact) { return synthesisHelpers._saveArtifact.call(this, artifact); }
   _saveMeetingMetrics() { return synthesisHelpers._saveMeetingMetrics.call(this); }
}

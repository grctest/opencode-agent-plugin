/**
 * MeetingOrchestrator — composition root.
 *
 * Delegates to focused helpers under src/orchestrator/* and services/*. Thin
 * forwarders bind orchestrator context so helpers can access services/state.
 * Constants are canonical in src/constants.js (re-exported here for compat).
 */

import { getTierConfig } from "./shared.js";
import { getConfig } from "./config.js";
import { getMeetingDbPath } from "./paths.js";
import { MeetingDatabase } from "./database.js";
import { SessionManager } from "./session-manager.js";
import { Logger, LoomError, extractErrorInfo } from "./logger.js";
import { getMetricsSnapshot } from "./metrics.js";
import { getHighestTierModel } from "./services/model-service.js";
import { truncate } from "./shared.js";
import { restoreStateFromDb } from "./meeting-restorer.js";
import { collectObjections } from "./objection-collector.js";

import { StateManager } from "./services/state-manager.js";
import { PersistenceService } from "./services/persistence-service.js";


import { SynthesisCoordinator } from "./synthesis-coordinator.js";
import { updateStateOfPlay } from "./state-of-play.js";
import { RoundService } from "./services/round-service.js";
import { RoundExecutor } from "./round-executor.js";
import { StallWatchdog } from "./services/stall-watchdog.js";
import { RoundInitializer } from "./services/round-initializer.js";
import { MeetingExtender } from "./services/meeting-extender.js";
import { PersonaIndex } from "./services/persona-index.js";
import { getPersonas } from "./composer.js";
import * as weavingHelpers from "./orchestrator/weaving.js";
import * as roundHelpers from "./orchestrator/round.js";
import * as synthesisHelpers from "./orchestrator/synthesis.js";
import * as modelsHelpers from "./orchestrator/models.js";
import * as initHelpers from "./orchestrator/init.js";

export { SUMMARY_TRUNCATE_LEN, MAX_ORCHESTRATOR_MESSAGES } from "./constants.js";

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
  _startTime = 0;
  _sessionManager = null;
  _logger = null;
  _orchestratorMessages = [];
  _resume = false;
  _callStats = { orchestrator: 0, summary: 0, synthesis: 0, input_tokens: 0, output_tokens: 0 };
  _personaIndex = null;
  _availableModels = [];
  _maxTotalTokens = 0;
  _rateLimitError = null;
  _rateLimitRetryAt = null;

  constructor(options) {
    this._meetingId = options.meetingId ?? crypto.randomUUID();
    this._resume = options.resume === true;
    this._options = options;
    this._client = options.client;
    this._directory = options.directory;
    this._parentSessionId = options.parentSessionId;
    this._maxTotalTokens = options.maxTotalTokens ?? getConfig().maxTotalTokens ?? 0;
    this._availableModels = options.availableModels ?? [];

    this._logger = new Logger().forMeeting(this._meetingId);

    const initialState = {
      id: this._meetingId,
      parent_session_id: options.parentSessionId,
      question: options.question,
      context: options.context,
      participants: options.participants.map((p) => ({
        config: p,
        tier_config: getTierConfig(p.tier),
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
      objections: [],
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
  recordTokens(tokens) {
    if (!tokens) return;
    this._callStats.input_tokens += Number(tokens.input) || 0;
    this._callStats.output_tokens += Number(tokens.output) || 0;
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

  cancel() {
    this._cancelled = true;
    try { this._roundExecutor?._abortInflight?.(); } catch {}
    this._logger.info("cancellation", "Loom cancelled by user — aborting in-flight turn");
  }

    async close() {
    if (this._closed) return;
    this._closed = true;
    this._cancelled = true;
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
   _getHighestTierModel() { return modelsHelpers._getHighestTierModel.call(this); }
   _getOrchestratorModel() { return modelsHelpers._getOrchestratorModel.call(this); }
   _getAllowedFallbackModel() { return modelsHelpers._getAllowedFallbackModel.call(this); }
   _getParticipantModel(participant, fallbackOnError = false) { return modelsHelpers._getParticipantModel.call(this, participant, fallbackOnError); }
   async _promptOrchestrator(system, model, message, type, round) { return modelsHelpers._promptOrchestrator.call(this, system, model, message, type, round); }
   async initialize() { return initHelpers.initialize.call(this); }
   async runMeeting() { return weavingHelpers.runMeeting.call(this); }
   async extendMeeting(newPrompt, additionalRounds) { return weavingHelpers.extendMeeting.call(this, newPrompt, additionalRounds); }
   async resumeMeeting() { return weavingHelpers.resumeMeeting.call(this); }
   async _runWeavingLoop() { return weavingHelpers._runWeavingLoop.call(this); }
   _tokenBudgetExceeded() { return weavingHelpers._tokenBudgetExceeded.call(this); }
   _raceWithGuardTimer(promise, timeoutMs, label) { return weavingHelpers._raceWithGuardTimer.call(this, promise, timeoutMs, label); }
   async runRound() { return roundHelpers.runRound.call(this); }
   async _continueInterruptedRound() { return roundHelpers._continueInterruptedRound.call(this); }
   async _finalizeRound(round) { return roundHelpers._finalizeRound.call(this, round); }
   _isPersistenceError(err) { return roundHelpers._isPersistenceError.call(this, err); }
   async _persistState() { return roundHelpers._persistState.call(this, err); }
   _getMergedStats() { return roundHelpers._getMergedStats.call(this, err); }
   _logError(context, error, phase) { return roundHelpers._logError.call(this, context, error, phase); }
   _notifyUpdate() { return roundHelpers._notifyUpdate.call(this); }
   async _synthesize() { return synthesisHelpers._synthesize.call(this); }
   async finishSynthesis(originalStatus) { return synthesisHelpers.finishSynthesis.call(this, originalStatus); }
   _computeQualityTelemetry() { return synthesisHelpers._computeQualityTelemetry.call(this); }
   _saveArtifact(artifact) { return synthesisHelpers._saveArtifact.call(this, artifact); }
   _saveMeetingMetrics() { return synthesisHelpers._saveMeetingMetrics.call(this, artifact); }
}

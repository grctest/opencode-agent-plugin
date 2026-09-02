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
import { TimeBudget } from "./orchestrator/time-budget.js";

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
  _meetingTimeoutMs;
  _sessionManager = null;
  _logger = null;
  _orchestratorMessages = [];
  _resume = false;
  _callStats = { orchestrator: 0, summary: 0, synthesis: 0, input_tokens: 0, output_tokens: 0 };
  _personaIndex = null;
  _availableModels = [];
  _maxTotalTokens = 0;
  /** @type {import("./orchestrator/time-budget.js").TimeBudget} */
  _timeBudget;

  constructor(options) {
    this._meetingId = options.meetingId ?? crypto.randomUUID();
    this._resume = options.resume === true;
    this._options = options;
    this._client = options.client;
    this._directory = options.directory;
    this._parentSessionId = options.parentSessionId;
    // Hard deadline disabled by default (P1 Option A) — meeting_timeout removed from knit.
    // Stall watchdog (10m inactivity) and provider errors are the only extrinsic stops.
    // Any explicit value is treated as no limit to avoid LLM hallucinating 120000.
    this._meetingTimeoutMs = 0;
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

    this._timeBudget = new TimeBudget(this._startTime, this._meetingTimeoutMs);
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

  // Thin forwarders — bound to orchestrator instance so helpers can access this.* services.
  _modelList() { return modelsHelpers._modelList.call(this); }
  _getHighestTierModel() { return modelsHelpers._getHighestTierModel.call(this); }
  _getAllowedFallbackModel() { return modelsHelpers._getAllowedFallbackModel.call(this); }
  _getParticipantModel(participant, fallbackOnError = false) { return modelsHelpers._getParticipantModel.call(this, participant, fallbackOnError); }
  async _promptOrchestrator(system, model, message, type, round) { return modelsHelpers._promptOrchestrator.call(this, system, model, message, type, round); }
  async initialize() { return initHelpers.initialize.call(this); }
  async runMeeting() { return weavingHelpers.runMeeting.call(this); }
  async extendMeeting(newPrompt) { return weavingHelpers.extendMeeting.call(this, newPrompt); }
  async _runWeavingLoop() { return weavingHelpers._runWeavingLoop.call(this); }
  _tokenBudgetExceeded() { return weavingHelpers._tokenBudgetExceeded.call(this); }
  _remainingMs() {
    if (this._timeBudget) return this._timeBudget.remainingMs();
    return weavingHelpers._remainingMs.call(this);
  }
  _raceWithGuardTimer(promise, timeoutMs, label) { return weavingHelpers._raceWithGuardTimer.call(this, promise, timeoutMs, label); }
  _checkTimeout() {
    if (this._timeBudget) {
      if (this._timeBudget.checkTimeout()) {
        this._stateManager.transitionTo("timeout");
        this._logger.warn("timeout", "Meeting timed out", { elapsed: Date.now() - this._startTime, limit: this._meetingTimeoutMs });
        return true;
      }
      return false;
    }
    return weavingHelpers._checkTimeout.call(this);
  }
  async runRound() { return roundHelpers.runRound.call(this); }
  async _finalizeRound(round) { return roundHelpers._finalizeRound.call(this, round); }
  _isPersistenceError(err) { return roundHelpers._isPersistenceError.call(this, err); }
  async _persistState() { return roundHelpers._persistState.call(this); }
  _getMergedStats() { return roundHelpers._getMergedStats.call(this); }
  _logError(context, error, phase) { return roundHelpers._logError.call(this, context, error, phase); }
  _notifyUpdate() { return roundHelpers._notifyUpdate.call(this); }
  async _synthesize() { return synthesisHelpers._synthesize.call(this); }
  _computeQualityTelemetry() { return synthesisHelpers._computeQualityTelemetry.call(this); }
  _saveArtifact(artifact) { return synthesisHelpers._saveArtifact.call(this, artifact); }
  _saveMeetingMetrics() { return synthesisHelpers._saveMeetingMetrics.call(this); }
}

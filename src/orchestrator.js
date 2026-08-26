/**
 * MeetingOrchestrator — composition root (Phase 3 audit).
 *
 * Composition: this class is the single owner of meeting state/services and
 * delegates behavior to focused helpers under src/orchestrator/ (weaving,
 * round, synthesis, models, init) plus services/. Helpers are currently
 * mixed in via thin `apply(this)` forwarders so `this` stays the orchestrator
 * instance (explicit dependency injection via args is the intended future —
 * see weaving/round helpers receiving stateManager/database/etc. directly).
 * This header documents the intended decomposition; the forwarder pattern is
 * retained for minimal-risk Phase 3.
 *
 * Constants (SUMMARY_TRUNCATE_LEN / MAX_ORCHESTRATOR_MESSAGES) are now
 * canonical here; src/orchestrator/constants.js re-exports them for
 * backward compat. Deadline logic is centralized in TimeBudget.
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
import { ModeratorService } from "./services/moderator-service.js";

import { SynthesisCoordinator } from "./synthesis-coordinator.js";
import { updateStateOfPlay } from "./fabric-manager.js";
import { RoundService } from "./services/round-service.js";
import { RoundExecutor } from "./round-executor.js";
import { StallWatchdog } from "./services/stall-watchdog.js";
import { RoundInitializer } from "./services/round-initializer.js";
import { MeetingExtender } from "./services/meeting-extender.js";
import { VectorIndex } from "./services/vector-index.js";
import { PersonaIndex } from "./services/persona-index.js";
import { getPersonas } from "./composer.js";
import * as weavingHelpers from "./orchestrator/weaving.js";
import * as roundHelpers from "./orchestrator/round.js";
import * as synthesisHelpers from "./orchestrator/synthesis.js";
import * as modelsHelpers from "./orchestrator/models.js";
import * as initHelpers from "./orchestrator/init.js";
import { TimeBudget } from "./orchestrator/time-budget.js";

// Canonical constants — single source (Phase 3 collapse of orchestrator/constants.js)
export const SUMMARY_TRUNCATE_LEN = 200;
export const MAX_ORCHESTRATOR_MESSAGES = 200;

export class MeetingOrchestrator {
  _meetingId;
  _stateManager;
  _persistenceService;
  _moderatorService;
  _synthesisCoordinator;
  _roundService;
  _roundInitializer;
  _meetingExtender;
  _stallWatchdog;
  _vectorIndex;
  _options;
  _client;
  _directory;
  _parentSessionId;
  _database = null;
  _roundExecutor = null;
  _cancelled = false;
  _startTime = 0;
  _meetingTimeoutMs;
  _sessionManager = null;
  _logger = null;
  _orchestratorMessages = [];
  _resume = false;
  _callStats = { orchestrator: 0, moderation: 0, summary: 0, synthesis: 0, input_tokens: 0, output_tokens: 0 };
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
    this._meetingTimeoutMs = options.meetingTimeoutMs ?? getConfig().defaultMeetingTimeoutMs;
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
    this._moderatorService = new ModeratorService();
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

  getVectorIndex() {
    return this._vectorIndex;
  }

  cancel() {
    this._cancelled = true;
    this._logger.info("cancellation", "Loom cancelled by user");
  }

    async close() {
    try {
      if (this._sessionManager) {
        try { await this._sessionManager.deleteOrchestratorSession(); } catch {}
      }
      if (this._database) {
        this._logger.info("close", "Closing meeting database");
        this._database.close();
      }
    } catch (err) {
      this._logger.error("close_failed", "Failed to close database", extractErrorInfo(err));
    } finally {
      try { this._stallWatchdog?.stop(); } catch {}
    }
  }

  // ---------------------------------------------------------------------------
  // Mixin forwarders (Phase 3): thin `apply(this)` delegators — `this` remains
  // the orchestrator instance so helpers can access services/state. Explicit
  // dependency-injection (passing stateManager/database/etc. as args) is the
  // intended future; retained here for minimal-risk audit with documented
  // composition in the file header. Each forwarder has JSDoc where behavior
  // is non-trivial; trivial delegators are intentionally one-liners.
  // ---------------------------------------------------------------------------
  /** @returns {Array<{tier:string, model:any}>} */
  _modelList(...args) {
    return modelsHelpers._modelList.apply(this, args);
  }
  _getHighestTierModel(...args) {
    return modelsHelpers._getHighestTierModel.apply(this, args);
  }
  _getAllowedFallbackModel(...args) {
    return modelsHelpers._getAllowedFallbackModel.apply(this, args);
  }
  _getParticipantModel(...args) {
    return modelsHelpers._getParticipantModel.apply(this, args);
  }
  async _promptOrchestrator(...args) {
    return modelsHelpers._promptOrchestrator.apply(this, args);
  }
  async initialize(...args) {
    return initHelpers.initialize.apply(this, args);
  }
  async runMeeting(...args) {
    return weavingHelpers.runMeeting.apply(this, args);
  }
  async extendMeeting(...args) {
    return weavingHelpers.extendMeeting.apply(this, args);
  }
  async _runWeavingLoop(...args) {
    return weavingHelpers._runWeavingLoop.apply(this, args);
  }

  /**
   * Token budget brake (audit 14 PV4): maxTotalTokens > 0 caps total LLM tokens
   * per meeting so a runaway meeting has a cost ceiling, not just a time one.
   */
  _tokenBudgetExceeded(...args) {
    return weavingHelpers._tokenBudgetExceeded.apply(this, args);
  }

  /**
   * Single deadline authority (audit 01 E6) — every timeout check consults this.
   * Delegates to TimeBudget when available (Phase 3 centralization).
   */
  _remainingMs(...args) {
    if (this._timeBudget) {
      this._timeBudget.syncFrom(this);
      return this._timeBudget.remainingMs(...args);
    }
    return weavingHelpers._remainingMs.apply(this, args);
  }

  /**
   * Promise.race with a guard timer that is always cleared and unref'd, so losing
   * the race doesn't leak a pending timer (audit 05 LS6 / audit 17 PF1).
   */
  _raceWithGuardTimer(...args) {
    return weavingHelpers._raceWithGuardTimer.apply(this, args);
  }
  _checkTimeout(...args) {
    if (this._timeBudget) {
      this._timeBudget.syncFrom(this);
      if (this._timeBudget.checkTimeout()) {
        this._stateManager.transitionTo("timeout");
        this._logger.warn("timeout", "Meeting timed out", { elapsed: Date.now() - this._startTime, limit: this._meetingTimeoutMs });
        return true;
      }
      return false;
    }
    return weavingHelpers._checkTimeout.apply(this, args);
  }
  async runRound(...args) {
    return roundHelpers.runRound.apply(this, args);
  }
  async _finalizeRound(...args) {
    return roundHelpers._finalizeRound.apply(this, args);
  }

  /**
   * Classify whether an error from finalization is a persistence/indexing problem
   * (degradable) vs. a logic/state-machine error (must abort) — audit 01 E2.
   */
  _isPersistenceError(...args) {
    return roundHelpers._isPersistenceError.apply(this, args);
  }
  async _persistState(...args) {
    return roundHelpers._persistState.apply(this, args);
  }
  _getMergedStats(...args) {
    return roundHelpers._getMergedStats.apply(this, args);
  }
  _logError(...args) {
    return roundHelpers._logError.apply(this, args);
  }
  _notifyUpdate(...args) {
    return roundHelpers._notifyUpdate.apply(this, args);
  }
  async _synthesize(...args) {
    return synthesisHelpers._synthesize.apply(this, args);
  }

  /**
   * Deliberation quality telemetry (audit 14 PV5): derived counts over the
   * final weave — contribution mix, dissent survival, participation, votes.
   * Persisted inside meeting_metrics.counters.quality for trend analysis.
   */
  _computeQualityTelemetry(...args) {
    return synthesisHelpers._computeQualityTelemetry.apply(this, args);
  }
  _saveArtifact(...args) {
    return synthesisHelpers._saveArtifact.apply(this, args);
  }
  _saveMeetingMetrics(...args) {
    return synthesisHelpers._saveMeetingMetrics.apply(this, args);
  }
}

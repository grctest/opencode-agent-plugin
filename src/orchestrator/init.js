import { getConfig } from "../config.js";
import { MeetingDatabase } from "../database.js";
import { SessionManager } from "../session-manager.js";
import { SynthesisCoordinator } from "../synthesis-coordinator.js";
import { PersonaIndex } from "../services/persona-index.js";
import { getPersonas } from "../composer.js";
import { restoreStateFromDb } from "../meeting-restorer.js";
import { RoundExecutor } from "../round-executor.js";
import { RoundService } from "../services/round-service.js";
import { StateManager } from "../services/state-manager.js";
import { PersistenceService } from "../services/persistence-service.js";
import { extractErrorInfo } from "../logger.js";

  export async function initialize() {
    if (this._stateManager.getStatus() !== "initializing") {
      return;
    }

    this._startTime = Date.now();

    try {
      const dbPath = this.getDbPath();
      const db = await MeetingDatabase.create(dbPath, this._meetingId);
      this._database = db;
      this._persistenceService = new PersistenceService(db, this._meetingId);

      this._sessionManager = new SessionManager(this._client, this._directory, this._parentSessionId, this._logger);
       this._sessionManager.setDatabase(db);
       this._sessionManager.setTokenRecorder((tokens) => this.recordTokens(tokens));
       this._sessionManager.setCallRecorder((type) => {
         if (!type) return;
         this._callStats[type] = (this._callStats[type] ?? 0) + 1;
       });
       this._synthesisCoordinator = new SynthesisCoordinator(this._sessionManager, this._options.orchestratorConfig);

      // Ensure the meeting row exists before any state is recorded against it.
      // Use upsertMeeting (UPDATE when already present from the dashboard
      // composition phase) to avoid cascade-deleting meeting-scoped rows.
      if (this._resume) {
        const restored = restoreStateFromDb({
          db,
          stateManager: this._stateManager,
          meetingId: this._meetingId,
          options: this._options,
        });
        this._stateManager.setNextSpeakerId(restored.nextSpeakerId);
        this._callStats = { ...this._callStats, ...restored.callStats };
      } else {
        const meetingInput = {
          question: this._options.question,
          context: this._options.context,
          maxRounds: this._options.maxRounds,
          convergence: "agent_driven", // display-only; termination is agent-driven via loom_pass tool
          tags: this._options.tags ?? [],
          parentSessionId: this._options.parentSessionId,
          opencodeSessionId: this._options.opencodeSessionId ?? this._options.parentSessionId,
          embedding_model: this._options.embedding_model ?? null,
          embedding_dim: this._options.embedding_dim ?? null,
          participants: this._stateManager.getParticipants().map((p) => p.config),
        };
        db.upsertMeeting(meetingInput);
        this._logger.info("meeting_upserted", "Meeting row ensured in database");
      }

      // Ensure a real embedder is loaded; guard with 5s timeout so init never hangs indefinitely (init runs outside stall watchdog)
      try {
        const { ensureEmbedderInitialized, isEmbedderInitialized, getEmbeddingDim } = await import("../services/embedding-service.js");
        const modelName = this._options.embedding_model ?? getConfig().embeddingModel ?? null;
        const wasInitialized = isEmbedderInitialized();
        await this._raceWithGuardTimer(ensureEmbedderInitialized(modelName, getConfig().embeddingQuant), 5000, "embedderInit");
        if (modelName) {
          if (!wasInitialized && isEmbedderInitialized()) {
            this._logger.info("embedder_initialized", `Embedding model loaded: ${modelName} (${getEmbeddingDim()}d)`);
          } else if (wasInitialized) {
            this._logger.debug("embedder_reused", `Embedding model reused: ${modelName} (${getEmbeddingDim()}d) — already initialized`);
          }
        }
      } catch (err) {
        this._logger.warn("embedder_init_failed", `Failed to initialize embedding model: ${err.message}`, extractErrorInfo(err));
      }

      // Index personas into the process-scoped in-memory store for similarity
      // search. Skipped internally when the model and catalog are unchanged.
      try {
        const personaIndex = new PersonaIndex();
        const personas = getPersonas();
        await personaIndex.indexAll(personas);
      } catch (err) {
        this._logger.warn("persona_index_failed", "Failed to index personas for similarity search", extractErrorInfo(err));
      }

      // Transition first, then persist — the DB must never lag the in-memory status
      // for the entire first round (audit 01 E1). transitionTo performs no I/O.
      this._stateManager.transitionTo("weaving");
      await this._persistState();

      this._roundExecutor = new RoundExecutor({
        db,
        stateManager: this._stateManager,
        options: {
          onAgentComplete: this._options.onAgentComplete,
          onContribution: (...args) => {
            this._stallWatchdog.touch();
            this._options.onContribution?.(...args);
          },
          onProgress: async (message) => this._sessionManager.postProgress(message),
          createEphemeralSession: async (participant) => this._sessionManager.createEphemeralSession(participant),
          deleteEphemeralSession: async (sessionId) => this._sessionManager.deleteEphemeralSession(sessionId),
        },
        sessionManager: this._sessionManager,
        promptParent: async (system, model, message) => this._promptOrchestrator(system, model, message),
        getParticipantModel: (participant) => this._getParticipantModel(participant, true),
        logError: (context, error) => this._logError(context, error),
        tools: this._options.agentTools ?? null,
        availableModels: this._availableModels,
        directory: this._directory,
      });

      this._roundService = new RoundService({ roundExecutor: this._roundExecutor, stateManager: this._stateManager });

      this._logger.info("initialized", `Meeting ${this._resume ? "resumed" : "initialized"}`, { participants: this._stateManager.getParticipants().length, resumed: this._resume });
    } catch (err) {
      const info = extractErrorInfo(err);
      this._logger.error("init_failed", "Failed to initialize meeting", info);
      throw err;
    }
  }


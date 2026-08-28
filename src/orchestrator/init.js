import { getConfig } from "../config.js";
import { MeetingDatabase } from "../database.js";
import { SessionManager } from "../session-manager.js";
import { SynthesisCoordinator } from "../synthesis-coordinator.js";
import { VectorIndex } from "../services/vector-index.js";
import { PersonaIndex } from "../services/persona-index.js";
import { getPersonas } from "../composer.js";
import { restoreStateFromDb } from "../meeting-restorer.js";
import { RoundExecutor } from "../round-executor.js";
import { RoundService } from "../services/round-service.js";
import { StateManager } from "../services/state-manager.js";
import { PersistenceService } from "../services/persistence-service.js";
import { ModeratorService } from "../services/moderator-service.js";
import { extractErrorInfo } from "../logger.js";

export async function initialize() {
    if (this._stateManager.getStatus() !== "initializing") {
      return;
    }

    this._startTime = Date.now();
    if (this._timeBudget) this._timeBudget.reset(this._startTime, this._meetingTimeoutMs);

    try {
      const dbPath = this.getDbPath();
      const db = await MeetingDatabase.create(dbPath, this._meetingId);
      this._database = db;
      this._persistenceService = new PersistenceService(db, this._meetingId);
      this._vectorIndex = new VectorIndex(db);

      this._sessionManager = new SessionManager(this._client, this._directory, this._parentSessionId, this._logger);
      this._sessionManager.setDatabase(db);
      this._synthesisCoordinator = new SynthesisCoordinator(this._sessionManager);

      // Ensure the meeting row exists BEFORE indexing personas.
      // The persona_embeddings table has a FK to meetings(id), so the meeting
      // must be inserted first.  Use upsertMeeting (UPDATE when already present
      // from the knit-handler composition phase) to avoid cascade-deleting the
      // persona embeddings that were just stored.
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
          convergence: "moderator_forces", // display-only; termination is deterministic
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
        const { ensureEmbedderInitialized, getEmbeddingDim } = await import("../services/embedding-service.js");
        const modelName = this._options.embedding_model ?? getConfig().embeddingModel ?? null;
        await this._raceWithGuardTimer(ensureEmbedderInitialized(modelName, getConfig().embeddingQuant), 5000, "embedderInit");
        if (modelName) {
          this._logger.info("embedder_initialized", `Embedding model loaded: ${modelName} (${getEmbeddingDim()}d)`);
        }
      } catch (err) {
        this._logger.warn("embedder_init_failed", `Failed to initialize embedding model: ${err.message}`, extractErrorInfo(err));
      }

      // Index personas into the meeting database for vector similarity search.
      // Skip if already indexed for this meeting (per-meeting scoping).
      const { isEmbedderInitialized } = await import("../services/embedding-service.js");
      if (isEmbedderInitialized()) {
        try {
          this._personaIndex = new PersonaIndex(db);
          if (db.countPersonaEmbeddings() === 0) {
            const personas = getPersonas();
            await this._personaIndex.indexAll(personas);
            if (db.countPersonaEmbeddings() > 0) {
              try { db.setSemanticDegraded(false); } catch {}
            }
          } else {
            this._logger.info("personas_already_indexed", "Persona embeddings already present for this meeting");
          }
        } catch (err) {
          this._logger.warn("persona_index_failed", "Failed to index personas for vector search", extractErrorInfo(err));
        }

        // Load persona embeddings onto participant objects for reflection targeting
        try {
          const participants = this._stateManager.getParticipants();
          const names = participants.map((p) => p.config.name);
          const embeddingMap = db.getPersonaEmbeddingsByNames(names);
          for (const p of participants) {
            this._stateManager.setParticipantEmbedding(p.config.id, embeddingMap.get(p.config.name) ?? null);
          }
        } catch (err) {
          this._logger.warn("embedding_load_failed", "Failed to load embeddings onto participants", extractErrorInfo(err));
        }
      }

      // Transition first, then persist — the DB must never lag the in-memory status
      // for the entire first round (audit 01 E1). transitionTo performs no I/O.
      this._stateManager.transitionTo("weaving");
      await this._persistState();

      if (!this._resume && this._options.context) {
        const { isEmbedderInitialized: isInit } = await import("../services/embedding-service.js");
        if (!isInit()) {
          this._logger.debug("vector_index_skipped", "Skipping context vector indexing — embedding service not initialized");
        } else {
          try {
            await this._raceWithGuardTimer(
              this._vectorIndex.indexContext(this._options.context),
              10000,
              "indexContext",
            );
          } catch (err) {
            this._logger.warn("vector_index_context_failed", "Failed to index context for vector search", extractErrorInfo(err));
          }
        }
      }

      this._roundExecutor = new RoundExecutor({
        db,
        stateManager: this._stateManager,
        vectorIndex: this._vectorIndex,
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
      });

      this._roundService = new RoundService({ roundExecutor: this._roundExecutor });

      this._logger.info("initialized", `Meeting ${this._resume ? "resumed" : "initialized"}`, { participants: this._stateManager.getParticipants().length, resumed: this._resume });
    } catch (err) {
      const info = extractErrorInfo(err);
      this._logger.error("init_failed", "Failed to initialize meeting", info);
      throw err;
    }
  }


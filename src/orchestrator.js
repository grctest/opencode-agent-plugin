import { getTierConfig } from "./shared.js";
import { getConfig } from "./config.js";
import { getMeetingDbPath } from "./paths.js";
import { MeetingDatabase } from "./database.js";
import { SessionManager } from "./session-manager.js";
import { Logger, LoomError, extractErrorInfo } from "./logger.js";
import { detectDomainsWithLLM } from "./composer.js";
import { getHighestTierModel } from "./services/model-service.js";
import { truncate } from "./shared.js";
import { restoreStateFromDb } from "./meeting-restorer.js";
import { collectObjections } from "./objection-collector.js";

import { StateManager } from "./services/state-manager.js";
import { PersistenceService } from "./services/persistence-service.js";
import { ModeratorService } from "./services/moderator-service.js";
import { ConvergenceService } from "./services/convergence-service.js";
import { SynthesisCoordinator } from "./synthesis-coordinator.js";
import { FabricService } from "./services/fabric-service.js";
import { RoundService } from "./services/round-service.js";
import { RoundExecutor } from "./round-executor.js";
import { StallWatchdog } from "./services/stall-watchdog.js";
import { RoundInitializer } from "./services/round-initializer.js";
import { MeetingExtender } from "./services/meeting-extender.js";
import { VectorIndex } from "./services/vector-index.js";

// Named constants for magic numbers
const SUMMARY_TRUNCATE_LEN = 200;
const MAX_ORCHESTRATOR_MESSAGES = 200;

export class MeetingOrchestrator {
  #meetingId;
  #stateManager;
  #persistenceService;
  #moderatorService;
  #convergenceService;
  #synthesisCoordinator;
  #fabricService;
  #roundService;
  #roundInitializer;
  #meetingExtender;
  #stallWatchdog;
  #vectorIndex;
  #options;
  #client;
  #directory;
  #parentSessionId;
  #database = null;
  #roundExecutor = null;
  #cancelled = false;
  #startTime = 0;
  #meetingTimeoutMs;
  #sessionManager = null;
  #logger = null;
  #orchestratorMessages = [];
  #resume = false;
  #callStats = { orchestrator: 0, domain: 0, compaction: 0, moderation: 0, summary: 0, convergence: 0, synthesis: 0, input_tokens: 0, output_tokens: 0 };

  constructor(options) {
    this.#meetingId = options.meetingId ?? crypto.randomUUID();
    this.#resume = options.resume === true;
    this.#options = options;
    this.#client = options.client;
    this.#directory = options.directory;
    this.#parentSessionId = options.parentSessionId;
    this.#meetingTimeoutMs = options.meetingTimeoutMs ?? getConfig().defaultMeetingTimeoutMs;

    this.#logger = new Logger().forMeeting(this.#meetingId);

    const initialState = {
      id: this.#meetingId,
      parent_session_id: options.parentSessionId,
      question: options.question,
      context: options.context,
      participants: options.participants.map((p) => ({
        config: p,
        tier_config: getTierConfig(p.tier),
        session_id: "",
        status: "listening",
        session_version: 0,
        reflections: [],
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
      convergence_mode: options.convergence,
      domain: options.domain ?? null,
      next_contribution_id: 0,
    };

    this.#stateManager = new StateManager(initialState);
    this.#moderatorService = new ModeratorService();
    this.#convergenceService = new ConvergenceService();
    this.#fabricService = new FabricService();
    this.#roundInitializer = new RoundInitializer();
    this.#meetingExtender = new MeetingExtender();
    this.#stallWatchdog = new StallWatchdog({
      onStall: () => {
        this.#cancelled = true;
        this.#sessionManager?.postProgress("⏱️ No activity detected for a while — stopping the deliberation.");
      },
      logger: this.#logger,
    });
  }

   getDbPath() {
    return getMeetingDbPath(this.#directory, this.#meetingId);
  }

  getMeetingId() {
    return this.#meetingId;
  }

  getState() {
    return this.#stateManager.getState();
  }

  getOrchestratorMessages() {
    return [...this.#orchestratorMessages];
  }

  cancel() {
    this.#cancelled = true;
    this.#logger.info("cancellation", "Loom cancelled by user");
  }

  async close() {
    try {
      if (this.#database) {
        this.#logger.info("close", "Closing meeting database");
        this.#database.close();
      }
    } catch (err) {
      this.#logger.warn("close_failed", "Failed to close database", extractErrorInfo(err));
    }
  }

  #modelList() {
    return this.#stateManager.getParticipants().map((p) => ({ tier: p.config.tier, model: p.config.model }));
  }

  #getHighestTierModel() {
    return getHighestTierModel(this.#modelList());
  }

  #getParticipantModel(participant, fallbackOnError = false) {
    if (participant.config.model) {
      const model = { providerID: participant.config.model.providerID, modelID: participant.config.model.modelID };
      if (fallbackOnError) {
        if (this.#roundExecutor && this.#roundExecutor.isModelHealthy(model)) {
          return model;
        }
        const fallback = this.#getHighestTierModel();
        if (fallback) return fallback;
      }
      return model;
    }
    const fallback = this.#getHighestTierModel();
    if (fallback) return fallback;
    throw new LoomError(
      `No model assigned for participant ${participant.config.name} (${participant.config.tier})`,
      { phase: "model_assignment", participantId: participant.config.id, recoverable: false }
    );
  }

  async #promptOrchestrator(system, model, message, type = "orchestrator") {
    const fastPathModel = getConfig().fastPathModel;
    const useModel = (fastPathModel && (type === "moderation" || type === "compaction" || type === "summary"))
      ? fastPathModel
      : model;

    this.#callStats[type] = (this.#callStats[type] ?? 0) + 1;
    if (this.#orchestratorMessages.length >= MAX_ORCHESTRATOR_MESSAGES) {
      this.#orchestratorMessages.shift();
    }
    this.#orchestratorMessages.push({ type, role: "user", content: message, timestamp: Date.now() });
    if (this.#database) {
      this.#database.addOrchestratorMessage(type, "user", message);
    }
    const { text: response, tokens } = await this.#sessionManager.promptOrchestrator(system, useModel, message);
    if (tokens) {
      this.#callStats.input_tokens += tokens.input ?? 0;
      this.#callStats.output_tokens += tokens.output ?? 0;
    }
    if (this.#orchestratorMessages.length >= MAX_ORCHESTRATOR_MESSAGES) {
      this.#orchestratorMessages.shift();
    }
    this.#orchestratorMessages.push({ type, role: "assistant", content: response, timestamp: Date.now() });
    if (this.#database) {
      this.#database.addOrchestratorMessage(type, "assistant", response);
    }
    return response;
  }

  async initialize() {
    if (this.#stateManager.getStatus() !== "initializing") {
      return;
    }

    this.#startTime = Date.now();

    try {
      const dbPath = this.getDbPath();
      const db = await MeetingDatabase.create(dbPath, this.#meetingId);
      this.#database = db;
      this.#persistenceService = new PersistenceService(db, this.#meetingId);
      this.#vectorIndex = new VectorIndex(db);
      this.#convergenceService.setVectorIndex(this.#vectorIndex);

      this.#sessionManager = new SessionManager(this.#client, this.#directory, this.#parentSessionId, this.#logger);
      this.#synthesisCoordinator = new SynthesisCoordinator(this.#client, this.#directory, this.#sessionManager);

      if (this.#resume) {
        const restored = restoreStateFromDb({
          db,
          stateManager: this.#stateManager,
          meetingId: this.#meetingId,
          options: this.#options,
        });
        this.#stateManager.setNextSpeakerId(restored.nextSpeakerId);
        this.#callStats = { ...this.#callStats, ...restored.callStats };
      } else {
        db.initializeMeeting({
          question: this.#options.question,
          context: this.#options.context,
          maxRounds: this.#options.maxRounds,
          convergence: this.#options.convergence,
          domain: this.#options.domain ?? null,
          parentSessionId: this.#options.parentSessionId,
          opencodeSessionId: this.#options.opencodeSessionId ?? this.#options.parentSessionId,
          participants: this.#stateManager.getParticipants().map((p) => p.config),
        });

        for (const p of this.#stateManager.getParticipants()) {
          if (!p.session_id) {
            const sessionId = await this.#sessionManager.createChildSession(p);
            this.#stateManager.setParticipantSessionId(p.config.id, sessionId);
            this.#stateManager.setParticipantSessionVersion(p.config.id, 1);
            db.setParticipantSessionId(p.config.id, sessionId);
          }
        }
      }

      const orchestratorSessionId = await this.#sessionManager.createOrchestratorSession();
      this.#sessionManager.setOrchestratorSessionId(orchestratorSessionId);

      if (this.#options.detectDomains && !this.#stateManager.getDomain()) {
        try {
          const domains = await detectDomainsWithLLM(
            this.#stateManager.getQuestion(),
            async (system, model, message) => this.#promptOrchestrator(system, model, message, "domain"),
            () => this.#getHighestTierModel(),
          );
          if (domains.length > 0) {
            this.#stateManager.setDomain(domains.join(", "));
            db.updateMeetingDomain(this.#meetingId, this.#stateManager.getDomain());
          }
        } catch (err) {
          this.#logger.warn("domain_detection_failed", "Orchestrator domain detection failed", extractErrorInfo(err));
        }
      }

      await this.#persistState();
      this.#stateManager.transitionTo("weaving");

      if (!this.#resume && this.#options.context) {
        this.#vectorIndex.indexContext(this.#options.context).catch(() => {});
      }

      this.#roundExecutor = new RoundExecutor({
        client: this.#client,
        directory: this.#directory,
        db,
        stateManager: this.#stateManager,
        vectorIndex: this.#vectorIndex,
        options: {
          onAgentComplete: this.#options.onAgentComplete,
          onContribution: (...args) => {
            this.#stallWatchdog.touch();
            this.#options.onContribution?.(...args);
          },
          onProgress: async (message) => this.#sessionManager.postProgress(message),
          recreateSession: async (participant) => this.#sessionManager.recreateSession(participant, db),
        },
        promptParent: async (system, model, message) => this.#promptOrchestrator(system, model, message),
        getParticipantModel: (participant) => this.#getParticipantModel(participant, true),
        logError: (context, error) => this.#logError(context, error),
      });

      this.#roundService = new RoundService({ roundExecutor: this.#roundExecutor });

      this.#logger.info("initialized", `Meeting ${this.#resume ? "resumed" : "initialized"}`, { participants: this.#stateManager.getParticipants().length, resumed: this.#resume });
    } catch (err) {
      const info = extractErrorInfo(err);
      this.#logger.error("init_failed", "Failed to initialize meeting", info);
      throw err;
    }
  }

  async runMeeting() {
    await this.initialize();

    const participantItems = this.#stateManager.getParticipants()
      .map((p) => `  - ${p.config.name} (${p.config.tier}${p.config.domain ? ", " + p.config.domain : ""})`)
      .join("\n");
    await this.#sessionManager.postProgress(
      `🎬 Loom started — ${this.#stateManager.getParticipants().length} participants:\n${participantItems}`
    );

    this.#stallWatchdog.start(
      () => this.#stateManager.getStatus(),
      () => this.#cancelled,
    );
    try {
      await this.#runWeavingLoop();
    } finally {
      this.#stallWatchdog.stop();
    }

    const output = await this.#synthesize();
    return output;
  }

  async extendMeeting(newPrompt) {
    this.#startTime = Date.now();
    this.#cancelled = false;
    this.#stallWatchdog.reset();

    await this.#meetingExtender.extend({
      database: this.#database,
      stateManager: this.#stateManager,
      sessionManager: this.#sessionManager,
      roundExecutor: this.#roundExecutor,
      newPrompt,
    });

    this.#stallWatchdog.start(
      () => this.#stateManager.getStatus(),
      () => this.#cancelled,
    );
    try {
      await this.#runWeavingLoop();
    } finally {
      this.#stallWatchdog.stop();
    }
    const output = await this.#synthesize();
    return output;
  }

  async #runWeavingLoop() {
    let continueWeaving = true;
    while (continueWeaving) {
      if (this.#cancelled) {
        const terminal = this.#stallWatchdog.stallCancelled ? "timeout" : "cancelled";
        this.#stateManager.transitionTo(terminal);
        await this.#sessionManager.postProgress(
          this.#stallWatchdog.stallCancelled
            ? "⏱️ Loom stopped due to no activity — generating output from collected contributions."
            : "🛑 Loom cancelled by user."
        );
        this.#logger.info(this.#stallWatchdog.stallCancelled ? "stall_timeout" : "cancelled", "Meeting stopped before weaving loop completed");
        break;
      }

      if (Date.now() - this.#startTime > this.#meetingTimeoutMs) {
        this.#stateManager.transitionTo("timeout");
        await this.#sessionManager.postProgress("⏱️ Loom timed out — generating output from collected contributions.");
        this.#logger.warn("timeout", "Meeting timed out", { elapsed: Date.now() - this.#startTime, limit: this.#meetingTimeoutMs });
        break;
      }

      continueWeaving = await this.runRound();
      this.#notifyUpdate();
    }
  }

  #checkTimeout() {
    if (Date.now() - this.#startTime > this.#meetingTimeoutMs) {
      this.#stateManager.transitionTo("timeout");
      this.#logger.warn("timeout", "Meeting timed out", { elapsed: Date.now() - this.#startTime, limit: this.#meetingTimeoutMs });
      return true;
    }
    return false;
  }

  async runRound() {
    if (this.#checkTimeout()) {
      await this.#sessionManager.postProgress("⏱️ Loom timed out — generating output from collected contributions.");
      return false;
    }

    const round = this.#roundInitializer.initializeRound(this.#stateManager, this.#database, () => this.#notifyUpdate());
    await this.#roundInitializer.recreateDirtySessions(this.#stateManager, this.#sessionManager, this.#database, this.#roundExecutor);
    const activeParticipants = this.#roundInitializer.filterActiveParticipants(this.#stateManager, round);

    if (activeParticipants.length === 0) {
      this.#stateManager.transitionTo("converged");
      return false;
    }

    if (!this.#roundExecutor) {
      throw new LoomError("RoundExecutor not initialized — call initialize() first", { phase: "round_execution", recoverable: false });
    }

    const { round: updatedRound, ijNotes } = await this.#roundService.runRound({
      round,
      activeParticipants,
      allowInterjections: this.#options.allowInterjections !== false,
      promptOrchestrator: async (system, model, message, type) => this.#promptOrchestrator(system, model, message, type),
      getHighestTierModel: () => this.#getHighestTierModel(),
      state: this.#stateManager.getState(),
    });

    return this.#finalizeRound(updatedRound, ijNotes);
  }

  async #finalizeRound(updatedRound, ijNotes) {
    try {
      this.#database.setRoundSummary(updatedRound.number, updatedRound.summary);

      if (ijNotes) {
        this.#stateManager.setFabric(this.#stateManager.getFabric() + ijNotes);
      }

      const compactFn = this.#fabricService.createCompactionFunction(
        async (system, model, message) => this.#promptOrchestrator(system, model, message, "compaction"),
        () => this.#getHighestTierModel(),
      );
      const newFabric = await this.#fabricService.evolve(this.#stateManager.getFabric(), updatedRound, compactFn);
      this.#stateManager.setFabric(newFabric);
      this.#database.setFabric(newFabric);

      this.#vectorIndex.indexRound(
        updatedRound.number,
        updatedRound.summary,
        updatedRound.contributions,
      ).catch(() => {});

      const contribCount = updatedRound.contributions.length;
      const ijCount = updatedRound.interjections.length;
      const summaryText = updatedRound.summary ? ` | ${truncate(updatedRound.summary, SUMMARY_TRUNCATE_LEN)}` : "";
      await this.#sessionManager.postProgress(
        `📋 Round ${this.#stateManager.getCurrentRound()} complete — ${contribCount} contribution${contribCount !== 1 ? "s" : ""}, ${ijCount} interjection${ijCount !== 1 ? "s" : ""}${summaryText}`
      );

      if (this.#options.onRoundComplete) {
        this.#options.onRoundComplete(this.#stateManager.getCurrentRound(), updatedRound.summary);
      }
      this.#notifyUpdate();

      const modResult = await this.#moderatorService.checkAndProcess({
        round: updatedRound,
        participants: this.#stateManager.getParticipants(),
        weave: this.#stateManager.getWeave(),
        currentRound: this.#stateManager.getCurrentRound(),
        maxRounds: this.#stateManager.getMaxRounds(),
        promptOrchestrator: async (system, model, message) => this.#promptOrchestrator(system, model, message, "moderation"),
        getHighestTierModel: () => this.#getHighestTierModel(),
        postProgress: async (message) => this.#sessionManager.postProgress(message),
      });

      if (modResult.action === "converge") {
        this.#stateManager.transitionTo("converged");
        await this.#persistState();
        return false;
      }

      if (modResult.action === "break") {
        this.#stateManager.setNextSpeakerId(this.#stateManager.getParticipants()[modResult.nextSpeakerIdx]?.config.id ?? null);
      }

      const convergenceResult = await this.#convergenceService.check({
        state: this.#stateManager.getState(),
        round: updatedRound,
        promptOrchestrator: async (system, model, message) => this.#promptOrchestrator(system, model, message, "convergence"),
        getHighestTierModel: () => this.#getHighestTierModel(),
        postProgress: async (message) => this.#sessionManager.postProgress(message),
      });

      if (convergenceResult.extendAmount > 0) {
        this.#stateManager.setMaxRounds(this.#stateManager.getMaxRounds() + convergenceResult.extendAmount);
      }

      if (convergenceResult.shouldStop) {
        this.#stateManager.transitionTo("converged");
        await this.#persistState();
        return false;
      }

      if (this.#stateManager.getCurrentRound() >= this.#stateManager.getMaxRounds()) {
        this.#stateManager.transitionTo("max_rounds_reached");
        await this.#persistState();
        return false;
      }

      await this.#persistState();
      return true;
    } catch (err) {
      const info = extractErrorInfo(err);
      this.#logger.error("finalize_round_failed", `Failed to finalize round ${updatedRound.number}`, info);
      await this.#persistState();
      return false;
    }
  }

   async #persistState() {
    const sharedState = this.#stateManager.buildSharedState();
    const stats = this.#getMergedStats();
    try {
      await this.#persistenceService.persistState(sharedState, this.#stateManager.getNextSpeakerId(), stats);
      this.#persistenceService.persistMaxRounds(this.#stateManager.getMaxRounds());
    } catch (err) {
      const info = extractErrorInfo(err);
      this.#logger.error("persist_state_failed", "Failed to persist meeting state to database", info);
    }
   }

  #getMergedStats() {
    const roundStats = this.#roundExecutor?.getCallStats() ?? {};
    return { ...this.#callStats, ...roundStats };
  }

  #logError(context, error) {
    try {
      const info = extractErrorInfo(error);
      this.#logger.error(context, info.message, { stack: info.stack });
      if (this.#database) {
        this.#database.logError(context, info.message, { stack: info.stack });
      }
    } catch {
      // Last-resort: do not let error logging failures propagate
    }
  }

  #notifyUpdate() {
    this.#stallWatchdog.touch();
    if (this.#options.onUpdate) {
      this.#options.onUpdate(this.#stateManager.getState());
    }
  }

  async #synthesize() {
    const allFailed = this.#stateManager.getParticipants().every((p) => p.status === "failed");
    if (allFailed) {
      const output = `# Deliberation Output\n\n## Decision\nNo output could be generated — all participants failed to respond.\n\n## Reasoning\nAll ${this.#stateManager.getParticipants().length} participants encountered errors during the deliberation.\n\n## Action Items\n- Check model connectivity and retry\n- Verify provider authentication\n\n## Confidence\nLow (no contributions received)`;
      this.#saveArtifact({ content: output, format: "markdown", decisions: [], action_items: [], dissent: [], open_questions: [], confidence: "low" });
      await this.#sessionManager.postProgress("⚠️ All participants failed — no synthesis possible.");
      this.#logger.error("all_failed", "All participants failed — no synthesis possible");
      await this.#persistState();
      return output;
    }

    const totalContributions = this.#stateManager.getWeave().length;
    if (totalContributions === 0) {
      const output = `# Deliberation Output\n\n## Decision\nNo output could be generated — all participants passed without contributing.\n\n## Reasoning\nAll ${this.#stateManager.getParticipants().length} participants chose to pass. This may indicate the question was unclear or participants had nothing to add.\n\n## Action Items\n- Rephrase the question with more specific context\n- Add participants with more targeted expertise\n\n## Confidence\nLow (no contributions received)`;
      this.#saveArtifact({ content: output, format: "markdown", decisions: [], action_items: [], dissent: [], open_questions: [], confidence: "low" });
      await this.#sessionManager.postProgress("ℹ️ All participants passed — no contributions to synthesize.");
      this.#logger.warn("all_passed", "All participants passed — no contributions to synthesize");
      await this.#persistState();
      return output;
    }

    const synthesizer = this.#synthesisCoordinator.selectSynthesizer(this.#stateManager.getParticipants());
    const transcriptData = this.#database.getTranscriptData(this.#meetingId);

    const objections = collectObjections({
      rounds: this.#stateManager.getRounds(),
      participants: this.#stateManager.getParticipants(),
    });
    this.#stateManager.setObjections(objections);

    let result;
    try {
      result = await this.#synthesisCoordinator.run(
        transcriptData,
        this.#stateManager.getParticipants(),
        objections,
        synthesizer,
        (p) => this.#getParticipantModel(p, true),
        () => {
          if (this.#options.onSynthesisStart) this.#options.onSynthesisStart();
        },
        (output) => {
          if (this.#options.onSynthesisComplete) this.#options.onSynthesisComplete(output);
          this.#notifyUpdate();
        },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#logger.error("synthesis_failed", `Synthesis failed — persisting degraded artifact: ${message}`);
      await this.#sessionManager.postProgress(`⚠️ Synthesis failed (${message}) — degraded artifact persisted.`);
      const degraded = `# Deliberation Output\n\n## Decision\nSynthesis could not be completed (${message}).\n\n## Reasoning\nThe meeting reached its end state but the synthesis step failed. The full transcript is preserved for review.\n\n## Action Items\n- Retry synthesis with the meeting data\n- Review the transcript tab for the full deliberation\n\n## Confidence\nLow (synthesis interrupted)`;
      result = {
        output: degraded,
        artifact: { content: degraded, format: "markdown", decisions: [], action_items: [], dissent: [], open_questions: [], confidence: "low" },
      };
    }

    this.#callStats.synthesis++;
    await this.#persistState();
    this.#saveArtifact(result.artifact ?? { content: result.output, format: "markdown", decisions: [], action_items: [], dissent: [], open_questions: [], confidence: null });
    this.#saveMeetingMetrics();
    return result.output;
  }

  #saveArtifact(artifact) {
    this.#stateManager.setArtifact(artifact);
    if (this.#database) {
      this.#database.saveArtifact(artifact);
    }
  }

  #saveMeetingMetrics() {
    if (!this.#database) return;
    try {
      const stats = this.#getMergedStats();
      const weave = this.#stateManager.getWeave();
      const allInterjections = this.#stateManager.getRounds().flatMap((r) => r.interjections);
      this.#database.saveMeetingMetrics({
        counters: stats,
        latencies: {},
        input_tokens: stats.input_tokens ?? 0,
        output_tokens: stats.output_tokens ?? 0,
        duration_ms: Date.now() - this.#startTime,
        rounds: this.#stateManager.getCurrentRound(),
        contributions: weave.length,
        interjections: allInterjections.length,
      });
    } catch { /* non-critical */ }
  }
}

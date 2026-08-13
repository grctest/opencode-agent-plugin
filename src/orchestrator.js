import { getTierConfig } from "./shared.js";
import { getConfig } from "./config.js";
import { join } from "node:path";
import { MeetingDatabase, indexMeeting } from "./database.js";
import { SessionManager } from "./session-manager.js";
import { Logger, LoomError, extractErrorInfo } from "./logger.js";
import { composeRoomWithDomains, formatRoomPreview, detectDomainsWithLLM } from "./composer.js";
import { getHighestTierModel } from "./services/model-service.js";
import { truncate, parseStats, parseReflections } from "./shared.js";

import { StateManager } from "./services/state-manager.js";
import { PersistenceService } from "./services/persistence-service.js";
import { ModeratorService } from "./services/moderator-service.js";
import { ConvergenceService } from "./services/convergence-service.js";
import { SynthesisService } from "./services/synthesis-service.js";
import { WarpService } from "./services/warp-service.js";
import { RoundService } from "./services/round-service.js";
import { RoundExecutor } from "./round-executor.js";

export class MeetingOrchestrator {
  #meetingId;
  #stateManager;
  #persistenceService;
  #moderatorService;
  #convergenceService;
  #synthesisService;
  #warpService;
  #roundService;
  #options;
  #client;
  #directory;
  #parentSessionId;
  #database = null;
  #turnMode;
  #roundExecutor = null;
  #cancelled = false;
  #startTime = 0;
  #meetingTimeoutMs;
  #sessionManager = null;
  #logger = null;
  #orchestratorMessages = [];
  #nextSpeakerId = null;
  #resume = false;
  #callStats = { orchestrator: 0, domain: 0, compaction: 0, moderation: 0, summary: 0, convergence: 0, synthesis: 0 };

  constructor(options) {
    this.#meetingId = options.meetingId ?? crypto.randomUUID();
    this.#resume = options.resume === true;
    this.#options = options;
    this.#client = options.client;
    this.#directory = options.directory;
    this.#parentSessionId = options.parentSessionId;
    this.#turnMode = options.turnMode ?? getConfig().turnMode ?? "sequential";
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
      warp: options.context,
      weft: [],
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
    this.#warpService = new WarpService();
  }

   getDbPath() {
    const home = process.env.HOME || process.env.USERPROFILE || "/root";
    const baseDir = (this.#directory && this.#directory !== "/")
      ? join(this.#directory, ".opencode", "loom")
      : join(home, ".config", "opencode", "loom");
    return join(baseDir, "meetings", `${this.#meetingId}.db`);
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
    if (this.#database) {
      this.#logger.info("close", "Closing meeting database");
      this.#database.close();
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
    this.#callStats[type] = (this.#callStats[type] ?? 0) + 1;
    this.#orchestratorMessages.push({ type, role: "user", content: message, timestamp: Date.now() });
    if (this.#database) {
      this.#database.addOrchestratorMessage(type, "user", message);
    }
    const response = await this.#sessionManager.promptOrchestrator(system, model, message);
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

      this.#sessionManager = new SessionManager(this.#client, this.#directory, this.#parentSessionId, this.#logger);
      this.#synthesisService = new SynthesisService(this.#client, this.#directory, this.#sessionManager);

      if (this.#resume) {
        this.#restoreStateFromDb();
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
            p.session_id = sessionId;
            p.session_version = 1;
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

      this.#roundExecutor = new RoundExecutor({
        client: this.#client,
        directory: this.#directory,
        db,
        state: this.#stateManager.getMutableState(),
        options: {
          onAgentComplete: this.#options.onAgentComplete,
          onContribution: this.#options.onContribution,
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

  /** Rebuilds in-memory state from the meeting database (used when extending a completed meeting). */
  #restoreStateFromDb() {
    const db = this.#database;
    const meeting = db.getMeeting();
    if (!meeting) {
      throw new LoomError("Cannot resume: meeting not found in database", { phase: "resume", recoverable: false });
    }

    this.#nextSpeakerId = meeting.next_speaker_id ?? null;
    this.#callStats = { ...this.#callStats, ...parseStats(meeting.stats) };

    const dbParts = db.getAllParticipantsWithStatus();
    const participants = dbParts.map((r) => ({
        config: {
          id: r.id,
          name: r.name,
          persona: r.persona,
          agenda: r.agenda,
          tier: r.tier,
          model: r.provider_id && r.model_id ? { providerID: r.provider_id, modelID: r.model_id } : undefined,
          domain: "general",
          domains: ["general"],
          known_biases: r.known_biases,
          communication_style: r.communication_style,
          preferred_contribution_types: r.preferred_contribution_types,
        },
        tier_config: getTierConfig(r.tier),
        session_id: r.session_id,
        session_version: r.session_version ?? 1,
        status: r.status,
        reflections: parseReflections(r.reflection),
        contributions_count: 0,
    }));

    const state = this.#stateManager.getMutableState();
    state.participants = participants;
    state.question = meeting.question;
    state.context = meeting.context ?? "";
    state.warp = meeting.warp ?? "";
    state.max_rounds = meeting.max_rounds;
    state.convergence_mode = meeting.convergence;
    state.domain = meeting.domain;
    state.current_round = meeting.round;
    state.status = "weaving";

    const contributions = db.getContributions(this.#meetingId);
    state.weft = contributions.map((c) => ({
      id: c.id,
      participant_id: c.participant_id,
      content: c.content,
      type: c.type,
      round: c.round,
      targets_which: c.targets_which ?? null,
      timestamp: c.timestamp,
    }));
    state.next_contribution_id = db.getMaxContributionId();

    const summaries = db.getRoundSummaries(this.#meetingId);
    const roundMap = new Map();
    for (const c of contributions) {
      if (!roundMap.has(c.round)) {
        roundMap.set(c.round, { number: c.round, contributions: [], interjections: [], summary: summaries[c.round] ?? "" });
      }
      roundMap.get(c.round).contributions.push({
        id: c.id,
        participant_id: c.participant_id,
        content: c.content,
        type: c.type,
        round: c.round,
        targets_which: c.targets_which ?? null,
        timestamp: c.timestamp,
      });
    }

    const interjections = db.getInterjections(this.#meetingId);
    for (const ij of interjections) {
      const roundNum = ij.round ?? 1;
      if (!roundMap.has(roundNum)) {
        roundMap.set(roundNum, { number: roundNum, contributions: [], interjections: [], summary: summaries[roundNum] ?? "" });
      }
      roundMap.get(roundNum).interjections.push({
        participant_id: ij.participant_id,
        target_participant_id: ij.target_participant_id,
        priority: ij.priority,
        reason: ij.reason,
        granted: ij.granted,
        pushback: ij.pushback,
        resolved: ij.resolved,
      });
    }

    state.rounds = Array.from(roundMap.values()).sort((a, b) => a.number - b.number);

    const countByParticipant = {};
    for (const c of contributions) {
      countByParticipant[c.participant_id] = (countByParticipant[c.participant_id] ?? 0) + 1;
    }
    for (const p of state.participants) {
      p.contributions_count = countByParticipant[p.config.id] ?? 0;
    }

    indexMeeting(db.getDatabasePath(), this.#meetingId, this.#options.opencodeSessionId ?? this.#options.parentSessionId);
  }

  async runMeeting() {
    await this.initialize();

    const participantItems = this.#stateManager.getParticipants()
      .map((p) => `  - ${p.config.name} (${p.config.tier}${p.config.domain ? ", " + p.config.domain : ""})`)
      .join("\n");
    await this.#sessionManager.postProgress(
      `🎬 Loom started — ${this.#stateManager.getParticipants().length} participants:\n${participantItems}`
    );

    await this.#runWeavingLoop();

    const output = await this.#synthesize();
    return output;
  }

  async extendMeeting(newPrompt) {
    if (!this.#database) {
      throw new LoomError("Cannot extend: database not available", { phase: "extension", recoverable: false });
    }
    this.#startTime = Date.now();
    const db = this.#database;
    const currentWarp = db.getWarp();
    db.setWarp(`${currentWarp}\n\n**User Input:** ${newPrompt}`);
    this.#stateManager.setWarp(db.getWarp());
    this.#stateManager.transitionTo("weaving");
    this.#stateManager.getMutableState().max_rounds += 4;
    db.setRound(this.#stateManager.getCurrentRound());
    for (const p of this.#stateManager.getParticipants()) {
      if (p.status === "failed") {
        await this.#sessionManager.recreateSession(p, db);
      } else {
        p.status = "listening";
        db.setParticipantStatus(p.config.id, "listening");
      }
    }
    await this.#sessionManager.postProgress(
      `🧵 Extending loom — adding 4 more rounds (now ${this.#stateManager.getMaxRounds()} total)`
    );
    this.#logger.info("extended", "Meeting extended", { newMaxRounds: this.#stateManager.getMaxRounds() });
    await this.#runWeavingLoop();
    const output = await this.#synthesize();
    return output;
  }

  async #runWeavingLoop() {
    let continueWeaving = true;
    while (continueWeaving) {
      if (this.#cancelled) {
        this.#stateManager.transitionTo("cancelled");
        await this.#sessionManager.postProgress("🛑 Loom cancelled by user.");
        this.#logger.info("cancelled", "Meeting cancelled during weaving loop");
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
      this.#stateManager.transitionTo("timeout");
      return false;
    }

    this.#stateManager.incrementRound();
    const round = {
      number: this.#stateManager.getCurrentRound(),
      contributions: [],
      interjections: [],
      token_path: [],
      summary: "",
    };
    this.#stateManager.addRound(round);

    this.#database.setRound(this.#stateManager.getCurrentRound());
    this.#notifyUpdate();

    const sharedState = this.#stateManager.buildSharedState();
    this.#database.setWarp(sharedState.warp);
    this.#database.setRound(sharedState.round);

    let activeParticipants = this.#stateManager.getActiveParticipants();

    for (const p of activeParticipants) {
      if (!p.session_id) {
        const recreated = await this.#sessionManager.recreateSession(p, this.#database);
        if (!recreated) {
          p.status = "failed";
          this.#database.setParticipantStatus(p.config.id, "failed");
        }
      }
    }

    const failedParticipants = this.#stateManager.getParticipants().filter((p) => p.status === "failed");
    for (const p of failedParticipants) {
      const recreated = await this.#sessionManager.recreateSession(p, this.#database);
      if (recreated) {
        p.status = "listening";
        this.#database.setParticipantStatus(p.config.id, "listening");
        this.#logger.info("session_retry", `Recreated session for ${p.config.name}, rejoining deliberation`);
      }
    }

    activeParticipants = this.#stateManager.getActiveParticipants();

    if (this.#nextSpeakerId) {
      this.#stateManager.reorderForNextSpeaker(this.#nextSpeakerId);
    }

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
      turnMode: this.#turnMode,
      allowInterjections: this.#options.allowInterjections !== false,
      promptOrchestrator: async (system, model, message) => this.#promptOrchestrator(system, model, message),
      getHighestTierModel: () => this.#getHighestTierModel(),
      state: this.#stateManager.getMutableState(),
    });

    this.#database.setRoundSummary(updatedRound.number, updatedRound.summary);

    if (ijNotes) {
      this.#stateManager.setWarp(this.#stateManager.getWarp() + ijNotes);
    }

    const compactFn = this.#warpService.createCompactionFunction(
      async (system, model, message) => this.#promptOrchestrator(system, model, message, "compaction"),
      () => this.#getHighestTierModel(),
    );
    const newWarp = await this.#warpService.evolve(this.#stateManager.getWarp(), updatedRound, compactFn);
    this.#stateManager.setWarp(newWarp);
    this.#database.setWarp(newWarp);

    const contribCount = updatedRound.contributions.length;
    const ijCount = updatedRound.interjections.length;
    const summaryText = updatedRound.summary ? ` | ${truncate(updatedRound.summary, 200)}` : "";
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
      weft: this.#stateManager.getWeft(),
      currentRound: this.#stateManager.getCurrentRound(),
      maxRounds: this.#stateManager.getMaxRounds(),
      promptOrchestrator: async (system, model, message) => this.#promptOrchestrator(system, model, message, "moderation"),
      getHighestTierModel: () => this.#getHighestTierModel(),
      postProgress: async (message) => this.#sessionManager.postProgress(message),
    });

    if (modResult.action === "converge") {
      await this.#persistState();
      return false;
    }

    if (modResult.action === "break") {
      this.#nextSpeakerId = this.#stateManager.getParticipants()[modResult.nextSpeakerIdx]?.config.id ?? null;
    }

    const shouldStop = await this.#convergenceService.check({
      state: this.#stateManager.getMutableState(),
      round: updatedRound,
      promptOrchestrator: async (system, model, message) => this.#promptOrchestrator(system, model, message, "convergence"),
      getHighestTierModel: () => this.#getHighestTierModel(),
      postProgress: async (message) => this.#sessionManager.postProgress(message),
    });

    if (shouldStop) {
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
  }

   async #persistState() {
    const sharedState = this.#stateManager.buildSharedState();
    const stats = this.#getMergedStats();
    try {
      await this.#persistenceService.persistState(sharedState, this.#nextSpeakerId, stats);
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
    const info = extractErrorInfo(error);
    this.#logger.error(context, info.message, { stack: info.stack });
    if (this.#database) {
      this.#database.logError(context, info.message, { stack: info.stack });
    }
  }

  #notifyUpdate() {
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
      return output;
    }

    const totalContributions = this.#stateManager.getWeft().length;
    if (totalContributions === 0) {
      const output = `# Deliberation Output\n\n## Decision\nNo output could be generated — all participants passed without contributing.\n\n## Reasoning\nAll ${this.#stateManager.getParticipants().length} participants chose to pass. This may indicate the question was unclear or participants had nothing to add.\n\n## Action Items\n- Rephrase the question with more specific context\n- Add participants with more targeted expertise\n\n## Confidence\nLow (no contributions received)`;
      this.#saveArtifact({ content: output, format: "markdown", decisions: [], action_items: [], dissent: [], open_questions: [], confidence: "low" });
      await this.#sessionManager.postProgress("ℹ️ All participants passed — no contributions to synthesize.");
      this.#logger.warn("all_passed", "All participants passed — no contributions to synthesize");
      return output;
    }

    const synthesizer = this.#synthesisService.selectSynthesizer(this.#stateManager.getParticipants());
    const transcriptData = this.#database.getTranscriptData(this.#meetingId);

    const objections = this.#collectObjections();
    this.#stateManager.setObjections(objections);

    const result = await this.#synthesisService.run({
      transcriptData,
      participants: this.#stateManager.getParticipants(),
      objections,
      synthesizer,
      getParticipantModel: (p) => this.#getParticipantModel(p),
      onSynthesisStart: () => {
        if (this.#options.onSynthesisStart) this.#options.onSynthesisStart();
      },
      onSynthesisComplete: (output) => {
        if (this.#options.onSynthesisComplete) this.#options.onSynthesisComplete(output);
        this.#notifyUpdate();
      },
    });

    this.#callStats.synthesis++;
    await this.#persistState();
    this.#saveArtifact(result.artifact ?? { content: result.output, format: "markdown", decisions: [], action_items: [], dissent: [], open_questions: [], confidence: null });
    return result.output;
  }

  /**
   * Collects unresolved objections = challenges/dissents from the final round that were
   * never reconciled (no later round addressed them). Computed at synthesis time so it
   * also works after a resumed/extended meeting.
   */
  #collectObjections() {
    const rounds = this.#stateManager.getRounds();
    if (rounds.length === 0) return [];
    const lastRound = rounds[rounds.length - 1];
    return lastRound.contributions
      .filter((c) => c.type === "challenge" || c.type === "dissent")
      .map((c) => {
        const p = this.#stateManager.getParticipants().find((pp) => pp.config.id === c.participant_id);
        return {
          participant_id: c.participant_id,
          content: `${p?.config.name ?? c.participant_id}: ${c.content}`,
          unresolved: true,
        };
      });
  }

  #saveArtifact(artifact) {
    this.#stateManager.getMutableState().artifact = artifact;
    if (this.#database) {
      this.#database.saveArtifact(artifact);
    }
  }
}

// Re-export for backward compatibility
export { parseModeratorRuling } from "./moderation.js";
export { deriveConfidence, extractSection } from "./synthesizer.js";

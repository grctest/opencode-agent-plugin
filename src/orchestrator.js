import { getTierConfig } from "./shared.js";
import { buildAgentSystemPrompt, buildAgentUserPrompt } from "./prompts.js";
import { getConfig } from "./config.js";
import { checkModeratorIntervention } from "./moderation.js";
import { formatInterjectionNotes } from "./interjection-resolver.js";
import { evolveWarp, generateRoundBriefs, compactWarpWithLLM } from "./warp-manager.js";
import { MeetingDatabase, indexMeeting } from "./database.js";
import { RoundExecutor } from "./round-executor.js";
import { SessionManager } from "./session-manager.js";
import { SynthesisCoordinator } from "./synthesis-coordinator.js";
import { truncate, LOOKBACK, parseReflections, parseStats } from "./shared.js";
import { Logger, LoomError, extractErrorInfo } from "./logger.js";
import { detectDomainsWithLLM } from "./composer.js";
import { getHighestTierModel } from "./services/model-service.js";
import { summarizeRound } from "./round-summarizer.js";
import { orchestrateConvergence } from "./convergence-orchestrator.js";

export class MeetingOrchestrator {
  #meetingId;
  #state;
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
  #synthesisCoordinator = null;
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

    this.#state = {
      id: this.#meetingId,
      parent_session_id: options.parentSessionId,
      question: options.question,
      context: options.context,
      participants: options.participants.map((p) => ({
        config: p,
        tier_config: getTierConfig(p.tier),
        session_id: "",
        status: "listening",
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
  }

  getDbPath() {
    return `${this.#directory}/.opencode/loom/meetings/${this.#meetingId}.db`;
  }

  getMeetingId() {
    return this.#meetingId;
  }

  getState() {
    return Object.freeze({ ...this.#state });
  }

  getOrchestratorMessages() {
    return [...this.#orchestratorMessages];
  }

  cancel() {
    this.#cancelled = true;
    this.#logger.info("cancellation", "Loom cancelled by user");
  }

  #modelList() {
    return this.#state.participants.map((p) => ({ tier: p.config.tier, model: p.config.model }));
  }

  #getHighestTierModel() {
    return getHighestTierModel(this.#modelList());
  }

  #getParticipantModel(participant) {
    if (participant.config.model) {
      return { providerID: participant.config.model.providerID, modelID: participant.config.model.modelID };
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
    if (this.#state.status !== "initializing") {
      return;
    }

    this.#startTime = Date.now();

    try {
      const dbPath = this.getDbPath();
      const db = await MeetingDatabase.create(dbPath, this.#meetingId);
      this.#database = db;

      this.#sessionManager = new SessionManager(this.#client, this.#directory, this.#parentSessionId, this.#logger);
      this.#synthesisCoordinator = new SynthesisCoordinator(this.#client, this.#directory, this.#sessionManager);

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
          participants: this.#state.participants.map((p) => p.config),
        });

        for (const p of this.#state.participants) {
          if (!p.session_id) {
            const sessionId = await this.#sessionManager.createChildSession(p);
            p.session_id = sessionId;
            db.setParticipantSessionId(p.config.id, sessionId);
          }
        }
      }

      const orchestratorSessionId = await this.#sessionManager.createOrchestratorSession();
      this.#sessionManager.setOrchestratorSessionId(orchestratorSessionId);

      if (this.#options.detectDomains && !this.#state.domain) {
        try {
          const domains = await detectDomainsWithLLM(
            this.#state.question,
            async (system, model, message) => this.#promptOrchestrator(system, model, message, "domain"),
            () => this.#getHighestTierModel(),
          );
          if (domains.length > 0) {
            this.#state.domain = domains.join(", ");
            db.updateMeetingDomain(this.#meetingId, this.#state.domain);
          }
        } catch (err) {
          this.#logger.warn("domain_detection_failed", "Orchestrator domain detection failed", extractErrorInfo(err));
        }
      }

      await this.#persistState();
      this.#state.status = "weaving";

      this.#roundExecutor = new RoundExecutor({
        client: this.#client,
        directory: this.#directory,
        db,
        state: this.#state,
        options: {
          onAgentComplete: this.#options.onAgentComplete,
          onContribution: this.#options.onContribution,
          onProgress: async (message) => this.#sessionManager.postProgress(message),
          recreateSession: async (participant) => this.#sessionManager.recreateSession(participant, db),
        },
        promptParent: async (system, model, message) => this.#promptOrchestrator(system, model, message),
        getParticipantModel: (participant) => this.#getParticipantModel(participant),
        logError: (context, error) => this.#logError(context, error),
      });

      this.#logger.info("initialized", `Meeting ${this.#resume ? "resumed" : "initialized"}`, { participants: this.#state.participants.length, resumed: this.#resume });
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
    this.#state.participants = dbParts.map((r) => ({
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
      status: r.status,
      reflections: parseReflections(r.reflection),
      contributions_count: 0,
    }));

    this.#state.question = meeting.question;
    this.#state.context = meeting.context ?? "";
    this.#state.warp = meeting.warp ?? "";
    this.#state.max_rounds = meeting.max_rounds;
    this.#state.convergence_mode = meeting.convergence;
    this.#state.domain = meeting.domain;
    this.#state.current_round = meeting.round;
    this.#state.status = "weaving";

    const contributions = db.getContributions(this.#meetingId);
    this.#state.weft = contributions.map((c) => ({
      id: c.id,
      participant_id: c.participant_id,
      content: c.content,
      type: c.type,
      round: c.round,
      targets_which: c.targets_which ?? null,
      timestamp: c.timestamp,
    }));
    this.#state.next_contribution_id = db.getMaxContributionId();

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

    this.#state.rounds = Array.from(roundMap.values()).sort((a, b) => a.number - b.number);

    const countByParticipant = {};
    for (const c of contributions) {
      countByParticipant[c.participant_id] = (countByParticipant[c.participant_id] ?? 0) + 1;
    }
    for (const p of this.#state.participants) {
      p.contributions_count = countByParticipant[p.config.id] ?? 0;
    }

    indexMeeting(db.getDatabasePath(), this.#meetingId, this.#options.opencodeSessionId ?? this.#options.parentSessionId);
  }

  async runMeeting() {
    await this.initialize();

    const participantItems = this.#state.participants
      .map((p) => `  - ${p.config.name} (${p.config.tier}${p.config.domain ? ", " + p.config.domain : ""})`)
      .join("\n");
    await this.#sessionManager.postProgress(
      `🎬 Loom started — ${this.#state.participants.length} participants:\n${participantItems}`
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
    this.#state.warp = db.getWarp();
    this.#state.status = "weaving";
    db.setStatus("weaving");
    this.#state.max_rounds += 4;
    db.setRound(this.#state.current_round);
    for (const p of this.#state.participants) {
      if (p.status === "failed") {
        await this.#sessionManager.recreateSession(p, db);
      } else {
        p.status = "listening";
        db.setParticipantStatus(p.config.id, "listening");
      }
    }
    await this.#sessionManager.postProgress(
      `🧵 Extending loom — adding 4 more rounds (now ${this.#state.max_rounds} total)`
    );
    this.#logger.info("extended", "Meeting extended", { newMaxRounds: this.#state.max_rounds });
    await this.#runWeavingLoop();
    const output = await this.#synthesize();
    return output;
  }

  async #runWeavingLoop() {
    let continueWeaving = true;
    while (continueWeaving) {
    if (this.#cancelled) {
      this.#state.status = "cancelled";
      await this.#sessionManager.postProgress("🛑 Loom cancelled by user.");
      this.#logger.info("cancelled", "Meeting cancelled during weaving loop");
      break;
    }

    if (Date.now() - this.#startTime > this.#meetingTimeoutMs) {
      this.#state.status = "timeout";
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
      this.#state.status = "timeout";
      this.#logger.warn("timeout", "Meeting timed out", { elapsed: Date.now() - this.#startTime, limit: this.#meetingTimeoutMs });
      return true;
    }
    return false;
  }

  async runRound() {
    if (this.#checkTimeout()) {
      await this.#sessionManager.postProgress("⏱️ Loom timed out — generating output from collected contributions.");
      this.#state.status = "timeout";
      return false;
    }

    this.#state.current_round++;
    const round = {
      number: this.#state.current_round,
      contributions: [],
      interjections: [],
      token_path: [],
      summary: "",
    };
    this.#state.rounds.push(round);

    this.#database.setRound(this.#state.current_round);
    this.#notifyUpdate();

    const sharedState = this.#buildSharedState();
    this.#database.setWarp(sharedState.warp);
    this.#database.setRound(sharedState.round);

    let activeParticipants = this.#state.participants.filter((p) => p.status !== "passed" && p.status !== "failed");

    for (const p of activeParticipants) {
      if (!p.session_id) {
        const recreated = await this.#sessionManager.recreateSession(p, this.#database);
        if (!recreated) {
          p.status = "failed";
          this.#database.setParticipantStatus(p.config.id, "failed");
        }
      }
    }

    const failedParticipants = this.#state.participants.filter((p) => p.status === "failed");
    for (const p of failedParticipants) {
      const recreated = await this.#sessionManager.recreateSession(p, this.#database);
      if (recreated) {
        p.status = "listening";
        this.#database.setParticipantStatus(p.config.id, "listening");
        this.#logger.info("session_retry", `Recreated session for ${p.config.name}, rejoining deliberation`);
      }
    }

    activeParticipants = this.#state.participants.filter((p) => p.status !== "passed" && p.status !== "failed");

    if (this.#nextSpeakerId) {
      const idx = activeParticipants.findIndex((p) => p.config.id === this.#nextSpeakerId);
      if (idx > 0) {
        const [speaker] = activeParticipants.splice(idx, 1);
        activeParticipants.unshift(speaker);
      }
      this.#nextSpeakerId = null;
    }

    if (activeParticipants.length === 0) {
      this.#state.status = "converged";
      return false;
    }

    if (!this.#roundExecutor) {
      throw new LoomError("RoundExecutor not initialized — call initialize() first", { phase: "round_execution", recoverable: false });
    }

    await this.#roundExecutor.runPromptPhase(round, activeParticipants, this.#turnMode);
    await this.#roundExecutor.runReflectionPhase(round, activeParticipants);

    if (this.#options.allowInterjections !== false) {
      await this.#roundExecutor.runInterjectionPhase(round, activeParticipants);
    }

    round.summary = await summarizeRound(round, this.#state, (system, model, message) => this.#promptOrchestrator(system, model, message, "summary"), () => this.#getHighestTierModel());
    this.#database.setRoundSummary(round.number, round.summary);
    const ijNotes = formatInterjectionNotes(round);
    if (ijNotes) {
      this.#state.warp += ijNotes;
    }
    const compactFn = async (warp, round) => {
      const model = this.#getHighestTierModel();
      if (!model) return null;
      return compactWarpWithLLM(warp, round, async (system, m, message) => this.#promptOrchestrator(system, m, message, "compaction"), model);
    };
    this.#state.warp = await evolveWarp(this.#state.warp, round, compactFn);
    this.#database.setWarp(this.#state.warp);

    const contribCount = round.contributions.length;
    const ijCount = round.interjections.length;
    const summaryText = round.summary ? ` | ${truncate(round.summary, 200)}` : "";
    await this.#sessionManager.postProgress(
      `📋 Round ${this.#state.current_round} complete — ${contribCount} contribution${contribCount !== 1 ? "s" : ""}, ${ijCount} interjection${ijCount !== 1 ? "s" : ""}${summaryText}`
    );

    if (this.#options.onRoundComplete) {
      this.#options.onRoundComplete(this.#state.current_round, round.summary);
    }
    this.#notifyUpdate();

    const modDecision = await checkModeratorIntervention(
      round,
      this.#state.participants,
      this.#state.weft,
      this.#state.current_round,
      this.#state.max_rounds,
      async (system, model, message) => this.#promptOrchestrator(system, model, message, "moderation"),
      () => this.#getHighestTierModel(),
    );

    if (modDecision.action === "converge") {
      const minRounds = getConfig().minRounds ?? 2;
      if (this.#state.current_round >= minRounds) {
        this.#state.status = "converged";
        this.#logger.info("moderator_converge", "Moderator forced convergence", { round: this.#state.current_round });
        await this.#persistState();
        return false;
      } else {
        this.#logger.info("moderator_converge_deferred", "Moderator converge deferred (minRounds not reached)", { round: this.#state.current_round, minRounds });
        await this.#sessionManager.postProgress(`🧭 Moderator wants to end the round early, but minimum rounds (${minRounds}) not yet reached.`);
      }
    }

    if (modDecision.action === "break" && modDecision.nextSpeakerIdx >= 0) {
      const target = this.#state.participants[modDecision.nextSpeakerIdx];
      if (target && target.status !== "passed" && target.status !== "failed") {
        this.#nextSpeakerId = target.config.id;
        this.#logger.info("moderator_break", `Moderator directed ${target.config.name} to speak next`, { round: this.#state.current_round });
        await this.#sessionManager.postProgress(`🧭 Moderator directs ${target.config.name} to speak first next round.`);
      }
    }

    if (await orchestrateConvergence(round, this.#state, (system, model, message) => this.#promptOrchestrator(system, model, message, "convergence"), () => this.#getHighestTierModel())) {
      await this.#persistState();
      return false;
    }

    if (this.#state.current_round >= this.#state.max_rounds) {
      this.#state.status = "max_rounds_reached";
      await this.#persistState();
      return false;
    }

    await this.#persistState();
    return true;
  }

  #buildSharedState() {
    return {
      meeting_id: this.#meetingId,
      round: this.#state.current_round,
      warp: this.#state.warp,
      question: this.#state.question,
      contributions: this.#state.weft,
      status: this.#state.status,
    };
  }

  #saveArtifact(artifact) {
    this.#state.artifact = artifact;
    if (this.#database) {
      this.#database.saveArtifact(artifact);
    }
  }

  async #synthesize() {
    const allFailed = this.#state.participants.every((p) => p.status === "failed");
    if (allFailed) {
      const output = `# Deliberation Output\n\n## Decision\nNo output could be generated — all participants failed to respond.\n\n## Reasoning\nAll ${this.#state.participants.length} participants encountered errors during the deliberation.\n\n## Action Items\n- Check model connectivity and retry\n- Verify provider authentication\n\n## Confidence\nLow (no contributions received)`;
      this.#saveArtifact({ content: output, format: "markdown", decisions: [], action_items: [], dissent: [], open_questions: [], confidence: "low" });
      await this.#sessionManager.postProgress("⚠️ All participants failed — no synthesis possible.");
      this.#logger.error("all_failed", "All participants failed — no synthesis possible");
      return output;
    }

    const totalContributions = this.#state.weft.length;
    if (totalContributions === 0) {
      const output = `# Deliberation Output\n\n## Decision\nNo output could be generated — all participants passed without contributing.\n\n## Reasoning\nAll ${this.#state.participants.length} participants chose to pass. This may indicate the question was unclear or participants had nothing to add.\n\n## Action Items\n- Rephrase the question with more specific context\n- Add participants with more targeted expertise\n\n## Confidence\nLow (no contributions received)`;
      this.#saveArtifact({ content: output, format: "markdown", decisions: [], action_items: [], dissent: [], open_questions: [], confidence: "low" });
      await this.#sessionManager.postProgress("ℹ️ All participants passed — no contributions to synthesize.");
      this.#logger.warn("all_passed", "All participants passed — no contributions to synthesize");
      return output;
    }

    const synthesizer = this.#synthesisCoordinator.selectSynthesizer(this.#state.participants);
    const transcriptData = this.#database.getTranscriptData(this.#meetingId);

    const objections = this.#collectObjections();
    this.#state.objections = objections;

    const result = await this.#synthesisCoordinator.run(
      transcriptData,
      this.#state.participants,
      objections,
      synthesizer,
      (p) => this.#getParticipantModel(p),
      () => {
        if (this.#options.onSynthesisStart) this.#options.onSynthesisStart();
      },
      (output) => {
        if (this.#options.onSynthesisComplete) this.#options.onSynthesisComplete(output);
        this.#notifyUpdate();
      },
    );

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
    if (this.#state.rounds.length === 0) return [];
    const lastRound = this.#state.rounds[this.#state.rounds.length - 1];
    return lastRound.contributions
      .filter((c) => c.type === "challenge" || c.type === "dissent")
      .map((c) => {
        const p = this.#state.participants.find((pp) => pp.config.id === c.participant_id);
        return {
          participant_id: c.participant_id,
          content: `${p?.config.name ?? c.participant_id}: ${c.content}`,
          unresolved: true,
        };
      });
  }

  async #persistState() {
    const sharedState = this.#buildSharedState();
    this.#database.setWarp(sharedState.warp);
    this.#database.setRound(sharedState.round);
    this.#database.setStatus(sharedState.status);
    this.#database.setNextSpeaker(this.#nextSpeakerId);
    this.#database.setStats(JSON.stringify(this.#getMergedStats()));
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
      this.#options.onUpdate(this.#state);
    }
  }
}

import { getTierConfig, splitModel } from "./shared.js";
import { buildAgentSystemPrompt, buildAgentUserPrompt } from "./prompts.js";
import { getConfig } from "./config.js";
import { checkModeratorIntervention } from "./moderation.js";
import { formatInterjectionNotes } from "./interjection-resolver.js";
import { evolveWarp, generateRoundBriefs, compactWarpWithLLM } from "./warp-manager.js";
import { checkConvergence, checkSemanticConvergence } from "./convergence-checker.js";
import { MeetingDatabase } from "./database.js";
import { RoundExecutor } from "./round-executor.js";
import { SessionManager } from "./session-manager.js";
import { SynthesisCoordinator } from "./synthesis-coordinator.js";
import { truncate, LOOKBACK } from "./shared.js";
import { Logger, LoomError, extractErrorInfo } from "./logger.js";
import { getDomainKeywords } from "./composer.js";

export class MeetingOrchestrator {
  #meetingId;
  #state;
  #options;
  #client;
  #directory;
  #parentSessionId;
  #database = null;
  #parallel = true;
  #roundExecutor = null;
  #cancelled = false;
  #startTime = 0;
  #meetingTimeoutMs;
  #sessionManager = null;
  #synthesisCoordinator = null;
  #logger = null;
  #orchestratorMessages = [];

  constructor(options) {
    this.#meetingId = crypto.randomUUID();
    this.#options = options;
    this.#client = options.client;
    this.#directory = options.directory;
    this.#parentSessionId = options.parentSessionId;
    this.#parallel = options.parallel !== false;
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
        reflection: "",
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

  #getHighestTierModel() {
    for (const tier of ["principal", "senior", "mid", "junior"]) {
      const p = this.#state.participants.find((pp) => pp.config.tier === tier);
      if (p?.config?.model) return { providerID: p.config.model.providerID, modelID: p.config.model.modelID };
    }
    const firstWithModel = this.#state.participants.find((p) => p.config.model);
    if (firstWithModel) return { providerID: firstWithModel.config.model.providerID, modelID: firstWithModel.config.model.modelID };
    return null;
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
    this.#orchestratorMessages.push({ type, role: "user", content: message, timestamp: Date.now() });
    if (this.#database) {
      this.#database.addOrchestratorMessage(type, "user", message.slice(0, 500));
    }
    const response = await this.#sessionManager.promptOrchestrator(system, model, message);
    this.#orchestratorMessages.push({ type, role: "assistant", content: response, timestamp: Date.now() });
    if (this.#database) {
      this.#database.addOrchestratorMessage(type, "assistant", response.slice(0, 500));
    }
    return response;
  }

  async initialize() {
    if (this.#state.status !== "initializing") {
      return;
    }

    this.#startTime = Date.now();
    this.#syncWeftFromDb();

    try {
      const dbPath = this.getDbPath();
      const db = await MeetingDatabase.create(dbPath, this.#meetingId);
      this.#database = db;

      this.#sessionManager = new SessionManager(this.#client, this.#directory, this.#parentSessionId, this.#logger);
      this.#synthesisCoordinator = new SynthesisCoordinator(this.#client, this.#directory, this.#sessionManager);

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

      const orchestratorSessionId = await this.#sessionManager.createOrchestratorSession();
      this.#sessionManager.setOrchestratorSessionId(orchestratorSessionId);

      if (this.#options.detectDomains && !this.#options.domain) {
        try {
          const model = this.#getHighestTierModel();
          if (model) {
            const keywords = getDomainKeywords();
            const domainDescriptions = Object.entries(keywords).map(([d, kws]) => `- ${d}: ${kws.slice(0, 5).join(", ")}...`).join("\n");
            const prompt = `Analyze the following question and determine which domains it touches on.\n\nQuestion: "${this.#options.question}"\n\nAvailable domains with example keywords:\n${domainDescriptions}\n\nRespond with ONLY a JSON array of domain names that apply. Include a domain if the question relates to any of its concepts. If none clearly apply, respond with [].\n\nJSON array:`;
            const result = await this.#promptOrchestrator("You are a domain classification expert. Analyze questions and return relevant domains as JSON.", model, prompt, "domain");
            const jsonMatch = result.match(/\[.*?\]/s);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              if (Array.isArray(parsed)) {
                const validDomains = parsed.filter((d) => Object.keys(keywords).includes(d));
                if (validDomains.length > 0) {
                  this.#state.domain = validDomains.join(", ");
                  db.updateMeetingDomain(this.#meetingId, this.#state.domain);
                }
              }
            }
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
        },
        promptParent: async (system, model, message) => this.#promptOrchestrator(system, model, message),
        getParticipantModel: (participant) => this.#getParticipantModel(participant),
        getHighestTierModel: () => this.#getHighestTierModel(),
        logError: (context, error) => this.#logError(context, error),
      });

      this.#logger.info("initialized", "Meeting initialized", { participants: this.#state.participants.length });
    } catch (err) {
      const info = extractErrorInfo(err);
      this.#logger.error("init_failed", "Failed to initialize meeting", info);
      throw err;
    }
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

      if (this.#state.current_round > 0 && this.#options.waitForUserInput) {
        this.#state.status = "waiting_for_user";
        this.#notifyUpdate();
        const userAction = await this.#options.waitForUserInput();

        if (userAction === "end") {
          this.#state.status = "converged";
          break;
        } else if (userAction !== "continue") {
          this.#state.warp += `\n\n**User Input:** ${userAction}`;
          this.#database.setWarp(this.#state.warp);
        }
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

    if (activeParticipants.length === 0) {
      this.#state.status = "converged";
      return false;
    }

    if (!this.#roundExecutor) {
      throw new LoomError("RoundExecutor not initialized — call initialize() first", { phase: "round_execution", recoverable: false });
    }

    await this.#roundExecutor.runPromptPhase(round, activeParticipants, this.#parallel);
    await this.#roundExecutor.runReflectionPhase(round, activeParticipants);

    if (this.#options.allowInterjections !== false) {
      await this.#roundExecutor.runInterjectionPhase(round, activeParticipants);
    }

    round.summary = await this.#summarizeRound(round);
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
    const summaryText = round.summary ? ` | ${truncate(round.summary, 100)}` : "";
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
      this.#state.status = "converged";
      this.#logger.info("moderator_converge", "Moderator forced convergence", { round: this.#state.current_round });
      await this.#persistState();
      return false;
    }

    if (await this.#checkConvergence(round)) {
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

  async #summarizeRound(round) {
    const contribCount = round.contributions.length;
    if (contribCount === 0) return "No contributions this round.";

    const types = round.contributions.map((c) => c.type);
    const typeCounts = {};
    for (const t of types) typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    const typeSummary = Object.entries(typeCounts).map(([t, c]) => `${c} ${t}`).join(", ");

    let summary = `Round contributions (${contribCount}): ${typeSummary}.`;
    if (round.interjections.length > 0) {
      summary += ` ${round.interjections.length} interjection(s).`;
    }

    if (this.#state.convergence_mode === "moderator_forces" && contribCount > 2) {
      try {
        const model = this.#getHighestTierModel();
        if (!model) throw new Error("No model available for semantic summary");
        const prompt = `Summarize this deliberation round in 2-3 sentences. What was established? What remains contested?\n\nContributions:\n${round.contributions.map((c) => `- ${c.content.slice(0, 150)}`).join("\n")}\n\nSummary:`;
        const semanticSummary = await this.#promptOrchestrator("You are a neutral summarizer.", model, prompt, "summary");
        if (semanticSummary && semanticSummary.trim().length > 10) {
          summary = semanticSummary.trim();
        }
      } catch (err) {
        const info = extractErrorInfo(err);
        this.#logError("semantic summary generation failed", err);
        this.#logger.warn("summary_fallback", "Semantic summary failed, using heuristic", info);
      }
    }

    return summary;
  }

  async #checkConvergence(round) {
    const activeCount = this.#state.participants.filter((p) => p.status !== "passed" && p.status !== "failed").length;
    const passedCount = this.#state.participants.filter((p) => p.status === "passed").length;

    const recentContributions = this.#state.weft.slice(-LOOKBACK.CONVERGENCE_RECENT);

    const result = checkConvergence({
      passedCount,
      activeCount,
      totalParticipants: this.#state.participants.length,
      currentRound: this.#state.current_round,
      maxRounds: this.#state.max_rounds,
      convergenceMode: this.#state.convergence_mode,
      contributions: recentContributions,
      rounds: this.#state.rounds,
    });

    this.#state.status = result.status;

    if (result.needsLLMCheck && this.#state.current_round >= 3) {
      try {
        const semanticResult = await checkSemanticConvergence({
          contributions: this.#state.weft,
          rounds: this.#state.rounds,
          currentRound: this.#state.current_round,
          maxRounds: this.#state.max_rounds,
          question: this.#state.question,
        }, async (system, model, message) => this.#promptOrchestrator(system, model, message, "convergence"), () => this.#getHighestTierModel());
        if (semanticResult.shouldStop) {
          this.#state.status = "converged";
          result.shouldStop = true;
          this.#logger.info("semantic_convergence", "Semantic convergence detected");
        } else if (semanticResult.action === "extend" && this.#state.max_rounds < 10) {
          this.#state.max_rounds += 1;
          this.#logger.info("semantic_extend", "Semantic analysis recommends one more round", { newMax: this.#state.max_rounds });
          await this.#sessionManager.postProgress(`🧵 Adding one more round based on semantic analysis (now ${this.#state.max_rounds} total)`);
        }
      } catch (err) {
        const info = extractErrorInfo(err);
        this.#logError("semantic_convergence", err);
        this.#logger.warn("convergence_check_failed", "Semantic convergence check failed", info);
      }
    }

    return result.shouldStop;
  }

  async #synthesize() {
    const allFailed = this.#state.participants.every((p) => p.status === "failed");
    if (allFailed) {
      const output = `# Deliberation Output\n\n## Decision\nNo output could be generated — all participants failed to respond.\n\n## Reasoning\nAll ${this.#state.participants.length} participants encountered errors during the deliberation.\n\n## Action Items\n- Check model connectivity and retry\n- Verify provider authentication\n\n## Confidence\nLow (no contributions received)`;
      this.#state.artifact = { content: output, format: "markdown" };
      await this.#sessionManager.postProgress("⚠️ All participants failed — no synthesis possible.");
      this.#logger.error("all_failed", "All participants failed — no synthesis possible");
      return output;
    }

    const totalContributions = this.#state.weft.length;
    if (totalContributions === 0) {
      const output = `# Deliberation Output\n\n## Decision\nNo output could be generated — all participants passed without contributing.\n\n## Reasoning\nAll ${this.#state.participants.length} participants chose to pass. This may indicate the question was unclear or participants had nothing to add.\n\n## Action Items\n- Rephrase the question with more specific context\n- Add participants with more targeted expertise\n\n## Confidence\nLow (no contributions received)`;
      this.#state.artifact = { content: output, format: "markdown" };
      await this.#sessionManager.postProgress("ℹ️ All participants passed — no contributions to synthesize.");
      this.#logger.warn("all_passed", "All participants passed — no contributions to synthesize");
      return output;
    }

    const synthesizer = this.#synthesisCoordinator.selectSynthesizer(this.#state.participants);
    const transcriptData = this.#database.getTranscriptData(this.#meetingId);

    const output = await this.#synthesisCoordinator.run(
      transcriptData,
      this.#state.participants,
      this.#state.objections,
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

    this.#state.artifact = { content: output, format: "markdown" };
    return output;
  }

  #syncWeftFromDb() {
    if (!this.#database) return;
    const dbContributions = this.#database.getContributions(this.#meetingId);
    this.#state.weft = dbContributions.map((c) => ({
      participant_id: c.participant_id,
      content: c.content,
      type: c.type,
      targets_which: null,
      timestamp: c.timestamp,
    }));
  }

  async #persistState() {
    const sharedState = this.#buildSharedState();
    this.#database.setWarp(sharedState.warp);
    this.#database.setRound(sharedState.round);
    this.#database.setStatus(sharedState.status);
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

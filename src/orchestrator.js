import { getTierConfig, splitModel } from "./tiers.js";
import { buildAgentSystemPrompt, buildAgentUserPrompt } from "./prompts.js";
import { CONFIG } from "./config.js";
import { checkModeratorIntervention } from "./moderation.js";
import { formatInterjectionNotes } from "./interjection-resolver.js";
import { evolveWarp, formatTranscriptFromData, generateRoundBriefs, compactWarpWithLLM } from "./warp-manager.js";
import { checkConvergence, checkSemanticConvergence } from "./convergence-checker.js";
import { MeetingDatabase } from "./database.js";
import { RoundExecutor } from "./round-executor.js";
import { SessionManager } from "./session-manager.js";
import { SynthesisCoordinator } from "./synthesis-coordinator.js";
import { truncate, LOOKBACK } from "./shared.js";

const DEFAULT_MEETING_TIMEOUT_MS = 900000;

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
  #meetingTimeoutMs = DEFAULT_MEETING_TIMEOUT_MS;
  #sessionManager = null;
  #synthesisCoordinator = null;

  constructor(options) {
    this.#meetingId = crypto.randomUUID();
    this.#options = options;
    this.#client = options.client;
    this.#directory = options.directory;
    this.#parentSessionId = options.parentSessionId;
    this.#parallel = options.parallel !== false;
    this.#meetingTimeoutMs = options.meetingTimeoutMs ?? DEFAULT_MEETING_TIMEOUT_MS;

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

  cancel() {
    this.#cancelled = true;
  }

  #getHighestTierModel() {
    for (const tier of ["principal", "senior", "mid", "junior"]) {
      const p = this.#state.participants.find((pp) => pp.config.tier === tier);
      if (p && p.tier_config.model) return splitModel(p.tier_config.model);
    }
    const firstWithModel = this.#state.participants.find((p) => p.tier_config.model);
    if (firstWithModel) return splitModel(firstWithModel.tier_config.model);
    return null;
  }

  #getParticipantModel(participant) {
    if (participant.config.model) {
      return { providerID: participant.config.model.providerID, modelID: participant.config.model.modelID };
    }
    throw new Error(`No model assigned for participant ${participant.config.name} (${participant.config.tier}). Run knit_models first.`);
  }

  async initialize() {
    if (this.#state.status !== "initializing") {
      return;
    }

    this.#startTime = Date.now();

    const dbPath = this.getDbPath();
    const db = await MeetingDatabase.create(dbPath, this.#meetingId);
    this.#database = db;

    this.#sessionManager = new SessionManager(this.#client, this.#directory, this.#parentSessionId);
    this.#synthesisCoordinator = new SynthesisCoordinator(this.#client, this.#directory, this.#sessionManager);

    db.initializeMeeting({
      question: this.#options.question,
      context: this.#options.context,
      maxRounds: this.#options.maxRounds,
      convergence: this.#options.convergence,
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
      promptParent: async (system, model, message) => this.#sessionManager.promptParent(system, model, message),
      getParticipantModel: (participant) => this.#getParticipantModel(participant),
      getHighestTierModel: () => this.#getHighestTierModel(),
      logError: (context, error) => this.#logError(context, error),
    });
  }

  async runMeeting() {
    await this.initialize();

    const participantItems = this.#state.participants
      .map((p) => `  - ${p.config.name} (${p.config.tier}${p.config.domain ? ", " + p.config.domain : ""})`)
      .join("\n");
    await this.#sessionManager.postProgress(
      `🎬 Loom started — ${this.#state.participants.length} participants:\n${participantItems}`
    );

    let continueWeaving = true;
    while (continueWeaving) {
      if (this.#cancelled) {
        this.#state.status = "cancelled";
        await this.#sessionManager.postProgress("🛑 Loom cancelled by user.");
        break;
      }

      if (Date.now() - this.#startTime > this.#meetingTimeoutMs) {
        this.#state.status = "timeout";
        await this.#sessionManager.postProgress("⏱️ Loom timed out — generating output from collected contributions.");
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

    const output = await this.#synthesize();
    return output;
  }

  async extendMeeting(newPrompt) {
    if (!this.#database) {
      throw new Error("Cannot extend: database not available");
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
    let continueWeaving = true;
    while (continueWeaving) {
      if (this.#cancelled) {
        this.#state.status = "cancelled";
        break;
      }
      if (Date.now() - this.#startTime > this.#meetingTimeoutMs) {
        this.#state.status = "timeout";
        break;
      }
      continueWeaving = await this.runRound();
      this.#notifyUpdate();
    }
    const output = await this.#synthesize();
    return output;
  }

  async runRound() {
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

    activeParticipants = this.#state.participants.filter((p) => p.status !== "passed" && p.status !== "failed");

    if (activeParticipants.length === 0) {
      this.#state.status = "converged";
      return false;
    }

    if (!this.#roundExecutor) {
      throw new Error("RoundExecutor not initialized — call initialize() first");
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
      return compactWarpWithLLM(warp, round, async (system, m, message) => this.#sessionManager.promptParent(system, m, message), model);
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
      async (system, model, message) => this.#sessionManager.promptParent(system, model, message),
      () => this.#getHighestTierModel(),
    );

    if (modDecision.action === "converge") {
      this.#state.status = "converged";
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
      interjections: [],
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
        const semanticSummary = await this.#sessionManager.promptParent("You are a neutral summarizer.", model, prompt);
        if (semanticSummary && semanticSummary.trim().length > 10) {
          summary = semanticSummary.trim();
        }
      } catch (err) {
        this.#logError("semantic summary generation failed", err);
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
        }, async (system, model, message) => this.#sessionManager.promptParent(system, model, message), () => this.#getHighestTierModel());
        if (semanticResult.shouldStop) {
          this.#state.status = "converged";
          result.shouldStop = true;
        }
      } catch (err) {
        this.#logError("semantic_convergence", err);
      }
    }

    return result.shouldStop;
  }

  async #synthesize() {
    const synthesizer = this.#synthesisCoordinator.selectSynthesizer(this.#state.participants);
    const db = this.#database;
    const transcriptData = db.getTranscriptData(this.#meetingId);

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

  async #persistState() {
    const sharedState = this.#buildSharedState();
    this.#database.setWarp(sharedState.warp);
    this.#database.setRound(sharedState.round);
    this.#database.setStatus(sharedState.status);
  }

  #logError(context, error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Loom ${this.#meetingId}] Round ${this.#state.current_round} | ${context}: ${message}`);
  }

  #notifyUpdate() {
    if (this.#options.onUpdate) {
      this.#options.onUpdate(this.#state);
    }
  }
}

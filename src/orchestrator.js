import { getTierConfig, splitModel } from "./tiers.js";
import { buildAgentSystemPrompt, buildAgentUserPrompt } from "./prompts.js";
import { checkModeratorIntervention } from "./moderation.js";
import { parseAgentResponse } from "./validation.js";
import { resolveInterjections, formatInterjectionNotes } from "./interjection-resolver.js";
import { evolveWarp, formatTranscriptFromData } from "./warp-manager.js";
import { synthesize, synthesizeFromData } from "./synthesizer.js";
import { buildSynthesisPromptForTranscript } from "./prompts.js";
import { checkConvergence } from "./convergence-checker.js";
import { MeetingDatabase } from "./database.js";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

/**
 * @typedef {Object} OrchestratorOptions
 * @property {import("./client-types.js").AgentSessionClient} client
 * @property {string} directory
 * @property {string} parentSessionId
 * @property {string} opencodeSessionId
 * @property {string} question
 * @property {string} context
 * @property {import("./types.js").ParticipantConfig[]} participants
 * @property {number} maxRounds
 * @property {"consensus" | "majority" | "moderator_forces"} convergence
 * @property {(state: import("./types.js").LoomState) => void} [onUpdate]
 * @property {(participantId: string, response: string) => void} [onAgentComplete]
 * @property {(name: string, round: number, type: string) => void} [onContribution]
 * @property {(round: number, summary: string) => void} [onRoundComplete]
 * @property {() => void} [onSynthesisStart]
 * @property {(output: string) => void} [onSynthesisComplete]
 * @property {() => Promise<"continue" | "end" | string>} [waitForUserInput]
 */

export class MeetingOrchestrator {
  /** @type {string} */
  #meetingId;
  /** @type {import("./types.js").LoomState} */
  #state;
  /** @type {OrchestratorOptions} */
  #options;
  /** @type {import("./client-types.js").AgentSessionClient} */
  #client;
  /** @type {string} */
  #directory;
  /** @type {string} */
  #parentSessionId;
  /** @type {string} */
  #opencodeSessionId;
  /** @type {MeetingDatabase | null} */
  #database = null;

  constructor(options) {
    this.#meetingId = crypto.randomUUID();
    this.#options = options;
    this.#client = options.client;
    this.#directory = options.directory;
    this.#parentSessionId = options.parentSessionId;
    this.#opencodeSessionId = options.opencodeSessionId;

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
    return join(this.#directory, ".opencode", "loom", "meetings", `${this.#meetingId}.db`);
  }

  getMeetingId() {
    return this.#meetingId;
  }

  getState() {
    return Object.freeze({ ...this.#state });
  }

  #getHighestTierModel() {
    for (const tier of ["principal", "senior", "mid", "junior"]) {
      const p = this.#state.participants.find((pp) => pp.config.tier === tier);
      if (p) return splitModel(p.tier_config.model);
    }
    return splitModel(this.#state.participants[0].tier_config.model);
  }

  #getParticipantModel(participant) {
    if (participant.config.model) {
      return { providerID: participant.config.model.providerID, modelID: participant.config.model.modelID };
    }
    throw new Error(`No model assigned for participant ${participant.config.name} (${participant.config.tier}). Run knit_models first.`);
  }

  async #getDb() {
    if (!this.#database) {
      const dbPath = join(this.#directory, ".opencode", "loom", "meetings", `${this.#meetingId}.db`);
      const db = await MeetingDatabase.create(dbPath, this.#meetingId);
      this.#database = db;
      db.initializeMeeting({
        question: this.#options.question,
        context: this.#options.context,
        maxRounds: this.#options.maxRounds,
        convergence: this.#options.convergence,
        parentSessionId: this.#options.parentSessionId,
        opencodeSessionId: this.#opencodeSessionId,
        participants: this.#state.participants.map((p) => p.config),
      });
    }
    return this.#database;
  }

  async initialize() {
    if (this.#state.status !== "initializing") {
      return;
    }

    const db = await this.#getDb();
    for (const p of this.#state.participants) {
      if (!p.session_id) {
        const sessionId = await this.#createChildSession(p);
        p.session_id = sessionId;
        db.setParticipantSessionId(p.config.id, sessionId);
      }
    }
    await this.#persistState();
    this.#state.status = "weaving";
  }

  async #createChildSession(participant) {
    const result = await this.#client.session.create({
      body: {
        parentID: this.#parentSessionId,
        title: `Loom · ${participant.config.name} (${participant.config.tier})`,
      },
      query: { directory: this.#directory },
    });

    if (!result.data || result.error) {
      throw new Error(`Failed to create session for ${participant.config.name}: ${result.error?.message || "unknown error"}`);
    }

    return result.data.id;
  }

  async runMeeting() {
    await this.initialize();

    const participantItems = this.#state.participants
      .map((p) => `  - ${p.config.name} (${p.config.tier}${p.config.domain ? ", " + p.config.domain : ""})`)
      .join("\n");
    await this.#postProgress(
      `🎬 Loom started — ${this.#state.participants.length} participants:\n${participantItems}`
    );

    let continueWeaving = true;
    while (continueWeaving) {
      if (this.#state.current_round > 0 && this.#options.waitForUserInput) {
        this.#state.status = "waiting_for_user";
        this.#notifyUpdate();
        const userAction = await this.#options.waitForUserInput();

        if (userAction === "end") {
          this.#state.status = "converged";
          break;
        } else if (userAction !== "continue") {
          this.#state.warp += `\n\n**User Input:** ${userAction}`;
          (await this.#getDb()).setWarp(this.#state.warp);
        }
      }

      continueWeaving = await this.runRound();
      this.#notifyUpdate();
    }

    const output = await this.#synthesize();
    this.#cleanupDatabase();
    return output;
  }

  async extendMeeting(newPrompt) {
    if (!this.#database) {
      throw new Error("Cannot extend: database not available");
    }
    const db = await this.#getDb();
    const currentWarp = db.getWarp();
    db.setWarp(`${currentWarp}\n\n**User Input:** ${newPrompt}`);
    this.#state.warp = db.getWarp();
    this.#state.status = "weaving";
    db.setStatus("weaving");
    this.#state.max_rounds += 4;
    db.setRound(this.#state.current_round);
    for (const p of this.#state.participants) {
      p.status = "listening";
      db.setParticipantStatus(p.config.id, "listening");
    }
    await this.#postProgress(
      `🧵 Extending loom — adding 4 more rounds (now ${this.#state.max_rounds} total)`
    );
    let continueWeaving = true;
    while (continueWeaving) {
      continueWeaving = await this.runRound();
      this.#notifyUpdate();
    }
    const output = await this.#synthesize();
    this.#cleanupDatabase();
    return output;
  }

  #cleanupDatabase() {
    if (!this.#database) return;
    const dbPath = this.#database.getDatabasePath();
    this.#database.close();
    this.#database = null;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
      }
    }
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

    (await this.#getDb()).setRound(this.#state.current_round);
    this.#notifyUpdate();

    await this.#clearPreviousResponses();

    const sharedState = this.#buildSharedState();
    (await this.#getDb()).setWarp(sharedState.warp);
    (await this.#getDb()).setRound(sharedState.round);

    const activeParticipants = this.#state.participants.filter((p) => p.status !== "passed");

    for (const p of activeParticipants) {
      await this.#postProgress(`⏳ ${p.config.name} (${p.config.tier}) is thinking...`);
      (await this.#getDb()).setParticipantStatus(p.config.id, "speaking");

      let result = await this.#promptChildSession(p);

      if (!result) {
        result = await this.#promptChildSession(p);
      }

      if (!result) {
        await this.#postProgress(
          `⏭️ ${p.config.name} (${p.config.tier}) — no response after retry, passing`
        );
        const participant = this.#state.participants.find(
          (pp) => pp.config.id === p.config.id,
        );
        if (participant) {
          participant.status = "passed";
        }
        (await this.#getDb()).setParticipantStatus(p.config.id, "passed");
        (await this.#getDb()).recordAgentError(
          this.#meetingId, p.config.id, this.#state.current_round,
          "no_response", "Failed to get response after retries", 2,
        );
        round.token_path.push(p.config.id);
        if (this.#options.onContribution) {
          this.#options.onContribution(p.config.name, this.#state.current_round, "passed_no_response");
        }
        this.#notifyUpdate();
        continue;
      }

      const participant = this.#state.participants.find(
        (pp) => pp.config.id === result.participant_id,
      );
      if (!participant) continue;

      if (result.content === "[PASS]") {
        participant.status = "passed";
        (await this.#getDb()).setParticipantStatus(participant.config.id, "passed");
        round.token_path.push(participant.config.id);
        await this.#postProgress(`⏭️ ${participant.config.name} (${participant.config.tier}) — chose to pass`);
        if (this.#options.onContribution) {
          this.#options.onContribution(p.config.name, this.#state.current_round, "pass");
        }
        this.#notifyUpdate();
        continue;
      }

      const contribution = {
        participant_id: result.participant_id,
        content: result.content,
        type: result.type,
        targets_which: null,
        timestamp: Date.now(),
      };

      this.#state.weft.push(contribution);
      round.contributions.push(contribution);
      round.token_path.push(participant.config.id);
      participant.contributions_count++;
      participant.status = "listening";
      (await this.#getDb()).setParticipantStatus(participant.config.id, "listening");

      (await this.#getDb()).addContribution(this.#meetingId, {
        ...contribution,
        round: this.#state.current_round,
      });

      if (result.interjection) {
        const interjection = {
          participant_id: result.participant_id,
          priority: result.interjection.priority,
          reason: result.interjection.reason,
          granted: false,
          pushback: null,
          resolved: "pending",
        };
        round.interjections.push(interjection);
        (await this.#getDb()).addInterjection(this.#meetingId, interjection);
      }

      const truncated = this.#truncate(result.content, 120);
      await this.#postProgress(
        `✅ ${p.config.name} (${p.config.tier}) — ${result.type}: "${truncated}"`
      );

      if (this.#options.onAgentComplete) {
        this.#options.onAgentComplete(result.participant_id, result.content);
      }
      if (this.#options.onContribution) {
        this.#options.onContribution(p.config.name, this.#state.current_round, result.type);
      }
      this.#notifyUpdate();
    }

    if (round.interjections.length > 0) {
      await resolveInterjections(round, (ij) => this.#moderateInterjection(ij));
    }

    round.summary = await this.#summarizeRound(round);
    const ijNotes = formatInterjectionNotes(round);
    if (ijNotes) {
      this.#state.warp += ijNotes;
    }
    this.#state.warp = evolveWarp(this.#state.warp, round);
    (await this.#getDb()).setWarp(this.#state.warp);

    const contribCount = round.contributions.length;
    const ijCount = round.interjections.length;
    const summaryText = round.summary ? ` | ${this.#truncate(round.summary, 100)}` : "";
    await this.#postProgress(
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
      async (system, model, message) => this.#promptParent(system, model, message),
      () => this.#getHighestTierModel(),
    );

    if (modDecision.action === "converge") {
      this.#state.status = "converged";
      await this.#persistState();
      return false;
    }

    if (this.#checkConvergence(round)) {
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

  async #promptChildSession(participant) {
    participant.status = "speaking";

    if (!participant.session_id) {
      return null;
    }

    const maxRetries = 2;
    const timeoutMs = 120000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.#withTimeout(
          this.#client.session.prompt({
            path: { id: participant.session_id },
            body: {
              system: buildAgentSystemPrompt(participant),
              model: this.#getParticipantModel(participant),
              parts: [{ type: "text", text: buildAgentUserPrompt(
                participant,
                this.#state.warp,
                this.#state.weft,
                this.#state.question,
                this.#state.current_round,
              ) }],
            },
            query: { directory: this.#directory },
          }),
          timeoutMs,
        );

        if (result.error) {
          throw new Error(result.error.message || JSON.stringify(result.error));
        }

        const content = this.#extractText(result.data);
        if (!content) {
          return null;
        }

        const response = parseAgentResponse(participant.config.id, content);
        if (!response) {
          return null;
        }

        if (this.#options.onAgentComplete) {
          this.#options.onAgentComplete(participant.config.id, response.content);
        }

        return response;
      } catch (err) {
        if (attempt === maxRetries) {
          this.#state.objections.push({
            participant_id: participant.config.id,
            content: `Failed after ${maxRetries + 1} attempts: ${err instanceof Error ? err.message : "unknown"}`,
            unresolved: false,
          });
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }

    return null;
  }

  #withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
      promise.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  #extractText(data) {
    if (!data?.parts) return null;
    const parts = data.parts;
    const textParts = parts.filter((p) => p.type === "text");
    const content = textParts.map((p) => p.text).join("\n").trim();
    return content.length > 0 ? content : null;
  }

  async #promptParent(system, model, message) {
    const result = await this.#client.session.prompt({
      path: { id: this.#parentSessionId },
      body: { system, model, tools: {}, parts: [{ type: "text", text: message }] },
      query: { directory: this.#directory },
    });
    if (result.error) throw new Error(JSON.stringify(result.error));
    const parts = result.data.parts;
    return parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
  }

  async #clearPreviousResponses() {
    const db = await this.#getDb();
    for (const p of this.#state.participants) {
      db.clearAgentResponse(this.#meetingId, p.config.id);
    }
  }

  #truncate(text, max) {
    const cleaned = text.replace(/\n/g, " ").trim();
    if (cleaned.length <= max) return cleaned;
    return cleaned.slice(0, max - 3) + "...";
  }

  async #postProgress(message) {
    try {
      const session = this.#client.session;
      if (typeof session.promptAsync === "function") {
        await session.promptAsync({
          path: { id: this.#parentSessionId },
          body: {
            noReply: true,
            parts: [{ type: "text", text: message }],
          },
          query: { directory: this.#directory },
        });
      }
    } catch {
    }
  }

  async #moderateInterjection(ij) {
    const situation = `Two participants claim equal priority (${ij.priority}) for interjection:
- ${ij.participant_id}: "${ij.reason}"
Who should be granted the floor?`;

    try {
      const model = this.#getHighestTierModel();
      const prompt = `${situation}

Respond with: "grant" or "deny". One word only.`;
      const result = await this.#promptParent(
        "You are the deliberation moderator. Rule on interjection priority disputes.",
        model,
        prompt,
      );
      return result.toLowerCase().includes("grant");
    } catch {
      return false;
    }
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
        const prompt = `Summarize this deliberation round in 2-3 sentences. What was established? What remains contested?\n\nContributions:\n${round.contributions.map((c) => `- ${c.content.slice(0, 150)}`).join("\n")}\n\nSummary:`;
        const semanticSummary = await this.#promptParent("You are a neutral summarizer.", model, prompt);
        if (semanticSummary.trim().length > 10) {
          summary = semanticSummary.trim();
        }
      } catch {}
    }

    return summary;
  }

  #checkConvergence(round) {
    const activeCount = this.#state.participants.filter((p) => p.status !== "passed").length;
    const passedCount = this.#state.participants.filter((p) => p.status === "passed").length;

    const result = checkConvergence(
      passedCount,
      activeCount,
      this.#state.participants.length,
      this.#state.current_round,
      this.#state.max_rounds,
      this.#state.convergence_mode,
    );

    this.#state.status = result.status;
    return result.shouldStop;
  }

  async #synthesize() {
    const synthesizer = this.#state.participants.find((p) => p.config.tier === "principal")
      ?? this.#state.participants.find((p) => p.config.tier === "senior")
      ?? this.#state.participants[this.#state.participants.length - 1];

    if (!synthesizer) return "No participants available for synthesis.";

    if (this.#options.onSynthesisStart) {
      this.#options.onSynthesisStart();
    }
    await this.#postProgress(`🔄 Synthesizing final output...`);

    const db = await this.#getDb();
    const transcriptData = db.getTranscriptData(this.#meetingId);

    const synthSessionId = await this.#createSynthesizerSession(synthesizer);

    let artifactText;
    try {
      artifactText = await this.#promptSynthesizerSession(synthSessionId, synthesizer, transcriptData);
    } catch {
      artifactText = `# Deliberation Output\n\n${this.#state.weft.map((c) => `- ${c.content}`).join("\n")}`;
    }

    const result = await synthesizeFromData(
      transcriptData,
      this.#state.participants,
      this.#state.objections,
      synthesizer,
      async (_system, _model, _message) => artifactText,
      (p) => this.#getParticipantModel(p),
    );

    this.#state.artifact = result.artifact;

    await this.#postProgress(`✅ Synthesis complete`);

    if (this.#options.onSynthesisComplete) {
      this.#options.onSynthesisComplete(result.output);
    }
    this.#notifyUpdate();

    return result.output;
  }

  async #createSynthesizerSession(synthesizer) {
    const result = await this.#client.session.create({
      body: {
        parentID: this.#parentSessionId,
        title: `Loom · Synthesizer (${synthesizer.config.tier})`,
      },
      query: { directory: this.#directory },
    });

    if (!result.data || result.error) {
      throw new Error(`Failed to create synthesizer session: ${result.error?.message || "unknown error"}`);
    }

    return result.data.id;
  }

  async #promptSynthesizerSession(sessionId, synthesizer, transcriptData) {
    const model = this.#getParticipantModel(synthesizer);
    const transcript = formatTranscriptFromData(transcriptData, this.#state.participants);

    const userPrompt = buildSynthesisPromptForTranscript(transcriptData.question, transcript);

    const result = await this.#withTimeout(
      this.#client.session.prompt({
        path: { id: sessionId },
        body: {
          system: `You are ${synthesizer.config.name} (${synthesizer.config.tier}). Synthesize the final output.\n\n${synthesizer.tier_config.system_prompt_addendum}`,
          model,
          parts: [{ type: "text", text: userPrompt }],
        },
        query: { directory: this.#directory },
      }),
      180000,
    );

    if (result.error) {
      throw new Error(result.error.message || JSON.stringify(result.error));
    }

    const text = this.#extractText(result.data);
    if (!text) {
      throw new Error("Synthesizer returned empty response");
    }
    return text;
  }

  async #persistState() {
    const db = await this.#getDb();
    const sharedState = this.#buildSharedState();
    db.setWarp(sharedState.warp);
    db.setRound(sharedState.round);
    db.setStatus(sharedState.status);
  }

  #notifyUpdate() {
    if (this.#options.onUpdate) {
      this.#options.onUpdate(this.#state);
    }
  }
}

import type {
  ParticipantConfig,
  ParticipantState,
  LoomState,
  Contribution,
  Interjection,
  Tier,
  SharedMeetingState,
  AgentResponse,
  Round,
} from "./types.js";
import type { AgentSessionClient } from "./client-types.js";
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
import type { TranscriptData } from "./types.js";

declare const crypto: { randomUUID(): string };

interface OrchestratorOptions {
  client: AgentSessionClient;
  directory: string;
  parentSessionId: string;
  opencodeSessionId: string;
  question: string;
  context: string;
  participants: ParticipantConfig[];
  maxRounds: number;
  convergence: "consensus" | "majority" | "moderator_forces";
  onUpdate?: (state: LoomState) => void;
  onAgentComplete?: (participantId: string, response: string) => void;
  onContribution?: (name: string, round: number, type: string) => void;
  onRoundComplete?: (round: number, summary: string) => void;
  onSynthesisStart?: () => void;
  onSynthesisComplete?: (output: string) => void;
  waitForUserInput?: () => Promise<"continue" | "end" | string>;
}

export class MeetingOrchestrator {
  private meetingId: string;
  private state: LoomState;
  private options: OrchestratorOptions;
  private client: AgentSessionClient;
  private directory: string;
  private parentSessionId: string;
  private opencodeSessionId: string;
  private database: MeetingDatabase | null = null;

  constructor(options: OrchestratorOptions) {
    this.meetingId = crypto.randomUUID();
    this.options = options;
    this.client = options.client;
    this.directory = options.directory;
    this.parentSessionId = options.parentSessionId;
    this.opencodeSessionId = options.opencodeSessionId;

    this.state = {
      id: this.meetingId,
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

  /** Returns the unique meeting ID. */
  getMeetingId(): string {
    return this.meetingId;
  }

  /** Returns an immutable snapshot of the current meeting state. */
  getState(): Readonly<LoomState> {
    return Object.freeze({ ...this.state });
  }

  /** Finds the highest-tier model among participants (for moderator/synthesis tasks). */
  private getHighestTierModel(): { providerID: string; modelID: string } {
    for (const tier of ["principal", "senior", "mid", "junior"] as Tier[]) {
      const p = this.state.participants.find((pp) => pp.config.tier === tier);
      if (p) return splitModel(p.tier_config.model);
    }
    return splitModel(this.state.participants[0].tier_config.model);
  }

  /** Gets the model assignment for a participant, throwing if none is configured. */
  private getParticipantModel(participant: ParticipantState): { providerID: string; modelID: string } {
    if (participant.config.model) {
      return { providerID: participant.config.model.providerID, modelID: participant.config.model.modelID };
    }
    throw new Error(`No model assigned for participant ${participant.config.name} (${participant.config.tier}). Run knit_models first.`);
  }

  /** Gets the database instance, creating it lazily on first access. */
  private async getDb(): Promise<MeetingDatabase> {
    if (!this.database) {
      const dbPath = join(this.directory, ".opencode", "loom", "meetings", `${this.meetingId}.db`);
      const db = await MeetingDatabase.create(dbPath, this.meetingId);
      this.database = db;
      db.initializeMeeting({
        question: this.options.question,
        context: this.options.context,
        maxRounds: this.options.maxRounds,
        convergence: this.options.convergence,
        parentSessionId: this.options.parentSessionId,
        opencodeSessionId: this.opencodeSessionId,
        participants: this.state.participants.map((p) => p.config),
      });
    }
    return this.database;
  }

  /** Creates child sessions and initializes meeting files. Idempotent. */
  async initialize(): Promise<void> {
    if (this.state.status !== "initializing") {
      return;
    }

    const db = await this.getDb();
    for (const p of this.state.participants) {
      if (!p.session_id) {
        const sessionId = await this.createChildSession(p);
        p.session_id = sessionId;
        db.setParticipantSessionId(p.config.id, sessionId);
      }
    }
    await this.persistState();
    this.state.status = "weaving";
  }

  /** Creates a child session for a participant with its own model and isolated context. */
  private async createChildSession(participant: ParticipantState): Promise<string> {
    const result = await this.client.session.create({
      body: {
        parentID: this.parentSessionId,
        title: `Loom · ${participant.config.name} (${participant.config.tier})`,
      },
      query: { directory: this.directory },
    });

    if (!result.data || result.error) {
      throw new Error(`Failed to create session for ${participant.config.name}: ${result.error?.message || "unknown error"}`);
    }

    return result.data.id;
  }

  /** Runs the full deliberation: initializes, runs rounds, and synthesizes the final output. */
  async runMeeting(): Promise<string> {
    await this.initialize();

    const participantItems = this.state.participants
      .map((p) => `<li><b>${this.escapeHtml(p.config.name)}</b> <span style="color:#888">(${p.config.tier}${p.config.domain ? ", " + p.config.domain : ""})</span></li>`)
      .join("");
    await this.postProgress(
      `&#127916; <b>Loom started</b> — ${this.state.participants.length} participants:<ul style="margin:4px 0 0 16px;padding:0">${participantItems}</ul>`
    );

    let continueWeaving = true;
    while (continueWeaving) {
      if (this.state.current_round > 0 && this.options.waitForUserInput) {
        this.state.status = "waiting_for_user";
        this.notifyUpdate();
        const userAction = await this.options.waitForUserInput();

        if (userAction === "end") {
          this.state.status = "converged";
          break;
        } else if (userAction !== "continue") {
          this.state.warp += `\n\n**User Input:** ${userAction}`;
          (await this.getDb()).setWarp(this.state.warp);
        }
      }

      continueWeaving = await this.runRound();
      this.notifyUpdate();
    }

    const output = await this.synthesize();
    this.cleanupDatabase();
    return output;
  }

  private cleanupDatabase(): void {
    if (!this.database) return;
    const dbPath = this.database.getDatabasePath();
    this.database.close();
    this.database = null;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
      }
    }
  }

  /** Runs a single deliberation round. Returns true if the meeting should continue. */
  async runRound(): Promise<boolean> {
    this.state.current_round++;
    const round = {
      number: this.state.current_round,
      contributions: [] as Contribution[],
      interjections: [] as Interjection[],
      token_path: [] as string[],
      summary: "",
    };
    this.state.rounds.push(round);

    (await this.getDb()).setRound(this.state.current_round);
    this.notifyUpdate();

    await this.clearPreviousResponses();

    const sharedState = this.buildSharedState();
    (await this.getDb()).setWarp(sharedState.warp);
    (await this.getDb()).setRound(sharedState.round);

    const activeParticipants = this.state.participants.filter((p) => p.status !== "passed");

    for (const p of activeParticipants) {
      await this.postProgress(`&#129300; <b>${this.escapeHtml(p.config.name)}</b> <span style="color:#888">(${p.config.tier})</span> is thinking...`);

      let result = await this.promptChildSession(p);
      let retryError: string | null = null;

      if (!result) {
        retryError = "Empty response on first attempt";
        result = await this.promptChildSession(p);
      }

      if (!result) {
        const errorDetail = `${retryError}\nEmpty response after retry. Participant may have timed out or returned empty.`;
        await this.postProgress(
          `&#9197; <b>${this.escapeHtml(p.config.name)}</b> <span style="color:#888">(${p.config.tier})</span> &mdash; no response, passing` +
          `<details><summary style="color:#888;font-size:0.85em">error details</summary><pre style="margin:4px 0 0;padding:8px;background:#f5f5f5;border-radius:4px;font-size:0.8em;white-space:pre-wrap">${this.escapeHtml(errorDetail)}</pre></details>`
        );
        const participant = this.state.participants.find(
          (pp) => pp.config.id === p.config.id,
        );
        if (participant) {
          participant.status = "passed";
        }
        round.token_path.push(p.config.id);
        if (this.options.onContribution) {
          this.options.onContribution(p.config.name, this.state.current_round, "passed_no_response");
        }
        this.notifyUpdate();
        continue;
      }

      const participant = this.state.participants.find(
        (pp) => pp.config.id === result.participant_id,
      );
      if (!participant) continue;

      if (result.content === "[PASS]") {
        participant.status = "passed";
        round.token_path.push(participant.config.id);
        await this.postProgress(`&#9197; <b>${this.escapeHtml(participant.config.name)}</b> <span style="color:#888">(${participant.config.tier})</span> &mdash; chose to pass`);
        if (this.options.onContribution) {
          this.options.onContribution(p.config.name, this.state.current_round, "pass");
        }
        this.notifyUpdate();
        continue;
      }

      const contribution: Contribution = {
        participant_id: result.participant_id,
        content: result.content,
        type: result.type,
        targets_which: null,
        timestamp: Date.now(),
      };

      this.state.weft.push(contribution);
      round.contributions.push(contribution);
      round.token_path.push(participant.config.id);
      participant.contributions_count++;
      participant.status = "listening";

      (await this.getDb()).addContribution(this.meetingId, {
        ...contribution,
        round: this.state.current_round,
      });

      if (result.interjection) {
        const interjection: Interjection = {
          participant_id: result.participant_id,
          priority: result.interjection.priority,
          reason: result.interjection.reason,
          granted: false,
          pushback: null,
          resolved: "pending",
        };
        round.interjections.push(interjection);
        (await this.getDb()).addInterjection(this.meetingId, interjection);
      }

      const truncated = this.truncate(result.content, 80);
      await this.postProgress(
        `&#9989; <b>${this.escapeHtml(p.config.name)}</b> <span style="color:#888">(${p.config.tier})</span> &mdash; <i>${result.type}</i>: ` +
        this.collapsible(`"${truncated}"`, result.content)
      );

      if (this.options.onAgentComplete) {
        this.options.onAgentComplete(result.participant_id, result.content);
      }
      if (this.options.onContribution) {
        this.options.onContribution(p.config.name, this.state.current_round, result.type);
      }
      this.notifyUpdate();
    }

    if (round.interjections.length > 0) {
      await resolveInterjections(round, (ij) => this.moderateInterjection(ij));
    }

    round.summary = await this.summarizeRound(round);
    const ijNotes = formatInterjectionNotes(round);
    if (ijNotes) {
      this.state.warp += ijNotes;
    }
    this.state.warp = evolveWarp(this.state.warp, round);
    (await this.getDb()).setWarp(this.state.warp);

    const contribCount = round.contributions.length;
    const ijCount = round.interjections.length;
    await this.postProgress(
      `&#128203; <b>Round ${this.state.current_round} complete</b> &mdash; ${contribCount} contribution${contribCount !== 1 ? "s" : ""}, ${ijCount} interjection${ijCount !== 1 ? "s" : ""}` +
      (round.summary ? this.collapsible("Summary", round.summary) : "")
    );

    if (this.options.onRoundComplete) {
      this.options.onRoundComplete(this.state.current_round, round.summary);
    }
    this.notifyUpdate();

    const modDecision = await checkModeratorIntervention(
      round,
      this.state.participants,
      this.state.weft,
      this.state.current_round,
      this.state.max_rounds,
      async (system, model, message) => this.promptParent(system, model, message),
      () => this.getHighestTierModel(),
    );

    if (modDecision.action === "converge") {
      this.state.status = "converged";
      await this.persistState();
      return false;
    }

    if (this.checkConvergence(round)) {
      await this.persistState();
      return false;
    }

    if (this.state.current_round >= this.state.max_rounds) {
      this.state.status = "max_rounds_reached";
      await this.persistState();
      return false;
    }

    await this.persistState();
    return true;
  }

  /** Sends a prompt to a participant's child session with retry and timeout. */
  private async promptChildSession(participant: ParticipantState): Promise<AgentResponse | null> {
    participant.status = "speaking";

    if (!participant.session_id) {
      return null;
    }

    const maxRetries = 2;
    const timeoutMs = 120000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.withTimeout(
          this.client.session.prompt({
            path: { id: participant.session_id },
            body: {
              system: buildAgentSystemPrompt(participant),
              model: this.getParticipantModel(participant),
              parts: [{ type: "text", text: buildAgentUserPrompt(
                participant,
                this.state.warp,
                this.state.weft,
                this.state.question,
                this.state.current_round,
              ) }],
            },
            query: { directory: this.directory },
          }),
          timeoutMs,
        );

        if (result.error) {
          throw new Error(result.error.message || JSON.stringify(result.error));
        }

        const content = this.extractText(result.data);
        if (!content) {
          return null;
        }

        const response = parseAgentResponse(participant.config.id, content);
        if (!response) {
          return null;
        }

        if (this.options.onAgentComplete) {
          this.options.onAgentComplete(participant.config.id, response.content);
        }

        return response;
      } catch (err) {
        if (attempt === maxRetries) {
          this.state.objections.push({
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

  /** Wraps a promise with a timeout. */
  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
      promise.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }

  /** Extracts text content from a session prompt response. */
  private extractText(data: any): string | null {
    if (!data?.parts) return null;
    const parts: any[] = data.parts;
    const textParts = parts.filter((p: any) => p.type === "text");
    const content = textParts.map((p: any) => p.text).join("\n").trim();
    return content.length > 0 ? content : null;
  }

  private async promptParent(system: string, model: { providerID: string; modelID: string }, message: string): Promise<string> {
    const result = await this.client.session.prompt({
      path: { id: this.parentSessionId },
      body: { system, model, tools: {}, parts: [{ type: "text", text: message }] },
      query: { directory: this.directory },
    });
    if (result.error) throw new Error(JSON.stringify(result.error));
    const parts: any[] = result.data.parts;
    return parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
  }

  private async clearPreviousResponses(): Promise<void> {
    const db = await this.getDb();
    for (const p of this.state.participants) {
      db.clearAgentResponse(this.meetingId, p.config.id);
    }
  }

  private truncate(text: string, max: number): string {
    const cleaned = text.replace(/\n/g, " ").trim();
    if (cleaned.length <= max) return cleaned;
    return cleaned.slice(0, max - 3) + "...";
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  private collapsible(summary: string, content: string): string {
    return `<details><summary>${summary}</summary><div style="margin-top:8px;white-space:pre-wrap">${this.escapeHtml(content)}</div></details>`;
  }

  private async postProgress(message: string): Promise<void> {
    try {
      const session = (this.client as any).session;
      if (typeof session.promptAsync === "function") {
        await session.promptAsync({
          path: { id: this.parentSessionId },
          body: {
            noReply: true,
            parts: [{ type: "text", text: message }],
          },
          query: { directory: this.directory },
        });
      }
    } catch {
    }
  }

  /** Asks the moderator to rule on a contested interjection. Returns true if granted. */
  private async moderateInterjection(ij: Interjection): Promise<boolean> {
    const situation = `Two participants claim equal priority (${ij.priority}) for interjection:
- ${ij.participant_id}: "${ij.reason}"
Who should be granted the floor?`;

    try {
      const model = this.getHighestTierModel();
      const prompt = `${situation}

Respond with: "grant" or "deny". One word only.`;
      const result = await this.promptParent(
        "You are the deliberation moderator. Rule on interjection priority disputes.",
        model,
        prompt,
      );
      return result.toLowerCase().includes("grant");
    } catch {
      return false;
    }
  }

  private buildSharedState(): SharedMeetingState {
    return {
      meeting_id: this.meetingId,
      round: this.state.current_round,
      warp: this.state.warp,
      question: this.state.question,
      contributions: this.state.weft,
      interjections: [],
      status: this.state.status,
    };
  }



  private async summarizeRound(round: { contributions: Contribution[]; interjections: Interjection[] }): Promise<string> {
    const contribCount = round.contributions.length;
    if (contribCount === 0) return "No contributions this round.";

    const types = round.contributions.map((c) => c.type);
    const typeCounts: Record<string, number> = {};
    for (const t of types) typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    const typeSummary = Object.entries(typeCounts).map(([t, c]) => `${c} ${t}`).join(", ");

    let summary = `Round contributions (${contribCount}): ${typeSummary}.`;
    if (round.interjections.length > 0) {
      summary += ` ${round.interjections.length} interjection(s).`;
    }

    if (this.state.convergence_mode === "moderator_forces" && contribCount > 2) {
      try {
        const model = this.getHighestTierModel();
        const prompt = `Summarize this deliberation round in 2-3 sentences. What was established? What remains contested?\n\nContributions:\n${round.contributions.map((c) => `- ${c.content.slice(0, 150)}`).join("\n")}\n\nSummary:`;
        const semanticSummary = await this.promptParent("You are a neutral summarizer.", model, prompt);
        if (semanticSummary.trim().length > 10) {
          summary = semanticSummary.trim();
        }
      } catch {}
    }

    return summary;
  }

  private checkConvergence(round: { contributions: Contribution[] }): boolean {
    const activeCount = this.state.participants.filter((p) => p.status !== "passed").length;
    const passedCount = this.state.participants.filter((p) => p.status === "passed").length;

    const result = checkConvergence(
      passedCount,
      activeCount,
      this.state.participants.length,
      this.state.current_round,
      this.state.max_rounds,
      this.state.convergence_mode,
    );

    this.state.status = result.status;
    return result.shouldStop;
  }

  /** Produces the final deliberation artifact via a visible synthesizer child session. */
  private async synthesize(): Promise<string> {
    const synthesizer = this.state.participants.find((p) => p.config.tier === "principal")
      ?? this.state.participants.find((p) => p.config.tier === "senior")
      ?? this.state.participants[this.state.participants.length - 1];

    if (!synthesizer) return "No participants available for synthesis.";

    if (this.options.onSynthesisStart) {
      this.options.onSynthesisStart();
    }
    await this.postProgress(`&#128260; Synthesizing final output...`);

    const db = await this.getDb();
    const transcriptData = db.getTranscriptData(this.meetingId);

    const synthSessionId = await this.createSynthesizerSession(synthesizer);

    let artifactText: string;
    try {
      artifactText = await this.promptSynthesizerSession(synthSessionId, synthesizer, transcriptData);
    } catch {
      artifactText = `# Deliberation Output\n\n${this.state.weft.map((c) => `- ${c.content}`).join("\n")}`;
    }

    const result = await synthesizeFromData(
      transcriptData,
      this.state.participants,
      this.state.objections,
      synthesizer,
      async (_system, _model, _message) => artifactText,
      (p) => this.getParticipantModel(p),
    );

    this.state.artifact = result.artifact;

    await this.postProgress(`&#9989; Synthesis complete`);

    if (this.options.onSynthesisComplete) {
      this.options.onSynthesisComplete(result.output);
    }
    this.notifyUpdate();

    return result.output;
  }

  /** Creates a dedicated child session for the synthesizer (visible in UI). */
  private async createSynthesizerSession(synthesizer: ParticipantState): Promise<string> {
    const result = await this.client.session.create({
      body: {
        parentID: this.parentSessionId,
        title: `Loom · Synthesizer (${synthesizer.config.tier})`,
      },
      query: { directory: this.directory },
    });

    if (!result.data || result.error) {
      throw new Error(`Failed to create synthesizer session: ${result.error?.message || "unknown error"}`);
    }

    return result.data.id;
  }

  /** Prompts the synthesizer child session with the full transcript. */
  private async promptSynthesizerSession(
    sessionId: string,
    synthesizer: ParticipantState,
    transcriptData: TranscriptData,
  ): Promise<string> {
    const model = this.getParticipantModel(synthesizer);
    const transcript = formatTranscriptFromData(transcriptData, this.state.participants);

    const userPrompt = buildSynthesisPromptForTranscript(transcriptData.question, transcript);

    const result = await this.withTimeout(
      this.client.session.prompt({
        path: { id: sessionId },
        body: {
          system: `You are ${synthesizer.config.name} (${synthesizer.config.tier}). Synthesize the final output.\n\n${synthesizer.tier_config.system_prompt_addendum}`,
          model,
          parts: [{ type: "text", text: userPrompt }],
        },
        query: { directory: this.directory },
      }),
      180000,
    );

    if (result.error) {
      throw new Error(result.error.message || JSON.stringify(result.error));
    }

    const text = this.extractText(result.data);
    if (!text) {
      throw new Error("Synthesizer returned empty response");
    }
    return text;
  }

  /** Persists the current meeting state to the database. */
  private async persistState(): Promise<void> {
    const db = await this.getDb();
    const sharedState = this.buildSharedState();
    db.setWarp(sharedState.warp);
    db.setRound(sharedState.round);
    db.setStatus(sharedState.status);
  }

  private notifyUpdate(): void {
    if (this.options.onUpdate) {
      this.options.onUpdate(this.state);
    }
  }
}

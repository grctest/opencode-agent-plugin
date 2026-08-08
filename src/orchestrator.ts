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
import { deriveConfidence, extractSection } from "./artifact.js";
import { checkModeratorIntervention } from "./moderation.js";
import { parseAgentResponse } from "./validation.js";
import { withConcurrency } from "./concurrency.js";
import {
  initMeetingFiles,
  writeSharedState,
  writeWarp,
  writeRound,
  addContribution,
  addInterjection,
  initAgentDir,
  cleanupMeeting,
  clearAgentResponse,
} from "./shared-files.js";

declare const crypto: { randomUUID(): string };

interface OrchestratorOptions {
  client: AgentSessionClient;
  directory: string;
  parentSessionId: string;
  question: string;
  context: string;
  participants: ParticipantConfig[];
  maxRounds: number;
  convergence: "consensus" | "majority" | "moderator_forces";
  onUpdate?: (state: LoomState) => void;
  onAgentComplete?: (participantId: string, response: string) => void;
  waitForUserInput?: () => Promise<"continue" | "end" | string>;
}

export class MeetingOrchestrator {
  private meetingId: string;
  private state: LoomState;
  private options: OrchestratorOptions;
  private client: AgentSessionClient;
  private directory: string;
  private parentSessionId: string;

  constructor(options: OrchestratorOptions) {
    this.meetingId = crypto.randomUUID();
    this.options = options;
    this.client = options.client;
    this.directory = options.directory;
    this.parentSessionId = options.parentSessionId;

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

  getMeetingId(): string {
    return this.meetingId;
  }

  getState(): Readonly<LoomState> {
    return Object.freeze({ ...this.state });
  }

  private getHighestTierModel(): { providerID: string; modelID: string } {
    for (const tier of ["principal", "senior", "mid", "junior"] as Tier[]) {
      const p = this.state.participants.find((pp) => pp.config.tier === tier);
      if (p) return splitModel(p.tier_config.model);
    }
    return splitModel(this.state.participants[0].tier_config.model);
  }

  private getParticipantModel(participant: ParticipantState): { providerID: string; modelID: string } {
    if (participant.config.model) {
      return { providerID: participant.config.model.providerID, modelID: participant.config.model.modelID };
    }
    return splitModel(participant.tier_config.model);
  }

  async initialize(): Promise<void> {
    if (this.state.status !== "initializing") {
      return;
    }

    await initMeetingFiles(this.meetingId);
    for (const p of this.state.participants) {
      await initAgentDir(this.meetingId, p.config.id);
      if (!p.session_id) {
        const sessionId = await this.createChildSession(p);
        p.session_id = sessionId;
      }
    }
    await this.persistState();
    this.state.status = "weaving";
  }

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

  async runMeeting(): Promise<string> {
    await this.initialize();

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
          await writeWarp(this.meetingId, this.state.warp);
        }
      }

      continueWeaving = await this.runRound();
      this.notifyUpdate();
    }

    const output = await this.synthesize();
    await cleanupMeeting(this.meetingId);
    return output;
  }

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

    await writeRound(this.meetingId, this.state.current_round);
    this.notifyUpdate();

    await this.clearPreviousResponses();

    const sharedState = this.buildSharedState();
    await writeSharedState(sharedState);

    const activeParticipants = this.state.participants.filter((p) => p.status !== "passed");

    const tasks = activeParticipants.map((p) => () => this.promptChildSession(p));
    const settled = await withConcurrency(tasks, 4);

    const results: (AgentResponse | null)[] = settled.map((r) =>
      r.status === "fulfilled" ? r.value : null,
    );

    for (const result of results) {
      if (!result) continue;

      const participant = this.state.participants.find(
        (p) => p.config.id === result.participant_id,
      );
      if (!participant) continue;

      if (result.content === "[PASS]") {
        participant.status = "passed";
        round.token_path.push(participant.config.id);
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

      await addContribution(this.meetingId, contribution);

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
        await addInterjection(this.meetingId, interjection);
      }

      if (this.options.onAgentComplete) {
        this.options.onAgentComplete(result.participant_id, result.content);
      }
    }

    if (round.interjections.length > 0) {
      await this.resolveInterjections(round);
    }

    round.summary = await this.summarizeRound(round);

    const granted = round.interjections.filter((ij) => ij.granted);
    if (granted.length > 0) {
      const ijNotes = granted
        .map((ij) => `- ${ij.participant_id}: "${ij.reason}"`)
        .join("\n");
      this.state.warp += `\n\n### Interjections (Granted)\n${ijNotes}`;
    }

    this.state.warp = await this.evolveWarpAsync(this.state.warp, round);
    await writeWarp(this.meetingId, this.state.warp);

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

  private async promptChildSession(participant: ParticipantState): Promise<AgentResponse | null> {
    participant.status = "speaking";

    if (!participant.session_id) {
      return null;
    }

    const model = this.getParticipantModel(participant);
    const systemPrompt = buildAgentSystemPrompt(participant);
    const userPrompt = buildAgentUserPrompt(
      participant,
      this.state.warp,
      this.state.weft,
      this.state.question,
      this.state.current_round,
    );

    try {
      const result = await this.client.session.prompt({
        path: { id: participant.session_id },
        body: {
          system: systemPrompt,
          model,
          parts: [{ type: "text", text: userPrompt }],
        },
        query: { directory: this.directory },
      });

      if (result.error) {
        throw new Error(result.error.message || JSON.stringify(result.error));
      }

      const content = this.extractText(result.data);
      if (!content) {
        return null;
      }

      const response = parseAgentResponse(participant.config.id, content);

      if (this.options.onAgentComplete) {
        this.options.onAgentComplete(participant.config.id, response.content);
      }

      return response;
    } catch {
      return null;
    }
  }

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

  private clearPreviousResponses(): Promise<void[]> {
    const promises = this.state.participants.map((p) =>
      clearAgentResponse(this.meetingId, p.config.id),
    );
    return Promise.all(promises);
  }

  private async resolveInterjections(round: Round): Promise<void> {
    round.interjections.sort((a, b) => b.priority - a.priority);

    for (const ij of round.interjections) {
      if (ij.priority >= 9) {
        ij.granted = true;
        ij.resolved = "granted";
      } else if (ij.priority >= 7) {
        const contested = round.interjections.some(
          (other) =>
            other.participant_id !== ij.participant_id
            && other.priority === ij.priority
            && other.resolved === "pending",
        );

        if (contested) {
          const ruling = await this.moderateInterjection(ij, round);
          ij.granted = ruling;
          ij.resolved = ruling ? "granted" : "contested";
          if (!ruling) {
            ij.pushback = "Moderator ruled against interjection";
          }
        } else {
          ij.granted = true;
          ij.resolved = "granted";
        }
      } else {
        ij.resolved = "denied";
      }

      await addInterjection(this.meetingId, ij);
    }
  }

  private async moderateInterjection(
    ij: Interjection,
    round: Round,
  ): Promise<boolean> {
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

  private async evolveWarpAsync(warp: string, round: Round): Promise<string> {
    const { compactWarpWithLLM } = await import("./warp-compaction.js");
    const model = this.getHighestTierModel();
    const promptFn = async (system: string, m: { providerID: string; modelID: string }, msg: string) => {
      return this.promptParent(system, m, msg);
    };
    return compactWarpWithLLM(warp, round, promptFn, model);
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

    if (activeCount === 0) {
      this.state.status = "converged";
      return true;
    }

    switch (this.state.convergence_mode) {
      case "consensus":
        if (passedCount === this.state.participants.length) {
          this.state.status = "converged";
          return true;
        }
        break;
      case "majority":
        if (passedCount > this.state.participants.length / 2) {
          this.state.status = "converged";
          return true;
        }
        break;
    }
    return false;
  }

  private async synthesize(): Promise<string> {
    const synthesizer = this.state.participants.find((p) => p.config.tier === "principal")
      ?? this.state.participants.find((p) => p.config.tier === "senior")
      ?? this.state.participants[this.state.participants.length - 1];

    if (!synthesizer) return "No participants available for synthesis.";

    const { formatTranscript } = await import("./warp-compaction.js");
    const transcript = formatTranscript(this.state.rounds, this.state.participants);
    const model = this.getParticipantModel(synthesizer);

    const { buildSynthesisPrompt } = await import("./prompts.js");
    const userPrompt = buildSynthesisPrompt(this.state.question, transcript, this.state.participants);

    let artifactText: string;
    try {
      artifactText = await this.promptParent(
        `You are ${synthesizer.config.name} (${synthesizer.config.tier}). Synthesize the final output.\n\n${synthesizer.tier_config.system_prompt_addendum}`,
        model,
        userPrompt,
      );
    } catch {
      artifactText = `# Deliberation Output\n\n${this.state.weft.map((c) => `- ${c.content}`).join("\n")}`;
    }

    const unresolvedObjections = this.state.objections.filter((o) => o.unresolved);
    const objectionsText = unresolvedObjections.map((o) => `- ${o.content}`).join("\n");
    const finalOutput = objectionsText
      ? `${artifactText}\n\n## Unresolved Objections\n${objectionsText}`
      : artifactText;

    const confidence = deriveConfidence(this.state.weft, unresolvedObjections.length);

    this.state.artifact = {
      content: finalOutput,
      format: "markdown",
      decisions: extractSection(finalOutput, "Decision"),
      action_items: extractSection(finalOutput, "Action Items"),
      dissent: unresolvedObjections,
      open_questions: extractSection(finalOutput, "Open Questions"),
      confidence,
    };

    return finalOutput;
  }

  private async persistState(): Promise<void> {
    await writeSharedState(this.buildSharedState());
    await writeWarp(this.meetingId, this.state.warp);
    await writeRound(this.meetingId, this.state.current_round);
  }

  private notifyUpdate(): void {
    if (this.options.onUpdate) {
      this.options.onUpdate(this.state);
    }
  }
}

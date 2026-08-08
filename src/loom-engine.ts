import type {
  LoomState,
  Contribution,
  Tier,
  ParticipantState,
  Round,
  Client,
  ProviderID,
  ModelID,
} from "./types.js";
import { getTierConfig, splitModel, can } from "./tiers.js";
import { buildSpeakerSystemPrompt, buildSpeakerUserPrompt } from "./prompts.js";
import { handleInterjections } from "./interjections.js";
import { checkModeratorIntervention } from "./moderation.js";
import { generateArtifact, deriveConfidence, extractSection } from "./artifact.js";
import { evolveWarp, formatTranscript } from "./warp.js";
import { saveState, deleteState } from "./persistence.js";

declare const crypto: { randomUUID(): string };

export class LoomEngine {
  private state: LoomState;
  private client: Client;
  private directory: string;
  private metadataFn: (input: { title?: string; metadata?: Record<string, any> }) => void;
  private signal: AbortSignal | null = null;
  private startTime: number = 0;
  private readonly MAX_EXECUTION_MS = 5 * 60 * 1000;

  constructor(
    client: Client,
    directory: string,
    metadataFn: (input: { title?: string; metadata?: Record<string, any> }) => void,
    config: {
      question: string;
      context: string;
      parentSessionId: string;
      participants: Array<{
        id: string;
        name: string;
        persona: string;
        agenda: string;
        tier: Tier;
      }>;
      maxRounds: number;
      convergence: "consensus" | "majority" | "moderator_forces";
      modelOverrides?: Partial<Record<Tier, { model?: string; temperature?: number }>>;
    },
  ) {
    this.client = client;
    this.directory = directory;
    this.metadataFn = metadataFn;

    this.state = {
      id: crypto.randomUUID(),
      parent_session_id: config.parentSessionId,
      question: config.question,
      context: config.context,
      participants: config.participants.map((p) => ({
        config: p,
        tier_config: getTierConfig(p.tier, config.modelOverrides),
        status: "listening",
        reflection: "",
        contributions_count: 0,
      })),
      warp: config.context,
      weft: [],
      rounds: [],
      current_round: 0,
      max_rounds: config.maxRounds,
      current_speaker_idx: 0,
      status: "initializing",
      artifact: null,
      objections: [],
      convergence_mode: config.convergence,
    };
  }

  getState(): Readonly<LoomState> {
    return Object.freeze({ ...this.state });
  }

  setSignal(signal: AbortSignal): void {
    this.signal = signal;
  }

  private aborted(): boolean {
    return this.signal?.aborted ?? false;
  }

  private nearTimeout(): boolean {
    return Date.now() - this.startTime > this.MAX_EXECUTION_MS * 0.85;
  }

  // ─── Rights Enforcement ───────────────────────────────────────────────

  veto(participantId: string, reason: string): { ok: boolean; error?: string } {
    const p = this.state.participants.find((pp) => pp.config.id === participantId);
    if (!p) return { ok: false, error: "Participant not found" };
    if (!can(p, "veto")) return { ok: false, error: `${p.config.name} (${p.config.tier}) cannot veto` };

    this.state.objections.push({
      participant_id: participantId,
      content: `Veto: ${reason}`,
      unresolved: true,
    });
    return { ok: true };
  }

  forceEnd(participantId: string): { ok: boolean; error?: string } {
    const p = this.state.participants.find((pp) => pp.config.id === participantId);
    if (!p) return { ok: false, error: "Participant not found" };
    if (!can(p, "force_end")) return { ok: false, error: `${p.config.name} (${p.config.tier}) cannot force-end` };

    this.state.status = "converged";
    return { ok: true };
  }

  callVote(participantId: string): { ok: boolean; error?: string; result?: string } {
    const p = this.state.participants.find((pp) => pp.config.id === participantId);
    if (!p) return { ok: false, error: "Participant not found" };
    if (!can(p, "call_vote")) return { ok: false, error: `${p.config.name} (${p.config.tier}) cannot call votes` };

    const active = this.state.participants.filter((pp) => pp.status !== "passed");
    const totalActive = active.length;
    const votesToEnd = active.filter(
      (pp) =>
        pp.reflection.toLowerCase().includes("ready to conclude") ||
        pp.reflection.toLowerCase().includes("vote to end"),
    ).length;

    if (votesToEnd > totalActive / 2) {
      this.state.status = "converged";
      return { ok: true, result: `Vote passed: ${votesToEnd}/${totalActive} ready to conclude. Deliberation ending.` };
    }

    return { ok: true, result: `Vote failed: ${votesToEnd}/${totalActive} ready to conclude. Need majority.` };
  }

  // ─── Core API Call ────────────────────────────────────────────────────

  private async promptTurn(
    systemPrompt: string,
    model: { providerID: ProviderID; modelID: ModelID },
    userMessage: string,
  ): Promise<string> {
    const result = await this.client.session.prompt({
      path: { id: this.state.parent_session_id },
      body: {
        system: systemPrompt,
        model,
        tools: {},
        parts: [{ type: "text", text: userMessage }],
      },
      query: { directory: this.directory },
    });

    if (result.error) {
      throw new Error(`Prompt failed: ${JSON.stringify(result.error)}`);
    }

    const parts: any[] = result.data.parts;
    const textParts = parts.filter((p: any) => p.type === "text");
    return textParts.map((p: any) => p.text).join("\n");
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private getHighestTierModel(): { providerID: string; modelID: string } {
    for (const tier of ["principal", "senior", "mid", "junior"] as Tier[]) {
      const p = this.state.participants.find((pp) => pp.config.tier === tier);
      if (p) return splitModel(p.tier_config.model);
    }
    return splitModel(this.state.participants[0].tier_config.model);
  }

  private isPass(text: string): boolean {
    const t = text.trim().toLowerCase();
    if (t === "[pass]") return true;
    if (t === "pass") return true;
    if (t.startsWith("[pass]")) return true;
    if (t === "i pass" || t === "i have nothing to add") return true;
    if (t.includes("nothing to add") && t.includes("pass")) return true;
    return false;
  }

  private async updateMetadata(extra: Record<string, any> = {}): Promise<void> {
    const speaker = this.state.participants[this.state.current_speaker_idx];
    const progress = Math.round(
      (this.state.current_round / Math.max(this.state.max_rounds, 1)) * 100,
    );
    this.metadataFn({
      title: `Loom: Round ${this.state.current_round}/${this.state.max_rounds}`,
      metadata: {
        loom_status: this.state.status,
        loom_round: this.state.current_round,
        loom_max_rounds: this.state.max_rounds,
        loom_progress: `${progress}%`,
        loom_current_speaker: speaker?.config.name ?? "none",
        loom_contributions: this.state.weft.length,
        loom_participants: this.state.participants
          .map((p) => `${p.config.name} (${p.config.tier})`)
          .join(", "),
        ...extra,
      },
    });
  }

  // ─── Initialization ───────────────────────────────────────────────────

  async initialize(): Promise<void> {
    this.state.status = "weaving";
    this.startTime = Date.now();
    await this.updateMetadata({ loom_phase: "starting" });
  }

  // ─── Round Execution ──────────────────────────────────────────────────

  async runRound(): Promise<boolean> {
    if (this.state.status !== "weaving") return false;
    if (this.aborted()) {
      this.state.status = "aborted";
      return false;
    }

    this.state.current_round++;
    const round: Round = {
      number: this.state.current_round,
      contributions: [],
      interjections: [],
      token_path: [],
      summary: "",
    };
    this.state.rounds.push(round);

    let passesThisRound = 0;
    let activeThisRound = 0;

    for (let i = 0; i < this.state.participants.length; i++) {
      if (this.aborted()) {
        this.state.status = "aborted";
        return false;
      }
      if (this.nearTimeout()) {
        this.state.status = "converged";
        return false;
      }

      const speakerIdx =
        (this.state.current_speaker_idx + i) % this.state.participants.length;
      const speaker = this.state.participants[speakerIdx];

      if (speaker.status === "passed") continue;

      speaker.status = "speaking";
      this.state.current_speaker_idx = speakerIdx;
      round.token_path.push(speaker.config.id);
      activeThisRound++;
      await this.updateMetadata({ loom_phase: "speaking" });

      let response: string;
      try {
        const model = splitModel(speaker.tier_config.model);
        const systemPrompt = buildSpeakerSystemPrompt(speaker);
        const userPrompt = buildSpeakerUserPrompt(
          speaker,
          this.state.question,
          this.state.warp,
          this.state.weft,
          this.state.participants,
        );
        response = await this.promptTurn(systemPrompt, model, userPrompt);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        speaker.status = "passed";
        passesThisRound++;
        this.state.objections.push({
          participant_id: speaker.config.id,
          content: `Participant failed: ${message}`,
          unresolved: false,
        });
        continue;
      }

      if (this.isPass(response)) {
        speaker.status = "passed";
        passesThisRound++;
        continue;
      }

      const contribution = this.parseContribution(speaker.config.id, response);
      this.state.weft.push(contribution);
      round.contributions.push(contribution);
      speaker.contributions_count++;
      speaker.status = "listening";

      await this.gatherReflections(speaker.config.id, response);

      await this.updateMetadata({ loom_phase: "checking_interjections" });
      const interjectionResult = await handleInterjections(
        speaker.config.id,
        round,
        this.state.weft,
        this.state.participants,
        this.client,
        this.directory,
        (s, m, msg) => this.promptTurn(s, m, msg),
        () => this.getHighestTierModel(),
        () => this.aborted(),
        (extra) => this.updateMetadata(extra),
      );

      if (interjectionResult === "broken") break;
    }

    round.summary = await this.summarizeRound(round);
    this.state.warp = evolveWarp(this.state.warp, round);
    await this.updateMetadata({ loom_phase: "round_complete" });
    await saveState(this.state);

    const modDecision = await checkModeratorIntervention(
      round,
      this.state.participants,
      this.state.weft,
      this.state.current_round,
      this.state.max_rounds,
      (s, m, msg) => this.promptTurn(s, m, msg),
      () => this.getHighestTierModel(),
    );
    if (modDecision.action === "break" && modDecision.nextSpeakerIdx >= 0) {
      this.state.current_speaker_idx = modDecision.nextSpeakerIdx;
      return true;
    }
    if (modDecision.action === "converge") {
      this.state.status = "converged";
      return false;
    }

    if (this.checkConvergence(passesThisRound, activeThisRound)) {
      return false;
    }

    if (this.state.current_round >= this.state.max_rounds) {
      this.state.status = "max_rounds_reached";
      return false;
    }

    return true;
  }

  private checkConvergence(passesThisRound: number, activeThisRound: number): boolean {
    if (activeThisRound === 0) return false;

    switch (this.state.convergence_mode) {
      case "consensus":
        if (passesThisRound === activeThisRound) {
          this.state.status = "converged";
          return true;
        }
        break;
      case "majority":
        if (passesThisRound > activeThisRound / 2) {
          this.state.status = "converged";
          return true;
        }
        break;
      case "moderator_forces":
        break;
    }
    return false;
  }

  // ─── Reflections ───────────────────────────────────────────────────────

  private async gatherReflections(speakerId: string, contribution: string): Promise<void> {
    const speaker = this.state.participants.find((p) => p.config.id === speakerId);
    if (!speaker) return;

    const listeners = this.state.participants.filter(
      (p) => p.config.id !== speakerId && p.status !== "passed",
    );

    const reflectionPrompt = `## Private Reflection

**${speaker.config.name}** just said:
"${contribution}"

For each listener below, provide a 2-3 sentence honest reaction:
${listeners.map((l) => `- **${l.config.name}** (${l.config.tier}, agenda: ${l.config.agenda})`).join("\n")}

Respond with one line per listener in format: [REFLECTION: name: your 2-3 sentence reaction]`;

    try {
      const model = this.getHighestTierModel();
      const result = await this.promptTurn(
        "You are a neutral observer writing private reflections for deliberation participants.",
        model,
        reflectionPrompt,
      );

      for (const line of result.split("\n")) {
        const match = line.match(/\[REFLECTION:\s*(.+?):\s*(.+)\]/i);
        if (match) {
          const name = match[1].trim().toLowerCase();
          const reflection = match[2].trim();
          const participant = this.state.participants.find(
            (p) => p.config.name.toLowerCase() === name || p.config.id.toLowerCase() === name,
          );
          if (participant) {
            participant.reflection = reflection;
          }
        }
      }
    } catch {
    }
  }

  // ─── Summarization ────────────────────────────────────────────────────

  private async summarizeRound(round: Round): Promise<string> {
    const contribCount = round.contributions.length;
    const types = round.contributions.map((c) => c.type);
    const typeCounts: Record<string, number> = {};
    for (const t of types) {
      typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    }
    const typeSummary = Object.entries(typeCounts)
      .map(([t, c]) => `${c} ${t}`)
      .join(", ");

    const keyPoints = round.contributions.slice(0, 3).map((c) => c.content.slice(0, 80)).join("; ");

    let summary = `Round ${round.number}: ${contribCount} contributions (${typeSummary}).`;
    if (keyPoints) summary += ` Key points: ${keyPoints}.`;
    if (round.interjections.length > 0) {
      summary += ` ${round.interjections.length} interjection(s): ${round.interjections.map((ij) => ij.resolved).join(", ")}.`;
    }

    if (this.state.convergence_mode === "moderator_forces" && contribCount > 2) {
      try {
        const model = this.getHighestTierModel();
        const prompt = `Provide a 2-3 sentence summary of this deliberation round. Focus on what was established, what remains contested, and what new information emerged.

Contributions:
${round.contributions.map((c) => `- ${c.content.slice(0, 150)}`).join("\n")}

Summary:`;
        const semanticSummary = await this.promptTurn(
          "You are a neutral deliberation summarizer.",
          model,
          prompt,
        );
        if (semanticSummary.trim().length > 10) {
          summary = semanticSummary.trim();
        }
      } catch {
      }
    }

    return summary;
  }

  // ─── Contribution Parsing ─────────────────────────────────────────────

  private parseContribution(participantId: string, response: string): Contribution {
    let type: Contribution["type"] = "propose";
    const text = response.trim();

    if (text.startsWith("[CHALLENGE]")) type = "challenge";
    else if (text.startsWith("[REFINE]")) type = "refine";
    else if (text.startsWith("[SUPPORT]")) type = "support";
    else if (text.startsWith("[DISSENT]")) type = "dissent";
    else if (text.startsWith("[SYNTHESIZE]")) type = "synthesize";
    else if (text.startsWith("[QUESTION]")) type = "question";
    else if (text.toLowerCase().includes("challenge")) type = "challenge";
    else if (text.toLowerCase().includes("disagree")) type = "dissent";
    else if (text.toLowerCase().includes("agree")) type = "support";
    else if (text.toLowerCase().includes("refine") || text.toLowerCase().includes("modify")) type = "refine";

    const cleanContent = text.replace(/^\[(\w+)\]\s*/, "");

    return {
      participant_id: participantId,
      content: cleanContent,
      type,
      targets_which: null,
      timestamp: Date.now(),
    };
  }

  // ─── Artifact Generation ──────────────────────────────────────────────

  async generateArtifact(): Promise<string> {
    const synthesizer =
      this.state.participants.find((p) => p.config.tier === "principal") ??
      this.state.participants.find((p) => p.config.tier === "senior") ??
      this.state.participants[this.state.participants.length - 1];

    if (!synthesizer) return "No participants available for synthesis.";

    await this.updateMetadata({ loom_phase: "synthesizing" });

    const { splitModel } = await import("./tiers.js");
    const model = splitModel(synthesizer.tier_config.model);

    const { artifact, output } = await generateArtifact(
      this.state.question,
      this.state.rounds,
      this.state.weft,
      this.state.participants,
      this.state.objections,
      this.state.current_round,
      synthesizer,
      (s, m, msg) => this.promptTurn(s, m, msg),
    );

    this.state.artifact = artifact;

    await deleteState(this.state.id);

    this.metadataFn({
      title: `Loom: Complete — ${this.state.current_round} rounds`,
      metadata: {
        loom_status: "converged",
        loom_round: this.state.current_round,
        loom_contributions: this.state.weft.length,
        loom_confidence: artifact.confidence,
        loom_output_length: output.length,
      },
    });

    return output;
  }

  abort(): void {
    this.state.status = "aborted";
  }
}

export { parseModeratorRuling } from "./moderation.js";
export { deriveConfidence, extractSection } from "./artifact.js";

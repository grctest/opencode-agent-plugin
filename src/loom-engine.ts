import type { LoomState, ParticipantConfig, Tier, ModelAssignment } from "./types.js";
import type { AgentSessionClient } from "./client-types.js";
import { MeetingOrchestrator } from "./orchestrator.js";
import { parseModeratorRuling } from "./moderation.js";
import { deriveConfidence, extractSection } from "./artifact.js";

/** Thin wrapper that creates and runs a MeetingOrchestrator. This is the main entry point for the plugin. */
export class LoomEngine {
  private orchestrator: MeetingOrchestrator;

  constructor(
    client: AgentSessionClient,
    directory: string,
    metadataFn: (input: { title?: string; metadata?: Record<string, any> }) => void,
    config: {
      question: string;
      context: string;
      parentSessionId: string;
      opencodeSessionId: string;
      participants: Array<{
        id: string;
        name: string;
        persona: string;
        agenda: string;
        tier: Tier;
        model?: ModelAssignment;
      }>;
      maxRounds: number;
      convergence: "consensus" | "majority" | "moderator_forces";
      modelOverrides?: Partial<Record<Tier, { model?: string; temperature?: number }>>;
      onContribution?: (name: string, round: number, type: string) => void;
      onRoundComplete?: (round: number, summary: string) => void;
      onSynthesisStart?: () => void;
      onSynthesisComplete?: (output: string) => void;
    },
  ) {
    this.orchestrator = new MeetingOrchestrator({
      client,
      directory,
      parentSessionId: config.parentSessionId,
      opencodeSessionId: config.opencodeSessionId,
      question: config.question,
      context: config.context,
      participants: config.participants,
      maxRounds: config.maxRounds,
      convergence: config.convergence,
      onUpdate: (state) => {
        metadataFn({
          title: `Loom: ${state.status} (Round ${state.current_round})`,
          metadata: {
            loom_status: state.status,
            loom_round: state.current_round,
            loom_contributions: state.weft.length,
            loom_participants: state.participants
              .map((p) => `${p.config.name} (${p.config.tier})`)
              .join(", "),
          },
        });
      },
      onAgentComplete: (_participantId: string, _response: string) => {},
      onContribution: config.onContribution,
      onRoundComplete: config.onRoundComplete,
      onSynthesisStart: config.onSynthesisStart,
      onSynthesisComplete: config.onSynthesisComplete,
    });
  }

  getState(): Readonly<LoomState> {
    return this.orchestrator.getState();
  }

  async initialize(): Promise<void> {
    await this.orchestrator.initialize();
  }

  async runMeeting(): Promise<string> {
    return await this.orchestrator.runMeeting();
  }

  getMeetingId(): string {
    return this.orchestrator.getMeetingId();
  }
}

export { parseModeratorRuling } from "./moderation.js";
export { deriveConfidence, extractSection } from "./artifact.js";
export type { AgentSessionClient } from "./client-types.js";

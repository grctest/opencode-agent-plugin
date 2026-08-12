import { MeetingOrchestrator } from "./orchestrator.js";
import { parseModeratorRuling } from "./moderation.js";
import { deriveConfidence, extractSection } from "./synthesizer.js";

/** Thin wrapper that creates and runs a MeetingOrchestrator. This is the main entry point for the plugin. */
export class LoomEngine {
  /** @type {MeetingOrchestrator} */
  #orchestrator;

  /**
   * @param {import("./client-types.js").AgentSessionClient} client
   * @param {string} directory
   * @param {(input: { title?: string; metadata?: Record<string, any> }) => void} metadataFn
   * @param {Object} config
   * @param {string} config.question
   * @param {string} config.context
   * @param {string} config.parentSessionId
   * @param {string} config.opencodeSessionId
   * @param {Array<{ id: string; name: string; persona: string; agenda: string; tier: string; model?: { providerID: string; modelID: string } }>} config.participants
   * @param {number} config.maxRounds
   * @param {"consensus" | "majority" | "moderator_forces"} config.convergence
   * @param {Partial<Record<string, { model?: string; temperature?: number }>>} [config.modelOverrides]
   * @param {(name: string, round: number, type: string) => void} [config.onContribution]
   * @param {(round: number, summary: string) => void} [config.onRoundComplete]
   * @param {() => void} [config.onSynthesisStart]
   * @param {(output: string) => void} [config.onSynthesisComplete]
   */
  constructor(client, directory, metadataFn, config) {
    this.#orchestrator = new MeetingOrchestrator({
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
       onAgentComplete: (_participantId, _response) => {},
       onContribution: config.onContribution,
       onRoundComplete: config.onRoundComplete,
       onSynthesisStart: config.onSynthesisStart,
       onSynthesisComplete: config.onSynthesisComplete,
     });
  }

  getState() {
    return this.#orchestrator.getState();
  }

  async initialize() {
    await this.#orchestrator.initialize();
  }

  async runMeeting() {
    return await this.#orchestrator.runMeeting();
  }

  async extendMeeting(newPrompt) {
    return await this.#orchestrator.extendMeeting(newPrompt);
  }

  getMeetingId() {
    return this.#orchestrator.getMeetingId();
  }
}

export { parseModeratorRuling } from "./moderation.js";
export { deriveConfidence, extractSection } from "./synthesizer.js";

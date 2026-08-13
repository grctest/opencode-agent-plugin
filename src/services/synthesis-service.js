import { SynthesisCoordinator } from "../synthesis-coordinator.js";
import { Logger } from "../logger.js";

/**
 * Handles synthesis coordination.
 * Thin wrapper around SynthesisCoordinator for consistent service pattern.
 */
export class SynthesisService {
  /** @type {import("../synthesis-coordinator.js").SynthesisCoordinator} */
  #synthesisCoordinator;
  /** @type {import("../logger.js").Logger} */
  #logger;

  /**
   * @param {import("../session-manager.js").SessionManager} sessionManager
   * @param {import("../client-types.js").AgentSessionClient} client
   * @param {string} directory
   */
  constructor(client, directory, sessionManager) {
    this.#synthesisCoordinator = new SynthesisCoordinator(client, directory, sessionManager);
    this.#logger = new Logger();
  }

  /**
   * Runs the synthesis process.
   * @param {Object} params
   * @param {Object} params.transcriptData
   * @param {Array} params.participants
   * @param {Array} params.objections
   * @param {Object} params.synthesizer
   * @param {Function} params.getParticipantModel
   * @param {Function} params.onSynthesisStart
   * @param {Function} params.onSynthesisComplete
   * @returns {Promise<string>} The synthesized output
   */
  async run(params) {
    const {
      transcriptData,
      participants,
      objections,
      synthesizer,
      getParticipantModel,
      onSynthesisStart,
      onSynthesisComplete,
    } = params;

    return this.#synthesisCoordinator.run(
      transcriptData,
      participants,
      objections,
      synthesizer,
      getParticipantModel,
      onSynthesisStart,
      onSynthesisComplete,
    );
  }

  /**
   * Selects the synthesizer participant.
   * @param {Array} participants
   * @returns {Object|null}
   */
  selectSynthesizer(participants) {
    return this.#synthesisCoordinator.selectSynthesizer(participants);
  }
}
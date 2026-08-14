import { LoomError, extractErrorInfo } from "../logger.js";
import { Logger } from "../logger.js";

const EXTENSION_EXTRA_ROUNDS = 4;

/**
 * Handles meeting extension logic: fabric update, round limit bump.
 * Extracted from MeetingOrchestrator for single responsibility.
 */
export class MeetingExtender {
  /** @type {import("../logger.js").Logger} */
  #logger;

  constructor() {
    this.#logger = new Logger();
  }

  /**
   * Extends the meeting with new prompt and additional rounds.
   * @returns {Promise<void>}
   */
  async extend(params) {
    const {
      database,
      stateManager,
      sessionManager,
      newPrompt,
    } = params;

    if (!database) {
      throw new LoomError("Cannot extend: database not available", { phase: "extension", recoverable: false });
    }

    const newFabric = `${database.getFabric()}\n\n**User Input:** ${newPrompt}`;
    database.setFabric(newFabric);
    stateManager.setFabric(newFabric);
    stateManager.forceTransitionTo("weaving");
    stateManager.setMaxRounds(stateManager.getMaxRounds() + EXTENSION_EXTRA_ROUNDS);
    database.setRound(stateManager.getCurrentRound());

    for (const p of stateManager.getParticipants()) {
      stateManager.setParticipantStatus(p.config.id, "listening");
      database.setParticipantStatus(p.config.id, "listening");
    }

    await sessionManager.postProgress(
      `🧵 Extending loom — adding ${EXTENSION_EXTRA_ROUNDS} more rounds (now ${stateManager.getMaxRounds()} total)`
    );
    this.#logger.info("extended", "Meeting extended", { newMaxRounds: stateManager.getMaxRounds() });
  }
}

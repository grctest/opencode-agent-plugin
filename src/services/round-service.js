import { RoundExecutor } from "../round-executor.js";
import { summarizeRound } from "../round-summarizer.js";
import { formatInterjectionNotes } from "../interjection-resolver.js";
import { Logger } from "../logger.js";

/**
 * Handles round execution including prompt, reflection, and interjection phases.
 */
export class RoundService {
  /** @type {import("../round-executor.js").RoundExecutor} */
  #roundExecutor;
  /** @type {import("../logger.js").Logger} */
  #logger;

  /**
   * @param {Object} params
   * @param {import("../round-executor.js").RoundExecutor} params.roundExecutor
   */
  constructor({ roundExecutor }) {
    this.#roundExecutor = roundExecutor;
    this.#logger = new Logger();
  }

  /**
   * Runs a complete round: prompt phase, reflection phase, interjection phase.
   * @param {Object} params
   * @param {Object} params.round - Round object to populate
   * @param {Array} params.activeParticipants
   * @param {boolean} params.allowInterjections
   * @param {Function} params.promptOrchestrator
   * @param {Function} params.getHighestTierModel
   * @returns {Promise<Object>} Updated round with summary
   */
   async runRound(params) {
    const { round, activeParticipants, allowInterjections, promptOrchestrator, getHighestTierModel } = params;

    this.#roundExecutor.resetRoundStats();

    await this.#roundExecutor.runPromptPhase(round, activeParticipants);
    await this.#roundExecutor.runReflectionPhase(round, activeParticipants);

    if (allowInterjections !== false) {
      await this.#roundExecutor.runInterjectionPhase(round, activeParticipants);
    }

    // Summarize the round
    round.summary = await summarizeRound(round, params.state, promptOrchestrator, getHighestTierModel);

    // Add interjection notes to fabric
    const ijNotes = formatInterjectionNotes(round);

    return { round, ijNotes };
  }
}
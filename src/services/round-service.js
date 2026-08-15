import { RoundExecutor } from "../round-executor.js";
import { summarizeRound } from "../round-summarizer.js";
import { formatTurnOrderNotes } from "../interjection-resolver.js";
import { Logger } from "../logger.js";

/**
 * Handles round execution including prompt phase.
 * Reflections now happen mid-round in runPromptPhase (after each challenge/dissent).
 * Turn order planning is handled separately by the moderator service.
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
   * Runs a complete round: prompt phase (with mid-round reflections).
   * @param {Object} params
   * @param {Object} params.round - Round object to populate
   * @param {Array} params.activeParticipants
   * @param {Function} params.promptOrchestrator
   * @param {Function} params.getHighestTierModel
   * @returns {Promise<Object>} Updated round with summary
   */
   async runRound(params) {
    const { round, activeParticipants, promptOrchestrator, getHighestTierModel } = params;

    this.#roundExecutor.resetRoundStats();

    await this.#roundExecutor.runPromptPhase(round, activeParticipants);
    // Reflections now happen mid-round in runPromptPhase — no separate phase needed

    // Summarize the round
    round.summary = await summarizeRound(round, params.state, promptOrchestrator, getHighestTierModel);

    // Add turn order notes to fabric (empty for now, filled after turn order planning)
    const turnNotes = formatTurnOrderNotes(round, []);

    return { round, turnNotes };
  }
}
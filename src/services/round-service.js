import { RoundExecutor } from "../round-executor.js";
import { summarizeRound } from "../round-summarizer.js";
import { Logger } from "../logger.js";

/**
 * Handles round execution including prompt phase.
 * Reflections now happen mid-round in runPromptPhase (after each challenge/dissent).
 * Turn order planning is handled separately by the moderation module.
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
   * @param {Function} [params.getFallbackModel]
   * @returns {Promise<Object>} Updated round with summary
   */
   async runRound(params) {
    const { round, activeParticipants, promptOrchestrator, getHighestTierModel, getFallbackModel, deadline } = params;

    this.#roundExecutor.resetRoundStats();
    if (Number.isFinite(deadline)) this.#roundExecutor.setDeadline(deadline);

    await this.#roundExecutor.runPromptPhase(round, activeParticipants);

    try {
      round.summary = await summarizeRound(round, params.state, promptOrchestrator, getHighestTierModel, getFallbackModel);
    } catch (err) {
      this.#logger.warn("round_summary_failed", `Round ${round.number} summary failed — using digest fallback`, { error: err?.message ?? String(err) });
      round.summary = "";
    }

    return { round };
  }
}
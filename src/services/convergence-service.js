import { orchestrateConvergence } from "../convergence-orchestrator.js";
import { Logger } from "../logger.js";

/**
 * Handles convergence checking logic.
 * Delegates to the unified convergence protocol with weighted scoring.
 */
export class ConvergenceService {
  /** @type {import("../logger.js").Logger} */
  #logger;

  constructor() {
    this.#logger = new Logger();
  }

  /**
   * Checks convergence using the unified protocol.
   * @param {Object} params
   * @param {Object} params.state - Meeting state
   * @param {Object} params.round - Current round
   * @param {Function} params.promptOrchestrator
   * @param {Function} params.getHighestTierModel
   * @param {Function} [params.postProgress]
   * @returns {Promise<{shouldStop: boolean, extendAmount: number}>} Whether the meeting should stop
   */
  async check(params) {
    const { state, round, promptOrchestrator, getHighestTierModel, postProgress } = params;

    const result = await orchestrateConvergence(
      state,
      round,
      promptOrchestrator,
      getHighestTierModel,
    );

    if (result.shouldStop) {
      this.#logger.info("convergence_reached", "Convergence detected, ending meeting", {
        round: state.current_round,
        status: state.status,
        confidence: result.confidence,
        triggeredBy: result.triggeredBy,
        reason: result.reason,
      });
      if (postProgress) {
        const triggeredList = result.triggeredBy.join(", ");
        const explanation = result.reason || `Triggered by: ${triggeredList}`;
        await postProgress(`Convergence reached: ${explanation}`);
      }
    }

    return {
      shouldStop: result.shouldStop,
      extendAmount: result.extendAmount ?? 0,
    };
  }
}

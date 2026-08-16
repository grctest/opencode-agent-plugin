import { orchestrateConvergence } from "../convergence-orchestrator.js";
import { Logger } from "../logger.js";

/**
 * Handles convergence checking logic.
 * Delegates to the deterministic convergence protocol (all_passed, max_rounds).
 */
export class ConvergenceService {
  /** @type {import("../logger.js").Logger} */
  #logger;

  constructor() {
    this.#logger = new Logger();
  }

  /**
   * Checks convergence using the deterministic protocol.
   * @param {Object} params
   * @param {Object} params.state - Meeting state
   * @param {Object} params.round - Current round
   * @param {Function} [params.postProgress]
   * @returns {Promise<{shouldStop: boolean}>} Whether the meeting should stop
   */
  async check(params) {
    const { state, round, postProgress } = params;

    const result = orchestrateConvergence(state, round);

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
    };
  }
}

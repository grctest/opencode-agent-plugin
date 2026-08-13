import { evolveWarp, compactWarpWithLLM } from "../warp-manager.js";
import { getConfig } from "../config.js";
import { Logger } from "../logger.js";

/**
 * Handles warp context evolution and compaction.
 */
export class WarpService {
  /** @type {import("../logger.js").Logger} */
  #logger;

  constructor() {
    this.#logger = new Logger();
  }

  /**
   * Evolves the warp with a new round summary.
   * @param {string} warp - Current warp
   * @param {Object} round - Round data with summary
   * @param {Function} [compactFn] - Optional LLM compaction function
   * @returns {Promise<string>} Updated warp
   */
  async evolve(warp, round, compactFn) {
    const result = await evolveWarp(warp, round, compactFn);
    return result ?? warp ?? "";
  }

  /**
   * Creates the LLM compaction function bound to the orchestrator.
   * @param {Function} promptOrchestrator
   * @param {Function} getHighestTierModel
   * @returns {Function|null} Compaction function or null if disabled
   */
  createCompactionFunction(promptOrchestrator, getHighestTierModel) {
    if (!getConfig().enableLlmWarpCompaction) {
      return null;
    }
    return async (warp, round) => {
      const model = getHighestTierModel();
      if (!model) return null;
      return compactWarpWithLLM(
        warp,
        round,
        async (system, m, message) => promptOrchestrator(system, m, message, "compaction"),
        model,
      );
    };
  }
}
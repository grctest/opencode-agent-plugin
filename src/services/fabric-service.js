import { evolveFabric, compactFabricWithLLM } from "../fabric-manager.js";
import { getConfig } from "../config.js";
import { Logger } from "../logger.js";

/**
 * Handles fabric context evolution and compaction.
 */
export class FabricService {
  /** @type {import("../logger.js").Logger} */
  #logger;

  constructor() {
    this.#logger = new Logger();
  }

  /**
   * Evolves the fabric with a new round summary.
   * @param {string} fabric - Current fabric
   * @param {Object} round - Round data with summary
   * @param {Function} [compactFn] - Optional LLM compaction function
   * @returns {Promise<string>} Updated fabric
   */
  async evolve(fabric, round, compactFn) {
    const result = await evolveFabric(fabric, round, compactFn);
    return result ?? fabric ?? "";
  }

  /**
   * Creates the LLM compaction function bound to the orchestrator.
   * @param {Function} promptOrchestrator
   * @param {Function} getHighestTierModel
   * @returns {Function|null} Compaction function or null if disabled
   */
  createCompactionFunction(promptOrchestrator, getHighestTierModel) {
    if (!getConfig().enableLlmFabricCompaction) {
      return null;
    }
    return async (fabric, round) => {
      const model = getHighestTierModel();
      if (!model) return null;
      return compactFabricWithLLM(
        fabric,
        round,
        async (system, m, message) => promptOrchestrator(system, m, message, "compaction"),
        model,
      );
    };
  }
}

import { checkModeratorIntervention, parseModeratorRuling, planTurnOrder } from "../moderation.js";
import { getConfig } from "../config.js";
import { Logger } from "../logger.js";

const MAX_RULINGS = 50;

/**
 * Handles moderator intervention logic.
 * Separated from orchestrator for testability and single responsibility.
 */
export class ModeratorService {
  /** @type {import("../logger.js").Logger} */
  #logger;
  /** @type {Array<{round: number, decision: string, next_speaker: string}>} */
  #rulings;

  constructor() {
    this.#logger = new Logger();
    this.#rulings = [];
  }

  /**
   * Checks if moderator intervention is needed and processes the ruling.
   * @param {Object} params
   * @param {Object} params.round - Current round data
   * @param {Array} params.participants - All participants
   * @param {Array} params.weave - All contributions
   * @param {number} params.currentRound
   * @param {number} params.maxRounds
   * @param {Function} params.promptOrchestrator - Function to prompt the orchestrator LLM
   * @param {Function} params.getHighestTierModel - Function to get the highest tier model
   * @param {Function} params.postProgress - Function to post progress messages
   * @param {string} params.stateOfPlay - Current state of play summary
   * @returns {Promise<{action: string, nextSpeakerIdx: number}>}
   */
  async checkAndProcess(params) {
    const {
      round,
      participants,
      weave,
      currentRound,
      maxRounds,
      promptOrchestrator,
      getHighestTierModel,
      postProgress,
      stateOfPlay = "",
    } = params;

    const modDecision = await checkModeratorIntervention(
      round,
      participants,
      weave,
      currentRound,
      maxRounds,
      promptOrchestrator,
      getHighestTierModel,
      this.#rulings,
      stateOfPlay,
    );

    if (modDecision.action === "converge") {
      const minRounds = getConfig().minRounds ?? 2;
      if (currentRound >= minRounds) {
        this.#logger.info("moderator_converge", "Moderator forced convergence", { round: currentRound });
        if (this.#rulings.length >= MAX_RULINGS) this.#rulings.shift();
        this.#rulings.push({ round: currentRound, decision: "Converge deliberation", next_speaker: "synthesize" });
        await postProgress(`🧭 Moderator ends deliberation: converged at round ${currentRound}`);
        return { action: "converge", nextSpeakerIdx: -1 };
      } else {
        this.#logger.info("moderator_converge_deferred", "Moderator converge deferred (minRounds not reached)", { round: currentRound, minRounds });
        await postProgress(`🧭 Moderator wants to end early, but minimum rounds (${minRounds}) not yet reached.`);
      }
    }

    if (modDecision.action === "break" && modDecision.nextSpeakerIdx >= 0) {
      const target = participants[modDecision.nextSpeakerIdx];
      if (target && target.status !== "passed" && target.status !== "failed") {
        this.#logger.info("moderator_break", `Moderator directed ${target.config.name} to speak next`, { round: currentRound });
        if (this.#rulings.length >= MAX_RULINGS) this.#rulings.shift();
        this.#rulings.push({ round: currentRound, decision: `Direct ${target.config.name} to speak`, next_speaker: target.config.id });
        await postProgress(`🧭 Moderator directs ${target.config.name} to speak first next round.`);
        return { action: "break", nextSpeakerIdx: modDecision.nextSpeakerIdx };
      }
    }

    return { action: "continue", nextSpeakerIdx: -1 };
  }

  /**
   * Plans turn order for the next round based on agent [REQUEST_NEXT] tags.
   * @param {Object} params
   * @param {string} params.stateOfPlay - Current state of play
   * @param {string} params.roundSummary - Summary of the completed round
   * @param {Array} params.turnRequests - Array of {participant_id, priority, reason}
   * @param {Array} params.participants - All participants
   * @param {Function} params.promptOrchestrator - Function to prompt the orchestrator LLM
   * @param {Function} params.getHighestTierModel - Function to get the highest tier model
   * @returns {Promise<string[]>} Ordered array of participant IDs
   */
  async planTurnOrder(params) {
    const {
      stateOfPlay,
      roundSummary,
      turnRequests,
      participants,
      promptOrchestrator,
      getHighestTierModel,
    } = params;

    this.#logger.info("turn_order_planning", "Planning turn order for next round", {
      requestCount: turnRequests?.length ?? 0,
    });

    const ordered = await planTurnOrder({
      stateOfPlay,
      roundSummary,
      turnRequests,
      participants,
      promptFn: promptOrchestrator,
      getHighestTierModel,
    });

    this.#logger.info("turn_order_planned", "Turn order planned", {
      order: ordered,
    });

    return ordered;
  }
}
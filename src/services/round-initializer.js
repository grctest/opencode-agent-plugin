import { Logger } from "../logger.js";

const SKIP_PASSED_MIN_ROUND = 3;
const SKIP_PASSED_LOOKBACK = 10;
const SKIP_PASSED_WINDOW = 2;

/**
 * Handles round initialization and participant filtering.
 * Extracted from MeetingOrchestrator for single responsibility.
 */
export class RoundInitializer {
  /** @type {import("../logger.js").Logger} */
  #logger;

  constructor() {
    this.#logger = new Logger();
  }

  /**
   * Creates a new round, persists state, and returns the round object.
   */
  initializeRound(stateManager, database, notifyUpdate) {
    stateManager.incrementRound();
    const round = {
      number: stateManager.getCurrentRound(),
      contributions: [],
      turn_requests: [],
      token_path: [],
      summary: "",
    };
    stateManager.addRound(round);

    notifyUpdate();

    const sharedState = stateManager.buildSharedState();
    database.setFabric(sharedState.fabric);
    database.setRound(sharedState.round);

    return round;
  }

  /**
   * Filters active participants, skipping passed agents with no new reflections
   * and reordering for the next speaker if one is set.
   */
  filterActiveParticipants(stateManager, round) {
    let activeParticipants = stateManager.getActiveParticipants();

    if (round.number >= SKIP_PASSED_MIN_ROUND) {
      const weave = stateManager.getWeave();
      const filtered = activeParticipants.filter((p) => {
        if (p.status !== "passed") return true;
        const recentPasses = weave.slice(-SKIP_PASSED_LOOKBACK).filter(
          (c) => c.participant_id === p.config.id && c.type === "pass"
        );
        if (recentPasses.length === 0) return true;
        const lastPassRound = recentPasses[recentPasses.length - 1].round;
        const roundsSincePass = round.number - lastPassRound;
        if (roundsSincePass > SKIP_PASSED_WINDOW) return true;
        const hasReflection = !!p.reflection;
        return hasReflection;
      });
      if (filtered.length > 0 && filtered.length < activeParticipants.length) {
        this.#logger.info("skip_passed", `Skipping ${activeParticipants.length - filtered.length} passed agents with no new reflections`);
        activeParticipants = filtered;
      }
    }

    // Apply planned turn order if available
    const plannedOrder = stateManager.getPlannedTurnOrder();
    if (plannedOrder.length > 0) {
      // Reorder active participants based on planned order
      const ordered = [];
      const remaining = [...activeParticipants];
      
      for (const id of plannedOrder) {
        const idx = remaining.findIndex(p => p.config.id === id);
        if (idx !== -1) {
          ordered.push(remaining.splice(idx, 1)[0]);
        }
      }
      
      // Add any remaining participants not in the planned order
      ordered.push(...remaining);
      
      if (ordered.length > 0) {
        this.#logger.info("turn_order", `Applied planned turn order: ${plannedOrder.join(', ')}`);
        activeParticipants = ordered;
      }
      
      // Clear the planned order after applying
      stateManager.setPlannedTurnOrder([]);
    } else if (stateManager.getNextSpeakerId()) {
      stateManager.reorderForNextSpeaker(stateManager.getNextSpeakerId());
    }

    return activeParticipants;
  }
}

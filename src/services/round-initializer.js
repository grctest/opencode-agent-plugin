import { Logger } from "../logger.js";

const SKIP_PASSED_MIN_ROUND = 3;
const SKIP_PASSED_LOOKBACK = 10;
const SKIP_PASSED_WINDOW = 2;

/**
 * Handles round initialization, session recreation, and participant filtering.
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
      interjections: [],
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
   * Recreates sessions for participants with dirty, missing, or failed sessions.
   */
  async recreateDirtySessions(stateManager, sessionManager, database, roundExecutor) {
    const dirtyIds = new Set(roundExecutor?.takeDirtySessions() ?? []);
    const needsRecreate = stateManager.getParticipants().filter(
      (p) => !p.session_id || p.status === "failed" || dirtyIds.has(p.config.id),
    );
    for (const p of needsRecreate) {
      const recreated = await sessionManager.recreateSession(p, database);
      if (recreated) {
        if (p.status === "failed") {
          stateManager.setParticipantStatus(p.config.id, "listening");
          database.setParticipantStatus(p.config.id, "listening");
          this.#logger.info("session_retry", `Recreated session for ${p.config.name}, rejoining deliberation`);
        } else {
          this.#logger.info("session_recreated", `Recreated session for ${p.config.name}`);
        }
      } else if (!p.session_id) {
        stateManager.setParticipantStatus(p.config.id, "failed");
        database.setParticipantStatus(p.config.id, "failed");
      }
    }
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
        const recentReflections = (p.reflections || []).filter(
          (r) => r.round > lastPassRound
        );
        return recentReflections.length > 0;
      });
      if (filtered.length > 0 && filtered.length < activeParticipants.length) {
        this.#logger.info("skip_passed", `Skipping ${activeParticipants.length - filtered.length} passed agents with no new reflections`);
        activeParticipants = filtered;
      }
    }

    if (stateManager.getNextSpeakerId()) {
      stateManager.reorderForNextSpeaker(stateManager.getNextSpeakerId());
    }

    return activeParticipants;
  }
}

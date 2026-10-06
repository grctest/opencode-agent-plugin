import { RoundExecutor } from "../round-executor.js";
import { summarizeRound } from "../round-summarizer.js";
import { recordLatency } from "../metrics.js";
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
  #stateManager;

  /**
   * @param {Object} params
   * @param {import("../round-executor.js").RoundExecutor} params.roundExecutor
   */
  constructor({ roundExecutor, stateManager }) {
    this.#roundExecutor = roundExecutor;
    this.#stateManager = stateManager;
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
      const { round, activeParticipants, promptOrchestrator, getHighestTierModel, getFallbackModel, orchestratorConfig } = params;

    this.#roundExecutor.resetRoundStats();
    // N9 — measure the round's span. Without it there is no way to tell a
    // deadline round from a substantive one: deliberation 1355a723's closing
    // round ran 382s against a 1301s peak and nothing in the system said so.
    const startedAt = Date.now();
    round.started_at = new Date(startedAt).toISOString();

    await this.#roundExecutor.runPromptPhase(round, activeParticipants);

    let participantStates = [];
    try {
      participantStates = this.#stateManager?.getParticipantStateSnapshots?.() ?? [];
    } catch (err) {
      this.#logger.warn("round_summary_state_snapshot_failed", `Round ${round.number} agent state snapshot unavailable`, { error: err?.message ?? String(err) });
    }

    // Clerk context (audit O9/Step 5): round position, tier-free roster, and
    // prior SoP excerpt — all already in memory at this call site.
    let summaryOpts = {};
    try {
      const sm = this.#stateManager;
      summaryOpts = {
        maxRounds: typeof sm?.getMaxRounds === "function" ? sm.getMaxRounds() : null,
        roster: typeof sm?.getParticipants === "function"
          ? sm.getParticipants().filter((p) => p?.status !== "failed").map((p) => ({
              id: p?.config?.id, contributions_count: p?.contributions_count ?? 0, status: p?.status,
            }))
          : [],
        stateOfPlay: typeof sm?.getStateOfPlay === "function" ? sm.getStateOfPlay() : "",
      };
    } catch {}
    try {
      round.summary = await summarizeRound(round, params.state, promptOrchestrator, getHighestTierModel, getFallbackModel, participantStates, orchestratorConfig, summaryOpts);
    } catch (err) {
      this.#logger.warn("round_summary_failed", `Round ${round.number} summary failed — using digest fallback`, { error: err?.message ?? String(err) });
      round.summary = "";
    }

    // N9 — the span travels with the round so the closing round can be
    // measured against the median of the rounds that came before it.
    round.span_ms = Date.now() - startedAt;
    try { recordLatency("round_span_ms", round.span_ms); } catch {}
    this.#logger.info("round_span", `Round ${round.number} ran ${Math.round(round.span_ms / 1000)}s`, { round: round.number, span_ms: round.span_ms });

    return { round };
  }
}
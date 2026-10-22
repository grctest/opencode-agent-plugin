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
  #db;

  /**
   * @param {Object} params
   * @param {import("../round-executor.js").RoundExecutor} params.roundExecutor
   * @param {import("../database.js").MeetingDatabase} [params.db] — read-only
   *   surface for the clerk's forum snapshot (optional; tests may omit it).
   */
  constructor({ roundExecutor, stateManager, db = null }) {
    this.#roundExecutor = roundExecutor;
    this.#stateManager = stateManager;
    this.#db = db;
    this.#logger = new Logger();
  }

  /**
   * Runs a complete round: prompt phase (with mid-round reflections).
   * @param {Object} params
   * @param {Object} params.round - Round object to populate
   * @param {Array} params.activeParticipants
   * @param {Function} params.promptOrchestrator
   * @param {Function} params.getDefaultModel
   * @param {Function} [params.getFallbackModel]
   * @returns {Promise<Object>} Updated round with summary
   */
    async runRound(params) {
      const { round, activeParticipants, promptOrchestrator, getDefaultModel, getFallbackModel, orchestratorConfig } = params;

    this.#roundExecutor.resetRoundStats();
    // N9 — measure the round's span. Without it there is no way to tell a
    // deadline round from a substantive one: deliberation 1355a723's closing
    // round ran 382s against a 1301s peak and nothing in the system said so.
    const startedAt = Date.now();
    round.started_at = new Date(startedAt).toISOString();

    // A stopped meeting does not start a round at all, and never runs the
    // clerk: the summary is an LLM call, and a cancelled run must not issue
    // calls the user did not ask for.
    if (this.#roundExecutor.isHalted?.()) {
      this.#logger.info("round_skipped_halted", `Round ${round.number} skipped — the meeting was stopped`, { round: round.number });
      return { round };
    }

    await this.#roundExecutor.runPromptPhase(round, activeParticipants);

    // The clerk is another LLM call — skipped when the run was stopped while
    // the round was in flight.
    if (this.#roundExecutor.isHalted?.()) {
      this.#logger.info("round_summary_skipped_halted", `Round ${round.number} summary skipped — the meeting was stopped`, { round: round.number });
      return { round };
    }

    let participantStates = [];
    try {
      participantStates = this.#stateManager?.getParticipantStateSnapshots?.() ?? [];
    } catch (err) {
      this.#logger.warn("round_summary_state_snapshot_failed", `Round ${round.number} agent state snapshot unavailable`, { error: err?.message ?? String(err) });
    }

    // Clerk context (audit O9/Step 5): round position, category-free roster, and
    // prior SoP excerpt — all already in memory at this call site.
    let summaryOpts = {};
    try {
      const sm = this.#stateManager;
      summaryOpts = {
        maxRounds: typeof sm?.getMaxRounds === "function" ? sm.getMaxRounds() : null,
        // The roster carries the speaking order of THIS round as well as the
        // cumulative counts: the orchestrator is the one who decides who
        // speaks next, and it cannot act on a pattern it cannot see (in the
        // recorded 10-round meeting the same participant opened every round,
        // because the roster never showed it) (audit D).
        roster: typeof sm?.getParticipants === "function"
          ? sm.getParticipants().filter((p) => p?.status !== "failed").map((p) => ({
              id: p?.config?.id, contributions_count: p?.contributions_count ?? 0, status: p?.status,
              // The display name travels with the roster: the clerk is told to
              // pair every [#id] with the holder's NAME, and it can only do
              // that reliably if the name is on screen next to the id — a
              // two-hop lookup under transcript pressure renders raw ids or
              // hallucinated names instead (formatContribution renders id +
              // name together for the same reason).
              name: p?.config?.name,
              spoke_this_round: (round?.contributions ?? []).some((c) => c?.participant_id === p?.config?.id),
              spoke_first: (round?.contributions ?? [])[0]?.participant_id === p?.config?.id,
            }))
          : [],
        stateOfPlay: typeof sm?.getStateOfPlay === "function" ? sm.getStateOfPlay() : "",
        // Forum snapshot taken HERE, not from the prior SoP: the SoP is
        // recomputed after this call, so a thread opened/commented this round
        // would otherwise be invisible to the clerk who should report it.
        forumTopics: this.#db?.listForumTopicsForPrompt?.(5) ?? null,
      };
    } catch {}
    try {
      round.summary = await summarizeRound(round, params.state, promptOrchestrator, getDefaultModel, getFallbackModel, participantStates, orchestratorConfig, summaryOpts);
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
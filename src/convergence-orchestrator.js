import { getConfig } from "./config.js";
import { LOOKBACK } from "./shared.js";
import { checkConvergence, checkSemanticConvergence } from "./convergence-checker.js";
import { Logger, extractErrorInfo } from "./logger.js";

const convergenceLogger = new Logger();

/**
 * Orchestrates convergence checking for a round. Combines heuristic checks from
 * convergence-checker.js with semantic LLM analysis when triggered.
 *
 * Returns { shouldStop: boolean } — whether the meeting should end.
 */
export async function orchestrateConvergence(round, state, promptOrchestrator, getHighestTierModel) {
  const activeCount = state.participants.filter((p) => p.status !== "passed" && p.status !== "failed").length;
  const passedCount = state.participants.filter((p) => p.status === "passed").length;

  const recentContributions = state.weft.slice(-LOOKBACK.CONVERGENCE_RECENT);

  const result = checkConvergence({
    passedCount,
    activeCount,
    totalParticipants: state.participants.length,
    currentRound: state.current_round,
    maxRounds: state.max_rounds,
    convergenceMode: state.convergence_mode,
    contributions: recentContributions,
    rounds: state.rounds,
  });

  state.status = result.status;

  if (result.needsLLMCheck && state.current_round >= (getConfig().convergence.semanticConvergenceFromRound ?? 3)) {
    try {
      const semanticResult = await checkSemanticConvergence(
        {
          contributions: state.weft,
          rounds: state.rounds,
          currentRound: state.current_round,
          maxRounds: state.max_rounds,
          question: state.question,
        },
        async (system, model, message) => promptOrchestrator(system, model, message, "convergence"),
        () => getHighestTierModel(),
      );
      if (semanticResult.shouldStop) {
        state.status = "converged";
        result.shouldStop = true;
        convergenceLogger.info("semantic_convergence", "Semantic convergence detected");
      } else if (semanticResult.action === "extend" && state.max_rounds < 10) {
        state.max_rounds += 1;
        convergenceLogger.info("semantic_extend", "Semantic analysis recommends one more round", { newMax: state.max_rounds });
      }
    } catch (err) {
      const info = extractErrorInfo(err);
      convergenceLogger.warn("convergence_check_failed", "Semantic convergence check failed", info);
    }
  }

  return result.shouldStop;
}

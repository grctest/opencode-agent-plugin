import { Logger } from "./logger.js";

const convergenceLogger = new Logger();

/**
 * Deterministic convergence protocol with 2 checks:
 * 1. all_passed — all participants have passed or failed
 * 2. max_rounds — current round >= max rounds
 *
 * The moderator handles deadlock detection. Max rounds handles termination.
 * Agents handle passing. This protocol only detects early convergence
 * when all agents have passed.
 */
const CONVERGENCE_CHECKS = [
  {
    name: 'all_passed',
    weight: 1.0,
    check: (state) => {
      const activeCount = state.participants.filter(
        (p) => p.status !== "passed" && p.status !== "failed"
      ).length;
      return {
        triggered: activeCount === 0 && state.participants.length > 0,
        confidence: activeCount === 0 ? 100 : 0,
        evidence: { activeCount, totalParticipants: state.participants.length },
      };
    },
  },
  {
    name: 'max_rounds',
    weight: 1.0,
    check: (state) => ({
      triggered: state.current_round >= state.max_rounds,
      confidence: state.current_round >= state.max_rounds ? 100 : 0,
      evidence: { currentRound: state.current_round, maxRounds: state.max_rounds },
    }),
  },
];

/**
 * Deterministic convergence protocol: runs 2 checks and produces a single decision.
 *
 * - all_passed: all participants have passed or failed
 * - max_rounds: current round >= max rounds
 *
 * @param {Object} state - Meeting state
 * @param {Object} round - Current round data
 * @returns {{shouldStop: boolean, confidence: number, triggeredBy: string[], reason: string}}
 */
export function orchestrateConvergence(state, round) {
  const triggered = [];
  let maxConfidence = 0;

  for (const checkDef of CONVERGENCE_CHECKS) {
    const result = checkDef.check(state);

    if (result.triggered) {
      triggered.push(checkDef.name);
      maxConfidence = Math.max(maxConfidence, result.confidence * checkDef.weight);
    }
  }

  const normalizedScore = maxConfidence / 100;
  const shouldStop = normalizedScore >= 0.5;

  const reason = triggered.length > 0
    ? `Triggered by: ${triggered.join(", ")}`
    : "No convergence signals";

  convergenceLogger.info('convergence_evaluated', 'Convergence protocol evaluated', {
    shouldStop,
    score: normalizedScore,
    triggered,
  });

  return {
    shouldStop,
    confidence: normalizedScore,
    triggeredBy: triggered,
    reason,
  };
}

import type { Round, LoomStatus } from "./types.js";

export interface ConvergenceResult {
  shouldStop: boolean;
  status: LoomStatus;
}

/** Checks whether the deliberation should end based on convergence rules and round limits. */
export function checkConvergence(
  passedCount: number,
  activeCount: number,
  totalParticipants: number,
  currentRound: number,
  maxRounds: number,
  convergenceMode: "consensus" | "majority" | "moderator_forces",
): ConvergenceResult {
  if (activeCount === 0) {
    return { shouldStop: true, status: "converged" };
  }

  switch (convergenceMode) {
    case "consensus":
      if (passedCount === totalParticipants) {
        return { shouldStop: true, status: "converged" };
      }
      break;
    case "majority":
      if (passedCount > totalParticipants / 2) {
        return { shouldStop: true, status: "converged" };
      }
      break;
    case "moderator_forces":
      break;
  }

  if (currentRound >= maxRounds) {
    return { shouldStop: true, status: "max_rounds_reached" };
  }

  return { shouldStop: false, status: "weaving" };
}

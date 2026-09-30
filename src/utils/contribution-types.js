/**
 * Single source of truth for contribution type classification (audit 01 E2 / Phase 3).
 * Primary turns are untyped "contribution"; peer responses retain specific types.
 * Any consumer that previously checked legacy types (propose/challenge/...) must
 * use helpers here to avoid drift.
 */

export const CONTRIBUTION_TYPE = {
  CONTRIBUTION: "contribution",
  QUERY_RESPONSE: "query_response",
  PERSPECTIVE_RESPONSE: "perspective_response",
  CRITIQUE_RESPONSE: "critique_response",
  EVIDENCE_RESPONSE: "evidence_response",
  SUMMONED_RESPONSE: "summoned_response",
  VOTE_RESPONSE: "vote_response",
};

// Legacy types from older meetings — treat as contribution for summary/SoP
const LEGACY_SUBSTANTIVE = new Set(["propose", "refine", "support", "synthesize", "question"]);

// Types that carry substantive deliberation positions (for summaries)
// vote_tally removed — outcome lives in invoker's prose, not a separate row
export const SUBSTANTIVE_TYPES = new Set([
  "contribution",
  "query_response",
  "perspective_response",
  "critique_response",
  "evidence_response",
  "summoned_response",
  ...LEGACY_SUBSTANTIVE,
]);

export function isSubstantiveType(type) {
  return SUBSTANTIVE_TYPES.has(type);
}

export function isPassContribution(c) {
  if (!c) return false;
  return c.type === "pass";
}

export function isVoteNoise(c) {
  return c?.type === "vote_response";
}

export function isSystemNoise(c) {
  // Types that should not alone count as substantive deliberation for summary bucket
  return c?.type === "pass" || c?.type === "vote_response" || c?.type === "synthesize" || c?.type === "refuse";
}

// ---------------------------------------------------------------------------
// N12 — mechanism-mix telemetry.
//
// Observation, not a rule. Deliberation 1355a723 saw ballots rise 2 → 16 while
// unresolved objections fell 15 → 3; whether that is a good trade is not
// decidable from one meeting, and a cap on ballot share would have punished a
// legitimate choice (N5 was withdrawn for exactly that reason). So the mix is
// measured per round, next to the objection inventory, and nothing constrains
// it.
// ---------------------------------------------------------------------------

/** Contributions that argue: prose that makes a case to the room. */
export const ARGUMENT_SHAPED_TYPES = new Set([
  "contribution",
  "critique_response",
  "query_response",
  "evidence_response",
  ...LEGACY_SUBSTANTIVE,
]);

/** Contributions that settle: a position taken under a fixed option list. */
export const DECISION_SHAPED_TYPES = new Set(["vote_response"]);

/**
 * Counts argument-shaped against decision-shaped contributions, per round and
 * overall, alongside the objection inventory. Read-only: no caller may use it
 * to gate or steer a meeting.
 * @param {Array<{type: string, round?: number|null}>} weave
 * @param {Array<{round?: number|null, unresolved?: boolean}>} [objections]
 */
export function computeMechanismMix(weave) {
  const byRound = new Map();
  const bucket = (round) => {
    const key = round ?? 0;
    if (!byRound.has(key)) {
      byRound.set(key, { round: key, argument_shaped: 0, decision_shaped: 0, other: 0 });
    }
    return byRound.get(key);
  };
  const totals = { argument_shaped: 0, decision_shaped: 0, other: 0 };
  for (const c of weave ?? []) {
    const row = bucket(c.round);
    if (DECISION_SHAPED_TYPES.has(c.type)) {
      row.decision_shaped++;
      totals.decision_shaped++;
    } else if (ARGUMENT_SHAPED_TYPES.has(c.type)) {
      row.argument_shaped++;
      totals.argument_shaped++;
    } else {
      row.other++;
      totals.other++;
    }
  }
  const decided = totals.argument_shaped + totals.decision_shaped;
  return {
    ...totals,
    // Observed share only — nothing reads this to constrain a turn.
    decision_share: decided > 0 ? Math.round((totals.decision_shaped / decided) * 1000) / 1000 : 0,
    by_round: [...byRound.values()].sort((a, b) => a.round - b.round),
  };
}

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
const LEGACY_SUBSTANTIVE = new Set(["propose", "challenge", "refine", "support", "dissent", "synthesize", "question"]);

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

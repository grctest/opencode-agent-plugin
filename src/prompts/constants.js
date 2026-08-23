/** Shared seniority ordering — civilian ranks at mid per utils/tier.js. */
export const TIER_ORDER = { junior: 0, mid: 1, senior: 2, principal: 3, civilian: 1 };

/** Word/sentence contracts for every contribution type — interpolate, never hardcode. */
export const LENGTH_LIMITS = Object.freeze({
  reflectionWords: "80-150",
  agentProseWords: "120-180",
  codeDiffWords: "150-350",
  querySentences: "2-4",
  evidenceWords: "100-180",
  summonWords: "100-150",
});

// Shared tool-ladder wording — single source of truth so the system-prompt
// ladder and the query/evidence/reflection guidance cannot drift apart.
export const TOOL_LADDER_LINE =
  "loom_vector_search (recall what was said → cheapest) → websearch (verify current fact) → read/grep/glob (verify local file) → webfetch (deep dive ONLY after a search hit)";
export const TOOL_FAILURE_LINE =
  'If tool returns error or 0 hits, write “evidence unavailable — searched X, 0 hits” and proceed with experience-qualified claim. Do not retry same query.';
export const CITATION_LINE =
  "Cite as Source: [#id] or Source: https://… or file=src/... . Synthesize, don’t dump.";

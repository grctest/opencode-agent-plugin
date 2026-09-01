/** Shared seniority ordering — civilian ranks at mid per utils/tier.js. */
export const TIER_ORDER = { junior: 0, mid: 1, senior: 2, principal: 3, civilian: 1 };

/** Word/sentence contracts — generous ranges favouring thoroughness; never cost-cut.
 * Agents may use up to the top of the range; synthesis prefers the upper half.
 * 200k-1M context windows make verbosity cheap — truncations are anti-timeout only. */
export const LENGTH_LIMITS = Object.freeze({
  // Agent prose: thorough deliberation, not terse bullet points
  reflectionWords: "150-300",
  agentProseWords: "350-700",
  codeDiffWords: "300-700",
  querySentences: "3-6",
  evidenceWords: "180-350",
  perspectiveWords: "150-300",
  critiqueWords: "200-400",
  risksWords: "180-350",
  assumptionsWords: "150-300",
  alternativesWords: "180-350",
  summonWords: "150-300",
  // Synthesis: human-first executive summary + detailed audit sections
  synthesisExecutive: "150-250",
  synthesisDecision: "150-350",
  synthesisReasoning: "350-700",
  synthesisProposedFix: "300-800",
  synthesisActionItems: "150-350",
  synthesisDissent: "150-400",
  synthesisOpenQuestions: "100-250",
  synthesisConfidence: "40-80",
});

// Shared tool-ladder wording — single source of truth so the system-prompt
// ladder and the query/evidence/reflection guidance cannot drift apart.
export const TOOL_LADDER_LINE =
  "loom_vector_search (recall what was said → cheapest) → websearch (verify current fact) → read/grep/glob (verify local file + LIVE edits) → webfetch (deep dive ONLY after a search hit) → write/edit (apply fix when in build mode)";
export const TOOL_FAILURE_LINE =
  'If tool returns error or 0 hits, write “evidence unavailable — searched X, 0 hits” and proceed with an experience-qualified claim. Do not retry the identical query; reformulate or acknowledge the gap.';
export const CITATION_LINE =
  "Cite once per evidence block — Source: [#id] or Source: https://… or file=src/... . Group citations; do not spam [#id] per sentence. Synthesize, don’t dump.";

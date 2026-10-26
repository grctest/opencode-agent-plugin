import { LENGTH_LIMITS } from "./constants.js";

/**
 * Single source of truth for loom_query modes.
 *
 * Each mode defines:
 * - contributionType: the stored contribution.type
 * - words:             response-length contract interpolated into prompts
 * - sopBucket:         State-of-Play bucket this mode's answers feed (fabric-manager)
 * - requiresResearch:  whether the responder MUST use a research tool
 * - timeoutMs:         ephemeral prompt timeout for this mode
 * - taskBlock():       One authored task contract rendered in system and user prompts
 * - systemPrompt(t):   shared role wrapper + the mode's task contract
 * - contentPrefix(n,s): contribution content header
 */

const researchTools = () => ({
  webfetch: true,
  websearch: true,
  read: true,
});

/**
 * Ephemeral sub-agent tool map for loom_query targets (all modes except
 * summoned guests). Research tools only — no nested
 * loom_query/loom_vote/loom_summon/loom_pass
 * and no loom_state_patch (patching is primary-tail-only; the asker's tail
 * projects what survives).
 */
const subAgentTools = () => ({
  webfetch: true,
  websearch: true,
  read: true,
});

const PROSE_IS_CONTRIBUTION = ` Your prose IS the contribution — never write "State patched" or "Contribution delivered" in place of the answer.`;

function buildModeSystemPrompt(target, role, taskBlock) {
  return `You are ${target.config.name} (${target.config.category ?? target.config.tier}) — ${role} in Loom. Answer only the directed request, follow its task and output format, and stay grounded and in character. Never emit <<< or >>>.${PROSE_IS_CONTRIBUTION}

## Task
${taskBlock}`;
}

export const QUERY_MODES = {
  clarify: {
    label: "clarify",
    contributionType: "query_response",
    words: `${LENGTH_LIMITS.querySentences} sentences`,
    sopBucket: "keyFacts",
    requiresResearch: false,
    timeoutMs: 60000,
    guidanceKind: "query",
    toolChoice: "auto",
    contentPrefix: (targetName, sourceName) => `[Response to query from ${sourceName}]`,
    taskBlock: () =>
      `Answer in ${LENGTH_LIMITS.querySentences} sentences, no contribution tags ([PROPOSE] etc). Address the specific question; if it’s “what was said”, cite prior [#id] from recent context. If you don’t know, say “insufficient evidence” — do not speculate. Cite Source: [#id] or URL if you use evidence. Stay in character.\nAnswer only what was asked. If the answer is already settled in State of Play, cite its [#id] in one sentence — do not re-derive it.`,
    systemPrompt: (target, guidance = "") =>
      buildModeSystemPrompt(target, "answering a directed query", QUERY_MODES.clarify.taskBlock(guidance)),
  },

  perspective: {
    label: "perspective",
    contributionType: "perspective_response",
    words: LENGTH_LIMITS.perspectiveWords,
    sopBucket: "keyFacts",
    requiresResearch: false,
    timeoutMs: 60000,
    guidanceKind: "reflection",
    toolChoice: "auto",
    contentPrefix: (targetName) => `[Perspective from ${targetName}]`,
    taskBlock: (guidance = "") =>
      `Share your honest perspective on their statement in relation to the question — agreement, disagreement, or a nuanced take. Ground your stance in the deliberation (cite [#id]) or your domain lens. Close with \`Position: [held|revised|expanded] because {one reason}\`.\n${LENGTH_LIMITS.perspectiveWords} words, no contribution tags ([PROPOSE] etc). Stay in character.\nAnswer the specific question asked — do not restate your full position or re-litigate settled points. If you agree and add nothing new, say so in one sentence and close.${guidance ? `\nLens guidance: ${guidance}` : ""}`,
    systemPrompt: (target, guidance = "") =>
      buildModeSystemPrompt(target, "offering a perspective on another participant's statement", QUERY_MODES.perspective.taskBlock(guidance)),
  },

  evidence: {
    label: "evidence",
    contributionType: "evidence_response",
    words: LENGTH_LIMITS.evidenceWords,
    sopBucket: "keyFacts",
    requiresResearch: true,
    timeoutMs: 90000,
    guidanceKind: "evidence",
    toolChoice: "required",
    contentPrefix: (targetName) => `[Evidence from ${targetName}]`,
    taskBlock: () =>
      `You MUST use at least one research tool. No speculation. ${LENGTH_LIMITS.evidenceWords} words.\n\nReport: Finding (1 sentence) + Source (URL or [#id]) + Strength: strong | weak | inconclusive\nIf inconclusive: state why — “0 hits” vs “contradictory sources” — and what would resolve it. Stay in character — translate evidence through your lens.`,
    systemPrompt: (target, guidance = "") =>
      buildModeSystemPrompt(target, "providing evidence", QUERY_MODES.evidence.taskBlock(guidance)),
  },

  critique: {
    label: "critique",
    contributionType: "critique_response",
    words: LENGTH_LIMITS.critiqueWords,
    sopBucket: "disagreements",
    requiresResearch: false,
    timeoutMs: 90000,
    guidanceKind: "reflection",
    toolChoice: "auto",
    contentPrefix: (targetName) => `[Critique from ${targetName}]`,
    taskBlock: () =>
      `Adversarially stress-test the statement above — attack the idea, not the person. Name its weakest assumptions, hidden premises, or concrete failure scenarios; prioritize the objection that would most damage the claim if true. Cite [#id] where possible.\n${LENGTH_LIMITS.critiqueWords} words, no contribution tags. End with: **Most damaging objection:** {one sentence}. Stay in character.`,
    systemPrompt: (target, guidance = "") =>
      buildModeSystemPrompt(target, "critically stress-testing another participant's statement", QUERY_MODES.critique.taskBlock(guidance)),
  },

  risks: {
    label: "risks",
    contributionType: "query_response",
    words: LENGTH_LIMITS.risksWords,
    sopBucket: "openQuestions",
    requiresResearch: false,
    timeoutMs: 90000,
    guidanceKind: "query",
    toolChoice: "auto",
    contentPrefix: (targetName) => `[Risk analysis by ${targetName}]`,
    taskBlock: () =>
      `Enumerate the concrete ways the proposal/statement above could fail or backfire — second-order effects, costs, edge cases, adoption blockers. For each risk: one-line description + severity (high/med/low) + mitigation if obvious.\n${LENGTH_LIMITS.risksWords} words, no contribution tags. Stay in character.`,
    systemPrompt: (target, guidance = "") =>
      buildModeSystemPrompt(target, "analyzing risks in another participant's statement", QUERY_MODES.risks.taskBlock(guidance)),
  },

  assumptions: {
    label: "assumptions",
    contributionType: "query_response",
    words: LENGTH_LIMITS.assumptionsWords,
    sopBucket: "openQuestions",
    requiresResearch: false,
    timeoutMs: 90000,
    guidanceKind: "query",
    toolChoice: "auto",
    contentPrefix: (targetName) => `[Assumptions surfaced by ${targetName}]`,
    taskBlock: () =>
      `List the unstated assumptions the statement above depends on. For each: state it plainly, mark whether it is load-bearing (if wrong, the claim collapses), and how it could be tested cheaply.\n${LENGTH_LIMITS.assumptionsWords} words, no contribution tags. Stay in character.`,
    systemPrompt: (target, guidance = "") =>
      buildModeSystemPrompt(target, "surfacing assumptions in another participant's statement", QUERY_MODES.assumptions.taskBlock(guidance)),
  },

  alternatives: {
    label: "alternatives",
    contributionType: "query_response",
    words: LENGTH_LIMITS.alternativesWords,
    sopBucket: "keyFacts",
    requiresResearch: false,
    timeoutMs: 60000,
    guidanceKind: "query",
    toolChoice: "auto",
    contentPrefix: (targetName) => `[Alternatives proposed by ${targetName}]`,
    taskBlock: () =>
      `Propose 1-3 genuinely different approaches to the problem the statement raises — not refinements of it. For each alternative: one line describing the approach + its main tradeoff versus the statement above.\n${LENGTH_LIMITS.alternativesWords} words, no contribution tags. Stay in character.`,
    systemPrompt: (target, guidance = "") =>
      buildModeSystemPrompt(target, "proposing alternatives to another participant's statement", QUERY_MODES.alternatives.taskBlock(guidance)),
  },
};

/** Mode enum values for tool schemas / zod. */
export const QUERY_MODE_NAMES = Object.keys(QUERY_MODES);

/** Research-tool allowlist map offered to responders (shared across modes). */
export { researchTools, subAgentTools };

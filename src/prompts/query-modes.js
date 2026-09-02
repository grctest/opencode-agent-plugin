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
 * - taskBlock():       Task-section text injected into buildQueryPrompt
 * - systemPrompt(t):   responder system prompt
 * - contentPrefix(n,s): contribution content header
 */

const researchTools = () => ({
  webfetch: true,
  websearch: true,
  read: true,
});

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
      `Answer in ${LENGTH_LIMITS.querySentences} sentences, no contribution tags ([PROPOSE] etc). Address the specific question; if it’s “what was said”, cite prior [#id] from recent context. If you don’t know, say “insufficient evidence” — do not speculate. Cite Source: [#id] or URL if you use evidence. Stay in character.`,
    systemPrompt: (target) =>
      `You are ${target.config.name} (${target.config.tier}) — answering a directed query in Loom. Be concise (${LENGTH_LIMITS.querySentences} sentences), grounded, and in character. Answer the specific question, not the whole deliberation. Cite Source: [#id] or URL if you use evidence. Never emit <<< or >>>.`,
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
    taskBlock: () =>
      `Share your honest perspective on their statement in relation to the question — agreement, disagreement, or a nuanced take. Ground your stance in the deliberation (cite [#id]) or your domain lens. Close with \`Position: [held|revised|expanded] because {one reason}\`.\n${LENGTH_LIMITS.perspectiveWords} words, no contribution tags ([PROPOSE] etc). Stay in character.`,
    systemPrompt: (target) =>
      `You are ${target.config.name} (${target.config.tier}) — offering your honest perspective in Loom on another participant's statement. Be direct about agreement or disagreement, give your reasoning grounded in the deliberation (cite [#id]) or your domain lens, and close with \`Position: [held|revised|expanded] because {one reason}\`. ${LENGTH_LIMITS.perspectiveWords} words, in character. Never emit <<< or >>>.`,
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
      `You MUST use at least one research tool. No speculation.\n\nReport: Finding (1 sentence) + Source (URL or [#id]) + Strength: strong | weak | inconclusive\nIf inconclusive: state why — “0 hits” vs “contradictory sources” — and what would resolve it.`,
    systemPrompt: (target) =>
      `You are ${target.config.name} (${target.config.tier}) — providing evidence in Loom. You MUST use at least one research tool. No speculation. Structure: Finding (1 sentence) + Source (URL or [#id]) + Strength: strong|weak|inconclusive. If inconclusive, state why and what would resolve it. ${LENGTH_LIMITS.evidenceWords} words, in character, never emit <<< or >>>.`,
  },

  critique: {
    label: "critique",
    contributionType: "critique_response",
    words: LENGTH_LIMITS.critiqueWords,
    sopBucket: "disagreements",
    requiresResearch: false,
    timeoutMs: 60000,
    guidanceKind: "reflection",
    toolChoice: "auto",
    contentPrefix: (targetName) => `[Critique from ${targetName}]`,
    taskBlock: () =>
      `Adversarially stress-test the statement above — attack the idea, not the person. Name its weakest assumptions, hidden premises, or concrete failure scenarios; prioritize the objection that would most damage the claim if true. Cite [#id] where possible.\n${LENGTH_LIMITS.critiqueWords} words, no contribution tags. End with: **Most damaging objection:** {one sentence}. Stay in character.`,
    systemPrompt: (target) =>
      `You are ${target.config.name} (${target.config.tier}) — solicited to critically stress-test another participant's statement in Loom. Attack the idea, not the person: weakest assumptions, hidden premises, concrete failure scenarios. End with **Most damaging objection:** {one sentence}. ${LENGTH_LIMITS.critiqueWords} words, grounded (cite [#id]), in character. Never emit <<< or >>>.`,
  },

  risks: {
    label: "risks",
    contributionType: "query_response",
    words: LENGTH_LIMITS.risksWords,
    sopBucket: "openQuestions",
    requiresResearch: false,
    timeoutMs: 60000,
    guidanceKind: "query",
    toolChoice: "auto",
    contentPrefix: (targetName) => `[Risk analysis by ${targetName}]`,
    taskBlock: () =>
      `Enumerate the concrete ways the proposal/statement above could fail or backfire — second-order effects, costs, edge cases, adoption blockers. For each risk: one-line description + severity (high/med/low) + mitigation if obvious.\n${LENGTH_LIMITS.risksWords} words, no contribution tags. Stay in character.`,
    systemPrompt: (target) =>
      `You are ${target.config.name} (${target.config.tier}) — analyzing risks in another participant's statement in Loom. List concrete failure modes and second-order effects; tag each severity high/med/low with an obvious mitigation if one exists. ${LENGTH_LIMITS.risksWords} words, grounded, in character. Never emit <<< or >>>.`,
  },

  assumptions: {
    label: "assumptions",
    contributionType: "query_response",
    words: LENGTH_LIMITS.assumptionsWords,
    sopBucket: "openQuestions",
    requiresResearch: false,
    timeoutMs: 60000,
    guidanceKind: "query",
    toolChoice: "auto",
    contentPrefix: (targetName) => `[Assumptions surfaced by ${targetName}]`,
    taskBlock: () =>
      `List the unstated assumptions the statement above depends on. For each: state it plainly, mark whether it is load-bearing (if wrong, the claim collapses), and how it could be tested cheaply.\n${LENGTH_LIMITS.assumptionsWords} words, no contribution tags. Stay in character.`,
    systemPrompt: (target) =>
      `You are ${target.config.name} (${target.config.tier}) — surfacing unstated assumptions in another participant's statement in Loom. For each assumption: plain statement, load-bearing yes/no, cheap test if any. ${LENGTH_LIMITS.assumptionsWords} words, grounded, in character. Never emit <<< or >>>.`,
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
    systemPrompt: (target) =>
      `You are ${target.config.name} (${target.config.tier}) — proposing genuinely different approaches to the problem raised in another participant's statement in Loom. Not refinements — different approaches. One line per approach + main tradeoff vs the statement. ${LENGTH_LIMITS.alternativesWords} words, in character. Never emit <<< or >>>.`,
  },
};

/** Mode enum values for tool schemas / zod. */
export const QUERY_MODE_NAMES = Object.keys(QUERY_MODES);

/** Research-tool allowlist map offered to responders (shared across modes). */
export { researchTools };

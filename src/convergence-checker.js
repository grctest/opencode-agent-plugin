import { CONFIG } from "./config.js";
import { LOOKBACK } from "./shared.js";

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "both",
  "each", "few", "more", "most", "other", "some", "such", "no", "nor",
  "not", "only", "own", "same", "so", "than", "too", "very", "just",
  "because", "but", "and", "or", "if", "while", "about", "up", "that",
  "this", "these", "those", "it", "its", "i", "we", "you", "they", "he",
  "she", "my", "your", "their", "our", "his", "her", "me", "them", "us",
]);

function fingerprint(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/);
  const meaningful = words.filter((w) => w.length > 3 && !STOPWORDS.has(w));
  return new Set(meaningful);
}

function overlapFraction(setA, setB) {
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  return intersection / Math.min(setA.size, setB.size);
}

function detectRepetition(contributions) {
  const window = LOOKBACK.CONVERGENCE_REPETITION_WINDOW;
  if (contributions.length < window) return false;
  const recent = contributions.slice(-window);
  const fingerprints = recent.map((c) => fingerprint(c.content));

  const threshold = CONFIG.convergence.repetitionOverlapThreshold;
  for (let i = 0; i < fingerprints.length; i++) {
    for (let j = i + 1; j < fingerprints.length; j++) {
      if (overlapFraction(fingerprints[i], fingerprints[j]) <= threshold) {
        return false;
      }
    }
  }
  return true;
}

function detectNegationOverlap(contentA, contentB) {
  const negationWords = ["not", "no", "never", "don't", "doesn't", "won't", "can't", "shouldn't", "isn't", "aren't", "wasn't", "weren't"];
  const wordsA = contentA.toLowerCase().split(/\s+/);
  const wordsB = contentB.toLowerCase().split(/\s+/);

  const negatedA = new Set();
  const negatedB = new Set();

  for (let i = 0; i < wordsA.length; i++) {
    if (negationWords.includes(wordsA[i]) && i + 1 < wordsA.length) {
      negatedA.add(wordsA[i + 1].replace(/[^a-z0-9]/g, ""));
    }
  }
  for (let i = 0; i < wordsB.length; i++) {
    if (negationWords.includes(wordsB[i]) && i + 1 < wordsB.length) {
      negatedB.add(wordsB[i + 1].replace(/[^a-z0-9]/g, ""));
    }
  }

  if (negatedA.size === 0 && negatedB.size === 0) return false;

  for (const word of negatedA) {
    if (!negatedB.has(word)) {
      const fpA = fingerprint(contentA);
      const fpB = fingerprint(contentB);
      if (overlapFraction(fpA, fpB) > 0.6) {
        return true;
      }
    }
  }
  return false;
}

function detectDiminishingReturns(rounds) {
  const window = CONFIG.convergence.diminishingReturnsWindow;
  if (rounds.length < window) return false;
  const recentTypes = rounds.slice(-window).map((r) => {
    const types = new Set();
    for (const c of r.contributions) types.add(c.type);
    return types;
  });

  const allTypes = new Set();
  for (const typeSet of recentTypes) {
    for (const t of typeSet) allTypes.add(t);
  }

  const previousTypes = new Set();
  for (let i = 0; i < rounds.length - window; i++) {
    for (const c of rounds[i].contributions) previousTypes.add(c.type);
  }

  let newTypeFound = false;
  for (const t of allTypes) {
    if (!previousTypes.has(t)) {
      newTypeFound = true;
      break;
    }
  }

  return !newTypeFound;
}

function detectStaleParticipants(rounds, totalParticipants) {
  if (rounds.length < 3) return false;
  const lastThree = rounds.slice(-3);
  const activeParticipants = new Set();
  for (const round of lastThree) {
    for (const c of round.contributions) {
      activeParticipants.add(c.participant_id);
    }
  }
  return activeParticipants.size <= Math.ceil(totalParticipants / 3);
}

/**
 * @typedef {Object} ConvergenceInput
 * @property {number} passedCount
 * @property {number} activeCount
 * @property {number} totalParticipants
 * @property {number} currentRound
 * @property {number} maxRounds
 * @property {"consensus" | "majority" | "moderator_forces"} convergenceMode
 * @property {import("./types.js").Contribution[]} contributions
 * @property {import("./types.js").Round[]} rounds
 */

/**
 * @typedef {Object} ConvergenceResult
 * @property {boolean} shouldStop
 * @property {import("./types.js").LoomStatus} status
 * @property {boolean} needsLLMCheck
 */

/** Checks whether the deliberation should end based on convergence rules and round limits. */
export function checkConvergence(input) {
  const {
    passedCount,
    activeCount,
    totalParticipants,
    currentRound,
    maxRounds,
    convergenceMode,
    contributions,
    rounds,
  } = input;

  if (activeCount === 0) {
    return { shouldStop: true, status: "converged", needsLLMCheck: false };
  }

  if (currentRound < 2) {
    return { shouldStop: false, status: "weaving", needsLLMCheck: false };
  }

  if (detectRepetition(contributions)) {
    return { shouldStop: true, status: "converged", needsLLMCheck: false };
  }

  const recentContribs = contributions.slice(-LOOKBACK.CONVERGENCE_RECENT);
  for (let i = 0; i < recentContribs.length; i++) {
    for (let j = i + 1; j < recentContribs.length; j++) {
      if (detectNegationOverlap(recentContribs[i].content, recentContribs[j].content)) {
        return { shouldStop: false, status: "weaving", needsLLMCheck: true };
      }
    }
  }

  if (rounds.length >= 3 && detectDiminishingReturns(rounds)) {
    return { shouldStop: false, status: "weaving", needsLLMCheck: true };
  }

  if (rounds.length >= 3 && detectStaleParticipants(rounds, totalParticipants)) {
    return { shouldStop: false, status: "weaving", needsLLMCheck: true };
  }

  switch (convergenceMode) {
    case "consensus":
      if (passedCount === totalParticipants) {
        return { shouldStop: true, status: "converged", needsLLMCheck: false };
      }
      break;
    case "majority":
      if (passedCount > totalParticipants / 2) {
        return { shouldStop: true, status: "converged", needsLLMCheck: false };
      }
      break;
    case "moderator_forces":
      break;
  }

  if (currentRound >= maxRounds) {
    return { shouldStop: true, status: "max_rounds_reached", needsLLMCheck: false };
  }

  if (currentRound >= 4 && activeCount <= Math.ceil(totalParticipants / 2)) {
    return { shouldStop: false, status: "weaving", needsLLMCheck: true };
  }

  return { shouldStop: false, status: "weaving", needsLLMCheck: false };
}

export async function checkSemanticConvergence(input, promptFn, getModel) {
  const { contributions, rounds, currentRound, maxRounds, question } = input;

  if (contributions.length < 4) {
    return { shouldStop: false, reason: "Not enough contributions to assess" };
  }

  const recentContribs = contributions.slice(-Math.min(10, contributions.length));
  const contributionsText = recentContribs
    .map((c) => `- [${c.participant_id}] (${c.type}): ${c.content.slice(0, 200)}`)
    .join("\n");

  const roundSummaries = rounds.slice(-3).map((r) =>
    `Round ${r.number}: ${r.summary || "No summary"}`
  ).join("\n");

  const prompt = `You are evaluating whether a multi-agent deliberation has reached a natural conclusion.

## Original Question
${question}

## Deliberation State
Round: ${currentRound}/${maxRounds}
Total contributions: ${contributions.length}

## Recent Round Summaries
${roundSummaries}

## Most Recent Contributions
${contributionsText}

## Task
Assess whether this deliberation has converged. Answer with ONE of:
- "CONTINUE" — if participants are still generating new ideas or meaningfully developing positions
- "CONVERGE" — if participants are repeating positions, going in circles, or have naturally exhausted the discussion

Then provide a one-sentence reason for your assessment.

Format exactly:
verdict: CONTINUE or CONVERGE
reason: <one sentence>`;

  try {
    const model = getModel();
    if (!model) return { shouldStop: false, reason: "No model available for semantic check" };
    const result = await promptFn(
      "You are a deliberation analyst. Assess whether a discussion has naturally converged.",
      model,
      prompt,
    );

    const lines = result.trim().split("\n");
    let verdict = "";
    let reason = "";

    for (const line of lines) {
      const lower = line.toLowerCase().trim();
      if (lower.startsWith("verdict:")) {
        verdict = line.substring(line.indexOf(":") + 1).trim().toUpperCase();
      } else if (lower.startsWith("reason:")) {
        reason = line.substring(line.indexOf(":") + 1).trim();
      }
    }

    if (verdict === "CONVERGE") {
      return { shouldStop: true, reason: reason || "Semantic convergence detected" };
    }
    return { shouldStop: false, reason: reason || "Discussion still productive" };
  } catch (err) {
    return { shouldStop: false, reason: `Semantic check failed: ${err instanceof Error ? err.message : "unknown"}` };
  }
}

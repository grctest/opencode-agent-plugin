import { CONFIG } from "./config.js";

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
  const window = CONFIG.convergence.repetitionWindow;
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

/**
 * @typedef {Object} ConvergenceResult
 * @property {boolean} shouldStop
 * @property {import("./types.js").LoomStatus} status
 */

/** Checks whether the deliberation should end based on convergence rules and round limits. */
export function checkConvergence(
  passedCount,
  activeCount,
  totalParticipants,
  currentRound,
  maxRounds,
  convergenceMode,
  contributions = [],
  rounds = [],
) {
  if (activeCount === 0) {
    return { shouldStop: true, status: "converged" };
  }

  if (detectRepetition(contributions)) {
    return { shouldStop: true, status: "converged" };
  }

  if (rounds.length >= 2 && detectDiminishingReturns(rounds)) {
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

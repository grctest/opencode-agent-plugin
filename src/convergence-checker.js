import { getConfig } from "./config.js";
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

function computeTfidfVector(text, idf) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/);
  const meaningful = words.filter((w) => w.length > 3 && !STOPWORDS.has(w));
  const termFreq = {};
  for (const w of meaningful) {
    termFreq[w] = (termFreq[w] || 0) + 1;
  }
  const vec = {};
  for (const [term, freq] of Object.entries(termFreq)) {
    const idfVal = idf[term] || 1;
    vec[term] = freq * idfVal;
  }
  return vec;
}

function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  const allTerms = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);
  for (const term of allTerms) {
    const a = vecA[term] || 0;
    const b = vecB[term] || 0;
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function buildIdf(contributions) {
  const docCount = contributions.length;
  const docFreq = {};
  for (const c of contributions) {
    const words = fingerprint(c.content);
    for (const w of words) {
      docFreq[w] = (docFreq[w] || 0) + 1;
    }
  }
  const idf = {};
  for (const [term, freq] of Object.entries(docFreq)) {
    idf[term] = Math.log((docCount + 1) / (freq + 1)) + 1;
  }
  return idf;
}

function detectSemanticRepetition(contributions, window, threshold) {
  if (contributions.length < window) return false;
  const recent = contributions.slice(-window);
  const idf = buildIdf(contributions);
  const vectors = recent.map((c) => computeTfidfVector(c.content, idf));

  let highSimilarityPairs = 0;
  const totalPairs = (vectors.length * (vectors.length - 1)) / 2;

  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const sim = cosineSimilarity(vectors[i], vectors[j]);
      if (sim >= threshold) {
        highSimilarityPairs++;
      }
    }
  }

  return highSimilarityPairs / totalPairs >= 0.5;
}

function detectContentDiversity(rounds, window) {
  if (rounds.length < window) return true;

  const recentRounds = rounds.slice(-window);
  const allRecentContent = recentRounds
    .flatMap((r) => r.contributions)
    .map((c) => c.content)
    .join(" ");

  const olderRounds = rounds.slice(0, -window);
  const allOlderContent = olderRounds
    .flatMap((r) => r.contributions)
    .map((c) => c.content)
    .join(" ");

  if (allOlderContent.length === 0) return true;

  const idf = buildIdf(
    rounds.flatMap((r) => r.contributions).map((c) => ({ content: c.content }))
  );

  const recentVec = computeTfidfVector(allRecentContent, idf);
  const olderVec = computeTfidfVector(allOlderContent, idf);

  const similarity = cosineSimilarity(recentVec, olderVec);

  return similarity < 0.85;
}

function detectStaleParticipants(rounds, totalParticipants) {
  const config = getConfig();
  const ratio = config.convergence.staleParticipantRatio;

  if (rounds.length < 3) return false;
  const lastThree = rounds.slice(-3);
  const activeParticipants = new Set();
  for (const round of lastThree) {
    for (const c of round.contributions) {
      activeParticipants.add(c.participant_id);
    }
  }
  return activeParticipants.size <= Math.ceil(totalParticipants * ratio);
}

function detectDiminishingReturns(rounds) {
  if (rounds.length < 3) return false;

  const counts = rounds.map((r) => r.contributions.length);
  const recent = counts.slice(-2);
  const previous = counts.slice(0, -2);
  if (previous.length === 0) return false;

  const prevAvg = previous.reduce((a, b) => a + b, 0) / previous.length;
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;

  return prevAvg > 0 && recentAvg <= prevAvg * 0.5;
}

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

  const config = getConfig();

  if (activeCount === 0) {
    return { shouldStop: true, status: "converged", needsLLMCheck: false, confidence: 100 };
  }

  if (currentRound < 2) {
    return { shouldStop: false, status: "weaving", needsLLMCheck: false, confidence: 0 };
  }

  if (currentRound === 2 && activeCount > 0 && passedCount >= activeCount) {
    return { shouldStop: true, status: "converged", needsLLMCheck: false, confidence: 80 };
  }

  if (detectSemanticRepetition(contributions, config.convergence.repetitionWindow, config.convergence.repetitionOverlapThreshold)) {
    return { shouldStop: true, status: "converged", needsLLMCheck: false, confidence: 80 };
  }

  if (rounds.length >= config.convergence.diminishingReturnsWindow && !detectContentDiversity(rounds, config.convergence.diminishingReturnsWindow)) {
    return { shouldStop: false, status: "weaving", needsLLMCheck: true, confidence: 60 };
  }

  if (rounds.length >= 3 && detectStaleParticipants(rounds, totalParticipants)) {
    return { shouldStop: false, status: "weaving", needsLLMCheck: true, confidence: 50 };
  }

  if (rounds.length >= 3 && detectDiminishingReturns(rounds)) {
    return { shouldStop: false, status: "weaving", needsLLMCheck: true, confidence: 55 };
  }

  switch (convergenceMode) {
    case "consensus":
      if (passedCount === totalParticipants) {
        return { shouldStop: true, status: "converged", needsLLMCheck: false, confidence: 100 };
      }
      break;
    case "majority":
      if (passedCount > totalParticipants / 2) {
        return { shouldStop: true, status: "converged", needsLLMCheck: false, confidence: 90 };
      }
      break;
    case "moderator_forces":
      if (currentRound >= config.convergence.moderatorForcesMinRound && passedCount >= activeCount && activeCount > 0) {
        return { shouldStop: true, status: "converged", needsLLMCheck: false, confidence: 85 };
      }
      if (currentRound >= config.convergence.moderatorForcesHalfActiveRound && activeCount <= Math.ceil(totalParticipants / 2)) {
        return { shouldStop: false, status: "weaving", needsLLMCheck: true, confidence: 55 };
      }
      break;
  }

  if (currentRound >= maxRounds) {
    return { shouldStop: true, status: "max_rounds_reached", needsLLMCheck: false, confidence: 100 };
  }

  if (currentRound >= 4 && activeCount <= Math.ceil(totalParticipants / 2)) {
    return { shouldStop: false, status: "weaving", needsLLMCheck: true, confidence: 40 };
  }

  return { shouldStop: false, status: "weaving", needsLLMCheck: false, confidence: 0 };
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
Decide whether this deliberation should continue or converge. Consider:
- Are participants repeating positions from earlier rounds without new reasoning?
- Is new information or meaningful reasoning still being introduced?
- Has the discussion naturally exhausted its productive potential?

Respond with EXACTLY this format:
decision: <converge | continue | extend>
reason: <one sentence explanation>
key_disagreements: <comma-separated list of unresolved disagreements, or "none">

Guidelines:
- "converge" = productive discussion is done, synthesize now
- "continue" = meaningful development is still happening
- "extend" = close but needs one more round to resolve key disagreements`;

  try {
    const model = getModel();
    if (!model) return { shouldStop: false, reason: "No model available for semantic check" };
    const result = await promptFn(
      "You are a deliberation analyst. Assess whether a discussion has naturally converged.",
      model,
      prompt,
    );

    const lines = result.trim().split("\n");
    let decision = "continue";
    let reason = "";

    for (const line of lines) {
      const lower = line.toLowerCase().trim();
      if (lower.startsWith("decision:")) {
        const val = line.substring(line.indexOf(":") + 1).trim().toLowerCase();
        if (val === "converge" || val === "continue" || val === "extend") {
          decision = val;
        }
      } else if (lower.startsWith("reason:")) {
        reason = line.substring(line.indexOf(":") + 1).trim();
      }
    }

    if (decision === "converge") {
      return { shouldStop: true, reason: reason || "Discussion has naturally converged", action: "converge" };
    }
    if (decision === "extend") {
      return { shouldStop: false, reason: reason || "Close but needs one more round", action: "extend" };
    }
    return { shouldStop: false, reason: reason || "Discussion still productive", action: "continue" };
  } catch (err) {
    return { shouldStop: false, reason: `Semantic check failed: ${err instanceof Error ? err.message : "unknown"}`, action: "continue" };
  }
}

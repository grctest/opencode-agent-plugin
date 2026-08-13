import { getConfig } from "./config.js";
import { Logger, extractErrorInfo } from "./logger.js";
import { tokenizeMeaningful, computeTfidfVector, cosineSimilarity, buildIdf } from "./utils/nlp.js";

const convergenceLogger = new Logger();

/**
 * Detects stalled discussion: the LAST contribution of each of the last two rounds is
 * highly similar (>= threshold) to the preceding context, meaning agents are rehashing
 * the same point round after round rather than introducing new information.
 */
function detectLowNoveltyAcrossRounds(rounds, windowSize, threshold) {
  if (rounds.length < 3) return false;
  const pool = [];
  let lowNoveltyRounds = 0;

  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    if (i >= rounds.length - 2) {
      if (r.contributions.length === 0) {
        continue;
      }
      const last = r.contributions[r.contributions.length - 1];
      const candidates = pool.slice(-windowSize);
      if (candidates.length >= 3) {
        const idf = buildIdf([...candidates, last]);
        const lastVec = computeTfidfVector(last.content, idf);
        let maxSim = 0;
        for (const c of candidates) {
          maxSim = Math.max(maxSim, cosineSimilarity(lastVec, computeTfidfVector(c.content, idf)));
        }
        if (maxSim >= threshold) lowNoveltyRounds++;
      }
    }
    for (const c of r.contributions) pool.push(c);
  }

  return lowNoveltyRounds >= 2;
}

function detectContentDiversity(rounds, window, threshold = 0.85) {
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

  return similarity < threshold;
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

function detectDiminishingReturns(rounds, multiplier = 0.5) {
  if (rounds.length < 3) return false;

  const counts = rounds.map((r) => r.contributions.length);
  const recent = counts.slice(-2);
  const previous = counts.slice(0, -2);
  if (previous.length === 0) return false;

  const prevAvg = previous.reduce((a, b) => a + b, 0) / previous.length;
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;

  return prevAvg > 0 && recentAvg <= prevAvg * multiplier;
}

/**
 * Unified convergence checks. Each check returns:
 * { triggered: boolean, confidence: number, evidence?: any, reason?: string }
 * Confidence is 0-100 representing how sure we are this condition indicates convergence.
 */
const CONVERGENCE_CHECKS = [
  {
    name: 'all_passed',
    weight: 1.0,
    alwaysRun: true,
    check: (state) => {
      const activeCount = state.participants.filter(
        (p) => p.status !== "passed" && p.status !== "failed"
      ).length;
      return {
        triggered: activeCount === 0 && state.participants.length > 0,
        confidence: activeCount === 0 ? 100 : 0,
        evidence: { activeCount, totalParticipants: state.participants.length },
      };
    },
  },
  {
    name: 'max_rounds',
    weight: 1.0,
    alwaysRun: true,
    check: (state) => ({
      triggered: state.current_round >= state.max_rounds,
      confidence: state.current_round >= state.max_rounds ? 100 : 0,
      evidence: { currentRound: state.current_round, maxRounds: state.max_rounds },
    }),
  },
  {
    name: 'early_convergence',
    weight: 0.8,
    minRound: 2,
    check: (state) => {
      const passedCount = state.participants.filter((p) => p.status === "passed").length;
      const activeCount = state.participants.filter(
        (p) => p.status !== "passed" && p.status !== "failed"
      ).length;
      const confidence = getConfig().convergence.allPassedConfidence;
      return {
        triggered: passedCount >= activeCount && activeCount > 0 && state.current_round >= 2,
        confidence: passedCount >= activeCount ? confidence : 0,
        evidence: { passedCount, activeCount },
      };
    },
  },
  {
    name: 'low_novelty',
    weight: 0.8,
    minRound: 3,
    check: (state) => {
      const config = getConfig().convergence;
      const triggered = detectLowNoveltyAcrossRounds(
        state.rounds, config.repetitionWindow, config.lowNoveltyCosineThreshold
      );
      return {
        triggered,
        confidence: triggered ? config.semanticConfidence : 0,
        evidence: {
          repetitionWindow: config.repetitionWindow,
          threshold: config.lowNoveltyCosineThreshold,
          rounds: state.rounds.length,
        },
      };
    },
  },
  {
    name: 'diminishing_returns',
    weight: 0.6,
    minRound: 3,
    check: (state) => {
      const config = getConfig().convergence;
      const triggered =
        state.rounds.length >= config.diminishingReturnsWindow &&
        !detectContentDiversity(state.rounds, config.diminishingReturnsWindow);
      return {
        triggered,
        confidence: triggered ? config.stalemateConfidence : 0,
        evidence: { window: config.diminishingReturnsWindow },
      };
    },
  },
  {
    name: 'stale_participants',
    weight: 0.5,
    minRound: 3,
    check: (state) => {
      const triggered = detectStaleParticipants(state.rounds, state.participants.length);
      const activeCount = state.participants.filter(
        (p) => p.status !== "passed" && p.status !== "failed"
      ).length;
      return {
        triggered,
        confidence: triggered ? 50 : 0,
        evidence: { 
          staleParticipantRatio: getConfig().convergence.staleParticipantRatio,
          activeCount 
        },
      };
    },
  },
  {
    name: 'diminishing_contributions',
    weight: 0.55,
    minRound: 3,
    check: (state) => {
      const triggered = detectDiminishingReturns(state.rounds);
      return {
        triggered,
        confidence: triggered ? 55 : 0,
        evidence: { contributionDrop: triggered },
      };
    },
  },
  {
    name: 'semantic',
    weight: 0.9,
    minRound: 3,
    requiresLLM: true,
    check: async (state, promptFn, getHighestTierModel) => {
      const config = getConfig().convergence;
      const recentContribs = state.weft.slice(-Math.min(10, state.weft.length));
      if (recentContribs.length < 4) {
        return { triggered: false, confidence: 0, reason: 'not_enough_contributions' };
      }

      const contributionsText = recentContribs
        .map((c) => `- [${c.participant_id}] (${c.type}): ${c.content.slice(0, 200)}`)
        .join("\n");

      const roundSummaries = state.rounds.slice(-3).map((r) =>
        `Round ${r.number}: ${r.summary || "No summary"}`
      ).join("\n");

      const prompt = `You are evaluating whether a multi-agent deliberation has reached a natural conclusion.

## Original Question
${state.question}

## Deliberation State
Round: ${state.current_round}/${state.max_rounds}
Total contributions: ${state.weft.length}

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
        const model = getHighestTierModel();
        if (!model) return { triggered: false, confidence: 0, reason: 'no_model' };

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

        const confidence = decision === "converge" ? getConfig().convergence.llmVerdictConfidence : 0;
        const shouldStop = decision === "converge";
        return {
          triggered: shouldStop,
          confidence,
          reason: reason || (shouldStop ? "Discussion has naturally converged" : "Discussion still productive"),
          action: decision,
        };
      } catch (err) {
        const info = extractErrorInfo(err);
        convergenceLogger.warn('semantic_check_failed', 'Semantic convergence check failed', info);
        return { triggered: false, confidence: 0, reason: `check_failed: ${info.message}` };
      }
    },
  },
];

/**
 * Unified convergence protocol: runs all applicable checks and produces a single
 * weighted decision. Threshold varies by convergence mode.
 *
 * @param {Object} state - Meeting state (MutableState)
 * @param {Object} round - Current round data
 * @param {Function} promptOrchestrator - Function to prompt the orchestrator LLM
 * @param {Function} getHighestTierModel - Function to get the highest tier model
 * @returns {Promise<{shouldStop: boolean, confidence: number, triggeredBy: string[], reason: string}>}
 */
export async function orchestrateConvergence(state, round, promptOrchestrator, getHighestTierModel) {
  const triggered = [];
  let maxConfidence = 0;
  let semanticExtend = false;
  let extendAmount = 0;

  for (const checkDef of CONVERGENCE_CHECKS) {
    if (checkDef.minRound && state.current_round < checkDef.minRound) {
      continue;
    }

    let result;
    if (checkDef.requiresLLM) {
      result = await checkDef.check(state, promptOrchestrator, getHighestTierModel);
      if (result.action === "extend" && state.max_rounds < 10) {
        extendAmount = 1;
        semanticExtend = true;
        convergenceLogger.info('semantic_extend', 'Semantic analysis recommends one more round', { newMax: state.max_rounds + 1 });
      }
    } else {
      result = checkDef.check(state);
    }

    if (result.triggered) {
      triggered.push(checkDef.name);
      maxConfidence = Math.max(maxConfidence, result.confidence * checkDef.weight);
    }
  }

  const config = getConfig().convergence;
  const thresholds = {
    consensus: config.llmVerdictConfidence / 100,
    majority: 0.7,
    moderator_forces: 0.6,
  };
  const threshold = thresholds[state.convergence_mode] ?? 0.6;

  const normalizedScore = maxConfidence / 100;
  const shouldStop = normalizedScore >= threshold;

  const reason = triggered.length > 0
    ? `Triggered by: ${triggered.join(", ")}`
    : semanticExtend
      ? "Extended by semantic analysis"
      : "No convergence signals";

  convergenceLogger.info('convergence_evaluated', 'Convergence protocol evaluated', {
    shouldStop,
    score: normalizedScore,
    threshold,
    triggered,
    mode: state.convergence_mode,
  });

  return {
    shouldStop,
    confidence: normalizedScore,
    triggeredBy: triggered,
    reason,
    extendAmount,
  };
}

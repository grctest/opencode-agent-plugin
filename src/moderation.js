import { buildModeratorPrompt, buildTurnOrderPrompt } from "./prompts.js";
import { getConfig } from "./config.js";
import { LOOKBACK } from "./shared.js";
import { Logger, extractErrorInfo } from "./logger.js";

/** Parses a moderator's XML ruling into structured fields (decision, next_speaker, reason). */
export function parseModeratorRuling(text) {
  let decision = "";
  let next_speaker = "continue";
  let reason = "";

  const rulingMatch = text.match(/<ruling>([\s\S]*?)<\/ruling>/i);
  const content = rulingMatch ? rulingMatch[1] : text;

  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("decision:")) {
      decision = trimmed.substring(trimmed.indexOf(":") + 1).trim();
    } else if (lower.startsWith("next_speaker:")) {
      next_speaker = trimmed.substring(trimmed.indexOf(":") + 1).trim();
    } else if (lower.startsWith("reason:")) {
      reason = trimmed.substring(trimmed.indexOf(":") + 1).trim();
    }
  }

  if (!decision) {
    const lower = text.toLowerCase();
    if (lower.includes("converge") || lower.includes("synthesize") || lower.includes("wrap up")) {
      next_speaker = "synthesize";
      decision = "Converge the deliberation";
    } else {
      decision = text.slice(0, 200);
    }
  }

  return { decision, next_speaker, reason };
}

/**
 * Checks if moderator intervention is needed (circular arguments) and obtains a ruling.
 * Returns an action: continue, break (redirect to specific speaker), or converge (end meeting).
 */
export async function checkModeratorIntervention(round, participants, weave, currentRound, maxRounds, promptFn, getHighestTierModel, previousRulings = [], stateOfPlay = "") {
  const trigger = getConfig().moderatorTrigger;
  if (round.contributions.length < trigger.minContributions) {
    return { action: "continue", nextSpeakerIdx: -1 };
  }

  const recentTypes = round.contributions.slice(-trigger.lookbackWindow).map((c) => c.type);
  const challengeCount = recentTypes.filter(
    (t) => t === "challenge" || t === "dissent",
  ).length;
  if (challengeCount < trigger.recentChallenges) {
    return { action: "continue", nextSpeakerIdx: -1 };
  }

  // Consensus short-circuit: if no conflict signals at all, skip moderator
  const hasConflict = recentTypes.some((t) => t === "challenge" || t === "dissent");
  if (!hasConflict) {
    return { action: "continue", nextSpeakerIdx: -1 };
  }

  let situation = `Circular argument detected: ${challengeCount} challenges/dissents in the last ${trigger.lookbackWindow} contributions within a single round. The deliberation appears to be going in circles.`;

  if (weave.length >= LOOKBACK.SENDER_HISTORY) {
    const lastSix = weave.slice(-LOOKBACK.SENDER_HISTORY);
    const challengeCounts = {};
    for (const c of lastSix) {
      if (c.type === "challenge" || c.type === "dissent") {
        challengeCounts[c.participant_id] = (challengeCounts[c.participant_id] || 0) + 1;
      }
    }
    const repeatedChallenger = Object.entries(challengeCounts).find(([, n]) => n >= 3);
    if (repeatedChallenger) {
      situation = `Participant ${repeatedChallenger[0]} has challenged/dissented 3+ times in the last ${LOOKBACK.SENDER_HISTORY} contributions across rounds. Possible circular argument or deadlock.`;
    }
  }

  const lastContributions = weave.slice(-7).map((c) => ({
    content: c.content || "",
    type: c.type,
    participant_id: c.participant_id,
  }));

  const prompt = buildModeratorPrompt(
    situation,
    currentRound,
    maxRounds,
    weave.length,
    lastContributions,
    previousRulings,
    stateOfPlay,
  );
  const principalModel = getHighestTierModel();
  if (!principalModel) return { action: "continue", nextSpeakerIdx: -1 };

  try {
    const result = await promptFn(
      "You are the deliberation moderator.",
      principalModel,
      prompt,
    );

    const ruling = parseModeratorRuling(result);

    if (
      ruling.next_speaker === "synthesize" ||
      ruling.next_speaker === "converge" ||
      ruling.decision.toLowerCase().includes("converge") ||
      ruling.decision.toLowerCase().includes("wrap up")
    ) {
      return { action: "converge", nextSpeakerIdx: -1 };
    }

    if (ruling.next_speaker && ruling.next_speaker !== "continue") {
      const targetIdx = participants.findIndex(
        (p) =>
          p.config.id.toLowerCase() === ruling.next_speaker.toLowerCase() ||
          p.config.name.toLowerCase() === ruling.next_speaker.toLowerCase(),
      );
      if (targetIdx >= 0 && participants[targetIdx].status !== "passed") {
        return { action: "break", nextSpeakerIdx: targetIdx };
      }
    }

    return { action: "continue", nextSpeakerIdx: -1 };
  } catch (err) {
    const info = extractErrorInfo(err);
    new Logger().warn("moderator_prompt_failed", "Moderator prompt failed — continuing deliberation", info);
    return { action: "continue", nextSpeakerIdx: -1 };
  }
}

/**
 * Plans turn order for the next round based on agent [REQUEST_NEXT] tags.
 * Uses the moderator via fastPathModel to order participants.
 *
 * @param {Object} params
 * @param {string} params.stateOfPlay - Current state of play
 * @param {string} params.roundSummary - Summary of the completed round
 * @param {Array} params.turnRequests - Array of {participant_id, priority, reason}
 * @param {Array} params.participants - All participants
 * @param {Function} params.promptFn - Function to prompt the orchestrator LLM
 * @param {Function} params.getHighestTierModel - Function to get the highest tier model
 * @returns {Promise<string[]>} Ordered array of participant IDs
 */
export async function planTurnOrder({ stateOfPlay, roundSummary, turnRequests, participants, promptFn, getHighestTierModel }) {
  const config = getConfig();
  
  // If no requests, return default order (active participants)
  if (!turnRequests || turnRequests.length === 0) {
    return participants
      .filter((p) => p.status !== "failed")
      .map((p) => p.config.id);
  }

  // Filter to only valid requests (participant must exist and not be failed)
  const validRequests = turnRequests.filter((req) => {
    const p = participants.find((pp) => pp.config.id === req.participant_id);
    return p && p.status !== "failed";
  });

  if (validRequests.length === 0) {
    return participants
      .filter((p) => p.status !== "failed")
      .map((p) => p.config.id);
  }

  // Fast path: single request — no LLM call needed
  if (validRequests.length === 1) {
    const requestedId = validRequests[0].participant_id;
    const ordered = participants
      .filter((p) => p.status !== "failed")
      .map((p) => p.config.id);
    const idx = ordered.indexOf(requestedId);
    if (idx > 0) {
      ordered.splice(idx, 1);
      ordered.unshift(requestedId);
    }
    return ordered;
  }

  // Check if fast-path model is available for turn order planning
  const fastPathModel = config.fastPathModel;
  const model = fastPathModel || getHighestTierModel();
  if (!model) {
    // Fallback: sort by priority descending, then by tier
    return fallbackTurnOrder(validRequests, participants);
  }

  const prompt = buildTurnOrderPrompt(stateOfPlay, roundSummary, validRequests, participants);

  try {
    const result = await promptFn(
      "You are a turn order planner. Return only a JSON array of participant IDs.",
      model,
      prompt,
    );

    // Parse JSON array from response
    const arrayMatch = result.match(/\[.*?\]/s);
    if (arrayMatch) {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Validate all IDs exist
        const validIds = participants
          .filter((p) => p.status !== "failed")
          .map((p) => p.config.id);
        const ordered = parsed.filter((id) => validIds.includes(id));
        // Add any missing participants at the end
        for (const id of validIds) {
          if (!ordered.includes(id)) {
            ordered.push(id);
          }
        }
        return ordered;
      }
    }
  } catch (err) {
    const info = extractErrorInfo(err);
    new Logger().warn("turn_order_planning_failed", "Turn order planning failed — using fallback", info);
  }

  // Fallback: sort by priority, then tier
  return fallbackTurnOrder(validRequests, participants);
}

/**
 * Fallback turn order when LLM planning fails.
 * Sorts by priority descending, then by tier (principal > senior > mid > civilian/junior).
 * Civilian ranks at mid per utils/tier.js and the shared TIER_ORDER (audit 02 P4).
 */
function fallbackTurnOrder(turnRequests, participants) {
  const tierOrder = { principal: 0, senior: 1, mid: 2, civilian: 2, junior: 3 };

  // Sort requests by priority descending, then tier
  const sorted = [...turnRequests].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const pA = participants.find((p) => p.config.id === a.participant_id);
    const pB = participants.find((p) => p.config.id === b.participant_id);
    const tierA = tierOrder[pA?.config.tier] ?? 3;
    const tierB = tierOrder[pB?.config.tier] ?? 3;
    return tierA - tierB;
  });

  // Build ordered list: requested participants first, then remaining
  const ordered = sorted.map((r) => r.participant_id);
  const remaining = participants
    .filter((p) => p.status !== "failed" && !ordered.includes(p.config.id))
    .map((p) => p.config.id);
  
  return [...ordered, ...remaining];
}

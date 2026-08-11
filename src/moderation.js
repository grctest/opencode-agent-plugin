import { buildModeratorPrompt } from "./prompts.js";
import { CONFIG } from "./config.js";

/**
 * @typedef {Object} ModeratorRuling
 * @property {string} decision
 * @property {string} next_speaker
 * @property {string} reason
 */

/**
 * @typedef {Object} ModeratorDecision
 * @property {"continue" | "break" | "converge"} action
 * @property {number} nextSpeakerIdx
 */

/** Parses a moderator's free-text ruling into structured fields (decision, next_speaker, reason). */
export function parseModeratorRuling(text) {
  const lines = text.split("\n");
  let decision = "";
  let next_speaker = "continue";
  let reason = "";

  for (const line of lines) {
    const lower = line.toLowerCase().trim();
    if (lower.startsWith("decision:")) {
      decision = line.substring(line.indexOf(":") + 1).trim();
    } else if (lower.startsWith("next_speaker:")) {
      next_speaker = line.substring(line.indexOf(":") + 1).trim();
    } else if (lower.startsWith("reason:")) {
      reason = line.substring(line.indexOf(":") + 1).trim();
    }
  }

  if (!decision) {
    decision = text.slice(0, 200);
    const lower = text.toLowerCase();
    if (lower.includes("converge") || lower.includes("synthesize") || lower.includes("wrap up")) {
      next_speaker = "synthesize";
    }
  }

  return { decision, next_speaker, reason };
}

/**
 * Checks if moderator intervention is needed (circular arguments) and obtains a ruling.
 * Returns an action: continue, break (redirect to specific speaker), or converge (end meeting).
 */
export async function checkModeratorIntervention(round, participants, weft, currentRound, maxRounds, promptFn, getHighestTierModel) {
  const trigger = CONFIG.moderatorTrigger;
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

  let situation = `Circular argument detected: ${challengeCount} challenges/dissents in the last 3 contributions within a single round. The deliberation appears to be going in circles.`;

  if (weft.length >= 6) {
    const lastSix = weft.slice(-6);
    const challengeCounts = {};
    for (const c of lastSix) {
      if (c.type === "challenge" || c.type === "dissent") {
        challengeCounts[c.participant_id] = (challengeCounts[c.participant_id] || 0) + 1;
      }
    }
    const repeatedChallenger = Object.entries(challengeCounts).find(([, n]) => n >= 3);
    if (repeatedChallenger) {
      situation = `Participant ${repeatedChallenger[0]} has challenged/dissented 3+ times in the last 6 contributions across rounds. Possible circular argument or deadlock.`;
    }
  }
  const prompt = buildModeratorPrompt(
    situation,
    currentRound,
    maxRounds,
    weft.length,
    weft.slice(-3),
  );
  const principalModel = getHighestTierModel();

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
  } catch {
    return { action: "continue", nextSpeakerIdx: -1 };
  }
}

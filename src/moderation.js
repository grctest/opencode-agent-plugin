import { buildModeratorPrompt } from "./prompts.js";

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
  if (round.contributions.length < 6) {
    return { action: "continue", nextSpeakerIdx: -1 };
  }

  const recentTypes = round.contributions.slice(-4).map((c) => c.type);
  const challengeCount = recentTypes.filter(
    (t) => t === "challenge" || t === "dissent",
  ).length;
  if (challengeCount < 3) {
    return { action: "continue", nextSpeakerIdx: -1 };
  }

  const situation = `Circular argument detected: ${challengeCount} challenges/dissents in the last 4 contributions within a single round. The deliberation appears to be going in circles.`;
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

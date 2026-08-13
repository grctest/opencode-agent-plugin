import { buildModeratorPrompt } from "./prompts.js";
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
export async function checkModeratorIntervention(round, participants, weft, currentRound, maxRounds, promptFn, getHighestTierModel, previousRulings = []) {
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

  let situation = `Circular argument detected: ${challengeCount} challenges/dissents in the last ${trigger.lookbackWindow} contributions within a single round. The deliberation appears to be going in circles.`;

  if (weft.length >= LOOKBACK.SENDER_HISTORY) {
    const lastSix = weft.slice(-LOOKBACK.SENDER_HISTORY);
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

  const lastContributions = weft.slice(-7).map((c) => ({
    content: c.content || "",
    type: c.type,
    participant_id: c.participant_id,
  }));

  const prompt = buildModeratorPrompt(
    situation,
    currentRound,
    maxRounds,
    weft.length,
    lastContributions,
    previousRulings,
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

import type { ParticipantState, Round } from "./types.js";
import { buildModeratorPrompt } from "./prompts.js";

export interface ModeratorRuling {
  decision: string;
  next_speaker: string;
  reason: string;
}

export interface ModeratorDecision {
  action: "continue" | "break" | "converge";
  nextSpeakerIdx: number;
}

type PromptFn = (system: string, model: { providerID: string; modelID: string }, message: string) => Promise<string>;

export function parseModeratorRuling(text: string): ModeratorRuling {
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

export async function checkModeratorIntervention(
  round: Round,
  participants: ParticipantState[],
  weft: Array<{ content: string }>,
  currentRound: number,
  maxRounds: number,
  promptFn: PromptFn,
  getHighestTierModel: () => { providerID: string; modelID: string },
): Promise<ModeratorDecision> {
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

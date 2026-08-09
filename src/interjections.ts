import type { Interjection, ParticipantState, Round, Contribution, PromptFn, Client } from "./types.js";
import { can, splitModel } from "./tiers.js";
import { buildInterjectionCheckPrompt, buildPushbackPrompt, buildSpeakerSystemPrompt } from "./prompts.js";

type ParticipantLookup = Array<{ config: { id: string; name: string; tier: string; persona: string }; status: string; canInterject: boolean }>;

/** Handles the full interjection pipeline: check for interjection requests, resolve conflicts, and execute push-back. */
export async function handleInterjections(
  currentSpeakerId: string,
  round: Round,
  weft: Contribution[],
  participants: ParticipantState[],
  client: Client,
  directory: string,
  promptFn: PromptFn,
  getHighestTierModel: () => { providerID: string; modelID: string },
  isAborted: () => boolean,
  updateMetadata: (extra: Record<string, any>) => Promise<void>,
): Promise<"continued" | "broken"> {
  if (isAborted()) return "broken";

  const interjections = await checkForInterjections(
    currentSpeakerId, weft, participants, client, directory,
    promptFn, getHighestTierModel,
  );
  if (interjections.length === 0) return "continued";

  interjections.sort((a, b) => b.priority - a.priority);

  for (const ij of interjections) {
    if (isAborted()) return "broken";
    const resolved = await resolveInterjection(
      ij, currentSpeakerId, round, participants, client, directory,
      promptFn, getHighestTierModel, isAborted, updateMetadata,
    );
    if (resolved === "broken") return "broken";
  }

  return "continued";
}

/** Asks a neutral coordinator which listeners want to interject after a speaker's contribution. */
export async function checkForInterjections(
  currentSpeakerId: string,
  weft: Contribution[],
  participants: ParticipantState[],
  client: Client,
  directory: string,
  promptFn: PromptFn,
  getHighestTierModel: () => { providerID: string; modelID: string },
): Promise<Interjection[]> {
  const lastContribution = weft[weft.length - 1];
  const lastContent = lastContribution?.content ?? "";

  const participantLookup: ParticipantLookup = participants.map((p) => ({
    config: p.config,
    status: p.status,
    canInterject: can(p, "interject"),
  }));

  const checkPrompt = buildInterjectionCheckPrompt(currentSpeakerId, lastContent, participantLookup);
  const principalModel = getHighestTierModel();

  let result: string;
  try {
    result = await promptFn(
      "You are a neutral process coordinator evaluating interjection requests.",
      principalModel,
      checkPrompt,
    );
  } catch {
    return [];
  }

  const interjections: Interjection[] = [];
  for (const line of result.split("\n")) {
    const interjectMatch = line.match(
      /\[INTERJECT:\s*(.+?),\s*Priority:\s*(\d+),\s*Reason:\s*"(.+?)"\]/i,
    );
    if (interjectMatch) {
      const name = interjectMatch[1].trim();
      const priority = parseInt(interjectMatch[2]);
      const reason = interjectMatch[3].trim();

      const participant = participants.find(
        (p) =>
          p.config.name.toLowerCase() === name.toLowerCase() ||
          p.config.id.toLowerCase() === name.toLowerCase(),
      );

      if (participant) {
        interjections.push({
          participant_id: participant.config.id,
          priority: Math.min(10, Math.max(1, priority)),
          reason,
          granted: false,
          pushback: null,
          resolved: "pending",
        });
      }
    }
  }

  return interjections;
}

async function resolveInterjection(
  ij: Interjection,
  currentSpeakerId: string,
  round: Round,
  participants: ParticipantState[],
  client: Client,
  directory: string,
  promptFn: PromptFn,
  getHighestTierModel: () => { providerID: string; modelID: string },
  isAborted: () => boolean,
  updateMetadata: (extra: Record<string, any>) => Promise<void>,
): Promise<"continued" | "broken"> {
  const interjector = participants.find((p) => p.config.id === ij.participant_id);
  const currentSpeaker = participants.find((p) => p.config.id === currentSpeakerId);

  if (!interjector || !currentSpeaker) {
    ij.resolved = "denied";
    round.interjections.push(ij);
    return "continued";
  }

  if (ij.priority >= 9) {
    ij.granted = true;
  } else if (ij.priority >= 7) {
    const lastContent = round.contributions[round.contributions.length - 1]?.content ?? "";
    const pushback = await checkPushback(
      currentSpeaker, ij, interjector.config.name, lastContent, promptFn,
    );
    if (pushback === "yield") {
      ij.granted = true;
    } else if (pushback === "contest_wins") {
      ij.resolved = "contested";
      ij.pushback = "Speaker contested and won";
      round.interjections.push(ij);
      return "continued";
    } else if (pushback === "tiebreaker") {
      const tieResult = await moderatorTiebreaker(
        currentSpeaker, interjector, ij, promptFn, getHighestTierModel,
      );
      if (tieResult === "interjector_wins") {
        ij.granted = true;
      } else {
        ij.resolved = "contested";
        ij.pushback = "Moderator ruled in favor of current speaker";
        round.interjections.push(ij);
        return "continued";
      }
    } else {
      ij.granted = true;
    }
  } else {
    ij.resolved = "denied";
    round.interjections.push(ij);
    return "continued";
  }

  if (ij.granted) {
    ij.resolved = "granted";
    round.interjections.push(ij);

    if (isAborted()) return "broken";

    interjector.status = "speaking";
    await updateMetadata({
      loom_phase: "interjection",
      loom_current_speaker: interjector.config.name,
    });

    const model = splitModel(interjector.tier_config.model);
    const systemPrompt = buildSpeakerSystemPrompt(interjector);
    const lastContent = round.contributions[round.contributions.length - 1]?.content ?? "";
    const userPrompt = `## You Interjected

You requested to interrupt with priority ${ij.priority}:
"${ij.reason}"

The current speaker said:
"${lastContent}"

State your interjection now. Be direct and under 200 words.`;

    try {
      const result = await promptFn(systemPrompt, model, userPrompt);
      const contribution: Contribution = {
        participant_id: interjector.config.id,
        content: result.replace(/^\[(\w+)\]\s*/, ""),
        type: "interjection",
        targets_which: currentSpeakerId,
        timestamp: Date.now(),
      };
      round.contributions.push(contribution);
      interjector.contributions_count++;
    } catch {
    }

    interjector.status = "listening";
  }

  return "continued";
}

async function checkPushback(
  speaker: ParticipantState,
  ij: Interjection,
  interjectorName: string,
  lastContribution: string,
  promptFn: PromptFn,
): Promise<"yield" | "contest_wins" | "contest_loses" | "tiebreaker"> {
  const model = splitModel(speaker.tier_config.model);
  const prompt = buildPushbackPrompt(speaker, interjectorName, ij.priority, lastContribution);

  try {
    const result = await promptFn(buildSpeakerSystemPrompt(speaker), model, prompt);
    const text = result.trim();

    if (text.startsWith("[CONTEST")) {
      const priorityMatch = text.match(/Priority:\s*(\d+)/);
      const contestPriority = priorityMatch ? parseInt(priorityMatch[1]) : ij.priority;

      if (contestPriority > ij.priority) {
        return "contest_wins";
      } else if (contestPriority === ij.priority) {
        return "tiebreaker";
      } else {
        return "contest_loses";
      }
    }

    return "yield";
  } catch {
    return "yield";
  }
}

async function moderatorTiebreaker(
  speaker: ParticipantState,
  interjector: ParticipantState,
  ij: Interjection,
  promptFn: PromptFn,
  getHighestTierModel: () => { providerID: string; modelID: string },
): Promise<"speaker_wins" | "interjector_wins"> {
  const { buildModeratorPrompt } = await import("./prompts.js");
  const situation = `Two participants claim equal priority (${ij.priority}):
- **${speaker.config.name}** (${speaker.config.tier}) is currently speaking
- **${interjector.config.name}** (${interjector.config.tier}) wants to interject: "${ij.reason}"

Both claim priority ${ij.priority}. Who should speak?`;

  const prompt = buildModeratorPrompt(situation, 0, 0, 0, []);
  const model = getHighestTierModel();

  try {
    const result = await promptFn("You are the deliberation moderator.", model, prompt);
    if (result.toLowerCase().includes(interjector.config.name.toLowerCase())) {
      return "interjector_wins";
    }
    return "speaker_wins";
  } catch {
    return "speaker_wins";
  }
}

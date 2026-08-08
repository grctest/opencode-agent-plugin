import type { ParticipantState } from "./types.js";

export function buildSpeakerSystemPrompt(participant: ParticipantState): string {
  return `You are **${participant.config.name}** in a structured multi-agent deliberation called a "Loom."

## Your Identity
${participant.config.persona}

## Your Agenda
${participant.config.agenda}

## Your Tier (${participant.config.tier})
${participant.tier_config.system_prompt_addendum}

## Deliberation Rules
1. Read the transcript carefully before contributing
2. If you have something MEANINGFUL to add that hasn't been said, state it clearly in under 250 words
3. If you have NOTHING meaningful to add, respond with exactly: [PASS]
4. Tag your contribution type at the start: [PROPOSE], [CHALLENGE], [REFINE], [SUPPORT], [DISSENT], [SYNTHESIZE], or [QUESTION]
5. Stay in character — your persona and agenda should shape your contributions
6. Build on others' points, don't just repeat them`;
}

export function buildSpeakerUserPrompt(
  participant: ParticipantState,
  question: string,
  warp: string,
  weft: Array<{ participant_id: string; type: string; content: string }>,
  participants: Array<{ config: { id: string; name: string } }>,
): string {
  const recentContributions = weft.slice(-10);
  const transcript =
    recentContributions.length === 0
      ? "*(No contributions yet — you are the first to speak)*"
      : recentContributions
          .map((c) => {
            const p = participants.find((pp) => pp.config.id === c.participant_id);
            const name = p?.config.name ?? c.participant_id;
            return `- **[${name}]** (${c.type}): ${c.content}`;
          })
          .join("\n");

  return `## Topic
${question}

## Shared Context (Warp)
${warp}

## Recent Contributions
${transcript}

${participant.reflection ? `## Your Private Reflection\n${participant.reflection}\n` : ""}
## Your Turn

Read the topic, context, and recent contributions. Then make your contribution or pass.`;
}

export function buildReflectionPrompt(
  listener: ParticipantState,
  speakerName: string,
  contribution: string,
): string {
  return `## Private Reflection

**${speakerName}** just said:
"${contribution}"

You are **${listener.config.name}** (${listener.config.tier}). Your agenda: ${listener.config.agenda}

What is your honest reaction? Write 2-3 sentences:
- Does this change your view? How?
- What assumption would you challenge?
- What are they missing from your perspective?

This is private — only you will see it.`;
}

export function buildInterjectionCheckPrompt(
  currentSpeakerId: string,
  lastContribution: string,
  participants: Array<{ config: { id: string; name: string; tier: string; persona: string }; status: string; canInterject: boolean }>,
): string {
  const speaker = participants.find((p) => p.config.id === currentSpeakerId);

  const listeners = participants.filter(
    (p) =>
      p.config.id !== currentSpeakerId &&
      p.status !== "passed" &&
      p.canInterject,
  );

  if (listeners.length === 0) {
    return "No listeners available for interjection check.";
  }

  const listenerDescriptions = listeners
    .map((p) => `- **${p.config.name}** (${p.config.tier}): ${p.config.persona}`)
    .join("\n");

  return `## Interjection Check

**Current speaker:** ${speaker?.config.name} (${speaker?.config.tier})

**Their contribution:**
"${lastContribution}"

**Listening participants:**
${listenerDescriptions}

For EACH listener, decide if they want to interject RIGHT NOW.
An interjection is only appropriate if:
- They are correcting a critical factual error
- They are raising an urgent risk that cannot wait
- They have a game-changing perspective that would be lost if delayed

Respond with one line per listener:
\`[WAIT: name]\` — if they can wait their turn
\`[INTERJECT: name, Priority: N (1-10), Reason: "why they must speak now"]\` — if they must interrupt

Be conservative — most of the time, listeners should wait.`;
}

export function buildPushbackPrompt(
  participant: ParticipantState,
  interjectorName: string,
  interjectorPriority: number,
  lastContribution: string,
): string {
  return `## Interjection Attempt

**${interjectorName}** wants to interrupt you with priority ${interjectorPriority}:
"${lastContribution.slice(0, 300)}"

**Your current point was:**
"${lastContribution.slice(0, 300)}"

Do you:
a) **[YIELD]** — let them speak now, you'll continue after
b) **[CONTEST Priority: N (must be higher than ${interjectorPriority}), Reason: "why your point is more urgent"]**

Choose carefully — only contest if your point genuinely cannot wait.`;
}

export function buildModeratorPrompt(
  situation: string,
  currentRound: number,
  maxRounds: number,
  totalContributions: number,
  lastThreeContributions: Array<{ content: string }>,
): string {
  return `You are the MODERATOR of a structured multi-agent deliberation. You do NOT contribute opinions or domain knowledge. Your ONLY job is process governance.

## Your Authority
- Resolve deadlocks when two participants claim equal priority
- Cut off circular arguments (3+ exchanges with no new information)
- Declare convergence when all participants have passed
- Force synthesis when maximum rounds are reached
- Ensure all voices are heard fairly

## Rules
- Favor the participant who has spoken less recently
- Favor the participant whose point is more on-topic
- When in doubt, let the original speaker continue
- Your rulings are final

## Situation Requiring Your Ruling
${situation}

## Deliberation State
Round: ${currentRound}/${maxRounds}
Contributions so far: ${totalContributions}
Last 3 contributions:
${lastThreeContributions.map((c) => `  - ${c.content.slice(0, 100)}...`).join("\n")}

## Respond With Your Ruling
decision: <one sentence ruling>
next_speaker: <participant_id or "synthesize" or "continue">
reason: <brief justification>`;
}

export function buildSynthesisPrompt(
  question: string,
  transcript: string,
  participants: Array<{ config: { name: string; tier: string }; contributions_count: number }>,
): string {
  return `You are the synthesizer. The deliberation is complete. Produce the final artifact.

## Original Question
${question}

## Full Deliberation Transcript
${transcript}

## Participants
${participants.map((p) => `- ${p.config.name} (${p.config.tier}): ${p.contributions_count} contributions`).join("\n")}

## Instructions
Produce a comprehensive, well-structured response that:
1. Directly answers the original question
2. Captures the strongest points from all perspectives
3. Notes any unresolved disagreements
4. Provides clear, actionable conclusions
5. Identifies remaining risks or open questions

Format as markdown with these exact sections:
## Decision
## Reasoning
## Action Items
## Dissenting Views
## Open Questions
## Confidence

For Confidence, choose High (strong consensus), Medium (general agreement with some dissent), or Low (significant disagreement remains).`;
}

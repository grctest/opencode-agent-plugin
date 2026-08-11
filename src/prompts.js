import { generateRoundBriefs } from "./warp-manager.js";

/** Builds a prompt asking a listener to privately reflect on a speaker's contribution. */
export function buildReflectionPrompt(listener, speakerName, contribution) {
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

/** Builds a prompt asking the current speaker to yield or contest an interjection attempt. */
export function buildPushbackPrompt(participant, interjectorName, interjectorPriority, lastContribution) {
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

/** Builds a prompt for the moderator to rule on deadlocks, circular arguments, or force convergence. */
export function buildModeratorPrompt(situation, currentRound, maxRounds, totalContributions, lastThreeContributions) {
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

/** Builds a prompt for synthesizing the final deliberation artifact from all contributions. */
export function buildSynthesisPrompt(question, transcript, participants = []) {
  const participantsSection = participants.length > 0
    ? `\n## Participants\n${participants.map((p) => `- ${p.config.name} (${p.config.tier}): ${p.contributions_count} contributions`).join("\n")}\n`
    : "";

  return `You are the synthesizer. The deliberation is complete. Produce the final artifact.

## Original Question
${question}

## Full Deliberation Transcript
${transcript}
${participantsSection}
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

// ─── Multi-Session Agent Prompts ──────────────────────────────────────

/** Builds the system prompt for an agent in the multi-session architecture (identity + rules). */
export function buildAgentSystemPrompt(participant) {
  const tier = participant.config.tier;
  const isJunior = tier === "junior";
  const isPrincipal = tier === "principal";

  let tierGuidance;
  if (isJunior) {
    tierGuidance = "Think creatively and bring fresh perspectives. Wild ideas are welcome. Challenge senior thinking with naive questions that expose hidden assumptions.";
  } else if (tier === "mid") {
    tierGuidance = "Balance creativity with evidence. When you disagree, explain why with specific reasoning. Synthesize others' points before adding your own.";
  } else if (tier === "senior") {
    tierGuidance = "Prioritize accuracy and risk assessment. Flag irreversible decisions. Be conservative with claims but commit fully when you do.";
  } else {
    tierGuidance = "See the whole system. Cut through noise and circular argument. When consensus is impossible, decide.";
  }

  const interjectionRule = tier === "junior"
    ? "5. To interject, add: [INTERJECT: Priority: <1-5>, Reason: \"why you must speak now\"]"
    : tier === "mid"
    ? "5. To interject, add: [INTERJECT: Priority: <1-7>, Reason: \"why you must speak now\"]"
    : tier === "senior"
    ? "5. To interject, add: [INTERJECT: Priority: <1-9>, Reason: \"why you must speak now\"]"
    : "5. To interject, add: [INTERJECT: Priority: <1-10>, Reason: \"why you must speak now\"]";

  return `You are **${participant.config.name}** (${participant.config.tier}) in a structured multi-agent deliberation called "Loom."

## Your Identity
${participant.config.persona}

## Your Agenda
${participant.config.agenda}

## Your Tier Guidance
${tierGuidance}

## Rules
1. Read the shared context and recent contributions carefully
2. If you have something meaningful to add, state it concisely (aim for under 200 words)
3. If you have nothing to add, respond with exactly: [PASS]
4. Tag your type: [PROPOSE], [CHALLENGE], [REFINE], [SUPPORT], [DISSENT], [SYNTHESIZE], or [QUESTION]
${interjectionRule}
6. Stay in character — your persona and agenda shape your contributions
7. Reference prior contributions using their ID: [R2-C3] means Round 2, Contribution 3

## Example Response
[CHALLENGE] The proposed approach doesn't account for backward compatibility. In my experience, breaking changes typically require a migration period. Have we validated this with stakeholders?

To interject on the current point: [INTERJECT: Priority: 7, Reason: "I have critical information that changes this tradeoff"]`;
}

/** Builds the user prompt for an agent's turn: warp context + recent contributions + interjection notes. */
export function buildAgentUserPrompt(participant, warp, weft, question, round) {
  const roundBriefs = generateRoundBriefs(warp, round);

  const recentContributions = weft.slice(-3);
  const transcript =
    recentContributions.length === 0
      ? "*(No contributions yet — you are the first to speak)*"
      : recentContributions
          .map((c, i) => {
            const idx = weft.length - recentContributions.length + i;
            const wasInterjection = c.type === "interjection" ? " [INTERJECTION]" : "";
            return `- **[R${round}-C${idx + 1}]** [${c.participant_id}] (${c.type})${wasInterjection}: ${c.content}`;
          })
          .join("\n");

  return `## Question
${question}

## Round ${round}

${roundBriefs ? `## Prior Deliberation Brief\n${roundBriefs}\n` : ""}
## Shared Context (Warp)
${warp}

## Recent Contributions (last 3)
${transcript}

${participant.reflection ? `## Your Previous Reflection\n${participant.reflection}\n` : ""}
## Your Turn

Read the context and contributions. Then make your contribution or pass.`;
}

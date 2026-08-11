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

/** Builds a prompt asking a neutral coordinator which listeners (if any) should interject. */
export function buildInterjectionCheckPrompt(currentSpeakerId, lastContribution, participants) {
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
   return `You are **${participant.config.name}** (${participant.config.tier}) in a structured multi-agent deliberation called "Loom."

## Your Identity
${participant.config.persona}

## Your Agenda
${participant.config.agenda}

## Your Tier Guidance
${participant.config.tier === "junior" ? "Think creatively and bring fresh perspectives. Wild ideas are welcome — you won't be penalized for being wrong. Challenge senior thinking with naive questions." : participant.config.tier === "mid" ? "Balance creativity with evidence. When you disagree, explain why. Synthesize others' points before adding your own." : participant.config.tier === "senior" ? "Prioritize accuracy and risk assessment. Flag irreversible decisions. Be conservative with claims but commit fully when you do." : "See the whole system. Cut through noise. When consensus is impossible, decide."}

## Rules
1. Read the shared context and recent contributions carefully
2. If you have something meaningful to add, state it in under 250 words
3. If you have nothing to add, respond with exactly: [PASS]
4. Tag your type: [PROPOSE], [CHALLENGE], [REFINE], [SUPPORT], [DISSENT], [SYNTHESIZE], or [QUESTION]
5. To interject, add: [INTERJECT: Priority: <1-10>, Reason: "why you must speak now"]
6. Stay in character — your persona and agenda shape your contributions

## Example Response
[CHALLENGE] The proposed timeline doesn't account for QA. In my experience, testing typically adds 30% to estimates. Have we validated these numbers with the QA team?

To interject on the current point: [INTERJECT: Priority: 8, Reason: "I have critical security context that changes this tradeoff"]`;
 }

/** Builds the user prompt for an agent's turn: warp context + recent contributions + interjection notes. */
export function buildAgentUserPrompt(participant, warp, weft, question, round) {
  const recentContributions = weft.slice(-10);
  const transcript =
    recentContributions.length === 0
      ? "*(No contributions yet — you are the first to speak)*"
      : recentContributions
          .map((c) => {
            const wasInterjection = c.type === "interjection" ? " [INTERJECTION]" : "";
            return `- **[${c.participant_id}]** (${c.type})${wasInterjection}: ${c.content}`;
          })
          .join("\n");

  return `## Question
${question}

## Round ${round}

## Shared Context (Warp)
${warp}

## Recent Contributions
${transcript}

${participant.reflection ? `## Your Previous Reflection\n${participant.reflection}\n` : ""}
## Your Turn

Read the context and contributions. Then make your contribution or pass.`;
}

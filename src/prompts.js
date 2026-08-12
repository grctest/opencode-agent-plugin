import { generateRoundBriefs } from "./warp-manager.js";
import { getPromptForTier } from "./shared.js";

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

/** Builds a prompt that produces private reflections for all listeners in a single call. */
export function buildBatchReflectionPrompt(speakerName, contribution, listeners) {
  const listenerLines = listeners
    .map((l) => `  - ${l.config.name} (${l.config.tier}): ${l.config.agenda}`)
    .join("\n");

  return `## Batch Private Reflection

**${speakerName}** just said:
"${contribution}"

Generate a private 2-3 sentence reflection for EACH participant below. For each, answer:
- Does this change their view? How?
- What assumption would they challenge?
- What are they missing from their perspective?

Participants:
${listenerLines}

Respond with ONLY a JSON object in this exact shape:
{"reflections":[{"name":"<participant name>","reflection":"<their 2-3 sentence reflection>"}]}`;
}

/** Builds a prompt asking the current speaker to yield or contest an interjection attempt. */
export function buildPushbackPrompt(participant, interjectorName, interjectorPriority, lastContribution, interjectorReason = "") {
  return `## Interjection Attempt

**${interjectorName}** wants to interrupt you with priority ${interjectorPriority}.
Reason: "${interjectorReason}"

**Your current point was:**
"${lastContribution.slice(0, 300)}"

Do you:
a) **[YIELD]** — let them speak now, you'll continue after
b) **[CONTEST]** — your point must be heard now because [reason]

Respond with either "[YIELD]" or "[CONTEST] [your reason in one sentence]"`;
}

/** Builds a prompt for the moderator to rule on deadlocks, circular arguments, or force convergence. */
export function buildModeratorPrompt(situation, currentRound, maxRounds, totalContributions, lastThreeContributions) {
  const contributionsList = lastThreeContributions.map((c) =>
    `  - ${c.content ? c.content.slice(0, 100) : "(no content)"}...`
  ).join("\n");

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
${contributionsList}

## Respond With Your Ruling
<ruling>
decision: <one sentence ruling>
next_speaker: <participant_id or "synthesize" or "continue">
reason: <brief justification>
</ruling>

IMPORTANT: Respond ONLY with the <ruling> block above. Do not include any other text.`;
}

/** Builds a prompt for synthesizing the final deliberation artifact from all contributions. */
export function buildSynthesisPrompt(question, transcript, participants = [], domain = null) {
  const participantsSection = participants.length > 0
    ? `\n## Participants\n${participants.map((p) => `- ${p.config.name} (${p.config.tier}): ${p.contributions_count} contributions`).join("\n")}\n`
    : "";

  const domainGuidance = domain ? getDomainSynthesisGuidance(domain) : "";

  return `You are the synthesizer. The deliberation is complete. Produce the final artifact.

## Original Question
${question}
${domain ? `\n## Domain Context\nThis is a ${domain} question. ${domainGuidance}\n` : ""}
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

For Confidence:
- High = all active participants contributed meaningfully and there are no unresolved disagreements
- Medium = general agreement with minor dissent, or some participants did not contribute
- Low = significant disagreement remains, or many participants failed to contribute

## Example Output Structure
## Decision
The team should adopt a phased migration approach, starting with the user authentication service.

## Reasoning
The Staff Architect emphasized long-term maintainability, while the Security Engineer flagged the risk of session fixation. The Financial Analyst noted that a phased approach reduces upfront cost risk. The consensus was that a big-bang migration introduces unacceptable downtime risk.

## Action Items
- Implement JWT for the auth service in Q1
- Add refresh token rotation to address Security Engineer's concerns
- Schedule migration review after auth service is stable

## Dissenting Views
The Engineering Director advocated for a faster timeline, arguing that the team has capacity to handle a parallel migration.

## Open Questions
- What is the rollback plan if JWT causes client-side issues?
- How will existing sessions be handled during the transition?

## Confidence
High`;
}

function getDomainSynthesisGuidance(domain) {
  const guidance = {
    engineering: "Focus on technical tradeoffs, implementation feasibility, and risk mitigation. Prioritize solutions that balance correctness with pragmatism.",
    finance: "Focus on risk-return tradeoffs, quantitative reasoning, and practical constraints. Acknowledge uncertainty in projections.",
    business: "Focus on strategic alignment, market dynamics, and actionable next steps. Prioritize decisions that can be executed.",
    creative: "Focus on originality, user experience, and feasibility. Balance creative ambition with practical constraints.",
    executive: "Focus on organizational impact, stakeholder alignment, and decision-making clarity. Prioritize decisions that move the organization forward.",
    operations: "Focus on process efficiency, reliability, and scalability. Prioritize solutions that reduce toil and improve consistency.",
  };
  return guidance[domain] || "Provide a balanced analysis that considers multiple stakeholder perspectives.";
}

/** Builds the system prompt for an agent in the multi-session architecture (identity + rules). */
export function buildAgentSystemPrompt(participant) {
  const tier = participant.config.tier;
  const isJunior = tier === "junior";
  const cfg = participant.config;

  const tierGuidance = getPromptForTier(tier);

  const priorityCap = isJunior ? 5 : tier === "mid" ? 7 : tier === "senior" ? 9 : 10;
  const interjectionRule = `5. To interject, add: [INTERJECT: Priority: <1-${priorityCap}>, Reason: "why you must speak now", Target: <optional contribution id like #12 or participant name>] — then write your interjection content immediately after on the same line`;

  const biases = Array.isArray(cfg.known_biases) && cfg.known_biases.length > 0
    ? cfg.known_biases.map((b) => `- ${b}`).join("\n")
    : null;
  const style = typeof cfg.communication_style === "string" && cfg.communication_style.trim().length > 0
    ? cfg.communication_style.trim()
    : null;
  const contribTypes = Array.isArray(cfg.preferred_contribution_types) && cfg.preferred_contribution_types.length > 0
    ? cfg.preferred_contribution_types.join(", ")
    : null;

  const dispositionSection = (biases || style || contribTypes)
    ? `
## Your Disposition
${biases ? `You are prone to these known tendencies — name them when they might be coloring your view, and actively check them:\n${biases}\n` : ""}${style ? `Communicate in this register: ${style}\n` : ""}${contribTypes ? `You naturally contribute via: ${contribTypes}. Lean into these, but stay open to others when the moment calls for it.\n` : ""}`
    : "";

  return `You are **${cfg.name}** (${cfg.tier}) in a structured multi-agent deliberation called "Loom."

## Your Identity
${cfg.persona}

## Your Agenda
${cfg.agenda}
${dispositionSection}

## Your Tier Guidance
${tierGuidance}

## Rules
1. Read the shared context and recent contributions carefully
2. If you have something meaningful to add, state it concisely (aim for under 200 words)
3. If you have nothing to add, respond with exactly: [PASS]
4. Tag your type: [PROPOSE], [CHALLENGE], [REFINE], [SUPPORT], [DISSENT], [SYNTHESIZE], or [QUESTION]
${interjectionRule}
6. Stay in character — your persona and agenda shape your contributions
7. Reference prior contributions using their stable ID from the Recent Contributions list, e.g. [#12]

## Example Response
[CHALLENGE] The proposed approach doesn't account for backward compatibility. In my experience, breaking changes typically require a migration period. Have we validated this with stakeholders?

## Example With Interjection
[PROPOSE] We should adopt a phased migration over Q1 and Q2. This gives us time to validate each service migration before proceeding to the next.

To interject on the current point: [INTERJECT: Priority: 8, Reason: "I have data showing the auth service migration alone will take 6 weeks, making Q1 unrealistic"] The auth service migration alone will take 6 weeks based on our last project timeline — Q1 is unrealistic without additional resources.`;
}

/**
 * Builds the user prompt for an agent's turn. Child sessions are persistent, so the prompt
 * only carries the delta: the question (round 1), the shared context warp (round 1 only),
 * round briefs for everything prior, and contributions from the previous + current rounds.
 */
export function buildAgentUserPrompt(participant, warp, weft, question, round, roundBriefs, domain = null) {
  const briefs = roundBriefs ?? generateRoundBriefs(warp, round);
  const firstRound = round <= 1;

  const recentContributions = weft.filter((c) => c.round == null || c.round >= round - 1);
  const transcript =
    recentContributions.length === 0
      ? "*(No contributions yet — you are the first to speak)*"
      : recentContributions
          .map((c) => {
            const id = c.id != null ? `[#${c.id}]` : "";
            const wasInterjection = c.type === "interjection" ? " [INTERJECTION]" : "";
            return `- ${id} [${c.participant_id}] (${c.type})${wasInterjection}: ${c.content}`;
          })
          .join("\n");

  const warpStr = firstRound && typeof warp === "string" ? warp : "";
  const reflections = formatReflections(participant);

  return `## Question
${question}
${domain ? `\n## Domain: ${domain}\n` : ""}
## Round ${round}

${briefs ? `## Prior Deliberation Brief\n${briefs}\n` : ""}
${warpStr ? `## Shared Context (Warp)\n${warpStr}\n\n` : ""}
## Recent Contributions (rounds ${Math.max(1, round - 1)}-${round})
${transcript}

${reflections}
## Your Turn

Read the context and contributions. Then make your contribution or pass.`;
}

function formatReflections(participant) {
  const reflections = Array.isArray(participant.reflections)
    ? participant.reflections
    : participant.reflection
      ? [participant.reflection]
      : [];
  if (reflections.length === 0) return "";
  return reflections.map((r) => `## Your Reflection\n${r}\n`).join("");
}

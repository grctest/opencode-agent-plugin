import { getPromptForTier, TURN_REQUEST_PRIORITY_CAP } from "./shared.js";
import { sanitizeForDisplay } from "./utils/sanitize.js";
import { getConfig } from "./config.js";

/** Generates a stable delimiter that won't change across runs. */
function makeDelimiter(label) {
  return `<<<LOOM_${label}>>>`;
}

/**
 * Wraps context in delimiter-protected sections to prevent prompt injection.
 * Uses stable delimiters for reproducibility and debugging.
 */
export function delimitContext(context, label) {
  if (!context || !context.trim()) return '';
  const delim = makeDelimiter(label);
  return `${delim}_BEGIN_\n${context}\n${delim}_END_`;
}

/** Builds a prompt asking a listener to reflect on a speaker's contribution. */
export function buildReflectionPrompt(listener, triggerParticipant, contribution, roundContributions) {
  const safeSpeaker = sanitizeForDisplay(triggerParticipant.config.name);
  const safeContribution = sanitizeForDisplay(contribution);
  const tier = listener.config.tier;

  const tierReflectionGuidance = {
    junior: "React instinctively — what excites you, what feels wrong, what reminds you of something unrelated? Don't worry about being right.",
    mid: "Evaluate the reasoning structure. Where does the logic hold? Where does it break? What evidence would change your mind?",
    senior: "Assess risk and feasibility. What has worked before in similar situations? What assumptions are most dangerous to leave unchallenged?",
    principal: "Determine if this contribution moves the deliberation forward or merely restates what's already known. Is it actionable?",
  };

  const guidance = tierReflectionGuidance[tier] || tierReflectionGuidance.mid;

  const previousReflection = listener.reflection || "";
  const reflectionBlock = previousReflection
    ? `Your previous reflection on this deliberation:\n"${sanitizeForDisplay(previousReflection)}"`
    : "(No prior reflection — this is your first)";

  const myContributions = (roundContributions || [])
    .filter((c) => c.participant_id === listener.config.id && c.type !== "pass")
    .slice(-2)
    .map((c) => sanitizeForDisplay(c.content));
  const recentBlock = myContributions.length > 0
    ? `Your recent contributions:\n${myContributions.map((c) => `- "${c}"`).join("\n")}`
    : "";

  const agentToolsConfig = getConfig().agentTools;
  const reflectionToolUsageSection = agentToolsConfig?.enabled
    ? `
## Tool Usage (Reflection)

During reflection, you may use tools to research and recall. Use them to inform your reflection on the deliberation, not to explore broadly.

**Use tools when:**
- You need to verify what a participant actually said (loom_vector_search)
- You need to check current facts before updating your position (web_search)

**Note:** Your reflection will be visible to other participants. Use tools to ground your reflection in evidence, not to gain an unfair advantage.`
    : "";

  return `## Reflection

You are **${listener.config.name}** (${listener.config.tier}). Your agenda: ${listener.config.agenda}

${recentBlock}

${reflectionBlock}

Now **${safeSpeaker}** said:
"${safeContribution}"

${guidance}
${reflectionToolUsageSection}

Write your reflection on this contribution. Update your previous reflection:
keep what still holds, revise what has changed, add what's new.
This reflection will be visible to other participants in the deliberation.`;
}

/** Builds a prompt for the moderator to plan turn order for the next round. */
export function buildTurnOrderPrompt(stateOfPlay, roundSummary, turnRequests, participants) {
  const safeStateOfPlay = sanitizeForDisplay(stateOfPlay, 2000);
  const safeRoundSummary = sanitizeForDisplay(roundSummary, 1000);
  
  const requestsList = turnRequests.map((r) => {
    const p = participants.find((pp) => pp.config.id === r.participant_id);
    const name = p?.config.name ?? r.participant_id;
    const tier = p?.config.tier ?? "mid";
    return `  - ${r.participant_id} (${name}, ${tier}): Priority ${r.priority} — "${sanitizeForDisplay(r.reason, 100)}"`;
  }).join("\n");

  const participantsList = participants
    .filter((p) => p.status !== "failed")
    .map((p) => `  - ${p.config.id} (${p.config.name}, ${p.config.tier})`)
    .join("\n");

  return `You are the turn order planner for a multi-agent deliberation.

## Current State of Play
${safeStateOfPlay || "(No state of play yet)"}

## Last Round Summary
${safeRoundSummary || "(First round)"}

## Agent Turn Requests
${requestsList || "(No requests — use default order)"}

## Active Participants
${participantsList}

## Task
Return a JSON array of participant IDs ordered by who should speak first to push the deliberation forward efficiently.

Rules:
1. Higher priority requests should generally speak first
2. Tie-break by: (1) who spoke least recently, (2) seniority tier (principal > senior > mid > junior)
3. Ensure all active participants get a turn
4. Consider the State of Play to avoid circular arguments
5. If no requests, return participants in their current order

Respond with ONLY a JSON array of participant IDs: ["id1", "id2", "id3"]`;
}

/** Builds a prompt for the moderator to rule on deadlocks, circular arguments, or force convergence. */
export function buildModeratorPrompt(situation, currentRound, maxRounds, totalContributions, recentContributions, previousRulings = [], stateOfPlay = "") {
  const safeSituation = sanitizeForDisplay(situation);
  const contributionsList = recentContributions.map((c) =>
    `  - ${c.content ? sanitizeForDisplay(c.content.slice(0, 100)) : "(no content)"}...`
  ).join("\n");

  const rulingsSection = previousRulings.length > 0
    ? `\n## Your Previous Rulings (for consistency)\n${previousRulings.map((r, i) => `  ${i + 1}. Round ${r.round}: ${r.decision} → ${r.next_speaker}`).join("\n")}\n`
    : "";

  const stateOfPlaySection = stateOfPlay
    ? `\n## Current State of Play\n${sanitizeForDisplay(stateOfPlay, 2000)}\n\nUse this to distinguish between:\n- Circular arguments (revisiting settled points with no new evidence)\n- Legitimate disputes (unresolved disagreements that need more discussion)\n`
    : "";

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
- Be consistent with your previous rulings unless circumstances have changed materially
${rulingsSection}
${stateOfPlaySection}
## Situation Requiring Your Ruling
${safeSituation}

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
export function buildSynthesisPrompt(question, transcript, participants = [], domain = null, stateOfPlay = "", objections = []) {
  const safeQuestion = sanitizeForDisplay(question);
  const safeTranscript = sanitizeForDisplay(transcript, 15000);
  const participantsSection = participants.length > 0
    ? `\n## Participants\n${participants.map((p) => `- ${p.config.name} (${p.config.tier}): ${p.contributions_count} contributions`).join("\n")}\n`
    : "";

  const domainGuidance = domain ? getDomainSynthesisGuidance(domain) : "";

  const stateOfPlaySection = stateOfPlay
    ? `\n## State of Play (Final)\n${sanitizeForDisplay(stateOfPlay, 3000)}\n`
    : "";

  const unresolvedObjections = (objections ?? []).filter((o) => o.unresolved);
  const objectionsSection = unresolvedObjections.length > 0
    ? `\n## Unresolved Objections\n${unresolvedObjections.map((o) => `- ${sanitizeForDisplay(o.content, 200)}`).join("\n")}\n`
    : "";

  return `You are the synthesizer. The deliberation is complete. Produce the final artifact.

## Original Question
${safeQuestion}
${domain ? `\n## Domain Context\nThis is a ${domain} question. ${domainGuidance}\n` : ""}
${stateOfPlaySection}${objectionsSection}
## Deliberation Transcript
${safeTranscript}
${participantsSection}
## Instructions
Produce a comprehensive, well-structured response that:
1. Directly answers the original question
2. Captures the strongest points from all perspectives
3. Notes any unresolved disagreements
4. Provides clear, actionable conclusions
5. Identifies remaining risks or open questions

Use the State of Play as your primary reference for what was decided, agreed upon, and left unresolved. The transcript provides supporting detail and attribution.

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
  const cfg = participant.config;

  const tierGuidance = getPromptForTier(tier);

  const priorityCap = TURN_REQUEST_PRIORITY_CAP[tier] ?? 5;
  const requestNextRule = `5. To request priority for the next round, add: [REQUEST_NEXT: Priority: <1-${priorityCap}>, Reason: "why you must speak next round"] — place this at the end of your response`;
  const agentToolsConfig = getConfig().agentTools;
  const toolUsageSection = agentToolsConfig?.enabled
    ? `
## Tool Usage

You have access to tools that let you research and explore. Use them to ground your contributions in evidence, not to replace direct engagement with the deliberation context.

**Use tools when:**
- You need to verify a factual claim (web_search, web_fetch)
- You need to examine code or files that aren't in your context (read, glob, grep)
- You need to recall specific prior contributions not in the State of Play (loom_vector_search)

**Do NOT use tools when:**
- The State of Play and Recent Contributions already contain the information you need
- You're using tools to delay or avoid making a substantive contribution
- You're searching for information that doesn't exist in the project

**Be efficient:** Each tool call adds latency and token cost. Make your queries specific and targeted.`
    : "";

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
4. Tag your type: [PROPOSE], [CHALLENGE], [REFINE], [SUPPORT], [DISSENT], [SYNTHESIZE], [QUESTION], or [REFUSE]
${requestNextRule}
6. Stay in character — your persona and agenda shape your contributions
7. Reference prior contributions using their stable ID from the Recent Contributions list, e.g. [#12]
${toolUsageSection}

## Example Response
[CHALLENGE] The proposed approach doesn't account for backward compatibility. In my experience, breaking changes typically require a migration period. Have we validated this with stakeholders?

## Example With Turn Request
[PROPOSE] We should adopt a phased migration over Q1 and Q2. This gives us time to validate each service migration before proceeding to the next.

[REQUEST_NEXT: Priority: 8, Reason: "Need to directly counter the Architect's claim about stateful overhead before we move to action items"]

## Example With Refusal
[REFUSE: I cannot engage with this premise because it assumes we have budget approval, which we do not] This discussion presupposes resources that haven't been allocated.`;
}

/**
 * Builds the user prompt for an agent's turn using the Golden Sandwich pattern:
 * System Prompt + State of Play + Vector RAG + Recent Contributions.
 * Each turn is stateless — fresh ephemeral session carries no prior history.
 */
export function buildAgentUserPrompt(participant, stateOfPlay, ragContext, recentContributions, round, question, domain = null) {
  const transcript =
    recentContributions.length === 0
      ? "*(No contributions yet — you are the first to speak)*"
      : recentContributions
          .map((c) => {
            const id = c.id != null ? `[#${c.id}]` : "";
            const safeContent = sanitizeForDisplay(c.content);
            return `- ${id} [${c.participant_id}] (${c.type}): ${safeContent}`;
          })
          .join("\n");

  const ragDelimited = ragContext ? delimitContext(ragContext, "RELEVANT_PRIOR_CONTEXT") : "";
  const stateOfPlayDelimited = stateOfPlay ? delimitContext(stateOfPlay, "STATE_OF_PLAY") : "";
  const transcriptDelimited = delimitContext(transcript, "CONTRIBUTIONS");
  const safeQuestion = sanitizeForDisplay(question);
  const safeDomain = domain ? sanitizeForDisplay(domain) : null;

  return `## Question
${safeQuestion}
${safeDomain ? `\n## Domain: ${safeDomain}\n` : ""}
## Round ${round}

${stateOfPlayDelimited ? `## State of Play\n${stateOfPlayDelimited}\n` : ""}
${ragDelimited ? `## Relevant Prior Context\n${ragDelimited}\n` : ""}
## Recent Contributions (last 3-4)
${transcriptDelimited}

${formatReflections(participant)}
## Your Turn

Read the state of play, relevant context, and recent contributions. Then make your contribution or pass.`;
}

function formatReflections(participant) {
  const reflection = participant.reflection;
  if (!reflection) return "";
  return `## Your Reflection\n${reflection}\n`;
}

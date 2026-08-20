import { TURN_REQUEST_PRIORITY_CAP } from "./shared.js";
import { sanitizeForDisplay, sanitizeForPrompt } from "./utils/sanitize.js";
import { getConfig } from "./config.js";

/** Generates a stable delimiter that won't change across runs. */
function makeDelimiter(label) {
  return `<<<LOOM_${label}>>>`;
}

function escapeDelimiters(text) {
  if (!text) return text;
  return text.replace(/<<</g, '\uFF3C\uFF3C\uFF3C').replace(/>>>/g, '\uFF3E\uFF3E\uFF3E');
}

/**
 * Wraps context in delimiter-protected sections to prevent prompt injection.
 * Uses stable delimiters for reproducibility and debugging.
 */
export function delimitContext(context, label) {
  if (!context || !context.trim()) return '';
  const delim = makeDelimiter(label);
  const safe = escapeDelimiters(context);
  return `${delim}_BEGIN_\n${safe}\n${delim}_END_`;
}

/** Builds a prompt asking a listener to reflect on a speaker's contribution. */
export function buildReflectionPrompt(listener, triggerParticipant, contribution, roundContributions, currentRound, maxRounds) {
  const safeSpeaker = sanitizeForDisplay(triggerParticipant.config.name);
  const safeContribution = sanitizeForDisplay(contribution);
  const guidance = listener.config.reflection_guidance || "Reflect on this contribution and update your position.";

  const previousReflection = listener.reflection || "";
  const reflectionBlock = previousReflection
    ? `Your previous reflection on this deliberation:\n"${sanitizeForDisplay(previousReflection)}"`
    : "";

  const myContributions = (roundContributions || [])
    .filter((c) => c.participant_id === listener.config.id && c.type !== "pass")
    .slice(-2)
    .map((c) => sanitizeForDisplay(c.content));
  const recentBlock = myContributions.length > 0
    ? `Your recent contributions:\n${myContributions.map((c) => `- "${c}"`).join("\n")}`
    : "";

  // Seniority relationship
  const TIER_ORDER = { junior: 0, mid: 1, senior: 2, principal: 3 };
  const listenerTierLevel = TIER_ORDER[listener.config.tier] ?? 1;
  const triggerTierLevel = TIER_ORDER[triggerParticipant.config.tier] ?? 1;
  const seniorityContext = buildSeniorityContext(
    listener.config.name,
    listener.config.tier,
    triggerParticipant.config.name,
    triggerParticipant.config.tier,
    listenerTierLevel,
    triggerTierLevel
  );

  // Round context
  const roundContext = buildRoundContext(currentRound, maxRounds);

  // Prior stance context
  const priorStanceContext = previousReflection
    ? `You have already reflected on this deliberation. Your current position is recorded above. Update it based on this new contribution — keep what still holds, revise what has changed, add what's new.`
    : "";

  const agentToolsConfig = getConfig().agentTools;
  const reflectionToolUsageSection = agentToolsConfig?.enabled
    ? `
## Research Tools (Reflection)

During reflection, you have access to research tools to ground your analysis in evidence. Use them to verify claims and check current facts before updating your position.

### When to Research
- You need to verify what a participant actually said versus what you remember
- You need to check current facts before revising your position on a claim
- You need to recall specific earlier contributions that aren't in your recent context

### Tool Selection
- **loom_vector_search**: Verify what was actually said in the deliberation
- **websearch**: Check current facts, data, or claims before updating your stance
- **webfetch**: Deep-dive into a specific source for detailed verification
- **read**: Examine project files or documents referenced in the discussion

### Quality Standards
- Synthesize findings into your reflection rather than listing raw results
- Your reflection will be visible to other participants — ground it in verifiable evidence`
    : "";

  return `## Reflection

You are **${listener.config.name}** (${listener.config.tier}). Your agenda: ${listener.config.agenda}

${recentBlock}

${reflectionBlock}

Now **${safeSpeaker}** said:
"${safeContribution}"

## Context for This Reflection

**Seniority relationship:**
${seniorityContext}

**Round context:**
${roundContext}

${priorStanceContext ? `**Your prior stance:** ${priorStanceContext}` : ""}

## Your Reflection Guidance
${guidance}

${reflectionToolUsageSection}

Write your reflection on this contribution.
This reflection will be visible to other participants in the deliberation.`;
}

/** Builds a prompt for a queried agent to respond to a direct question from another agent. */
export function buildQueryPrompt(sourceAgent, targetAgent, sourceContribution, question, roundContributions, currentRound, maxRounds) {
  const safeSourceName = sanitizeForDisplay(sourceAgent.config.name);
  const safeContribution = sanitizeForDisplay(sourceContribution);
  const safeQuestion = sanitizeForDisplay(question);

  const previousReflection = targetAgent.reflection || "";
  const reflectionBlock = previousReflection
    ? `Your previous reflection on this deliberation:\n"${sanitizeForDisplay(previousReflection)}"`
    : "";

  const myContributions = (roundContributions || [])
    .filter((c) => c.participant_id === targetAgent.config.id && c.type !== "pass")
    .slice(-2)
    .map((c) => sanitizeForDisplay(c.content));
  const recentBlock = myContributions.length > 0
    ? `Your recent contributions:\n${myContributions.map((c) => `- "${c}"`).join("\n")}`
    : "";

  const TIER_ORDER = { junior: 0, mid: 1, senior: 2, principal: 3 };
  const sourceTierLevel = TIER_ORDER[sourceAgent.config.tier] ?? 1;
  const targetTierLevel = TIER_ORDER[targetAgent.config.tier] ?? 1;
  const seniorityContext = buildSeniorityContext(
    targetAgent.config.name,
    targetAgent.config.tier,
    sourceAgent.config.name,
    sourceAgent.config.tier,
    targetTierLevel,
    sourceTierLevel,
  );

  const roundContext = buildRoundContext(currentRound, maxRounds);

  const agentToolsConfig = getConfig().agentTools;
  const queryToolUsageSection = agentToolsConfig?.enabled
    ? `
## Research Tools

You may use research tools to ground your answer in evidence. Use them to verify claims before responding.

### Tool Selection
- **loom_vector_search**: Verify what was actually said in the deliberation
- **websearch**: Check current facts, data, or claims
- **webfetch**: Deep-dive into a specific source for detailed verification
- **read**: Examine project files or documents referenced in the discussion`
    : "";

  return `## Direct Query

**${safeSourceName}** (${sourceAgent.config.tier}) asks you:

"${safeContribution}"

---
**Their question:** "${safeQuestion}"

${recentBlock}

${reflectionBlock}

## Context

**Seniority relationship:**
${seniorityContext}

**Round context:**
${roundContext}

## Your Task

Answer the question directly. Address ${safeSourceName}'s specific concern.
You may use research tools if needed. Stay in character.
Do NOT use contribution type tags ([PROPOSE], [CHALLENGE], etc.) — just answer.
${queryToolUsageSection}`;
}

/**
 * Builds a prompt for an evidence request — the target MUST use tools to find evidence.
 */
export function buildEvidencePrompt(sourceAgent, targetAgent, sourceContribution, question, roundContributions, currentRound, maxRounds) {
  const safeSourceName = sanitizeForDisplay(sourceAgent.config.name);
  const safeContribution = sanitizeForDisplay(sourceContribution);
  const safeQuestion = sanitizeForDisplay(question);

  const previousReflection = targetAgent.reflection || "";
  const reflectionBlock = previousReflection
    ? `Your previous reflection on this deliberation:\n"${sanitizeForDisplay(previousReflection)}"`
    : "";

  const myContributions = (roundContributions || [])
    .filter((c) => c.participant_id === targetAgent.config.id && c.type !== "pass")
    .slice(-2)
    .map((c) => sanitizeForDisplay(c.content));
  const recentBlock = myContributions.length > 0
    ? `Your recent contributions:\n${myContributions.map((c) => `- "${c}"`).join("\n")}`
    : "";

  const TIER_ORDER = { junior: 0, mid: 1, senior: 2, principal: 3 };
  const sourceTierLevel = TIER_ORDER[sourceAgent.config.tier] ?? 1;
  const targetTierLevel = TIER_ORDER[targetAgent.config.tier] ?? 1;
  const seniorityContext = buildSeniorityContext(
    targetAgent.config.name,
    targetAgent.config.tier,
    sourceAgent.config.name,
    sourceAgent.config.tier,
    targetTierLevel,
    sourceTierLevel,
  );

  const roundContext = buildRoundContext(currentRound, maxRounds);

  const agentToolsConfig = getConfig().agentTools;
  const evidenceToolUsageSection = agentToolsConfig?.enabled
    ? `
## Research Tools (REQUIRED)

You MUST use at least one research tool to find concrete evidence. Do NOT speculate or reason from memory alone.

### Tool Selection
- **websearch**: Search for current facts, data, benchmarks, or claims related to the evidence request
- **webfetch**: Deep-dive into a specific source URL for detailed evidence
- **read**: Examine project files or documents referenced in the discussion
- **loom_vector_search**: Verify what was actually said in the deliberation

### Reporting Requirements
- Report what you found and cite sources where possible
- If evidence is inconclusive or unavailable, explicitly state this
- Distinguish between strong evidence and weak/indirect evidence`
    : "";

  return `## Evidence Request

**${safeSourceName}** (${sourceAgent.config.tier}) is requesting evidence regarding:

"${safeContribution}"

---
**Their evidence question:** "${safeQuestion}"

${recentBlock}

${reflectionBlock}

## Context

**Seniority relationship:**
${seniorityContext}

**Round context:**
${roundContext}

## Your Task

Find concrete evidence to address this question. You MUST use research tools — do not speculate.
Report what you found, cite sources, and note if evidence is inconclusive or unavailable.
Stay in character.
Do NOT use contribution type tags ([PROPOSE], [CHALLENGE], etc.) — just present your findings.
${evidenceToolUsageSection}`;
}

/**
 * Builds a prompt for a voting agent to cast their vote on a poll.
 */
export function buildVotePrompt(sourceAgent, targetAgent, sourceContribution, question, roundContributions, currentRound, maxRounds) {
  const safeSourceName = sanitizeForDisplay(sourceAgent.config.name);
  const safeContribution = sanitizeForDisplay(sourceContribution);
  const safeQuestion = sanitizeForDisplay(question);

  const previousReflection = targetAgent.reflection || "";
  const reflectionBlock = previousReflection
    ? `Your previous reflection on this deliberation:\n"${sanitizeForDisplay(previousReflection)}"`
    : "";

  const myContributions = (roundContributions || [])
    .filter((c) => c.participant_id === targetAgent.config.id && c.type !== "pass")
    .slice(-2)
    .map((c) => sanitizeForDisplay(c.content));
  const recentBlock = myContributions.length > 0
    ? `Your recent contributions:\n${myContributions.map((c) => `- "${c}"`).join("\n")}`
    : "";

  const roundContext = buildRoundContext(currentRound, maxRounds);

  return `## Vote Requested

**${safeSourceName}** (${sourceAgent.config.tier}) asks:

"${safeContribution}"

---
**Vote on:** "${safeQuestion}"

${recentBlock}

${reflectionBlock}

## Context

**Round context:**
${roundContext}

## Your Task

Vote by choosing one option (A, B, etc.) and provide 1-2 sentences explaining your reasoning.

Format your response exactly as:
[Vote: <letter>]
<1-2 sentence justification>

Do NOT use contribution type tags ([PROPOSE], [CHALLENGE], etc.).
Stay in character.`;
}

/**
 * Builds a prompt for a summoned guest expert persona.
 */
export function buildSummonPrompt(summonedPersona, requester, issue, roundContributions, currentRound, maxRounds) {
  const safeRequesterName = sanitizeForDisplay(requester.config.name);
  const safeIssue = sanitizeForDisplay(issue);
  const safePersonaName = sanitizeForDisplay(summonedPersona.name);

  const recentContributions = (roundContributions || [])
    .slice(-4)
    .map((c) => {
      const id = c.id != null ? `[#${c.id}]` : "";
      return `- ${id} [${c.participant_id}] (${c.type}): ${sanitizeForDisplay(c.content)}`;
    })
    .join("\n");
  const recentBlock = recentContributions.length > 0
    ? `### Recent Deliberation Context\n${recentContributions}`
    : "*(No prior contributions yet)*";

  const roundContext = buildRoundContext(currentRound, maxRounds);

  const expertise = Array.isArray(summonedPersona.expertise)
    ? summonedPersona.expertise.join(", ")
    : summonedPersona.expertise || "general";
  const style = summonedPersona.communication_style || "Direct and professional";

  return `## Guest Expertise

You are **${safePersonaName}** (${summonedPersona.tier}), a guest expert summoned into this deliberation.

### Your Persona
${summonedPersona.persona}

### Your Expertise
${expertise}

### Your Communication Style
${style}

---

**${safeRequesterName}** (${requester.config.tier}) has asked you to address the following issue:
"${safeIssue}"

${recentBlock}

**Round context:**
${roundContext}

## Your Task

Provide your expert perspective on this issue. Use research tools to ground your response in evidence.
Stay in character based on your persona. Be direct and specific.
Do NOT use contribution type tags ([PROPOSE], [CHALLENGE], etc.) — just provide your analysis.`;
}

/**
 * Builds context about the seniority relationship between the reflecting agent
 * and the agent who triggered the reflection.
 */
function buildSeniorityContext(listenerName, listenerTier, triggerName, triggerTier, listenerLevel, triggerLevel) {
  if (triggerLevel > listenerLevel) {
    return `${triggerName} (${triggerTier}) outranks you (${listenerTier}). If their challenge has merit, update your position seriously. If it doesn't, hold your ground with evidence.`;
  } else if (triggerLevel < listenerLevel) {
    return `${triggerName} (${triggerTier}) is more junior than you (${listenerTier}). Evaluate their challenge on its merits, not seniority. Junior agents sometimes see what seniors miss.`;
  } else {
    return `${triggerName} (${triggerTier}) is your peer. Engage directly and challenge back if you disagree.`;
  }
}

/**
 * Builds context about the current round's position in the deliberation.
 */
function buildRoundContext(currentRound, maxRounds) {
  if (!currentRound || !maxRounds) {
    return "Deliberation round unknown. Reflect on the contribution's substance.";
  }

  const progress = currentRound / maxRounds;

  if (progress <= 0.33) {
    return `Early deliberation (round ${currentRound}/${maxRounds}). Be exploratory — this is the time to surface concerns and test assumptions.`;
  } else if (progress <= 0.66) {
    return `Mid deliberation (round ${currentRound}/${maxRounds}). Start converging — identify what's settled and what remains contested.`;
  } else {
    return `Late deliberation (round ${currentRound}/${maxRounds}). Focus on unresolved issues. Avoid re-litigating points already settled.`;
  }
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

  const relevantRulings = previousRulings.length > 10 ? previousRulings.slice(-10) : previousRulings;
  const rulingsSection = relevantRulings.length > 0
    ? `\n## Your Previous Rulings (for consistency)\n${relevantRulings.map((r, i) => `  ${i + 1}. Round ${r.round}: ${r.decision} → ${r.next_speaker}`).join("\n")}\n`
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
export function buildSynthesisPrompt(question, transcript, participants = [], tags = [], stateOfPlay = "", objections = []) {
  const safeQuestion = sanitizeForDisplay(question, 20000);
  const safeTranscript = sanitizeForDisplay(transcript, 100000);
  const participantsSection = participants.length > 0
    ? `\n## Participants\n${participants.map((p) => `- ${p.config.name} (${p.config.tier}): ${p.contributions_count} contributions`).join("\n")}\n`
    : "";

  const tagContext = tags?.length > 0 ? tags.join(", ") : null;

  const stateOfPlaySection = stateOfPlay
    ? `\n## State of Play (Final)\n${sanitizeForDisplay(stateOfPlay, 20000)}\n`
    : "";

  const unresolvedObjections = (objections ?? []).filter((o) => o.unresolved);
  const objectionsSection = unresolvedObjections.length > 0
    ? `\n## Unresolved Objections\n${unresolvedObjections.map((o) => `- ${sanitizeForDisplay(o.content, 1000)}`).join("\n")}\n`
    : "";

  return `You are the synthesizer. The deliberation is complete. Produce the final artifact.

## Original Question
${safeQuestion}
${tagContext ? `\n## Tags\n${tagContext}\n` : ""}
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

/** Builds the system prompt for an agent in the multi-session architecture (identity + rules). */
export function buildAgentSystemPrompt(participant) {
  const tier = participant.config.tier;
  const cfg = participant.config;
  // Sanitize persona fields to prevent injection while preserving voice; strip delimiters
  const safePersonaRaw = typeof cfg.persona === 'string' ? cfg.persona : '';
  const safeAgendaRaw = typeof cfg.agenda === 'string' ? cfg.agenda : '';
  const safePersona = escapeDelimiters(sanitizeForDisplay(safePersonaRaw, 2000));
  const safeAgenda = escapeDelimiters(sanitizeForDisplay(safeAgendaRaw, 2000));

  const tierGuidance = cfg.tier_guidance || "Contribute your expertise to the deliberation. Challenge assumptions and propose alternatives.";
  const safeTierGuidance = escapeDelimiters(sanitizeForDisplay(tierGuidance, 1000));

  const priorityCap = TURN_REQUEST_PRIORITY_CAP[tier] ?? 5;
  const requestNextRule = `5. To request priority for the next round, add: [REQUEST_NEXT: Priority: <1-${priorityCap}>, Reason: "why you must speak next round"] — place this at the end of your response`;
  const agentToolsConfig = getConfig().agentTools;
  const toolUsageSection = agentToolsConfig?.enabled
    ? `
## Research Tools

You have access to research tools that let you ground your contributions in real-world evidence. Strong deliberations are built on current, verified information — use your tools to bring that to the table.

### When to Research
- The question involves current data, trends, statistics, or market conditions
- A claim has been made that you're uncertain about or that may be outdated
- You need specific examples, case studies, or precedents to strengthen your argument
- You want to compare options, alternatives, or competing approaches with real data
- The discussion references files, code, or documents you haven't seen
- You need to recall earlier contributions not captured in the recent context

### Tool Selection
- **websearch**: Find current information, compare options, discover trends, validate claims with sources
- **webfetch**: Deep-dive into a specific URL for detailed content from articles or documentation
- **read / glob / grep**: Examine project files, code, or local documents
- **loom_vector_search**: Recall specific contributions from earlier in the deliberation

### Research Quality
- Make one focused search query rather than multiple vague ones
- Synthesize what you find — don't just dump search results into your response
- When you find useful information, weave it naturally into your argument with attribution
- If a tool call is rejected as invalid, retry it using the exact tool names above (websearch, webfetch, read, glob, grep, loom_vector_search) — do not silently fall back to memory
- If a search returns nothing useful, try once more with a single adjusted query before proceeding with your knowledge
- Cite sources when they strengthen your credibility`
    : "";

  const biases = Array.isArray(cfg.known_biases) && cfg.known_biases.length > 0
    ? cfg.known_biases.map((b) => `- ${escapeDelimiters(sanitizeForDisplay(b, 500))}`).join("\n")
    : null;
  const style = typeof cfg.communication_style === "string" && cfg.communication_style.trim().length > 0
    ? escapeDelimiters(sanitizeForDisplay(cfg.communication_style.trim(), 500))
    : null;
  const contribTypes = Array.isArray(cfg.preferred_contribution_types) && cfg.preferred_contribution_types.length > 0
    ? escapeDelimiters(cfg.preferred_contribution_types.map((t)=> sanitizeForDisplay(t, 100)).join(", "))
    : null;
  const antiPatterns = Array.isArray(cfg.anti_patterns) && cfg.anti_patterns.length > 0
    ? cfg.anti_patterns.map((a) => `- ${escapeDelimiters(sanitizeForDisplay(a, 500))}`).join("\n")
    : null;

  const dispositionSection = (biases || style || contribTypes)
    ? `
## Your Disposition
${biases ? `You are prone to these known tendencies — name them when they might be coloring your view, and actively check them:\n${biases}\n` : ""}${style ? `Communicate in this register: ${style}\n` : ""}${contribTypes ? `You naturally contribute via: ${contribTypes}. Lean into these, but stay open to others when the moment calls for it.\n` : ""}`
    : "";

  const antiPatternsSection = antiPatterns
    ? `
## What NOT to Do
${antiPatterns}
`
    : "";

  return `You are **${escapeDelimiters(sanitizeForDisplay(cfg.name, 200))}** (${cfg.tier}) in a structured multi-agent deliberation called "Loom."

## Your Identity
${safePersona}

## Your Agenda
${safeAgenda}
${dispositionSection}
${antiPatternsSection}

## Your Tier Guidance
${safeTierGuidance}

## Rules
1. Read the shared context and recent contributions carefully
2. If you have something meaningful to add, state your position clearly with supporting reasoning
3. If you have nothing to add, respond with exactly: [PASS]
4. Tag your type: [PROPOSE], [CHALLENGE], [REFINE], [SUPPORT], [DISSENT], [SYNTHESIZE], [QUESTION], or [REFUSE]
${requestNextRule}
6. Stay in character — your persona and agenda shape your contributions
7. Reference prior contributions using their stable ID from the Recent Contributions list, e.g. [#12]
8. To query a specific participant directly: [QUERY: @participant_id] your question — their response appears as a contribution. Max 2 targets.
9. To request evidence from a participant: [EVIDENCE: @participant_id] your evidence question — they must use tools to find concrete evidence. Max 2 targets.
10. To summon an external expert persona: [SUMMON: Persona Name] the issue you want addressed — they contribute a single response using your model. Use sparingly (max 1 per turn).
${toolUsageSection}

## Example Response
[CHALLENGE] The proposed approach doesn't account for backward compatibility. In my experience, breaking changes typically require a migration period. Have we validated this with stakeholders?

## Example With Turn Request
[PROPOSE] We should adopt a phased migration over Q1 and Q2. This gives us time to validate each service migration before proceeding to the next.

[REQUEST_NEXT: Priority: 8, Reason: "Need to directly counter the Architect's claim about stateful overhead before we move to action items"]

## Example With Refusal
[REFUSE: I cannot engage with this premise because it assumes we have budget approval, which we do not] This discussion presupposes resources that haven't been allocated.

## Example With Query
[CHALLENGE] The migration timeline assumes no integration conflicts, but we've seen collision issues in past rollouts.

[QUERY: @staff-architect] Based on the service dependency graph, which migrations are most likely to collide?

## Example With Evidence Request
[CHALLENGE] The budget projections assume 30% YoY growth but industry benchmarks show 12-15% for this sector.

[EVIDENCE: @data-scientist] Find current industry growth benchmarks for SaaS companies in this vertical.

## Example With Summons
[PROPOSE] We need to evaluate the security implications of this architecture change. I'm not a security expert.

[SUMMON: Security Engineer] What are the attack surfaces introduced by the new authentication flow?`;
}

/**
 * Builds the user prompt for an agent's turn using the Golden Sandwich pattern:
 * System Prompt + State of Play + Vector RAG + Recent Contributions.
 * Each turn is stateless — fresh ephemeral session carries no prior history.
 */
export function buildAgentUserPrompt(participant, stateOfPlay, ragContext, recentContributions, round, question, tags = []) {
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
  const tagContext = tags?.length > 0 ? tags.join(", ") : null;

  const prompt = `## Question
${safeQuestion}
${tagContext ? `\n## Tags: ${tagContext}\n` : ""}
## Round ${round}

${stateOfPlayDelimited ? `## State of Play\n${stateOfPlayDelimited}\n` : ""}
${ragDelimited ? `## Relevant Prior Context\n${ragDelimited}\n` : ""}
## Recent Contributions
${transcriptDelimited}

${formatReflections(participant)}
## Your Turn

Read the state of play, relevant context, and recent contributions. Then make your contribution or pass.`;

  return prompt;
}

function formatReflections(participant) {
  if (participant.reflectionHistory && participant.reflectionHistory.length > 0) {
    const recent = participant.reflectionHistory.slice(-3);
    const lines = recent.map((r) => `- Round ${r.round}: ${r.text.slice(0, 400).replace(/\n/g, " ")}`);
    const latest = participant.reflection ?? recent[recent.length - 1]?.text ?? "";
    if (recent.length === 1) {
      return `## Your Reflection\n${latest}\n`;
    }
    return `## Your Reflections (last ${recent.length})\n${lines.join("\n")}\n\n## Your Latest Reflection\n${latest}\n`;
  }
  const reflection = participant.reflection;
  if (!reflection) return "";
  return `## Your Reflection\n${reflection}\n`;
}

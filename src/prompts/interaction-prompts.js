import { sanitizeForDisplay } from "../utils/sanitize.js";
import { TIER_ORDER, LENGTH_LIMITS } from "./constants.js";
import { QUERY_MODES } from "./query-modes.js";
import { getRecentContributionsBlock, buildEvidenceGuidance, buildSeniorityContext, buildRoundContext } from "./blocks.js";

/** Builds a prompt asking a listener to reflect on a speaker's contribution. */
export function buildReflectionPrompt(listener, triggerParticipant, contribution, roundContributions, currentRound, maxRounds) {
  const safeSpeaker = sanitizeForDisplay(triggerParticipant.config.name);
  const safeContribution = sanitizeForDisplay(contribution);
  const guidance = listener.config.reflection_guidance || "Apply your domain lens; end with Position: [held|revised|expanded] because …";

  const previousReflection = listener.reflection || "";
  const listenerTierLevel = TIER_ORDER[listener.config.tier] ?? 1;
  const triggerTierLevel = TIER_ORDER[triggerParticipant.config.tier] ?? 1;

  const seniorityContext = buildSeniorityContext(
    listener.config.name, listener.config.tier,
    triggerParticipant.config.name, triggerParticipant.config.tier,
    listenerTierLevel, triggerTierLevel
  );
  const roundContext = buildRoundContext(currentRound, maxRounds);
  const toolSection = buildEvidenceGuidance("reflection");

  const compressedPrior = previousReflection
    ? `Your prior position (1 sentence): "${sanitizeForDisplay(previousReflection.slice(0, 280))}" — keep what holds, revise what changed, add what’s new.`
    : "You have no prior reflection — take a clear initial position.";

  const recentMine = getRecentContributionsBlock(roundContributions, listener.config.id);

  return `## Reflection — ${listener.config.name} (${listener.config.tier})

Your agenda: ${sanitizeForDisplay(listener.config.agenda, 400)}

${recentMine ? recentMine + "\n\n" : ""}${compressedPrior}

**Trigger — ${safeSpeaker} (${triggerParticipant.config.tier}) said:**
"${safeContribution}"

## Lens
${guidance}

## How to Weigh
- Seniority: ${seniorityContext}
- Round: ${roundContext}

## Task
Write a concise reflection (${LENGTH_LIMITS.reflectionWords} words) visible to all participants.
Structure: 1) What the trigger gets right/wrong with citation or scenario, 2) How your lens changes the view, 3) Closing line: Position: [held|revised|expanded] because {one falsifiable cause}.
If you cite deliberation content, use [#id]; if you cite external fact, use Source: URL. Do not re-emit <<< >>> boundaries.
${toolSection}`;
}

/** Builds a prompt for a queried agent to respond to a direct question from another agent.
 * mode: one of QUERY_MODES keys (clarify | perspective | evidence | critique | risks | assumptions | alternatives). */
export function buildQueryPrompt(sourceAgent, targetAgent, sourceContribution, question, roundContributions, currentRound, maxRounds, stateOfPlay = "", mode = "clarify") {
  const meta = QUERY_MODES[mode] ?? QUERY_MODES.clarify;
  const safeSourceName = sanitizeForDisplay(sourceAgent.config.name);
  const safeQuestion = sanitizeForDisplay(question);
  const safeContribution = sanitizeForDisplay(sourceContribution);

  const seniorityContext = buildSeniorityContext(
    targetAgent.config.name, targetAgent.config.tier,
    sourceAgent.config.name, sourceAgent.config.tier,
    TIER_ORDER[targetAgent.config.tier] ?? 1,
    TIER_ORDER[sourceAgent.config.tier] ?? 1,
  );
  const roundContext = buildRoundContext(currentRound, maxRounds);
  const toolSection = buildEvidenceGuidance(meta.guidanceKind);

  const recentMine = getRecentContributionsBlock(roundContributions, targetAgent.config.id);
  const reflectionLine = targetAgent.reflection ? `Your current position: "${sanitizeForDisplay(targetAgent.reflection.slice(0, 240))}"` : "";
  const sopSnippet = stateOfPlay ? `State of Play — Open Questions (what answer would unblock):\n${sanitizeForDisplay(stateOfPlay, 600)}\n\n` : "";

  const header = `## ${mode === "clarify" ? "Direct Query" : `${mode.charAt(0).toUpperCase() + mode.slice(1)} Request`} — to ${sanitizeForDisplay(targetAgent.config.name)} (${targetAgent.config.tier}) from ${safeSourceName} (${sourceAgent.config.tier})

Context (what they said):
"${safeContribution}"

Their question:
"${safeQuestion}"

${sopSnippet}${recentMine ? recentMine + "\n\n" : ""}${reflectionLine ? reflectionLine + "\n\n" : ""}Seniority: ${seniorityContext}
Round: ${roundContext}

## Task
${meta.taskBlock()}
${toolSection}`;
  return header;
}

/**
 * Builds a prompt for an evidence request — the target MUST use tools to find evidence.
 */
export function buildEvidencePrompt(sourceAgent, targetAgent, sourceContribution, question, roundContributions, currentRound, maxRounds) {
  const safeSourceName = sanitizeForDisplay(sourceAgent.config.name);
  const safeQuestion = sanitizeForDisplay(question);
  const safeContribution = sanitizeForDisplay(sourceContribution);

  const seniorityContext = buildSeniorityContext(
    targetAgent.config.name, targetAgent.config.tier,
    sourceAgent.config.name, sourceAgent.config.tier,
    TIER_ORDER[targetAgent.config.tier] ?? 1,
    TIER_ORDER[sourceAgent.config.tier] ?? 1,
  );
  const roundContext = buildRoundContext(currentRound, maxRounds);
  const toolSection = buildEvidenceGuidance("evidence");

  const recentMine = getRecentContributionsBlock(roundContributions, targetAgent.config.id);
  const reflectionLine = targetAgent.reflection ? `Your current position: "${sanitizeForDisplay(targetAgent.reflection.slice(0, 240))}"` : "";

  return `## Evidence Request — to ${sanitizeForDisplay(targetAgent.config.name)} (${targetAgent.config.tier}) from ${safeSourceName} (${sourceAgent.config.tier})

Context:
"${safeContribution}"

Evidence question:
"${safeQuestion}"

${recentMine ? recentMine + "\n\n" : ""}${reflectionLine ? reflectionLine + "\n\n" : ""}Seniority: ${seniorityContext}
Round: ${roundContext}

## Task
Provide grounded evidence (${LENGTH_LIMITS.evidenceWords} words). No contribution tags.
Required structure:
- Finding: {one sentence answer}
- Source: {URL or [#id] or “searched X, 0 hits”}
- Strength: strong | weak | inconclusive — and why (sample size, recency, conflict)
If inconclusive, name what would resolve it. Stay in character — translate evidence through your lens.
${toolSection}`;
}

/**
 * Builds a prompt for a voting agent to cast their vote on a poll.
 */
export function buildVotePrompt(sourceAgent, targetAgent, sourceContribution, question, roundContributions, currentRound, maxRounds, stateOfPlay = "") {
  const safeSourceName = sanitizeForDisplay(sourceAgent.config.name);
  const safeQuestion = sanitizeForDisplay(question);

  const sourceSnippet = sanitizeForDisplay(
    typeof sourceContribution === "string" ? sourceContribution : sourceContribution?.content ?? "",
    500
  );

  const reflectionLine = targetAgent.reflection ? `Your current position: "${sanitizeForDisplay(targetAgent.reflection.slice(0, 200))}"` : "";
  const recentMine = getRecentContributionsBlock(roundContributions, targetAgent.config.id);
  const roundContext = buildRoundContext(currentRound, maxRounds);
  let sopOptions = "";
  let sopFallbackNote = "";
  if (stateOfPlay) {
    const decisions = stateOfPlay.split("## Decisions")[1]?.split("##")[0] || "";
    const decisionLines = decisions.split("\n").filter(l => l.trim().startsWith("-")).slice(0, 4).map((l,i) => `${i+1}. ${sanitizeForDisplay(l.slice(2).trim().slice(0, 120))}`).join("\n");
    if (decisionLines) {
      sopOptions = `SoP Decisions (vote by number if question not lettered):\n${decisionLines}\n`;
      sopFallbackNote = `If vote question lists A) B) C), vote by letter: [Vote: A]. If not lettered, vote by SoP number: [Vote: 2]. Both formats accepted: [Vote: A] or [Vote: 2].\n`;
    }
    sopOptions = `State of Play — Decisions & Disagreements (your vote is on these):\n${sanitizeForDisplay(stateOfPlay, 650)}\n\n${sopOptions}${sopFallbackNote}`;
  }
  const sopSnippet = sopOptions;

  return `## Vote Requested — to ${sanitizeForDisplay(targetAgent.config.name)} (${targetAgent.config.tier}) from ${safeSourceName} (${sourceAgent.config.tier})

Source proposal (excerpt):
"${sourceSnippet.slice(0, 400)}"

Vote question:
"${safeQuestion}"

${sopSnippet}${recentMine ? recentMine + "\n" : ""}${reflectionLine ? reflectionLine + "\n" : ""}Round: ${roundContext}

## Task — Cast Your Vote

Choose one option. If the vote question lists A) B) C) … vote by letter. If it lists 1) 2) 3) or is unlettered, vote by SoP number.

Format exactly (both accepted for backward compat):
[Vote: A]  or  [Vote: 2]
One sentence criterion (cost / risk / time / reversibility) for your choice, citing [#id] that motivated your vote if possible.

No contribution tags. Stay in character — your criterion should reflect your agenda.`;
}

/**
 * Builds a prompt for a summoned guest expert persona.
 */
export function buildSummonPrompt(summonedPersona, requester, issue, roundContributions, currentRound, maxRounds, stateOfPlay = "") {
  const safeRequesterName = sanitizeForDisplay(requester.config.name);
  const safeIssue = sanitizeForDisplay(issue);
  const safePersonaName = sanitizeForDisplay(summonedPersona.name);

  const issueTokens = safeIssue.toLowerCase().split(/\W+/).filter(t => t.length > 3);
  const scored = (roundContributions || []).map((c) => {
    const hay = `${c.content || ""} ${c.participant_id || ""} ${c.type || ""}`.toLowerCase();
    let score = 0;
    for (const tok of issueTokens) if (hay.includes(tok)) score += 1;
    if (c.tool_calls && c.tool_calls.length > 0) score += 0.5;
    return { c, score };
  }).sort((a,b) => b.score - a.score || (b.c.id||0) - (a.c.id||0));
  const selected = scored.length > 0 ? scored.slice(0, 4).map(s=>s.c).sort((a,b)=>(a.id||0)-(b.id||0)) : [];
  const recentContributions = selected
    .map((c) => {
      const id = c.id != null ? `[#${c.id}]` : "";
      return `- ${id} [${c.participant_id}] (${c.type}): ${sanitizeForDisplay(c.content).slice(0, 280)}`;
    })
    .join("\n");
  const recentBlock = recentContributions.length > 0
    ? `### Recent Relevant Contributions (relevance-scored, top 4)\n${recentContributions}`
    : "*(No prior contributions yet)*";

  const roundContext = buildRoundContext(currentRound, maxRounds);
  const expertise = Array.isArray(summonedPersona.expertise)
    ? summonedPersona.expertise.join(", ")
    : summonedPersona.expertise || "general";
  const style = summonedPersona.communication_style || "Direct and professional";
  const sopSnippet = stateOfPlay
    ? `\n### State of Play — Decisions (what’s settled, build on it)\n${sanitizeForDisplay(stateOfPlay, 700)}\n`
    : "";

  return `## Guest Expert — ${safePersonaName} (${summonedPersona.tier}) summoned by ${safeRequesterName} (${requester.config.tier})

### Your Persona
${sanitizeForDisplay(summonedPersona.persona, 600)}

### Expertise
${sanitizeForDisplay(expertise, 300)}

### Voice
${sanitizeForDisplay(style, 300)}

Issue you were summoned for:
"${safeIssue}"
${sopSnippet}
${recentBlock}

Round: ${roundContext}

## Guest Norms
- Additive, not adversarial. Build on what’s settled; don’t re-litigate State-of-Play without new evidence.
- Synthesize through your expert lens; name one constraint others missed.
- ${LENGTH_LIMITS.summonWords} words, no contribution tags. If you use a tool, cite Source: URL or [#id].
- If tool returns error or 0 hits, write “evidence unavailable” and proceed with experience.

Provide your expert perspective — concise, grounded, in character.`;
}

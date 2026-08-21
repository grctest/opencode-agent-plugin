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

// ──────────────────────────────────────────────────────────────────────────────
// Shared helpers — deduplicated prelude for reflection / query / evidence
// ──────────────────────────────────────────────────────────────────────────────

function getRecentContributionsBlock(contributions, participantId) {
  if (!contributions || contributions.length === 0) return "";
  const mine = contributions
    .filter((c) => c.participant_id === participantId && c.type !== "pass")
    .slice(-2)
    .map((c) => sanitizeForDisplay(c.content));
  if (mine.length === 0) return "";
  return `Your last contributions:\n${mine.map((c) => `- "${c.slice(0, 300)}"`).join("\n")}`;
}

function getReflectionBlock(reflection) {
  if (!reflection) return "";
  return `Your current position:\n"${sanitizeForDisplay(reflection.slice(0, 500))}"`;
}

function buildEvidenceGuidance(kind) {
  const cfg = getConfig().agentTools;
  const toolsDisabled = !cfg?.enabled;
  if (toolsDisabled) {
    if (kind === "evidence") {
      return `
## Research Tools — Evidence (tools disabled)

Tools are currently disabled in config. Do NOT claim tool use.
Ground your answer with “in my experience…” + what vec recall or prior [#id] would verify if tools were available. State “evidence unavailable — tools disabled” and proceed with a falsifiable claim.`;
    }
    if (kind === "query") {
      return `
## Research Tools — Query (tools disabled)

Tools disabled — answer from deliberation context only. If you don’t know, say “insufficient evidence — tools disabled”. Cite [#id] if you use prior contributions.`;
    }
    if (kind === "reflection") {
      return `
## Research Tools — Reflection (tools disabled)

Tools disabled — reflect from deliberation only. Cite [#id] when referencing prior contributions. Reflection is visible — ground it in what was said.`;
    }
    return "";
  }
  if (kind === "reflection") {
    return `
## Research Tools — Reflection (optional but grounded)

Tool ladder: loom_vector_search (recall what was said) → websearch (verify current fact) → read/grep (verify local file) → webfetch (deep dive ONLY after a search hit). One call max unless evidence request.
For code analysis in this folder (react, file paths, bug): prioritize read/glob/grep first to inspect the file before revising.

- **loom_vector_search**: recall a prior [#id] you’re citing — prefer this over memory
- **websearch**: verify a claim before you revise your stance
- **webfetch**: open a URL returned by websearch
- **read**: inspect a file referenced in discussion (first for code analysis)

Cite as Source: [#id] or Source: https://… or file=src/... . Synthesize, don’t dump. Reflection is visible — ground it.
If tool returns error or 0 hits, write “evidence unavailable — searched X, 0 hits” and proceed with experience-qualified claim. Do not retry same query.`;
  }
  if (kind === "query") {
    return `
## Research Tools — Query (optional)

You may call one tool to verify before answering. Prefer loom_vector_search if the answer is “what was said”, websearch if it’s a current fact. Cite Source: [#id] or URL if you use one.
If tool returns error or 0 hits, write “evidence unavailable — searched X” and answer with “insufficient evidence” qualified.`;
  }
  if (kind === "evidence") {
    return `
## Research Tools — Evidence (REQUIRED)

You MUST call at least one tool. No speculation.

Tool ladder: websearch → webfetch/read/loom_vector_search. One focused query, then synthesize.

Report: Finding (1 sentence) + Source (URL or [#id]) + Strength: strong | weak | inconclusive
If inconclusive: state why — “0 hits” vs “contradictory sources” — and what would resolve it.
If tool returns error or 0 hits, write “evidence unavailable — searched X, 0 hits” and explain what would resolve it; do not retry same query.`;
  }
  return "";
}

function buildSeniorityContext(listenerName, listenerTier, triggerName, triggerTier, listenerLevel, triggerLevel) {
  // Evidence-weighted, not rank-weighted. All levels judged by citation strength.
  if (triggerLevel > listenerLevel) {
    return `${triggerName} (${triggerTier}) is senior to you (${listenerTier}). Assess by evidence strength: cited Source or [#id] > uncited claim. If they cited, address the citation; if not, you may request it. Hold your ground if evidence is weak.`;
  } else if (triggerLevel < listenerLevel) {
    return `${triggerName} (${triggerTier}) is junior to you (${listenerTier}). Assess by evidence strength, not seniority. Engage the claim’s falsifiable implication; if they surfaced a constraint, name it.`;
  } else {
    return `${triggerName} (${triggerTier}) is your peer (same tier). Assess by evidence strength; engage point-for-point with a counter-citation or falsifiable scenario if you disagree.`;
  }
}

function buildRoundContext(currentRound, maxRounds) {
  if (!currentRound || !maxRounds) {
    return "Round context unknown — focus on substance and whether the trigger introduces new evidence.";
  }
  const progress = currentRound / maxRounds;
  if (progress <= 0.33) {
    return `Early deliberation (round ${currentRound}/${maxRounds}) — DIVERGE. Surface assumptions, name at least one hidden constraint, introduce distinct options. Don’t converge yet.`;
  } else if (progress <= 0.66) {
    return `Mid deliberation (round ${currentRound}/${maxRounds}) — CONVERGE candidates. Identify what’s settled vs contested, bundle related proposals, name the decision that would unlock next steps.`;
  } else {
    return `Late deliberation (round ${currentRound}/${maxRounds}) — LOCK or LEAVE OPEN. Avoid re-litigating settled points. If you reopen, cite new evidence. End with Position: [held|revised|expanded] because …`;
  }
}

function buildTierDoctrine(tier, guidance) {
  // Guidance is already persona-specific and now diversified; wrap with verb-first doctrine.
  const doctrineMap = {
    junior: "Junior doctrine: surface one naive question that exposes an unstated senior assumption. Offer a concrete example from your lens, then ask ‘What would we need to learn to answer it?’",
    mid: "Mid doctrine: make one tradeoff explicit (cost / time / risk / quality). Translate a claim into a number or a measurable check.",
    senior: "Senior doctrine: name the irreversible commitment and its mitigation/rollback. Cite one pattern or precedent you’ve seen.",
    principal: "Principal doctrine: if at impasse, frame 2 options + decision criterion (cost, risk, time, reversibility) and a tie-break. Cut re-litigation: state ‘Settled: … Open: …’",
    civilian: "Civilian doctrine: ground in lived routine. Test the proposal against a real Tuesday: time, money, safety, fatigue. ‘On my Tuesday at 7am this means …’",
  };
  const doc = doctrineMap[tier] ?? "Contribute a falsifiable claim or question — avoid generalities.";
  // Persona’s tier_guidance is appended as the voice, not the rule.
  const safe = escapeDelimiters(sanitizeForDisplay(guidance, 1000));
  return `${doc}\n${safe}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Reflection / Query / Evidence / Vote / Summon
// ──────────────────────────────────────────────────────────────────────────────

/** Builds a prompt asking a listener to reflect on a speaker's contribution. */
export function buildReflectionPrompt(listener, triggerParticipant, contribution, roundContributions, currentRound, maxRounds) {
  const safeSpeaker = sanitizeForDisplay(triggerParticipant.config.name);
  const safeContribution = sanitizeForDisplay(contribution);
  const guidance = listener.config.reflection_guidance || "Apply your domain lens; end with Position: [held|revised|expanded] because …";

  const previousReflection = listener.reflection || "";
  const TIER_ORDER = { junior: 0, mid: 1, senior: 2, principal: 3, civilian: 1 };
  const listenerTierLevel = TIER_ORDER[listener.config.tier] ?? 1;
  const triggerTierLevel = TIER_ORDER[triggerParticipant.config.tier] ?? 1;

  const seniorityContext = buildSeniorityContext(
    listener.config.name, listener.config.tier,
    triggerParticipant.config.name, triggerParticipant.config.tier,
    listenerTierLevel, triggerTierLevel
  );
  const roundContext = buildRoundContext(currentRound, maxRounds);
  const toolSection = buildEvidenceGuidance("reflection");

  // Compress prior state to 1-sentence each (saves ~400 tokens vs prior 3-block dump)
  const compressedPrior = previousReflection
    ? `Your prior position (1 sentence): "${sanitizeForDisplay(previousReflection.slice(0, 280))}" — keep what holds, revise what changed, add what’s new.`
    : "You have no prior reflection — take a clear initial position.";

  const recentMine = getRecentContributionsBlock(roundContributions, listener.config.id);

  // Verb-first lens from persona; no templated boilerplate suffix — shared footer handles it.
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
Write a concise reflection (80-150 words) visible to all participants.
Structure: 1) What the trigger gets right/wrong with citation or scenario, 2) How your lens changes the view, 3) Closing line: Position: [held|revised|expanded] because {one falsifiable cause}.
If you cite deliberation content, use [#id]; if you cite external fact, use Source: URL. Do not re-emit <<< >>> boundaries.
${toolSection}`;
}

/** Builds a prompt for a queried agent to respond to a direct question from another agent. */
export function buildQueryPrompt(sourceAgent, targetAgent, sourceContribution, question, roundContributions, currentRound, maxRounds, stateOfPlay = "") {
  const safeSourceName = sanitizeForDisplay(sourceAgent.config.name);
  const safeQuestion = sanitizeForDisplay(question);
  const safeContribution = sanitizeForDisplay(sourceContribution);

  const TIER_ORDER = { junior: 0, mid: 1, senior: 2, principal: 3, civilian: 1 };
  const seniorityContext = buildSeniorityContext(
    targetAgent.config.name, targetAgent.config.tier,
    sourceAgent.config.name, sourceAgent.config.tier,
    TIER_ORDER[targetAgent.config.tier] ?? 1,
    TIER_ORDER[sourceAgent.config.tier] ?? 1,
  );
  const roundContext = buildRoundContext(currentRound, maxRounds);
  const toolSection = buildEvidenceGuidance("query");

  const recentMine = getRecentContributionsBlock(roundContributions, targetAgent.config.id);
  const reflectionLine = targetAgent.reflection ? `Your current position: "${sanitizeForDisplay(targetAgent.reflection.slice(0, 240))}"` : "";
  const sopSnippet = stateOfPlay ? `State of Play — Open Questions (what answer would unblock):\n${sanitizeForDisplay(stateOfPlay, 600)}\n\n` : "";

  return `## Direct Query — to ${sanitizeForDisplay(targetAgent.config.name)} (${targetAgent.config.tier}) from ${safeSourceName} (${sourceAgent.config.tier})

Context (what they said):
"${safeContribution}"

Their question:
"${safeQuestion}"

${sopSnippet}${recentMine ? recentMine + "\n\n" : ""}${reflectionLine ? reflectionLine + "\n\n" : ""}Seniority: ${seniorityContext}
Round: ${roundContext}

## Task
Answer in 2-4 sentences, no contribution tags ([PROPOSE] etc). Address the specific question; if it’s “what was said”, prefer loom_vector_search over memory. If you don’t know, say “insufficient evidence” — do not speculate. Cite Source: [#id] or URL if you use evidence. Stay in character.
${toolSection}`;
}

/**
 * Builds a prompt for an evidence request — the target MUST use tools to find evidence.
 */
export function buildEvidencePrompt(sourceAgent, targetAgent, sourceContribution, question, roundContributions, currentRound, maxRounds) {
  const safeSourceName = sanitizeForDisplay(sourceAgent.config.name);
  const safeQuestion = sanitizeForDisplay(question);
  const safeContribution = sanitizeForDisplay(sourceContribution);

  const TIER_ORDER = { junior: 0, mid: 1, senior: 2, principal: 3, civilian: 1 };
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
Provide grounded evidence (100-180 words). No contribution tags.
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

  // Extract a concise source context (first 400 chars of source contribution)
  const sourceSnippet = sanitizeForDisplay(
    typeof sourceContribution === "string" ? sourceContribution : sourceContribution?.content ?? "",
    500
  );

  const reflectionLine = targetAgent.reflection ? `Your current position: "${sanitizeForDisplay(targetAgent.reflection.slice(0, 200))}"` : "";
  const recentMine = getRecentContributionsBlock(roundContributions, targetAgent.config.id);
  const roundContext = buildRoundContext(currentRound, maxRounds);
  // Parse SoP Decisions into numbered options for deterministic voting
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

  // Relevance-based recent contributions: score by keyword overlap with issue, not recency
  const issueTokens = safeIssue.toLowerCase().split(/\W+/).filter(t => t.length > 3);
  const scored = (roundContributions || []).map((c) => {
    const hay = `${c.content || ""} ${c.participant_id || ""} ${c.type || ""}`.toLowerCase();
    let score = 0;
    for (const tok of issueTokens) if (hay.includes(tok)) score += 1;
    // Boost evidence-backed and recent within round
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
- 100-150 words, no contribution tags. If you use a tool, cite Source: URL or [#id].
- If tool returns error or 0 hits, write “evidence unavailable” and proceed with experience.

Provide your expert perspective — concise, grounded, in character.`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Moderator & Turn Order
// ──────────────────────────────────────────────────────────────────────────────

/** Builds a prompt for the moderator to plan turn order for the next round. */
export function buildTurnOrderPrompt(stateOfPlay, roundSummary, turnRequests, participants) {
  const safeStateOfPlay = escapeDelimiters(sanitizeForDisplay(stateOfPlay, 2000));
  const safeRoundSummary = escapeDelimiters(sanitizeForDisplay(roundSummary, 1000));

  const requestsList = turnRequests.map((r) => {
    const p = participants.find((pp) => pp.config.id === r.participant_id);
    const name = p?.config.name ?? r.participant_id;
    const tier = p?.config.tier ?? "mid";
    // Include type hint if available on request (challenge vs propose)
    const hint = r.type ? ` (${r.type})` : "";
    const toolHint = r.hasEvidence ? " [evidence]" : "";
    return `  - ${r.participant_id} (${name}, ${tier}${hint}${toolHint}): Priority ${r.priority} — "${sanitizeForDisplay(r.reason, 100)}"`;
  }).join("\n");

  const participantsList = participants
    .filter((p) => p.status !== "failed")
    .map((p) => {
      const cnt = p.contributions_count ?? 0;
      const didPass = p.status === "passed" ? " [passed last round]" : "";
      const hasReflect = p.reflection ? " [has reflection]" : "";
      return `  - ${p.config.id} (${p.config.name}, ${p.config.tier}, ${cnt} contribs${didPass}${hasReflect})`;
    })
    .join("\n");

  return `You are the turn order planner for a multi-agent deliberation. Favor longer, richer deliberation — give diverse voices room. Avoid starvation.

## Current State of Play
${safeStateOfPlay || "(No state of play yet)"}

## Last Round Summary
${safeRoundSummary || "(First round)"}

## Agent Turn Requests (priority already capped by tier)
${requestsList || "(No requests — use default order)"}

## Active Participants
${participantsList}

## Task
Return a JSON array of participant IDs ordered by who should speak first to push deliberation forward thoroughly.

Ranking doctrine (in order):
1. Strong evidence-backed challenges/requests first — tool output with Strength: strong or [#id] citation signals substance; weak/inconclusive does not outrank a substantive propose
2. Higher priority requests next (intrinsic urgency)
3. Proposals introducing a new distinct option before refinements/supports of an existing one
4. Anti-starvation: anyone who spoke last without new reflection/evidence is demoted one rank
5. Tie-break: (a) who spoke least recently, then (b) seniority principal > senior > mid > junior > civilian

Constraints:
- Include every active participant exactly once
- Consider State of Play to avoid immediate circular re-litigation (same 2 speakers challenge↔challenge without third voice = circular)
- If no requests, return participants in current order

Respond with ONLY a JSON array: ["id1", "id2", "id3"]`;
}

/** Builds a prompt for the moderator to rule on deadlocks, circular arguments, or force convergence. */
export function buildModeratorPrompt(situation, currentRound, maxRounds, totalContributions, recentContributions, previousRulings = [], stateOfPlay = "") {
  const safeSituation = escapeDelimiters(sanitizeForDisplay(situation, 500));
  const contributionsList = recentContributions.map((c) => {
    const budget = (c.type === "challenge" || c.type === "dissent" || c.type === "evidence_response") ? 220 : 140;
    const snippet = c.content ? escapeDelimiters(sanitizeForDisplay(c.content.slice(0, budget))) : "(no content)";
    const evidenceTag = (c.tool_calls && c.tool_calls.length > 0) ? ` [tools:${c.tool_calls.map(t=>t.tool).join(',')}]` : "";
    return `  - [${c.type ?? "?"}] ${c.participant_id ?? "?"}${evidenceTag}: ${snippet}`;
  }).join("\n");

  const relevantRulings = previousRulings.length > 10 ? previousRulings.slice(-10) : previousRulings;
  const rulingsSection = relevantRulings.length > 0
    ? `\n## Your Previous Rulings (for consistency — don’t contradict without new evidence)\n${relevantRulings.map((r, i) => `  ${i + 1}. Round ${r.round}: ${escapeDelimiters(sanitizeForDisplay(r.decision, 120))} → ${escapeDelimiters(sanitizeForDisplay(r.next_speaker, 60))}${r.reason ? ` — ${escapeDelimiters(sanitizeForDisplay(r.reason, 120))}` : ""}`).join("\n")}\n`
    : "";

  const stateOfPlaySection = stateOfPlay
    ? `\n## Current State of Play\n${escapeDelimiters(sanitizeForDisplay(stateOfPlay, 2000))}\n\nUse this to score NEW_INFO: if last round’s points already appear in Agreements/Decisions with no new evidence, NEW_INFO=0. A legitimate dispute has unresolved Disagreements/Open Questions that need more voices.\n`
    : "";

  return `You are the MODERATOR — process governor, not participant. You do not contribute domain opinions. You govern flow. Default bias: KEEP DELIBERATING. Only converge when deliberation is genuinely exhausted — this group prefers thorough over terse.

## Governance Doctrine (longer deliberation default)

Favor thoroughness over speed. The group values dissent and edge cases. Only cut off when NEW_INFO is truly zero.

## Rubric — score 0-2 each

- NEW_INFO: Does last round introduce evidence/tool output or a distinct option not already in State-of-Play Decisions/Agreements? 0=none, 1=one new angle, 2=multiple new evidence/options
- ENTRENCHMENT: Are the same 2 participants exchanging challenge↔challenge/dissent without a third voice or new evidence? 0=diverse, 1=mild repetition, 2=entrenched loop
- COVERAGE: Have ≥70% of active participants contributed meaningfully this round (not just [PASS])? 0=sparse, 1=partial, 2=broad
- DISSENT_DEPTH: Is there substantive unresolved Disagreements/Open Questions that deserve more voices before synthesis? 0=shallow/none, 1=one real dispute, 2=multiple substantive disputes

Ruling policy (bias toward continue):
- converge (next_speaker: synthesize) ONLY if NEW_INFO=0 AND COVERAGE≥1 AND (ENTRENCHMENT≥1 OR DISSENT_DEPTH=0) AND round ≥ minRounds
- break (next_speaker: <active_id>) if ENTRENCHMENT=2 — redirect to the under-heard voice or the holder of the uncovered dissent
- otherwise continue

${rulingsSection}
${stateOfPlaySection}## Situation Flagged by Heuristics
${safeSituation}

## Deliberation State
Round: ${currentRound}/${maxRounds} (minRounds enforced externally — you may still return synthesize, it will be deferred)
Contributions so far: ${totalContributions}
Recent contributions (last up to 7):
${contributionsList}

## Respond With Your Ruling — EXACT FORMAT REQUIRED
<ruling>
decision: <one sentence: continue | redirect to <name> | converge>
next_speaker: <participant_id or "synthesize" or "continue">
reason: <one sentence referencing rubric scores, e.g. "NEW_INFO 0, ENTRENCHMENT 2, COVERAGE 2 — entrenched loop between X and Y without new evidence">
</ruling>

IMPORTANT: Respond ONLY with the <ruling> block. No other text. next_speaker must be one of: continue, synthesize, or an active participant_id. If you return synthesize before minRounds, it will be deferred.`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Synthesis — mode-aware (conversational vs code-analysis, read-only)
// ──────────────────────────────────────────────────────────────────────────────

export function detectTaskMode(question, tags = []) {
  const q = (question || "").toLowerCase();
  const tagStr = (tags || []).join(" ").toLowerCase();
  const combined = q + " " + tagStr;
  // Code signals: file paths, react, bug/stack, src/, .tsx/.ts/.js, "in this folder", "how would you fix"
  const codeSignals = [
    /\breact\b/, /\bnext\.js\b/, /\btsx\b/, /\btypescript\b/,
    /\bsrc\//, /\.tsx\b/, /\.ts\b/, /\.js\b/, /\.jsx\b/,
    /in this folder/, /in my project/, /how would you.*fix/, /propose.*fix/,
    /\bbug\b/, /\berror\b/, /\bstack\b/, /\brepro\b/, /\brefactor\b/, /\bhook\b/, /\bhydration\b/
  ];
  const hits = codeSignals.filter(rx => rx.test(combined)).length;
  if (hits >= 1) return "code-analysis";
  // Engineering tag + folder context also counts
  if (tagStr.includes("engineering") && (q.includes("file") || q.includes("code") || q.includes("project"))) return "code-analysis";
  return "conversational";
}

/** Builds a prompt for synthesizing the final deliberation artifact from all contributions. */
export function buildSynthesisPrompt(question, transcript, participants = [], tags = [], stateOfPlay = "", objections = []) {
  const mode = detectTaskMode(question, tags);
  const isCode = mode === "code-analysis";
  const safeQuestion = escapeDelimiters(sanitizeForDisplay(question, 20000));
  const safeTranscript = escapeDelimiters(sanitizeForDisplay(transcript, 100000));
  const participantsSection = participants.length > 0
    ? `\n## Participants (activity)\n${participants.map((p) => `- ${escapeDelimiters(sanitizeForDisplay(p.config.name, 80))} (${p.config.tier}): ${p.contributions_count} contributions${p.status === "failed" ? " [failed]" : p.status === "passed" ? " [passed late]" : ""}`).join("\n")}\n`
    : "";

  const tagContext = tags?.length > 0 ? escapeDelimiters(tags.join(", ")) : null;

  const stateOfPlaySection = stateOfPlay
    ? `\n## State of Play (Final — PRIMARY source)\n${escapeDelimiters(sanitizeForDisplay(stateOfPlay, 20000))}\n`
    : "";

  const unresolvedObjections = (objections ?? []).filter((o) => o.unresolved);
  const resolvedObjections = (objections ?? []).filter((o) => !o.unresolved);
  const objectionsSection = unresolvedObjections.length > 0
    ? `\n## Unresolved Dissent (must appear in Dissenting Views with holder + [#id])\n${unresolvedObjections.map((o) => `- ${escapeDelimiters(sanitizeForDisplay(o.content, 600))} (holder: ${escapeDelimiters(sanitizeForDisplay(o.participant_id ?? "unknown", 80))})`).join("\n")}\n`
    : "";
  const resolvedSection = resolvedObjections.length > 0
    ? `\n## Resolved Concerns (do NOT re-list as dissent)\n${resolvedObjections.map((o) => `- ${escapeDelimiters(sanitizeForDisplay(o.content, 600))} (resolved)`).join("\n")}\n`
    : "";

  const modeNote = isCode
    ? `\n## Mode: Code-Analysis (read-only)\nYou are synthesizing a react/project coding analysis. Include concrete Proposed Fix diffs with file= paths. Novel synthesized fixes are allowed when marked “Proposed — synthesized from [#id]”.\n`
    : `\n## Mode: Conversational\n`;

  const groundingRule = isCode
    ? `1. **Grounding:** Prefer citing [#id] or State-of-Play. If you synthesize a novel fix/code not present verbatim, mark it “Proposed — synthesized from [#id]” and keep it. Do not invent file contents not read via tool; if no file was read, qualify as “Proposed (unverified — no tool read)”.\n`
    : `1. **Grounding:** Prefer citing [#id] or State-of-Play. If you synthesize a novel conclusion, mark it “Proposed — synthesized from [#id]” and keep it. Do not invent numbers/dates unsupported by transcript/State-of-Play.\n`;

  const lengthSection = isCode
    ? `## Length — per-section budget (code-analysis, allow diffs)

- Decision: 80-120 words — one paragraph, cites [#id]s
- Reasoning: 150-250 words — 3-7 bullets, who argued what + evidence + tradeoff, cite [#id] or State-of-Play
- Proposed Fix: 150-350 words — Files: \`path\` + diffs \`\`\`tsx file=src/...\`\`\` + why, mark Proposed if synthesized
- Action Items: 80-120 words — verbs with owners or “proposed: X” + cites (may be “None — see Proposed Fix”)
- Dissenting Views: 80-120 words — each holder + [#id] (Unresolved Objections mandatory)
- Open Questions: 60-90 words — why remains (missing evidence / tradeoff)
- Confidence: 20-40 words — one word + rubric justification
Total 700-1200 words welcome; preserve numbers and code verbatim — do not round or invent figures not in transcript/SoP.\n`
    : `## Length — per-section budget (stay within, prefer thoroughness within budget)

- Decision: 80-120 words — one paragraph, cites [#id]s
- Reasoning: 150-250 words — 3-7 bullets, each who argued what + evidence + tradeoff, cite [#id] or State-of-Play
- Action Items: 80-120 words — verbs with owners or “proposed: X” + cites
- Dissenting Views: 80-120 words — each holder + [#id] (Unresolved Objections mandatory)
- Open Questions: 60-90 words — why remains (missing evidence / tradeoff)
- Confidence: 20-40 words — one word + rubric justification
Total 500-900 words welcome; preserve numbers verbatim — do not round or invent figures not in transcript/SoP.\n`;

  const requiredSections = isCode
    ? `## Required Sections — output these exact headings in this order, even if empty (write “None”)

## Decision
One-paragraph direct answer to the Original Question, citing key [#id]s. Preserve numbers verbatim.

## Reasoning
3-7 bullets or short paragraphs. Each bullet should reference who argued what and on what evidence. Show tradeoffs considered. Cite [#id] or State-of-Play. Preserve numbers verbatim.

## Proposed Fix
Files involved + diffs with \`\`\`tsx file=src/...\`\`\` blocks. Mark any novel synthesized snippet “Proposed — synthesized from [#id]”. Preserve code verbatim; do not invent file contents not read.

## Action Items
- {verb} {what} — owner: {name or “proposed: X”} — cites [#id]
(Empty → “None — see Proposed Fix.”)

## Dissenting Views
Each dissent on its own line: **{Holder}** ({tier}): {view} — [#id]
If none, write “None — all active participants converged or passed.”
Unresolved Objections above must appear here.

## Open Questions
- {question that remains} — why it remains (missing evidence / unresolved tradeoff)`
    : `## Required Sections — output these exact headings in this order, even if empty (write “None”)

## Decision
One-paragraph direct answer to the Original Question, citing key [#id]s. Preserve numbers verbatim.

## Reasoning
3-7 bullets or short paragraphs. Each bullet should reference who argued what and on what evidence. Show tradeoffs considered. Cite [#id] or State-of-Play. Preserve numbers verbatim.

## Action Items
- {verb} {what} — owner: {name or “proposed: X”} — cites [#id]
(Empty → “None — deliberation surfaced no actionable consensus.”)

## Dissenting Views
Each dissent on its own line: **{Holder}** ({tier}): {view} — [#id]
If none, write “None — all active participants converged or passed.”
Unresolved Objections above must appear here.

## Open Questions
- {question that remains} — why it remains (missing evidence / unresolved tradeoff)`;

  return `You are the synthesis auditor. The deliberation is complete. Produce the final artifact — comprehensive, citation-grounded, open-ended for both conversational and code-analysis tasks.
${modeNote}
## Original Question
${safeQuestion}
${tagContext ? `\n## Tags (topic)\n${tagContext}\n` : ""}
${stateOfPlaySection}${objectionsSection}${resolvedSection}
## Deliberation Transcript (supporting detail — cite [#id] when using it)
${safeTranscript}
${participantsSection}
## Synthesis Doctrine

You are not a participant. You are an auditor. Every claim you make must be traceable.

${groundingRule}2. **Attribution:** Every Dissenting View must name holder + [#id]. Unresolved Objections above are mandatory dissent — include them.
3. **No invention:** Do not invent numbers, dates, costs, tool results, or participant positions not in transcript/State-of-Play. If evidence conflicts, state both and set Confidence accordingly. For code, do not invent file contents not read via tool.
4. **Resolved ≠ dissent:** Items in Resolved Concerns must NOT reappear as Dissenting Views.
5. **Actionability:** Action Items are verbs with owners or “proposed owner: …” if unattributed.

${lengthSection}
${requiredSections}

## Confidence
One word: High | Medium | Low — then 1 sentence justification referencing the rubric:

- High = ≥70% active participants contributed meaningfully AND 0 unresolved objections AND at least one tool- or vec-grounded claim
- Medium = broad participation with 1 dissent, or majority participation with some passes
- Low = significant disagreement remains, or many participants failed/passed, or key claims are ungrounded

Cite rubric condition you met.

## Negative Example (do NOT do this)
## Decision
We should migrate to JWT because everyone agreed.  ← BAD: no citations, vague consensus claim
## Dissenting Views
None  ← BAD when transcript has [CHALLENGE] entries
${isCode ? "\n## Negative Example (code) — do NOT do this\n## Proposed Fix\nFix hydration by editing layout.tsx.  ← BAD: no file=, no ``` block, no Proposed marking\n" : ""}

## Good Fragment (abstract, domain-free)
## Decision
Adopt option B (incremental rollout of X) — [#4][#7] converged on risk/reversibility over speed. [#9]’s cost analysis (Source: https://… ) supports Q1 pilot.
## Reasoning
- **Staff Lead (senior, [#4])** proposed B citing maintainability; **Security Engineer (mid, [#5])** challenged revocation, then reflected [#14] accepting short-lived tokens with rotation.
${isCode ? "\n## Good Fragment (code-analysis)\n## Proposed Fix\n- Files: `src/app/layout.tsx:18` — hydration mismatch from client-only hook\n- Diff: ```tsx file=src/app/layout.tsx\n  // Proposed — synthesized from [#4][#7]\n  'use client';\n  import { useEffect, useState } from 'react';\n  // guard hydration: only render after mount\n  ```\n  Why: [#4] read src/app/layout.tsx via read tool; [#7] challenge on useEffect stale closure. [#9] evidence via grep.\n" : ""}
`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Agent system / user prompts — hierarchy rebuild
// ──────────────────────────────────────────────────────────────────────────────

/** Builds the system prompt for an agent in the multi-session architecture (identity + rules). */
export function buildAgentSystemPrompt(participant) {
  const tier = participant.config.tier;
  const cfg = participant.config;

  const safePersonaRaw = typeof cfg.persona === 'string' ? cfg.persona : '';
  const safeAgendaRaw = typeof cfg.agenda === 'string' ? cfg.agenda : '';
  const safePersona = escapeDelimiters(sanitizeForDisplay(safePersonaRaw, 800));
  const safeAgenda = escapeDelimiters(sanitizeForDisplay(safeAgendaRaw, 400));

  const tierGuidance = cfg.tier_guidance || "Contribute a falsifiable claim, question, or refinement — avoid generalities.";
  const doctrine = buildTierDoctrine(tier, tierGuidance);

  const priorityCap = TURN_REQUEST_PRIORITY_CAP[tier] ?? 5;

  // Tool ladder — single source of truth, rendered from config, not duplicated strings
  const agentToolsConfig = getConfig().agentTools;
  const toolSection = agentToolsConfig?.enabled
    ? (() => {
        const t = agentToolsConfig;
        const builtIn = t.builtIn ?? {};
        const has = (k) => !!builtIn[k] || !!builtIn[k.replace('web', 'web_')];
        const tools = [];
        if (has('websearch')) tools.push('websearch');
        if (has('webfetch')) tools.push('webfetch');
        if (has('read')) tools.push('read');
        if (builtIn.glob) tools.push('glob');
        if (builtIn.grep) tools.push('grep');
        if (builtIn.bash?.enabled || builtIn.bash === true) tools.push('bash');
        if (t.loom?.loom_vector_search) tools.push('loom_vector_search');
        const toolList = tools.length ? tools.join(', ') : 'none enabled';
        return `
## Research Tools — Tool Ladder (use at most one per turn unless [EVIDENCE] requests)

Available: ${toolList}

Ladder: loom_vector_search (recall what was said → cheapest) → websearch (verify current fact) → read/grep/glob (verify local file) → webfetch (deep dive ONLY after a search hit)
For code analysis in this folder (react, bug, file paths, src/, hydration, error in this folder): prioritize read/glob/grep first to inspect project files, then recall — file=src/... citations require a read.
- **loom_vector_search**: “what did [#12] actually say?” — prefer over memory
- **websearch**: current data, benchmarks, alternatives, precedents
- **read / grep / glob**: inspect project files referenced in discussion (first for code analysis)
- **webfetch**: open a URL returned by websearch (don’t guess URLs)
- **bash**: only allowlisted commands (${Array.isArray(builtIn.bash?.allowlist) ? builtIn.bash.allowlist.join(', ') : 'git, ls, wc, head, tail, grep, find'})

Quality:
- One focused query beats three vague ones. Synthesize, don’t dump.
- If a tool is rejected as invalid, retry with exact names above — don’t silently fall back to memory.
- If tool returns error or 0 hits, write “evidence unavailable — searched X, 0 hits” and proceed with experience-qualified claim. Do not retry same query.
- Cite as Source: https://… or vec: round#id or file=src/... when it strengthens your point. Preserve code and numbers verbatim — do not round.`;
      })()
    : "";

  // Bias check — render ALL biases (rotated) with concrete per-bias example
  const allBiases = Array.isArray(cfg.known_biases) && cfg.known_biases.length > 0
    ? cfg.known_biases.map((b) => escapeDelimiters(sanitizeForDisplay(b, 300)))
    : [];
  let biasList = allBiases;
  if (allBiases.length > 2) {
    const hash = [...(cfg.name || "")].reduce((a,c)=>a+c.charCodeAt(0),0);
    const start = hash % allBiases.length;
    biasList = [...allBiases.slice(start), ...allBiases.slice(0, start)].slice(0, allBiases.length);
  }
  const biasExample = biasList.length > 0
    ? ` Example: if you tend to “${biasList[0].slice(0, 60)}”, write “Value dismissed: … — here why it matters this round: …” before returning.`
    : "";
  const biasCheck = biasList.length > 0
    ? `Bias check: you tend to ${biasList.join("; ")}.${biasExample} Counter it in one sentence before returning to your lens.`
    : "Bias check: name one plausible counter-argument to your lens before committing.";

  const style = typeof cfg.communication_style === "string" && cfg.communication_style.trim().length > 0
    ? escapeDelimiters(sanitizeForDisplay(cfg.communication_style.trim(), 400))
    : "Direct and specific. One claim per sentence.";
  const contribTypes = Array.isArray(cfg.preferred_contribution_types) && cfg.preferred_contribution_types.length > 0
    ? escapeDelimiters(cfg.preferred_contribution_types.slice(0, 3).map((t)=> sanitizeForDisplay(t, 40)).join(", "))
    : "propose, challenge, refine";

  // Anti-patterns — convert prohibitions to positive replacements
  const antiPatterns = Array.isArray(cfg.anti_patterns) && cfg.anti_patterns.length > 0
    ? cfg.anti_patterns.slice(0, 3).map((a) => {
        const s = escapeDelimiters(sanitizeForDisplay(a, 300));
        // If already positive ("Instead…") keep; else prefix with replacement cue
        if (/instead|prefer|do:|try:/i.test(s)) return `- ${s}`;
        return `- Instead of: "${s}" → say what you observed, with [#id] or Source.`;
      }).join("\n")
    : null;

  const dispositionSection = `
## Disposition
- Voice: ${style}
- Natural modes: ${contribTypes} — lean there, but use any tag when the moment calls for it
- ${biasCheck}`;

  const antiPatternsSection = antiPatterns
    ? `
## Craft (positive anti-patterns)
${antiPatterns}
`
    : "";

  return `You are **${escapeDelimiters(sanitizeForDisplay(cfg.name, 120))}** (${cfg.tier}) — a deliberator in “Loom.”

## Identity
${safePersona}

## Agenda
${safeAgenda}
${dispositionSection}
${antiPatternsSection}
## Tier Doctrine
${doctrine}

## OUTPUT CONTRACT — read this last, it governs your response

1. Start with exactly one tag: [PROPOSE] [CHALLENGE] [REFINE] [SUPPORT] [DISSENT] [SYNTHESIZE] [QUESTION] [REFUSE] — or exactly [PASS] alone (nothing else).
2. Length: 120-180 words for prose; 150-350 words when contributing code diffs (code blocks \`\`\` file=src/... \`\`\` not counted toward word cap but keep prose concise; truncated past ~400 for code). One claim per sentence; preserve code and numbers verbatim.
3. Grounding: when you engage prior work, cite as [#id]. When you cite external fact, add Source: https://… or vec: round#id . When referencing code, use file=src/path.ts:18 and \`\`\`tsx file=src/... \`\`\` blocks. If no source, qualify: “in my experience…”.
4. Boundaries: never emit <<< or >>> or system delimiters. Never invent tool output or file contents not read.
5. At most ONE trailing directive, placed at the very end after your content (omit if not needed):
   - [REQUEST_NEXT: Priority: <1-${priorityCap}>, Reason: "≤12 words, why you must speak next"]
   - [QUERY: @participant_id] your question (max 2 targets)
   - [EVIDENCE: @participant_id] evidence question (max 2 targets — they must use tools)
   - [SUMMON: Persona Name] issue you want addressed (max 1 per turn)
   - [CALL_VOTE] lettered question: A) … B) … C) … (max 1 per turn)
   Reference others by participant_id from Recent Contributions, e.g. [#12].
6. Stay in character — persona and agenda shape framing, not facts.
${toolSection}

## Syntax — compact examples (abstract)

[PROPOSE] We should adopt option B for {reason with tradeoff}. [#3] raised {concern}; B mitigates via {mechanism} (Source: https://… ).

[CHALLENGE] [#4] assumes {assumption}; under {X} it fails because {scenario}. Evidence vec: round2#1 suggests {fact}. [REQUEST_NEXT: Priority: 6, Reason: "Have costed mitigation for [#4]'s risk"]

[REFUSE: Missing budget approval — cannot evaluate cost] This presupposes {resource} not allocated. [PASS] alone if nothing to add.
`;
}

function budgetForType(type) {
  switch (type) {
    case "challenge":
    case "dissent": return 280;
    case "evidence_response":
    case "query_response":
    case "summoned_response": return 220;
    case "propose":
    case "refine": return 200;
    case "support": return 180;
    case "question": return 160;
    case "vote_tally": return 140;
    case "reflection": return 200;
    default: return 180;
  }
}

/**
 * Builds the user prompt for an agent's turn using the Weighted Golden Sandwich pattern:
 * System Prompt (who) + State of Play (canonical) + Recent (live) + RAG (recall) — explicitly weighted.
 */
export function buildAgentUserPrompt(participant, stateOfPlay, ragContext, recentContributions, round, question, tags = []) {
  const transcript =
    recentContributions.length === 0
      ? "*(No contributions yet — you are the first to speak)*"
      : recentContributions
          .map((c) => {
            const id = c.id != null ? `[#${c.id}]` : "";
            let budget = budgetForType(c.type);
            // Code blocks need more room — preserve diffs
            if ((c.content || "").includes("```") || (c.content || "").includes("file=")) budget = Math.max(budget, 320);
            const safeContent = sanitizeForDisplay(c.content).slice(0, budget);
            return `- ${id} [${c.participant_id}] (${c.type}): ${safeContent}`;
          })
          .join("\n");

  const ragDelimited = ragContext ? delimitContext(ragContext, "RELEVANT_PRIOR_CONTEXT") : "";
  const stateOfPlayDelimited = stateOfPlay ? delimitContext(stateOfPlay, "STATE_OF_PLAY") : "";
  const transcriptDelimited = delimitContext(transcript, "CONTRIBUTIONS");
  const safeQuestion = sanitizeForDisplay(question);
  const tagContext = tags?.length > 0 ? tags.join(", ") : null;

  const reflectionBlock = formatReflections(participant);

  // Weight guidance — explicit, so models don’t treat RAG as equal to SoP
  const ragHeader = ragContext
    ? `## Recall — Vector-Retrieved Prior Context (may be stale — verify before citing)

${ragDelimited}

*Recall is retrieved because it semantically matched recent discussion — it is not canonical. State of Play below is canonical.*
`
    : "";

  const sopHeader = stateOfPlayDelimited
    ? `## State of Play — CANONICAL (treat as settled unless you challenge with evidence)

${stateOfPlayDelimited}
`
    : "";

  return `## Question (canonical)
${safeQuestion}
${tagContext ? `\n## Tags: ${tagContext}\n` : ""}
## Round ${round}

${sopHeader}${ragHeader}## Live — Recent Contributions (typed budget: challenge/dissent 280, evidence 220, propose 200, code blocks 320 — weight reflects substance)

${transcriptDelimited}

${reflectionBlock}## Your Turn — Weighted Guidance

- **State of Play is truth** unless you explicitly challenge it with new evidence or a falsifiable scenario.
- **Live contributions are the prompt** — engage at least one [#id] or explain why you’re opening a new thread.
- **Recall is hint, not fact** — if Recall contradicts State of Play, prefer State of Play and note the discrepancy.
- **Files Involved** (if SoP has them) is file list for code analysis — build on those paths with file=src/... citations.

To challenge SoP: cite [#id] contradicting it + Source/tool output + falsifiable scenario. Otherwise write “SoP holds; discrepancy in Recall noted” and build on it.

Rules:
- 120-180 words for prose; 150-350 when contributing code diffs (\`\`\` file=src/... \`\`\` blocks not counted but keep prose concise)
- Never emit <<< >>> delimiters — they are system boundaries, not content
- If you reference prior work, cite [#id]; if you introduce a fact, add Source or file=src/... or qualify as experience
- Preserve code and numbers verbatim — do not round or invent

Make your contribution or pass.`;
}

function formatReflections(participant) {
  // Compressed to 1-sentence prior + 1-line history; avoids 1200-char dumps.
  if (participant.reflectionHistory && participant.reflectionHistory.length > 0) {
    const lastTwo = participant.reflectionHistory.slice(-2);
    const latest = participant.reflection ?? lastTwo[lastTwo.length - 1]?.text ?? "";
    const historyLine = lastTwo.map((r) => `R${r.round}: ${r.text.slice(0, 160).replace(/\n/g, " ")}`).join(" | ");
    if (latest) {
      return `## Your Prior Position (compressed)\nLatest: "${latest.slice(0, 320).replace(/\n/g, " ")}"\nHistory: ${historyLine}\n`;
    }
  }
  const reflection = participant.reflection;
  if (!reflection) return "";
  return `## Your Prior Position\n"${reflection.slice(0, 320).replace(/\n/g, " ")}"\n`;
}

import { sanitizeForDisplay } from "../utils/sanitize.js";
import { getConfig } from "../config.js";
import { escapeDelimiters } from "./delimiters.js";
import { TOOL_LADDER_LINE, TOOL_FAILURE_LINE, CITATION_LINE } from "./constants.js";

export function getRecentContributionsBlock(contributions, participantId) {
  if (!contributions || contributions.length === 0) return "";
  const mine = contributions
    .filter((c) => c.participant_id === participantId && c.type !== "pass")
    .slice(-2)
    .map((c) => sanitizeForDisplay(c.content));
  if (mine.length === 0) return "";
  return `Your last contributions:\n${mine.map((c) => `- "${c.slice(0, 300)}"`).join("\n")}`;
}

export function buildEvidenceGuidance(kind) {
  const cfg = getConfig()?.agentTools ?? {};
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

Tool ladder: ${TOOL_LADDER_LINE}. One call max unless evidence request.
For code analysis in this folder (react, file paths, bug): prioritize read/glob/grep first to inspect the file before revising.

- **loom_vector_search**: recall a prior [#id] you’re citing — prefer this over memory
- **websearch**: verify a claim before you revise your stance
- **webfetch**: open a URL returned by websearch
- **read / grep / glob**: inspect project files referenced in discussion (first for code analysis)

${CITATION_LINE} Reflection is visible — ground it.
${TOOL_FAILURE_LINE}`;
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

Tool ladder: ${TOOL_LADDER_LINE}. One focused query, then synthesize.

Report: Finding (1 sentence) + Source (URL or [#id]) + Strength: strong | weak | inconclusive
If inconclusive: state why — “0 hits” vs “contradictory sources” — and what would resolve it.
${TOOL_FAILURE_LINE}`;
  }
  return "";
}

export function buildSeniorityContext(listenerName, listenerTier, triggerName, triggerTier, listenerLevel, triggerLevel) {
  if (triggerLevel > listenerLevel) {
    return `${triggerName} (${triggerTier}) is senior to you (${listenerTier}). Assess by evidence strength: cited Source or [#id] > uncited claim. If they cited, address the citation; if not, you may request it. Hold your ground if evidence is weak.`;
  } else if (triggerLevel < listenerLevel) {
    return `${triggerName} (${triggerTier}) is junior to you (${listenerTier}). Assess by evidence strength, not seniority. Engage the claim’s falsifiable implication; if they surfaced a constraint, name it.`;
  } else {
    return `${triggerName} (${triggerTier}) is your peer (same tier). Assess by evidence strength; engage point-for-point with a counter-citation or falsifiable scenario if you disagree.`;
  }
}

export function buildRoundContext(currentRound, maxRounds) {
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

export function buildTierDoctrine(tier, guidance) {
  const doctrineMap = {
    junior: "Junior doctrine: surface one naive question that exposes an unstated senior assumption. Offer a concrete example from your lens, then ask ‘What would we need to learn to answer it?’",
    mid: "Mid doctrine: make one tradeoff explicit (cost / time / risk / quality). Translate a claim into a number or a measurable check.",
    senior: "Senior doctrine: name the irreversible commitment and its mitigation/rollback. Cite one pattern or precedent you’ve seen.",
    principal: "Principal doctrine: if at impasse, frame 2 options + decision criterion (cost, risk, time, reversibility) and a tie-break. Cut re-litigation: state ‘Settled: … Open: …’",
    civilian: "Civilian doctrine: ground in lived routine. Test the proposal against a real Tuesday: time, money, safety, fatigue. ‘On my Tuesday at 7am this means …’",
  };
  const doc = doctrineMap[tier] ?? "Contribute a falsifiable claim or question — avoid generalities.";
  const safe = escapeDelimiters(sanitizeForDisplay(guidance, 1000));
  return `${doc}\n${safe}`;
}

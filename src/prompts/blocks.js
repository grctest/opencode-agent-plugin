import { sanitizeForDisplay } from "../utils/sanitize.js";
import { getConfig } from "../config.js";
import { escapeDelimiters, delimitContext } from "./delimiters.js";
import { renderMyStateMarkdown } from "../state-patch.js";
import { TOOL_LADDER_LINE, TOOL_FAILURE_LINE, CITATION_LINE } from "./constants.js";

export function getRecentContributionsBlock(contributions, participantId, opts = {}) {
  if (!contributions || contributions.length === 0) return "";
  // Sub-prompts (query/evidence/vote/summon targets) get a trimmed echo surface:
  // the target's own last two full contributions are the strongest restatement
  // prime (audit: perspective answers that near-copy the target's previous turn).
  const mineCount = opts.mineCount ?? 2;
  const mineBudget = opts.mineBudget ?? 1200;
  const othersCount = opts.othersCount ?? 6;
  const othersBudget = opts.othersBudget ?? 600;
  const mine = contributions
    .filter((c) => c.participant_id === participantId && c.type !== "pass")
    .slice(-mineCount)
    .map((c) => sanitizeForDisplay(c.content, mineBudget).slice(0, mineBudget));
  // The room, not just the mirror: a peer answering inline needs the
  // conversation to answer in context. Previously the two-round ≤12 window
  // collapsed to filter-to-self and the other fetched contributions were thrown
  // away, leaving peers nearly blind (audit B4). Ballots and legacy reflection
  // rows stay excluded as noise.
  const others = contributions
    .filter((c) => c.participant_id !== participantId && c.type !== "pass" && c.type !== "vote_response" && c.type !== "reflection")
    .slice(-othersCount)
    .map((c) => `- "${sanitizeForDisplay(c.content, othersBudget).replace(/\n/g, " ").slice(0, othersBudget)}" [${c.participant_id}]`);
  const parts = [];
  if (mine.length > 0) parts.push(`Your last contributions:\n${mine.map((c) => `- "${c.slice(0, 600)}"`).join("\n")}`);
  if (others.length > 0) parts.push(`Recent from the room:\n${others.join("\n")}`);
  return parts.join("\n\n");
}

/**
 * SKILL.state single position line (plan §5.7/§5.9): Σⁱ.stance is the agent's
 * authoritative position. The legacy `reflection` field is a distinct fallback
 * used only when stance is empty (meeting start / flag-off / old DB, or a
 * perspective answer landed since the last patch). One line, never both.
 */
export function buildPositionLine(target) {
  const stance = typeof target?.state_stance === "string" && target.state_stance.trim()
    ? target.state_stance.trim()
    : (typeof target?.reflection === "string" ? target.reflection.trim() : "");
  if (!stance) return "";
  const fromState = typeof target?.state_stance === "string" && target.state_stance.trim();
  const versionTag = fromState && Number.isFinite(target?.state_version) && target.state_version > 0
    ? ` (from your state v${target.state_version})`
    : "";
  let line = `Your position${versionTag}: "${sanitizeForDisplay(stance.slice(0, 240))}"`;
  const bullets = Array.isArray(target?.state_bullets) ? target.state_bullets.filter(Boolean).slice(0, 4) : [];
  if (fromState && bullets.length > 0) {
    line += `\nYour top bullets: ${sanitizeForDisplay(bullets.join(" | ").slice(0, 600))}`;
  }
  return line;
}

export function buildAgentStateBlock(state) {
  if (state === null || state === undefined) return "";
  const body = escapeDelimiters(sanitizeForDisplay(renderMyStateMarkdown(state)));
  return `## Your State — CARRIED FORWARD\n\n${delimitContext(body, "MY_STATE")}`;
}

/**
 * Sub-agent state line (cut-back contract for loom_query/loom_vote targets).
 * Read-only context, never a directive: the target answers from the question +
 * room lines. Sub-agents never patch (primary-tail-only) — they must never
 * write "State patched" in prose either.
 * Empty state is the normal round-1 case — it must not hijack the task.
 */
export function buildSubAgentStateLine(targetAgent, targetState) {
  const stance = typeof targetState?.stance === "string" && targetState.stance.trim()
    ? targetState.stance.trim()
    : (typeof targetAgent?.state_stance === "string" && targetAgent.state_stance.trim()
      ? targetAgent.state_stance.trim()
      : (typeof targetAgent?.reflection === "string" ? targetAgent.reflection.trim() : ""));
  if (!stance) return "No prior state — answer from the question + room lines below.";
  return `Your prior stance (context only): "${sanitizeForDisplay(stance.slice(0, 240))}"`;
}

/**
 * Accurate tool guidance for ephemeral sub-agents. Mirrors the actual tool map
 * offered in query-evidence.js (websearch/webfetch/read only — patching is
 * primary-tail-only), unlike buildEvidenceGuidance which advertises
 * primary-turn loom_* tools the sub-agent does not have.
 */
export function buildSubAgentToolGuidance(kind = "query") {
  const base = kind === "evidence"
    ? `You MUST use at least one research tool (websearch, webfetch, or read). No speculation.

Report: Finding (1 sentence) + Source (URL or [#id]) + Strength: strong | weak | inconclusive.
If inconclusive: state why — "0 hits" vs "contradictory sources" — and what would resolve it.`
    : `You may use websearch, webfetch, or read to verify before answering. Prefer citing prior [#id] if the answer is "what was said", websearch if it's a current fact. Cite Source: [#id] or URL if you use one.
If a tool returns error or 0 hits, write "evidence unavailable — searched X" and answer with an experience-qualified claim.`;
  return `
## Tools Available To You (sub-agent scope)

${base}

- You do NOT have loom_query, loom_vote, loom_summon, loom_forum, loom_pass, or any state tool. Do not attempt them and do not mention them.
- Your prose IS the contribution. Never write about patching or state in place of the answer.
- ${CITATION_LINE}`;
}

/**
 * Peer-facing position context (audit B5): prefer the one-line position
 * (stance + top bullets) over the full Σⁱ block. The full block (≈11 kB worst
 * case) is the wrong trade inside a 60 s peer sub-prompt; the one-liner is the
 * documented contract. Falls back to the full block only when there is no
 * position to render at all, and to legacy reflection via buildPositionLine.
 */
export function buildTargetPositionContext(targetAgent, targetState) {
  const forPosition = {
    ...(targetAgent ?? {}),
    state_stance: targetState?.stance ?? targetAgent?.state_stance,
    state_bullets: targetState?.established ?? targetAgent?.state_bullets,
    state_version: targetState?.version ?? targetAgent?.state_version,
  };
  return buildPositionLine(forPosition) || buildAgentStateBlock(targetState);
}

export function buildEvidenceGuidance(kind, { activeCount } = {}) {
  const cfg = getConfig()?.agentTools ?? {};
  const isSolo = Number.isFinite(activeCount) && activeCount <= 1;
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
  if (isSolo) {
    if (kind === "reflection") {
      return `
## Research Tools — Reflection (solo — no peers)

No other active participants — peer query/vote unavailable. Ground reflection in prior [#id] (recent context) or loom_summon (expert), or websearch/read for facts. Use loom_forum_* for async sub-discussions.

Tool ladder: ${TOOL_LADDER_LINE}. One call max.

${CITATION_LINE} Reflection is visible — ground it.
${TOOL_FAILURE_LINE}`;
    }
    if (kind === "query") {
      return `
## Research Tools — Query (solo — no peers)

No other active participants — loom_query/loom_vote unavailable. Use loom_summon for expertise, or websearch/read for external facts. Use loom_forum_* to start or join async sub-discussions. Cite Source: [#id] or URL if you use one.
If tool returns error or 0 hits, write "evidence unavailable — searched X" and answer with "insufficient evidence" qualified.`;
    }
    if (kind === "evidence") {
      return `
## Research Tools — Evidence (REQUIRED — solo, no peers)

No other active participants — peer query unavailable. You MUST still call at least one tool: use loom_summon to bring an expert, or websearch/read for external facts. Use loom_forum_* for async sub-discussions. No speculation.

Tool ladder: ${TOOL_LADDER_LINE}. One focused query, then synthesize.

Report: Finding (1 sentence) + Source (URL or [#id]) + Strength: strong | weak | inconclusive
If inconclusive: state why — "0 hits" vs "contradictory sources" — and what would resolve it.
${TOOL_FAILURE_LINE}`;
    }
  }
  if (kind === "reflection") {
    return `
## Research Tools — Reflection (optional but grounded)

Tool ladder: ${TOOL_LADDER_LINE}. One call max unless evidence request.
For code analysis in this folder (react, file paths, bug): prioritize read/glob/grep first to inspect the file before revising.

- **prior [#id]**: cite recent deliberation from State of Play / recent contributions
- **websearch**: verify a claim before you revise your stance
- **webfetch**: open a URL returned by websearch
- **read / grep / glob**: inspect project files referenced in discussion (first for code analysis)

${CITATION_LINE} Reflection is visible — ground it.
${TOOL_FAILURE_LINE}`;
  }
  if (kind === "query") {
    return `
## Research Tools — Query (optional)

You may call one tool to verify before answering. Prefer citing prior [#id] if the answer is “what was said”, websearch if it’s a current fact. Cite Source: [#id] or URL if you use one.
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
    return "Round context unknown — focus on substance and whether the trigger introduces new evidence. Thoroughness over brevity; use the context window.";
  }
  const progress = currentRound / maxRounds;
  if (progress <= 0.33) {
    return `Early deliberation (round ${currentRound}/${maxRounds}) — DIVERGE. Surface assumptions, name hidden constraints, introduce distinct options. Don't converge yet; explore the full spectrum. Thoroughness welcome.
- Stake your own position first, in your own terms — do not build on the first speaker's frame or vocabulary. If you disagree with the emerging frame, say so and name the frame you'd use instead.
- Before critiquing a front-runner, spend one passage on the strongest case for a *different* option than the current leader.
- Frozen terms: the question's load-bearing terms (event set, scoring body, season shape, roster date, key definitions) are frozen before round 1. If you use a term that differs from the frozen definition, flag the divergence in one clause — definition-adjacent disputes are clerk-flagged, not debated.`;
  } else if (progress <= 0.66) {
    return `Mid deliberation (round ${currentRound}/${maxRounds}) — MAP & REFINE. Identify what’s settled vs contested, bundle related proposals, steelman opposing views, surface tradeoffs with numbers where possible. Name what would unlock next steps but don’t force consensus.
- When you build on a settled point, cite its [#id] once and add a delta — don’t restate it.`;
  } else {
    return `Late deliberation (round ${currentRound}/${maxRounds}) — CONSOLIDATE or LEAVE OPEN.
- SETTLED points in State of Play are signed: reference them by [#id] in one clause, then move on. Do NOT restate their content — restatement is a contract violation, not thoroughness.
- Your contribution must add one of: new evidence (Source/tool output), a new objection to a settled point, a refinement with numbers, or a decision-relevant synthesis of contested views.
- It’s fine to leave dissent unresolved — map the remaining disagreement with evidence for/against each view.
- End with Position: [held|revised|expanded] because …`;
  }
}

/**
 * Settled-registry block (F-A): renders consensus items (≥2 holders) as a
 * cite-and-delta guard. Late rounds get the hard block; earlier rounds get a
 * one-line pointer at most. Item text is model prose — delimited as DATA, with
 * the instruction line outside the delimiters (contract §3).
 */
export function buildSettledBlock(items, late = false) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return "";
  if (!late) {
    return `## Settled Watch\n\n${list.length} point(s) already have ≥2 holders in State of Play (see Agreements) — cite by [#id], don't restate.\n`;
  }
  const lines = list.map((it) => {
    const text = sanitizeForDisplay(String(it?.text ?? ""), 500).replace(/\n/g, " ").trim() || "(empty)";
    const holders = Array.isArray(it?.holders) ? it.holders.filter(Boolean).slice(0, 3) : [];
    const extra = Array.isArray(it?.holders) && it.holders.length > 3 ? ` (+${it.holders.length - 3} more)` : "";
    return `- ${text}${holders.length > 0 ? ` — holders: ${holders.join(", ")}${extra}` : ""}`;
  });
  return `## Settled — signed, do not re-argue\n\nReference these by [#id] in one clause, then move on. Do NOT restate their content — restatement is a contract violation, not thoroughness. Challenge only with new evidence.\n\n${delimitContext(lines.join("\n"), "SETTLED_ITEMS")}\n`;
}

export function buildTierDoctrine(tier, guidance) {
  const doctrineMap = {
    junior: "Junior doctrine: surface one naive question that exposes an unstated senior assumption. Offer a concrete example from your lens, then ask ‘What would we need to learn to answer it?’ Be curious, not deferential — thoroughness is valued.",
    mid: "Mid doctrine: make one tradeoff explicit (cost / time / risk / quality / dx). Translate a claim into a number or measurable check. If coding, show the verification step.",
    senior: "Senior doctrine: name the irreversible commitment and its mitigation/rollback. Cite one pattern or precedent you’ve seen. For code: name the files to touch, the regression risk, and the test that would catch it.",
    principal: "Principal doctrine: if at impasse, map the spectrum — 2-3 options + decision criterion (cost, risk, time, reversibility) and conditions under which each wins. It’s fine to leave open: state ‘Settled: … Contested: … Open: …’ Don’t force consensus.",
    civilian: "Civilian doctrine: ground in lived routine. Test the proposal against a real Tuesday: time, money, safety, fatigue. Bring the human cost that technical lenses miss. If a concrete routine image fits, one closer sentence (“On my Tuesday this means …”) is welcome — a skipped image is correct, not a failure; never force the analogy.",
  };
  const doc = doctrineMap[tier] ?? "Contribute a falsifiable claim or question — avoid generalities; be thorough, use the context window.";
  const safe = escapeDelimiters(sanitizeForDisplay(guidance, 1500));
  return `${doc}\nPersona lens (subordinate to contract):\n${safe}`;
}

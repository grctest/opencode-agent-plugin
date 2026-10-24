import { sanitizeForDisplay } from "../utils/sanitize.js";
import { getConfig } from "../config.js";
import { escapeDelimiters, delimitContext } from "./delimiters.js";
import { renderMyStateMarkdown } from "../state-patch.js";
import { TOOL_LADDER_LINE, TOOL_FAILURE_LINE, CITATION_LINE } from "./constants.js";

/**
 * Recent-contributions block — the target's own echo and the room's.
 *
 * Two surfaces, one helper:
 *   - `mineCount > 0`  → the target's own last N contributions. The strongest
 *     restatement prime when it is wanted: a peer that can see its own prior
 *     words answers in context.
 *   - `mineCount <= 0` → NO own-turn echo. This is the deliberate
 *     anti-near-copy setting for the query/evidence/vote sub-prompts: a
 *     self-echo made perspective answers restate the target's previous turn
 *     (audit B). The target's position still arrives — through the stored
 *     stance line and its state bullets (see buildSubAgentStateLine).
 *
 * A zero count means "omit the block", never "render every own contribution as
 * an empty row": `slice(-0)` returns the WHOLE array and a zero-length sanitize
 * budget truncates each row to "", which shipped as a literal
 * `Your last contributions:\n- ""` in every peer-facing prompt.
 */
export function getRecentContributionsBlock(contributions, participantId, opts = {}) {
  if (!contributions || contributions.length === 0) return "";
  const mineCount = Number.isFinite(opts.mineCount) ? Math.max(0, opts.mineCount) : 2;
  const mineBudget = opts.mineBudget ?? 1200;
  const othersCount = opts.othersCount ?? 6;
  const othersBudget = opts.othersBudget ?? 600;
  const parts = [];
  if (mineCount > 0) {
    // One cut only: sanitizeForDisplay truncates by code point, so the row is
    // surrogate-safe (a second String.slice here could split an emoji).
    const mine = contributions
      .filter((c) => c.participant_id === participantId && c.type !== "pass")
      .slice(-mineCount)
      .map((c) => sanitizeForDisplay(c.content, mineBudget).replace(/\n/g, " ").trim())
      .filter((c) => c.length > 0);
    if (mine.length > 0) parts.push(`Your last contributions:\n${mine.map((c) => `- "${c}"`).join("\n")}`);
  }
  // The room, not just the mirror: a peer answering inline needs the
  // conversation to answer in context. Previously the two-round ≤12 window
  // collapsed to filter-to-self and the other fetched contributions were thrown
  // away, leaving peers nearly blind (audit B4). Ballots and legacy reflection
  // rows stay excluded as noise.
  const others = contributions
    .filter((c) => c.participant_id !== participantId && c.type !== "pass" && c.type !== "vote_response" && c.type !== "reflection")
    .slice(-othersCount)
    .map((c) => ({ id: c.participant_id, text: sanitizeForDisplay(c.content, othersBudget).replace(/\n/g, " ").trim() }))
    .filter((c) => c.text.length > 0)
    .map((c) => `- "${c.text}" [${c.id}]`);
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
 *
 * The stance line is the target's POSITION and nothing more: the settled
 * digest carries consensus, and a peer prompt must never surface a solo
 * position as if it were shared ground (audit T4', test: a queried peer sees
 * consensus points but not solo positions).
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

- You do NOT have loom_query, loom_vote, loom_summon, loom_pass, or any state tool. Do not attempt them and do not mention them.
- Your prose IS the contribution. Never write about patching or state in place of the answer.
- ${CITATION_LINE}`;
}

/**
 * Peer settled digest (T4'): the consensus subset for queried peers. A peer
 * answering inline never sees the State of Play, so without this it can
 * unknowingly re-litigate a signed point and force the invoker to filter the
 * damage during synthesis. Text-only (no holder lists) and hard-capped —
 * typically a few lines, never kilobytes.
 */
export function buildPeerSettledDigest(items, cap = 4) {
  const list = (Array.isArray(items) ? items : []).filter((it) => it && typeof it.text === "string" && it.text.trim());
  if (list.length === 0) return "";
  const shown = list.slice(0, Math.max(1, cap));
  const lines = shown.map((it) => `- ${sanitizeForDisplay(String(it.text).trim(), 300).replace(/\n/g, " ")}`);
  const more = list.length > shown.length ? `\n(+${list.length - shown.length} more settled — see State of Play via the asker)` : "";
  return `## Settled — signed, do not re-argue\n\n${delimitContext(lines.join("\n") + more, "SETTLED_ITEMS")}\n\nChallenge a settled point only with new evidence (Source/tool output) plus [#id]; otherwise build on it.\n`;
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

No other active participants — peer query/vote unavailable. Ground reflection in prior [#id] (recent context) or loom_summon (expert), or websearch/read for facts.

Tool ladder: ${TOOL_LADDER_LINE}. One call max.

${CITATION_LINE} Reflection is visible — ground it.
${TOOL_FAILURE_LINE}`;
    }
    if (kind === "query") {
      return `
## Research Tools — Query (solo — no peers)

No other active participants — loom_query/loom_vote unavailable. Use loom_summon for expertise, or websearch/read for external facts. Cite Source: [#id] or URL if you use one.
If tool returns error or 0 hits, write "evidence unavailable — searched X" and answer with "insufficient evidence" qualified.`;
    }
    if (kind === "evidence") {
      return `
## Research Tools — Evidence (REQUIRED — solo, no peers)

No other active participants — peer query unavailable. You MUST still call at least one tool: use loom_summon to bring an expert, or websearch/read for external facts. No speculation.

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

/**
 * Persona lens block: the persona's own guidance text, rendered verbatim
 * (sanitized). Categories carry no doctrine — every category of persona is
 * instructed the same way: contribute something falsifiable and grounded.
 */
export function buildCategoryLens(guidance) {
  const fallback = "Contribute a falsifiable claim or question — avoid generalities; be thorough, use the context window.";
  const text = typeof guidance === "string" && guidance.trim() ? guidance : fallback;
  const safe = escapeDelimiters(sanitizeForDisplay(text, 1500));
  return `Persona lens (subordinate to contract):\n${safe}`;
}

export function buildRoundContext(currentRound, maxRounds, context = {}) {
  const hasPriorContributions = !!context?.hasPriorContributions;
  const settledCount = Number.isFinite(context?.settledCount) ? context.settledCount : null;
  if (!currentRound || !maxRounds) {
    return "Round context unknown — focus on substance and whether the trigger introduces new evidence. Thoroughness over brevity; use the context window.";
  }
  // Born-terminal meetings (round 1 of 1, nothing before it) are openings, not
  // closings: there is nothing to consolidate and no settled registry to cite.
  // Treat them as DIVERGE so the first turn is generative rather than terminal.
  const bornTerminal = (currentRound === 1 && maxRounds === 1 && !hasPriorContributions);
  const progress = bornTerminal ? 0 : (currentRound / maxRounds);
  const settledBullet = (settledCount === null || settledCount > 0)
    ? "- SETTLED points in State of Play are signed: reference them by [#id] in one clause, then move on. Do NOT restate their content — restatement is a contract violation, not thoroughness.\n"
    : "- Nothing is settled yet (the settled registry is empty): do not cite a signed point that does not exist. Treat this turn as establishing, not consolidating.\n";
  if (progress <= 0.33) {
    return `Early deliberation (round ${currentRound}/${maxRounds}) — DIVERGE. Surface assumptions, name hidden constraints, introduce distinct options. Don't converge yet; explore the full spectrum. Thoroughness welcome.
- Stake your own position first, in your own terms — do not build on the first speaker's frame or vocabulary. If you disagree with the emerging frame, say so and name the frame you'd use instead.
- Before critiquing a front-runner, spend one passage on the strongest case for a *different* option than the current leader.
- Frozen terms: nothing is frozen yet. If you are the first speaker, state in 1-3 lines how you read the question's load-bearing terms (what counts, how scored, scope). If a definition is already on the table (State of Play / Live), adopt it or amend yours in one clause — divergence is flagged once, definition disputes are not debated.`;
  } else if (progress <= 0.66) {
    return `Mid deliberation (round ${currentRound}/${maxRounds}) — MAP & REFINE. Identify what’s settled vs contested, bundle related proposals, steelman opposing views, surface tradeoffs with numbers where possible. Name what would unlock next steps but don’t force consensus.
- File at least one critique of a peer's load-bearing claim this round (in prose or loom_query mode 'critique') — a round spent only restating your view is a round spent restating.
- When you build on a settled point, cite its [#id] once and add a delta — don’t restate it.`;
  } else {
    return `Late deliberation (round ${currentRound}/${maxRounds}) — CONSOLIDATE or LEAVE OPEN.
${settledBullet}- Your contribution must add one of: new evidence (Source/tool output), a new objection to a settled point, a refinement with numbers, or a decision-relevant synthesis of contested views.
- It’s fine to leave dissent unresolved — map the remaining disagreement with evidence for/against each view.
- End with Position: [held|revised|expanded] because …`;
  }
}

/**
 * A plain round label for SUB-AGENT prompts (vote targets, summoned guests).
 *
 * The round doctrine above is a primary-turn contract — "file a critique",
 * "map the spectrum", "end with Position:" — and a voter or a guest expert
 * cannot act on any of it. The cut-back sub-agent contract says sub-prompts
 * carry no round doctrine; this is the one line that tells them where in the
 * deliberation they are, without the instructions that do not apply.
 */
export function buildRoundLabel(currentRound, maxRounds) {
  if (!currentRound) return "Round: unknown";
  return maxRounds ? `Round: ${currentRound} of ${maxRounds}` : `Round: ${currentRound}`;
}

/**
 * Settled-registry block (F-A): renders the ORCHESTRATOR's consensus items as a
 * cite-and-delta guard.
 *
 * The items are the round clerk's semantic judgement of what the room
 * converged on, carried in the meeting-level registry — the same list the
 * shared State of Play shows. They are rendered in EVERY round, not only in the
 * late phase: the early-phase pointer ("N points have ≥2 holders — see
 * Agreements & Proposals") pointed at a section that was empty in every
 * recorded meeting, so the room was told to build on settled points it could
 * not see (audit A). The late phase keeps the stricter, signed wording.
 *
 * Item text is model prose — delimited as DATA, with the instruction line
 * outside the delimiters (contract §3).
 */
export function buildSettledBlock(items, late = false) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return "";
  const lines = list.map((it) => {
    const text = sanitizeForDisplay(String(it?.text ?? ""), 500).replace(/\n/g, " ").trim() || "(empty)";
    const holders = Array.isArray(it?.holders) ? it.holders.filter(Boolean).slice(0, 3) : [];
    const extra = Array.isArray(it?.holders) && it.holders.length > 3 ? ` (+${it.holders.length - 3} more)` : "";
    return `- ${text}${holders.length > 0 ? ` — holders: ${holders.join(", ")}${extra}` : ""}`;
  });
  if (!late) {
    return `## Settled so far — the room has converged on these\n\nBuild on them: cite by [#id] in one clause and add a delta. Do not restate them.\n\n${delimitContext(lines.join("\n"), "SETTLED_ITEMS")}\n`;
  }
  return `## Settled — signed, do not re-argue\n\nReference these by [#id] in one clause, then move on. Do NOT restate their content — restatement is a contract violation, not thoroughness. Challenge only with new evidence.\n\n${delimitContext(lines.join("\n"), "SETTLED_ITEMS")}\n`;
}



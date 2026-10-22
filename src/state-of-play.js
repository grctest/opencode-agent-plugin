import { Logger, extractErrorInfo } from "./logger.js";
import { isPassContribution } from "./utils/contribution-types.js";
import { STATE_PATCH_CAPS } from "./state-patch.js";
import { renderClerkDigest } from "./lib/clerk-summary.js";

const TAG_STRIP_RE = /^\[(?:PROPOSE|CHALLENGE|REFINE|SUPPORT|DISSENT|SYNTHESIZE|QUESTION|REFUSE)\]\s*/i;
const REQUEST_NEXT_RE = /^\[REQUEST_NEXT:[^\]]*\]\s*/gim;
// Live prefixes emitted by loom_* tools (store as indented rows, but strip for SoP compactness)
const LIVE_PREFIX_RES = [
  /^\[Response to query from .+?\]\s*/gim,
  /^\[Evidence from .+?( on .+?)?\]\s*/gim,
  /^\[Critique from .+?\]\s*/gim,
  /^\[Risk analysis by .+?\]\s*/gim,
  /^\[Assumptions surfaced by .+?\]\s*/gim,
  /^\[Alternatives proposed by .+?\]\s*/gim,
  /^\[Summoned: .+?\] ?/gim,
  /^\[Vote from .+?\]\s*/gim,
  /^\[Reflection on .+?\]\s*/gim,
  /^\[Perspective from .+?\]\s*/gim,
];

function cleanContent(content) {
  let out = content
    .replace(TAG_STRIP_RE, "")
    .replace(REQUEST_NEXT_RE, "");
  for (const re of LIVE_PREFIX_RES) out = out.replace(re, "");
  // Also strip legacy generic [QUERY:/[EVIDENCE:/[SUMMON: for old rows
  out = out.replace(/^\[(?:QUERY|EVIDENCE|SUMMON):[^\]]*\]\s*/gi, "");
  return out.trim();
}

/**
 * Derives a structured state-of-play summary from the weave (contributions).
 * Captures decisions, agreements, disagreements, open questions, and key facts
 * so agents have a compact, accurate running context without O(N²) token growth.
 *
 * Classification is driven ENTIRELY by the structured contribution type
 * (`c.type`) plus the interaction mode the tool recorded. There is no
 * keyword-matching fallback (see `classifyContribution`): a primary turn is
 * untyped, and guessing which bucket its prose belongs in from words like
 * "we should" or "agree" put a machine-made judgement into the room's primary
 * shared context. An agent declares its own positions through
 * `loom_state_patch`, whose buckets are aggregated by `aggregateStateOfPlay`;
 * a turn that did not declare anything contributes nothing here.
 */
function hasFileMention(content) {
  // Exclude version strings like 1.2.js — require src/ path or file= prefix or word boundary without leading digit-dot
  if (/(?:file\s*=\s*[^\s]+\.\w+|src\/[^\s]+\.\w+|```[^`]*file=)/i.test(content)) return true;
  return /(^|[\s(])[\w-]+\.(?:tsx|ts|js|jsx|py|rs|go)\b/i.test(content) && !/\d+\.\d+\.js/.test(content);
}

export function updateStateOfPlay(weave, question, tags) {
  if (!weave || weave.length === 0) return "";

  const decisions = [];
  const agreements = [];
  const disagreements = [];
  const openQuestions = [];
  const keyFacts = [];
  const filesInvolved = [];

  for (const c of weave) {
    if (isPassContribution(c)) continue;
    const raw = (c.content ?? "").trim();
    if (!raw) continue;
    let content = cleanContent(raw);
    if (!content) continue;
    if (c.type === "reflection") {
      // Keep reflection visible as a concise fact — header already indicates context
      content = `[Reflected: ${content.slice(0, 400)}]`;
    }

    if (hasFileMention(content)) {
      const fileMatch = content.match(/(?:file\s*=\s*)([^\s`'"]+\.\w+)/i) || content.match(/(src\/[^\s`'"]+\.\w+)/i) || content.match(/(^|[\s(])([\w-]+\.(?:tsx|ts|js|jsx|py|rs|go))\b/i);
      const rawSnippet = fileMatch ? (fileMatch[2] ?? fileMatch[1]).slice(0, 80) : content.slice(0, 120);
      const fileSnippet = rawSnippet.toLowerCase().replace(/[,\)\.\]]+$/,'');
      filesInvolved.push(fileSnippet);
    }

    const toolCalls = c.tool_calls;
    const hasToolBacking = Array.isArray(toolCalls) ? toolCalls.length > 0 : toolCalls != null && toolCalls !== "";
    const bucket = classifyContribution(c.type, c.prompt_context?.mode ?? "", hasToolBacking);
    if (bucket === null) continue;
    switch (bucket) {
      case "decisions": decisions.push(content); break;
      case "agreements": agreements.push(content); break;
      case "disagreements": disagreements.push(content); break;
      case "openQuestions": openQuestions.push(content); break;
      default: keyFacts.push(content); break;
    }
  }

  // Deduplicate by full path lowercased, keep most recent, then take last 8
  const dedupMap = new Map();
  for (const f of filesInvolved) {
    const key = f.toLowerCase();
    // Use full path for dedup, not prefix-collided 80-char snippet alone
    if (dedupMap.has(key)) dedupMap.delete(key);
    dedupMap.set(key, f);
  }
  const dedupedFiles = [...dedupMap.values()];

  return formatStateOfPlay({ decisions, agreements, disagreements, openQuestions, keyFacts, filesInvolved: dedupedFiles.slice(-8) }, question, tags);
}

/**
 * Classifies a contribution into a state-of-play bucket from STRUCTURED signals
 * only: the contribution's type tag and, for peer interactions, the mode the
 * calling tool recorded in `prompt_context.mode`.
 *
 * Returns `null` for an untyped primary turn (`contribution`) and for any
 * unrecognised type. That is deliberate: a primary turn is untyped by design, so
 * filing it would require guessing from its prose, and the room's primary
 * shared context is the last place a guess belongs. `loom_state_patch` is the
 * declaration channel — see `aggregateStateOfPlay` in `src/state-patch.js`.
 */
function classifyContribution(type, mode = "", hasToolBacking = true) {
  switch (type) {
    case "contribution":
      // Undeclared. The agent's own state patch is the source of truth for
      // what a primary turn established; if it did not declare, nothing is
      // claimed on its behalf.
      return null;
    case "critique_response":
      return "disagreements";
    case "perspective_response":
      // A perspective answer is the target's position, not a question — filing it
      // as an open question inflates Open Questions with answered positions
      // (retrospective P0-1). It is attributed context, so file as a fact.
      return "keyFacts";
    case "query_response":
      if (mode === "risks" || mode === "assumptions" || mode === "alternatives") return "openQuestions";
      if (mode === "critique") return "disagreements";
      return "keyFacts";
    case "evidence_response":
      // tool_choice is server-ignored (prompt-enforced only), so an evidence
      // answer may arrive with no tool behind it. Un-backed "evidence" is a
      // claim needing verification, not a fact (audit B9).
      if (!hasToolBacking) return "openQuestions";
      return "keyFacts";
    case "summoned_response":
      return "keyFacts";
    case "vote_response":
    case "synthesize":
    case "refuse":
    case "pass":
      return null;
    // Legacy typed contributions no longer emitted. Not filed: their bucket
    // cannot be derived from a type this build does not understand.
    case "propose":
    case "refine":
    case "support":
    case "question":
      return null;
    case "reflection":
      return "keyFacts";
    default:
      return null;
  }
}


/**
 * Section names for the shared State of Play. The consensus section is ONE
 * bucket, not two: the per-agent patch channel files both "proposals" and
 * "agreements" in the same `established` bucket, so rendering them under
 * separate headings printed the same list twice and let a merely two-holder
 * claim wear the authority of consensus. Legacy headings are still READ (old
 * DBs) and folded into the same bucket.
 */
export const SOP_SECTIONS = {
  agreed: ["Agreements & Proposals", "Agreements", "Decisions & Proposals"],
  disagreements: ["Disagreements & Concerns", "Disagreements"],
  openQuestions: ["Open Questions"],
  keyFacts: ["Key Facts"],
  filesInvolved: ["Files Involved"],
};

/**
 * Reads the "- " items of a State-of-Play section as complete multi-line
 * strings. An item runs from its "- " line to the next "- " or "## " line —
 * without this, multi-line items are truncated to their first line and
 * perspective/evidence prefixes survive as standalone fragments
 * (retrospective P0-1 safety net).
 *
 * @param {string} markdown
 * @param {string|string[]} names heading names to read, in priority order
 * @returns {string[]} raw item texts (no leading "- ")
 */
export function readSoPSectionItems(markdown, names) {
  const wanted = Array.isArray(names) ? names : [names];
  const lines = String(markdown ?? "").split("\n");
  const out = [];
  for (const name of wanted) {
    const start = lines.findIndex((line) => line.trim() === `## ${name}`);
    if (start < 0) continue;
    const items = [];
    let current = null;
    for (const line of lines.slice(start + 1)) {
      if (line.startsWith("## ")) break;
      if (line.trim().startsWith("- ")) {
        if (current !== null) items.push(current);
        current = line.trim().slice(2);
      } else if (current !== null && line.trim()) {
        current += `\n${line.trim()}`;
      }
    }
    if (current !== null) items.push(current);
    out.push(...items);
  }
  return out;
}

/**
 * Merges a declared State of Play with a legacy fallback, section by section.
 */
export function mergeStateOfPlay(primary, fallback) {
  if (!primary) return fallback || "";
  if (!fallback) return primary;
  const readSection = (markdown, name) => {
    const lines = String(markdown).split("\n");
    const start = lines.findIndex((line) => line.trim() === `## ${name}`);
    if (start < 0) return "";
    const values = [];
    for (const line of lines.slice(start + 1)) {
      if (line.startsWith("## ")) break;
      values.push(line);
    }
    return values.join("\n").trim();
  };
  const mergeList = (names, limit = 8) => {
    const values = [];
    const seen = new Set();
    for (const source of [primary, fallback]) {
      for (const value of readSoPSectionItems(source, names)) {
        // Strip the aggregation's " (N holders)" attribution suffix before keying,
        // or `foo` and `foo (2 holders)` never dedupe and both leak through (audit A6).
        const key = value.replace(/\s*\(\d+ holders\)\s*$/i, "").replace(/\s+/g, " ").toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        values.push(value);
      }
    }
    // Newest wins: primary is already rank-ordered and the fallback buckets are
    // chronological, so the tail — not the head — is the most recent (audit A6).
    return values.slice(-limit);
  };
  const question = readSection(primary, "Question") || readSection(fallback, "Question");
  const tags = readSection(primary, "Tags") || readSection(fallback, "Tags");
  const sections = {
    // Legacy "Agreements" and "Decisions & Proposals" fold into the one
    // consensus bucket — reading both keeps old DBs merging correctly.
    decisions: mergeList(SOP_SECTIONS.agreed),
    agreements: [],
    disagreements: mergeList(SOP_SECTIONS.disagreements),
    openQuestions: mergeList(SOP_SECTIONS.openQuestions),
    keyFacts: mergeList(SOP_SECTIONS.keyFacts),
    filesInvolved: mergeList(SOP_SECTIONS.filesInvolved),
  };
  return formatStateOfPlay(sections, question, tags ? tags.split(",").map((tag) => tag.trim()).filter(Boolean) : []);
}

/**
 * Render caps for the shared State of Play. One source of truth: the
 * architecture doc states these numbers, and `scripts/docs-verify.mjs` pins
 * the doc against THIS object, so the two cannot drift apart again.
 */
export const SOP_CAPS = { items: 8, itemChars: 500, fileChars: 160 };

/**
 * Removes one section (its heading and body) from a State-of-Play markdown
 * string, matching the heading by name even when it carries a suffix
 * ("## Forum Threads (cite in prose as [#T{id}])").
 *
 * Used by the agent prompt: the forum digest lives in the SoP so the clerk and
 * the synthesizer read it, but the agent also gets a dedicated, richer forum
 * block — rendering both duplicated every thread in every turn (audit C1).
 *
 * @param {string} markdown
 * @param {string} name heading name to remove
 * @returns {string}
 */
export function stripSopSection(markdown, name) {
  const text = String(markdown ?? "");
  if (!text.trim()) return text;
  const lines = text.split("\n");
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      const heading = line.replace(/^##\s*/, "").trim();
      skipping = heading === name || heading.startsWith(`${name} `) || heading.startsWith(`${name}(`);
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/**
 * Formats structured state-of-play sections into a markdown summary — thorough, not terse.
 */
export function formatStateOfPlay(sections, question, tags) {
  const lines = [];
  if (question) lines.push(`## Question\n${question}`);
  if (tags?.length > 0) lines.push(`## Tags\n${tags.join(", ")}`);

  // ONE consensus section. The patch channel cannot tell a "proposal" from an
  // "agreement" (both live in `established`), so the old two-heading render
  // printed the same rows twice and let a merely two-holder claim read as
  // settled consensus. The per-row "(N holders)" suffix still shows how many
  // agents stand behind each item.
  const agreed = dedupeSoPItems([...(sections.decisions ?? []), ...(sections.agreements ?? [])]);
  if (agreed.length > 0) {
    lines.push(`## Agreements & Proposals\n${agreed.slice(-SOP_CAPS.items).map((d) => `- ${d.slice(0, SOP_CAPS.itemChars)}`).join("\n")}`);
  }
  if (sections.disagreements.length > 0) {
    lines.push(`## Disagreements & Concerns\n${sections.disagreements.slice(-SOP_CAPS.items).map((d) => `- ${d.slice(0, SOP_CAPS.itemChars)}`).join("\n")}`);
  }
  if (sections.openQuestions.length > 0) {
    lines.push(`## Open Questions\n${sections.openQuestions.slice(-SOP_CAPS.items).map((q) => `- ${q.slice(0, SOP_CAPS.itemChars)}`).join("\n")}`);
  }
  if (sections.keyFacts.length > 0) {
    lines.push(`## Key Facts\n${sections.keyFacts.slice(-SOP_CAPS.items).map((f) => `- ${f.slice(0, SOP_CAPS.itemChars)}`).join("\n")}`);
  }
  if (sections.filesInvolved && sections.filesInvolved.length > 0) {
    lines.push(`## Files Involved\n${sections.filesInvolved.slice(-SOP_CAPS.items).map((f) => `- ${f.slice(0, SOP_CAPS.fileChars)}`).join("\n")}`);
  }

  return lines.join("\n\n");
}

/** Drops duplicate rows (same text, ignoring the holder-count suffix). */
function dedupeSoPItems(items) {
  const seen = new Set();
  const out = [];
  for (const raw of items ?? []) {
    const item = String(raw ?? "").trim();
    if (!item) continue;
    const key = item.replace(/\s*\(\d+ holders\)\s*$/i, "").replace(/\s+/g, " ").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** Formats a single round's contributions into markdown lines. */
function formatRoundLines(round, participants) {
  const lines = [];
  const isFinal = round.number === undefined;
  lines.push(`### Round ${isFinal ? "(Final)" : round.number}`);

  for (const c of round.contributions) {
    // Pass rows carry no citable content; emitting them would mint valid-looking
    // [#id] targets that resolve to "passed" (audit A1).
    if (c.type === "pass") continue;
    const participant = participants.find((p) => p.config.id === c.participant_id);
    const name = participant?.config.name ?? c.participant_id;
    const category = participant?.config.category ?? participant?.config.tier ?? "";
    // The [#id] is the citation key the synthesis doctrine requires (audit A1):
    // every contribution line must carry the id finalizeSynthesis validates against.
    lines.push(`- **[#${c.id ?? "?"}] ${name}** (${category}, ${c.type}): ${c.content}`);
  }

  if (round.summary) {
    lines.push(`  *Summary:* ${round.summary}`);
  }

  return lines;
}

/**
 * One index line per contribution — the citable skeleton of a round.
 *
 * A contribution that is indexed but not quoted can still be CITED: the
 * synthesizer knows it exists, who said it, and roughly what it was about, so
 * "nothing silently dropped" holds even when the prose does not fit. The
 * earlier shape of the transcript dropped whole rounds instead, and the
 * measured result was 7% of a ten-round deliberation visible to the
 * synthesizer and 10% of the room's work represented in the artifact
 * (audit B).
 */
function formatRoundIndexLines(round, participants) {
  const lines = [];
  for (const c of round.contributions ?? []) {
    if (c.type === "pass") continue;
    const participant = participants.find((p) => p.config.id === c.participant_id);
    const name = participant?.config.name ?? c.participant_id;
    const category = participant?.config.category ?? participant?.config.tier ?? "";
    const body = String(c.content ?? "").replace(/\s+/g, " ").trim();
    // 90 chars of gist per contribution: the index is a skeleton, and the
    // skeleton has to fit a round's share of the budget for a 10-round
    // deliberation to keep every id citable.
    const head = `- **[#${c.id ?? "?"}] ${name}** (${category}, ${c.type}):`;
    lines.push(body.length > 90 ? `${head} ${body.slice(0, 90)} …` : `${head} ${body}`);
  }
  return lines;
}

/** Character budget for the agent-facing prior-round citable index. */
export const PRIOR_INDEX_BUDGET_CHARS = 2400;

/**
 * The agent-facing prior-round citable index.
 *
 * SKILL.state O_t gives agents the CURRENT round raw only — every id from an
 * earlier round resolves solely through whatever a State-of-Play bullet
 * restates, and a merged-away bullet takes its id with it: the room is asked
 * to cite ids it can no longer see. This block resolves them: one line per
 * earlier contribution — id, holder NAME, round, short gist.
 *
 * Deliberately NOT formatRoundIndexLines (the synthesizer's transcript index):
 *   - names only, no categories — the room reads attributions, not roster
 *     labels, and the name is what the "pair the holder's NAME with [#id]"
 *     doctrine needs;
 *   - 120-char gist, not 90 — agents ENGAGE with these claims ("[#23] says X,
 *     and I disagree"), they don't just point at them, so the gist must carry
 *     more of the claim;
 *   - ids already rendered elsewhere (the current round's Recent
 *     Contributions) are excluded by id, never by round boundary — the live
 *     window can cut mid-round, and a boundary rule would either duplicate an
 *     id or drop it from both blocks.
 *
 * Oldest rounds first: the newer an id, the likelier a State-of-Play bullet
 * still restates it — the digests merge forward. The oldest lines are the
 * only place those ids exist. When the budget cuts, it cuts the tail (the
 * newest older rounds), and the truncation is announced, never silent.
 *
 * Pure text assembly over caller data; sanitization and fencing happen in the
 * prompt builder (agent-authored content rides inside a fence like every
 * other untrusted block).
 *
 * @param {Array<{id?: number|string, participant_id?: string, round?: number, type?: string, content?: string}>} contributions
 * @param {Set<string>|Array} excludeIds ids already rendered in the live block
 * @param {Record<string,string>|Map<string,string>} nameMap participant id → display name
 * @param {{gistChars?: number, budgetChars?: number}} [opts]
 * @returns {string} markdown lines (possibly empty — caller renders nothing)
 */
export function buildPriorRoundContributionIndex(contributions, excludeIds = new Set(), nameMap = {}, opts = {}) {
  const gistChars = Number.isFinite(opts.gistChars) ? opts.gistChars : 120;
  const budgetChars = Number.isFinite(opts.budgetChars) ? opts.budgetChars : PRIOR_INDEX_BUDGET_CHARS;
  const exclude = new Set(
    [...(excludeIds ?? [])].map(String).filter((v) => v && v !== "undefined" && v !== "null"),
  );
  const rows = (contributions ?? [])
    .filter((c) => {
      if (c?.id == null) return false;
      const type = String(c.type ?? "");
      // Same species as the live block, minus pass rows: a pass carries no
      // citable content, and "None" rows would mint valid-looking ids.
      if (type === "pass") return false;
      if (type === "vote_response" || type === "reflection") return false;
      if (exclude.has(String(c.id))) return false;
      return Boolean(String(c.content ?? "").trim());
    })
    .sort((a, b) => (Number(a.round) || 0) - (Number(b.round) || 0) || (Number(a.id) || 0) - (Number(b.id) || 0));
  if (rows.length === 0) return "";

  const nameFor = (pid) => {
    const raw = String(nameMap?.[pid] ?? nameMap?.get?.(pid) ?? "");
    return raw && raw !== pid ? raw : "";
  };

  const lines = [];
  let used = 0;
  let omitted = 0;
  for (const c of rows) {
    const pid = String(c.participant_id ?? "unknown");
    const holder = nameFor(pid) || pid;
    const body = String(c.content ?? "").replace(/\s+/g, " ").trim();
    const gist = body.length > gistChars ? `${body.slice(0, gistChars).trimEnd()}…` : body;
    const roundNo = Number(c.round);
    const line = `- [#${c.id}] ${holder}${Number.isFinite(roundNo) && roundNo > 0 ? ` (round ${roundNo})` : ""}: ${gist}`;
    if (used + line.length + 1 > budgetChars) {
      omitted = rows.length - lines.length;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return "";
  const marker = omitted > 0
    ? `\n…[index truncated to fit the budget — ${omitted} contribution line(s) omitted; those ids resolve only as restated in the State of Play bullets]`
    : "";
  return `${lines.join("\n")}${marker}\n`;
}

/**
 * Formats transcript for synthesis: earlier rounds as citable indexes with the
 * clerk's judgement, the newest rounds in full, plus agent states and
 * reflections.
 *
 * The budget is the MODEL'S WINDOW, not a constant (audit B): the old fixed
 * 24,000 characters was ~6k tokens in a prompt that announces a 200k-token
 * window, and it cut the FINAL round first — the most decision-relevant round
 * disappeared while earlier rounds kept their full text. Now:
 *   - the final round is protected (the oldest full round is sacrificed first);
 *   - every round is represented, at minimum as an index of citable ids;
 *   - the older rounds carry the CLERK'S JUDGEMENT (settled / contested /
 *     next), not a prefix of prose that cut before the Contested bullet.
 *
 * @param {object} data transcript data ({ rounds, question, ... })
 * @param {Array} participants
 * @param {{budgetChars?: number}} [opts] the model's character budget for the
 *   transcript; defaults to 24000 for callers that do not know the window.
 */
export function formatFinalRoundTranscript(data, participants, opts = {}) {
  const truncForTranscript = (s, lim) => {
    if (s.length <= lim) return s;
    // Whole-unit cut: prefer a line boundary so a contribution line is never
    // left half-rendered — a silent half-line reads as complete to the
    // synthesizer, an explicit marker does not. Falls back to a hard cut only
    // when a single line exceeds half the budget (uncapped single unit).
    let cut = s.slice(0, lim);
    const nl = cut.lastIndexOf("\n");
    if (nl > lim * 0.5) cut = cut.slice(0, nl);
    // Avoid cutting surrogate pairs
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xD800 && last <= 0xDBFF) cut = cut.slice(0, -1);
    return cut + "\n...[truncated]";
  };
  const appendReflections = (lines) => {
    const reflections = (participants || []).filter((p) => p.reflection).map((p) => `**${p.config.name} (${p.config.category ?? p.config.tier ?? ""}) reflection**: ${p.reflection.slice(0, 800).replace(/\n/g, " ")}`);
    if (reflections.length > 0) {
      lines.push("### Final Reflections");
      lines.push(...reflections);
    }
  };
  // SKILL.state Agent States (final) block (§5.9): stances + top bullets, ≤4k chars,
  // before Final Reflections. Positions-only, never evidence: the synthesizer must
  // cite weave [#id] (and Source:/file= where present) for every contested claim;
  // state bullets without a [#id] trail are unattributed positions, not findings.
  const appendAgentStates = (lines) => {
    const states = (participants || []).filter((p) => p.state_stance || (Array.isArray(p.state_bullets) && p.state_bullets.length > 0));
    if (states.length === 0) return;
    // Budget whole participants, never a mid-participant slice: a silent cut
    // looks complete to the synthesizer, an explicit marker does not (audit D9/5.3).
    const blocks = states.map((p) => {
      const name = p.config?.name ?? p.config?.id ?? "unknown";
      const category = p.config?.category ?? p.config?.tier ?? "";
      const stance = String(p.state_stance ?? "").slice(0, STATE_PATCH_CAPS.stanceMax).replace(/\n/g, " ");
      const bullets = (p.state_bullets ?? []).slice(0, 4).map((b) => String(b).slice(0, STATE_PATCH_CAPS.bulletMax).replace(/\n/g, " "));
      return `**${name} (${category})${p.state_version ? ` v${p.state_version}` : ""}**: ${stance || "(no stance)"}${bullets.length > 0 ? ` — ${bullets.join(" | ")}` : ""}`;
    });
    const out = ["### Agent States (final)", "_Positions only — cite weave [#id] for every contested claim; bullets without a [#id] trail are unattributed positions, not findings._"];
    let used = out.join("\n").length;
    for (let i = 0; i < blocks.length; i++) {
      if (used + blocks[i].length + 1 > 4000) {
        out.push(`- …${blocks.length - i} more participant(s) omitted (state budget)`);
        break;
      }
      out.push(blocks[i]);
      used += blocks[i].length + 1;
    }
    lines.push(out.join("\n"));
  };
  if (!data.rounds || data.rounds.length === 0) {
    const lines = [];
    appendAgentStates(lines);
    appendReflections(lines);
    return lines.join("\n");
  }
  const budgetChars = Math.max(4000, Number(opts.budgetChars) || 24000);
  const rounds = data.rounds;
  if (rounds.length === 1) {
    const round = rounds[0];
    const lines = formatRoundLines(round, participants);
    lines[0] = `### Round ${round.number} (Final)`;
    appendAgentStates(lines);
    appendReflections(lines);
    const joined = lines.join("\n");
    return truncForTranscript(joined, budgetChars);
  }

  // The agent-states and reflections blocks are small and never sacrificed.
  const fixedLines = [];
  appendAgentStates(fixedLines);
  appendReflections(fixedLines);
  const fixedLen = fixedLines.join("\n").length + 200;

  // Per round: the full text, and the citable index that stands in for it.
  const perRound = rounds.map((r, i) => {
    const isFinal = i === rounds.length - 1;
    const ls = formatRoundLines(r, participants);
    ls[0] = `### Round ${r.number} ${isFinal ? "(Final)" : "(full)"}`;
    const index = formatRoundIndexLines(r, participants);
    const digest = renderClerkDigest(r.summary || (r.contributions?.[0]?.content ?? ""));
    const indexBlock = [`### Round ${r.number} (index — ids and the clerk's account; full text in the meeting record)`];
    if (index) indexBlock.push(index);
    if (digest) indexBlock.push(`Clerk: ${digest}`);
    return { number: r.number, isFinal, full: ls.join("\n"), index: indexBlock.join("\n") };
  });

  // Budget order, in two reserves:
  //   1. every round gets its citable index — a contribution the synthesizer
  //      cannot see cannot be cited, and "nothing silently dropped" is the
  //      point of the artifact (audit B);
  //   2. whatever is left goes to the NEWEST rounds' full text, so the final
  //      round is the last thing that would be sacrificed.
  const budget = Math.max(2000, budgetChars - fixedLen);
  const indexCost = perRound.reduce((sum, r) => sum + r.index.length + 2, 0);
  // The index reserve is honoured FIRST: a contribution the synthesizer cannot
  // see cannot be cited, and the artifact's "nothing silently dropped" promise
  // is worth more than the prose of a round that is already summarised. What
  // is left goes to the NEWEST rounds' full text, so the final round is the
  // last thing that would be sacrificed.
  const indexBudget = Math.min(indexCost, Math.floor(budget * 0.6));
  const fullBudget = budget - indexBudget;
  const full = [];
  let fullUsed = 0;
  for (let i = perRound.length - 1; i >= 0; i--) {
    const r = perRound[i];
    if (fullUsed + r.full.length + 2 <= fullBudget) {
      full.unshift(r.full);
      fullUsed += r.full.length + 2;
    }
  }
  // The rounds that did not get full text keep their citable index, newest
  // first; the ones that do not fit are dropped, and the loss is marked.
  const indexed = [];
  let indexUsed = 0;
  const indexRoom = budget - fullUsed;
  for (let i = perRound.length - 1; i >= 0; i--) {
    const r = perRound[i];
    if (full.includes(r.full)) continue;
    if (indexUsed + r.index.length + 2 > indexRoom) continue;
    indexed.unshift(r.index);
    indexUsed += r.index.length + 2;
  }
  const headLines = [];
  const dropped = perRound.length - full.length - indexed.length;
  if (dropped > 0) {
    headLines.push(`…[${dropped} earlier round${dropped === 1 ? "" : "s"} omitted from this transcript — every contribution is in the meeting record]`);
  }
  headLines.push(...indexed);
  const tailLines = [...full, ...fixedLines];
  const joined = [...headLines, ...tailLines].join("\n");
  return truncForTranscript(joined, budgetChars);
}

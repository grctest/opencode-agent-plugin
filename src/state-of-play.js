import { Logger, extractErrorInfo } from "./logger.js";
import { isPassContribution } from "./utils/contribution-types.js";

const TAG_STRIP_RE = /^\[(?:PROPOSE|CHALLENGE|REFINE|SUPPORT|DISSENT|SYNTHESIZE|QUESTION|REFUSE)\]\s*/i;
const REQUEST_NEXT_RE = /^\[REQUEST_NEXT:[^\]]*\]\s*/gim;
// Live prefixes emitted by loom_* tools (store as indented rows, but strip for SoP compactness)
const LIVE_PREFIX_RES = [
  /^\[Response to query from .+?\]\s*/gim,
  /^\[Evidence from .+? on .+?\]\s*/gim,
  /^\[Critique from .+?\]\s*/gim,
  /^\[Risk analysis by .+?\]\s*/gim,
  /^\[Assumptions surfaced by .+?\]\s*/gim,
  /^\[Alternatives proposed by .+?\]\s*/gim,
  /^\[Summoned: .+?\] ?/gim,
  /^\[Vote from .+?\]\s*/gim,
  /^\[Reflection on .+?\]\s*/gim,
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
 * Classification uses the parsed contribution type tag (c.type) as the primary
 * signal. Falls back to keyword matching only when c.type is missing or unknown.
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

    const bucket = classifyContribution(c.type, content, c.prompt_context?.mode ?? "");
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
 * Classifies a contribution into a state-of-play bucket.
 * Primary: use the parsed type tag. Fallback: keyword matching on content.
 */
function classifyContribution(type, content, mode = "") {
  switch (type) {
    case "contribution":
      return classifyByKeywords(content);
    case "critique_response":
    case "perspective_response":
      return type === "perspective_response" ? "keyFacts" : "disagreements";
    case "query_response":
      if (mode === "risks" || mode === "assumptions") return "openQuestions";
      return "keyFacts";
    case "evidence_response":
    case "summoned_response":
      return "keyFacts";
    case "vote_response":
    case "synthesize":
    case "refuse":
    case "pass":
      return null;
    // Legacy typed contributions no longer emitted; route to keyword fallback
    case "propose":
    case "refine":
    case "support":
    case "challenge":
    case "dissent":
    case "question":
      return classifyByKeywords(content);
    case "reflection":
      return "keyFacts";
    default:
      return classifyByKeywords(content);
  }
}

/**
 * Fallback keyword-based classification for contributions with unknown/missing type tags.
 * Uses word-boundary-aware matching to avoid substring false positives.
 */
function classifyByKeywords(content) {
  const withoutUrls = content.replace(/https?:\/\/\S+/g, "").replace(/`[^`]*`/g, "");
  const lower = withoutUrls.toLowerCase();
  if (/\bwe should\b/.test(lower) || /\bdecision\b/.test(lower)) return "decisions";
  if (/\bagree\b/.test(lower) || /\bconsensus\b/.test(lower)) return "agreements";
  if (/\bdisagree\b/.test(lower) || /\bconcern\b/.test(lower)) return "disagreements";
  if (/\?\s*$/.test(withoutUrls.trim()) || /\?\s+[A-Z]/.test(withoutUrls)) return "openQuestions";
  return "keyFacts";
}

/**
 * Formats structured state-of-play sections into a markdown summary — thorough, not terse.
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
  const mergeList = (name, limit = 8) => {
    const values = [];
    const seen = new Set();
    for (const source of [primary, fallback]) {
      for (const line of readSection(source, name).split("\n")) {
        const value = line.trim();
        if (!value.startsWith("- ")) continue;
        const key = value.slice(2).replace(/\s+/g, " ").toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        values.push(value);
      }
    }
    return values.slice(0, limit).map((value) => value.slice(2));
  };
  const question = readSection(primary, "Question") || readSection(fallback, "Question");
  const tags = readSection(primary, "Tags") || readSection(fallback, "Tags");
  const sectionKey = {
    decisions: "Decisions & Proposals",
    agreements: "Agreements",
    disagreements: "Disagreements & Concerns",
    openQuestions: "Open Questions",
    keyFacts: "Key Facts",
    filesInvolved: "Files Involved",
  };
  const sections = {};
  for (const [key, name] of Object.entries(sectionKey)) sections[key] = mergeList(name);
  return formatStateOfPlay(sections, question, tags ? tags.split(",").map((tag) => tag.trim()).filter(Boolean) : []);
}

export function formatStateOfPlay(sections, question, tags) {
  const lines = [];
  if (question) lines.push(`## Question\n${question}`);
  if (tags?.length > 0) lines.push(`## Tags\n${tags.join(", ")}`);

  if (sections.decisions.length > 0) {
    lines.push(`## Decisions & Proposals\n${sections.decisions.slice(-8).map((d) => `- ${d.slice(0, 500)}`).join("\n")}`);
  }
  if (sections.agreements.length > 0) {
    lines.push(`## Agreements\n${sections.agreements.slice(-8).map((a) => `- ${a.slice(0, 500)}`).join("\n")}`);
  }
  if (sections.disagreements.length > 0) {
    lines.push(`## Disagreements & Concerns\n${sections.disagreements.slice(-8).map((d) => `- ${d.slice(0, 500)}`).join("\n")}`);
  }
  if (sections.openQuestions.length > 0) {
    lines.push(`## Open Questions\n${sections.openQuestions.slice(-8).map((q) => `- ${q.slice(0, 500)}`).join("\n")}`);
  }
  if (sections.keyFacts.length > 0) {
    lines.push(`## Key Facts\n${sections.keyFacts.slice(-8).map((f) => `- ${f.slice(0, 500)}`).join("\n")}`);
  }
  if (sections.filesInvolved && sections.filesInvolved.length > 0) {
    lines.push(`## Files Involved\n${sections.filesInvolved.slice(-8).map((f) => `- ${f.slice(0, 160)}`).join("\n")}`);
  }

  return lines.join("\n\n");
}

/** Formats a single round's contributions and turn requests into markdown lines. */
function formatRoundLines(round, participants) {
  const lines = [];
  const isFinal = round.number === undefined;
  lines.push(`### Round ${isFinal ? "(Final)" : round.number}`);

  for (const c of round.contributions) {
    const participant = participants.find((p) => p.config.id === c.participant_id);
    const name = participant?.config.name ?? c.participant_id;
    const tier = participant?.config.tier ?? "mid";
    lines.push(`**[${name}]** (${tier}, ${c.type}): ${c.content}`);
  }

  if (round.turn_requests && round.turn_requests.length > 0) {
    lines.push(`  **Turn Requests:**`);
    for (const tr of round.turn_requests) {
      const name = participants.find((p) => p.config.id === tr.participant_id)?.config.name ?? tr.participant_id;
      const target = tr.target ?? tr.target_participant_id ?? tr.targetId ?? "next";
      lines.push(`  - [${name}] P${tr.priority} → ${target}: ${tr.reason}`);
    }
  }

  if (round.summary) {
    lines.push(`  *Summary:* ${round.summary}`);
  }

  return lines;
}

/** Formats transcript for synthesis: digest of earlier rounds + full final round + reflections. */
export function formatFinalRoundTranscript(data, participants) {
  const truncForTranscript = (s, lim) => {
    if (s.length <= lim) return s;
    // Avoid cutting surrogate pairs
    let cut = s.slice(0, lim);
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xD800 && last <= 0xDBFF) cut = cut.slice(0, -1);
    return cut + "\n...[truncated]";
  };
  const appendReflections = (lines) => {
    const reflections = (participants || []).filter((p) => p.reflection).map((p) => `**${p.config.name} (${p.config.tier}) reflection**: ${p.reflection.slice(0, 800).replace(/\n/g, " ")}`);
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
    const block = ["### Agent States (final)", "_Positions only — cite weave [#id] for every contested claim; bullets without a [#id] trail are unattributed positions, not findings._"];
    for (const p of states) {
      const name = p.config?.name ?? p.config?.id ?? "unknown";
      const tier = p.config?.tier ?? "";
      const stance = String(p.state_stance ?? "").slice(0, 400).replace(/\n/g, " ");
      const bullets = (p.state_bullets ?? []).slice(0, 4).map((b) => String(b).slice(0, 280).replace(/\n/g, " "));
      block.push(`**${name} (${tier})${p.state_version ? ` v${p.state_version}` : ""}**: ${stance || "(no stance)"}${bullets.length > 0 ? ` — ${bullets.join(" | ")}` : ""}`);
    }
    lines.push(block.join("\n").slice(0, 4000));
  };
  if (!data.rounds || data.rounds.length === 0) {
    const lines = [];
    appendAgentStates(lines);
    appendReflections(lines);
    return lines.join("\n");
  }
  if (data.rounds.length === 1) {
    const round = data.rounds[0];
    const lines = formatRoundLines(round, participants);
    lines[0] = `### Round ${round.number} (Final)`;
    appendAgentStates(lines);
    appendReflections(lines);
    const joined = lines.join("\n");
    return truncForTranscript(joined, 24000);
  }
  const lines = [];
  // For 2-4 rounds, include fuller digests; for longer, keep last 2 full + earlier digests 400 chars
  const fullRounds = data.rounds.length <= 4 ? data.rounds : data.rounds.slice(-2);
  const digestRounds = data.rounds.length <= 4 ? [] : data.rounds.slice(0, -2);
  for (let i = 0; i < digestRounds.length; i++) {
    const r = digestRounds[i];
    const summary = (r.summary || (r.contributions[0]?.content ?? "")).slice(0, 400).replace(/\n/g, " ");
    const contested = (r.contributions.find((c) => c.type === "critique_response" || c.type === "perspective_response" || c.type === "challenge" || c.type === "dissent" || /\b(challenge|dissent|disagree|concern|oppose|dispute|contradict|risk|flaw|weakness)\b/i.test(String(c.content ?? "")))?.content ?? "").slice(0, 400).replace(/\n/g, " ");
    // Include top file mention for code rounds
    const fileMention = (r.contributions.find((c) => /file=|src\/.*\.\w+|```/.test(String(c.content)))?.content ?? "").slice(0, 300).replace(/\n/g, " ");
    lines.push(`### Round ${r.number} (digest)`);
    if (summary) lines.push(`Summary: ${summary}`);
    if (contested) lines.push(`Contested: ${contested}`);
    if (fileMention) lines.push(`Code: ${fileMention}`);
  }
  for (const r of fullRounds) {
    const ls = formatRoundLines(r, participants);
    // mark last as final, others as full
    ls[0] = `### Round ${r.number} ${r === fullRounds[fullRounds.length-1] ? "(Final)" : "(full)"}`;
    lines.push(...ls);
  }
  appendAgentStates(lines);
  appendReflections(lines);
  const joined2 = lines.join("\n");
  return truncForTranscript(joined2, 24000);
}

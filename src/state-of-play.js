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
      content = `[Reflected: ${content.slice(0, 280)}]`;
    }

    if (hasFileMention(content)) {
      const fileMatch = content.match(/(?:file\s*=\s*)([^\s`'"]+\.\w+)/i) || content.match(/(src\/[^\s`'"]+\.\w+)/i) || content.match(/(^|[\s(])([\w-]+\.(?:tsx|ts|js|jsx|py|rs|go))\b/i);
      const rawSnippet = fileMatch ? (fileMatch[1] || fileMatch[2]).slice(0, 80) : content.slice(0, 120);
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

  // Deduplicate by full path lowercased, keep most recent, then take last 5
  const dedupMap = new Map();
  for (const f of filesInvolved) {
    const key = f.toLowerCase();
    // Use full path for dedup, not prefix-collided 80-char snippet alone
    if (dedupMap.has(key)) dedupMap.delete(key);
    dedupMap.set(key, f);
  }
  const dedupedFiles = [...dedupMap.values()];

  return formatStateOfPlay({ decisions, agreements, disagreements, openQuestions, keyFacts, filesInvolved: dedupedFiles.slice(-5) }, question, tags);
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
  const withoutUrls = content.replace(/https?:\/\/\S+/g, "");
  const lower = withoutUrls.toLowerCase();
  if (/\bwe should\b/.test(lower) || /\bdecision\b/.test(lower)) return "decisions";
  if (/\bagree\b/.test(lower) || /\bconsensus\b/.test(lower)) return "agreements";
  if (/\bdisagree\b/.test(lower) || /\bconcern\b/.test(lower)) return "disagreements";
  if (/\?/.test(withoutUrls)) return "openQuestions";
  return "keyFacts";
}

/**
 * Formats structured state-of-play sections into a concise markdown summary.
 */
export function formatStateOfPlay(sections, question, tags) {
  const lines = [];
  if (question) lines.push(`## Question\n${question}`);
  if (tags?.length > 0) lines.push(`## Tags\n${tags.join(", ")}`);

  if (sections.decisions.length > 0) {
    lines.push(`## Decisions & Proposals\n${sections.decisions.slice(-5).map((d) => `- ${d.slice(0, 300)}`).join("\n")}`);
  }
  if (sections.agreements.length > 0) {
    lines.push(`## Agreements\n${sections.agreements.slice(-5).map((a) => `- ${a.slice(0, 300)}`).join("\n")}`);
  }
  if (sections.disagreements.length > 0) {
    lines.push(`## Disagreements & Concerns\n${sections.disagreements.slice(-5).map((d) => `- ${d.slice(0, 300)}`).join("\n")}`);
  }
  if (sections.openQuestions.length > 0) {
    lines.push(`## Open Questions\n${sections.openQuestions.slice(-5).map((q) => `- ${q.slice(0, 300)}`).join("\n")}`);
  }
  if (sections.keyFacts.length > 0) {
    lines.push(`## Key Facts\n${sections.keyFacts.slice(-5).map((f) => `- ${f.slice(0, 300)}`).join("\n")}`);
  }
  if (sections.filesInvolved && sections.filesInvolved.length > 0) {
    lines.push(`## Files Involved\n${sections.filesInvolved.slice(-5).map((f) => `- ${f.slice(0, 120)}`).join("\n")}`);
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
    const reflections = (participants || []).filter((p) => p.reflection).map((p) => `**${p.config.name} (${p.config.tier}) reflection**: ${p.reflection.slice(0, 400).replace(/\n/g, " ")}`);
    if (reflections.length > 0) {
      lines.push("### Final Reflections");
      lines.push(...reflections);
    }
  };
  if (!data.rounds || data.rounds.length === 0) {
    const lines = [];
    appendReflections(lines);
    return lines.join("\n");
  }
  if (data.rounds.length === 1) {
    const round = data.rounds[0];
    const lines = formatRoundLines(round, participants);
    lines[0] = `### Round ${round.number} (Final)`;
    appendReflections(lines);
    const joined = lines.join("\n");
    return truncForTranscript(joined, 8000);
  }
  const lines = [];
  // Digest for rounds 1..n-1 (2 lines each, capped)
  for (let i = 0; i < data.rounds.length - 1; i++) {
    const r = data.rounds[i];
    const summary = (r.summary || (r.contributions[0]?.content ?? "")).slice(0, 120).replace(/\n/g, " ");
    const contested = (r.contributions.find((c) => c.type === "critique_response" || c.type === "perspective_response" || c.type === "challenge" || c.type === "dissent")?.content ?? "").slice(0, 120).replace(/\n/g, " ");
    lines.push(`### Round ${r.number} (digest)`);
    if (summary) lines.push(`Summary: ${summary}`);
    if (contested) lines.push(`Contested: ${contested}`);
  }
  const finalRound = data.rounds[data.rounds.length - 1];
  const finalLines = formatRoundLines(finalRound, participants);
  finalLines[0] = `### Round ${finalRound.number} (Final)`;
  lines.push(...finalLines);
  appendReflections(lines);
  const joined2 = lines.join("\n");
  return truncForTranscript(joined2, 8000);
}

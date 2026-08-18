import { Logger, extractErrorInfo } from "./logger.js";

const TAG_STRIP_RE = /^\[(?:PROPOSE|CHALLENGE|REFINE|SUPPORT|DISSENT|SYNTHESIZE|QUESTION|REFUSE)\]\s*/i;
const REQUEST_NEXT_RE = /\[REQUEST_NEXT:[^\]]*\]/gi;
const QUERY_TAG_RE = /\[QUERY:\s*[^\]]*\]\s*/gi;

function cleanContent(content) {
  return content
    .replace(TAG_STRIP_RE, "")
    .replace(REQUEST_NEXT_RE, "")
    .replace(QUERY_TAG_RE, "")
    .trim();
}

/**
 * Derives a structured state-of-play summary from the weave (contributions).
 * Captures decisions, agreements, disagreements, open questions, and key facts
 * so agents have a compact, accurate running context without O(N²) token growth.
 *
 * Classification uses the parsed contribution type tag (c.type) as the primary
 * signal. Falls back to keyword matching only when c.type is missing or unknown.
 */
export function updateStateOfPlay(weave, question, tags) {
  if (!weave || weave.length === 0) return "";

  const decisions = [];
  const agreements = [];
  const disagreements = [];
  const openQuestions = [];
  const keyFacts = [];

  for (const c of weave) {
    if (c.type === "pass") continue;
    const raw = (c.content ?? "").trim();
    if (!raw) continue;
    const content = cleanContent(raw);
    if (!content) continue;

    const bucket = classifyContribution(c.type, content);
    switch (bucket) {
      case "decisions": decisions.push(content); break;
      case "agreements": agreements.push(content); break;
      case "disagreements": disagreements.push(content); break;
      case "openQuestions": openQuestions.push(content); break;
      default: keyFacts.push(content); break;
    }
  }

  return formatStateOfPlay({ decisions, agreements, disagreements, openQuestions, keyFacts }, question, tags);
}

/**
 * Classifies a contribution into a state-of-play bucket.
 * Primary: use the parsed type tag. Fallback: keyword matching on content.
 */
function classifyContribution(type, content) {
  switch (type) {
    case "propose":
    case "refine":
      return "decisions";
    case "support":
      return "agreements";
    case "challenge":
    case "dissent":
      return "disagreements";
    case "question":
      return "openQuestions";
    case "query_response":
      return "keyFacts";
    case "synthesize":
    case "refuse":
    case "reflection":
      return null;
    default:
      return classifyByKeywords(content);
  }
}

/**
 * Fallback keyword-based classification for contributions with unknown/missing type tags.
 * Uses word-boundary-aware matching to avoid substring false positives.
 */
function classifyByKeywords(content) {
  const lower = content.toLowerCase();

  if (/\bwe should\b/.test(lower) || /\bdecision\b/.test(lower)) return "decisions";
  if (/\bagree\b/.test(lower) || /\bconsensus\b/.test(lower)) return "agreements";
  if (/\bdisagree\b/.test(lower) || /\bconcern\b/.test(lower)) return "disagreements";
  if (/\?/.test(content)) return "openQuestions";
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

  return lines.join("\n\n");
}

/** Formats a single round's contributions and turn requests into markdown lines. */
function formatRoundLines(round, participants) {
  const lines = [];
  const isFinal = round.number === undefined;
  lines.push(`### Round ${isFinal ? "(Final)" : round.number}${isFinal ? "" : ""}`);

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
      lines.push(`  - [${name}] P${tr.priority} → ${tr.target}: ${tr.reason}`);
    }
  }

  if (round.summary) {
    lines.push(`  *Summary:* ${round.summary}`);
  }

  return lines;
}

/** Formats only the final round's transcript for synthesis (reduces token usage). */
export function formatFinalRoundTranscript(data, participants) {
  if (!data.rounds || data.rounds.length === 0) return "";
  const round = data.rounds[data.rounds.length - 1];
  const lines = formatRoundLines(round, participants);
  lines[0] = `### Round ${round.number} (Final)`;
  return lines.join("\n");
}

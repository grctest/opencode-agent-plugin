import { CONFIG } from "./config.js";
import { enforceWordLimit, getPriorityCap } from "./shared.js";

const VALID_TYPES = new Set([
  "propose",
  "challenge",
  "refine",
  "support",
  "dissent",
  "synthesize",
  "question",
  "interjection",
]);

/**
 * @typedef {Object} ValidatedAgentResponse
 * @property {string} participant_id
 * @property {string} content
 * @property {import("./types.js").ContributionType} type
 * @property {{ priority: number; reason: string } | null} interjection
 */

const TYPE_PREFIXES = {
  "[PROPOSE]": "propose",
  "[CHALLENGE]": "challenge",
  "[REFINE]": "refine",
  "[SUPPORT]": "support",
  "[DISSENT]": "dissent",
  "[SYNTHESIZE]": "synthesize",
  "[QUESTION]": "question",
};

function validateResponse(data) {
  if (!data || typeof data !== "object") return null;
  if (typeof data.participant_id !== "string") return null;
  if (typeof data.content !== "string") return null;
  if (!VALID_TYPES.has(data.type)) return null;
  if (data.interjection !== null) {
    const ij = data.interjection;
    if (
      typeof ij !== "object" ||
      typeof ij.priority !== "number" ||
      !Number.isInteger(ij.priority) ||
      ij.priority < 1 ||
      ij.priority > 10 ||
      typeof ij.reason !== "string" ||
      ij.reason.length < 1 ||
      ij.reason.length > 500
    ) {
      return null;
    }
  }
  return data;
}

/** Parses an agent's text response into a structured AgentResponse with type and optional interjection. */
export function parseAgentResponse(participantId, response, tier) {
  const text = response.trim();

  if (!text || text.length < 3) {
    return null;
  }

  if (text === "[PASS]") {
    return { participant_id: participantId, content: "[PASS]", type: "propose", interjection: null };
  }

  let type = "propose";
  let contentStart = 0;

  for (const [prefix, t] of Object.entries(TYPE_PREFIXES)) {
    if (text.startsWith(prefix)) {
      type = t;
      contentStart = prefix.length;
      break;
    }
  }

  const rawContent = text.slice(contentStart).trim();
  let interjection = null;

  const ijMatch = rawContent.match(
    /\[INTERJECT:\s*Priority:\s*(\d+),\s*Reason:\s*"([^"]+)"\]/i,
  );
  if (ijMatch) {
    const rawPriority = Math.min(10, Math.max(1, parseInt(ijMatch[1])));
    const priorityCap = tier ? getPriorityCap(tier) : 10;
    const priority = Math.min(rawPriority, priorityCap);
    const reason = ijMatch[2].trim();
    interjection = { priority, reason };
  }

  const cleanContent = rawContent.replace(/\[INTERJECT:\s*Priority:\s*\d+,\s*Reason:\s*"[^"]*"\]/i, "").trim();

  const limitedContent = enforceWordLimit(cleanContent, CONFIG.maxContributionWords);

  const validated = validateResponse({
    participant_id: participantId,
    content: limitedContent,
    type,
    interjection,
  });

  if (validated) {
    return validated;
  }

  return {
    participant_id: participantId,
    content: enforceWordLimit(rawContent, CONFIG.maxContributionWords),
    type: "propose",
    interjection: null,
  };
}

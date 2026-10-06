import { AgentResponseSchema, parseAgentResponseRaw } from "./schemas.js";
import { Logger } from "./logger.js";

const validationLogger = new Logger();

/**
 * Parses an agent's text response into a structured AgentResponse.
 * Uses Zod schema validation for robust parsing.
 * @param {string} participantId
 * @param {string} response
 * @param {string} [tier] - Agent tier for priority cap
 * @returns {Object|null} Validated response or null if invalid
 */
export function parseAgentResponse(participantId, response, tier) {
  const text = response.trim();

  if (!text || text.trim().length < 3) return null;
  if (text.length < 10 && /^[.\s]+$/.test(text)) return null;

  // Parse raw response (extracts type prefix)
  const parsed = parseAgentResponseRaw(response, tier);
  if (!parsed) return null;

  // Validate with Zod schema
  const result = AgentResponseSchema.safeParse({
    participant_id: participantId,
    content: parsed.content,
    type: parsed.type,
    query: parsed.query,
    evidence: parsed.evidence,
    summon: parsed.summon,
    vote: parsed.vote,
  });

  if (result.success) {
    return result.data;
  }

  // Log validation failure for debugging
  validationLogger.warn("response_validation_failed", "Agent response failed schema validation — treating as challenge", {
    participantId,
    error: result.error.flatten(),
  });

  // Fallback: treat malformed output as a challenge so it's visible, not silently accepted as a proposal
  return {
    participant_id: participantId,
    content: parsed.content,
    type: "contribution",
    query: null,
    evidence: null,
    summon: null,
    vote: null,
  };
}
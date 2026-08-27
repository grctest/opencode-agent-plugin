import { AgentResponseSchema, parseAgentResponseRaw } from "./schemas.js";
import { Logger } from "./logger.js";

const validationLogger = new Logger();

/**
 * Parses an agent's text response into a structured AgentResponse with type and optional request_next.
 * Uses Zod schema validation for robust parsing.
 * @param {string} participantId
 * @param {string} response
 * @param {string} [tier] - Agent tier for priority cap
 * @returns {Object|null} Validated response or null if invalid
 */
export function parseAgentResponse(participantId, response, tier) {
  const text = response.trim();

  if (!text || text.length < 3) {
    // Very short text is likely a model glitch — fall back to a visible challenge rather than hard-failing the turn
    // (prevents "Failed to parse agent response" retries that exhaust all models)
    const fallback = text.length > 0 ? text : "[No content — model returned empty]";
    return {
      participant_id: participantId,
      content: fallback,
      type: "challenge",
      request_next: null,
      query: null,
      evidence: null,
      summon: null,
      vote: null,
    };
  }

  if (text === "[PASS]") {
    return { participant_id: participantId, content: "[PASS]", type: "propose", request_next: null, query: null, evidence: null, summon: null, vote: null };
  }

  // Parse raw response (extracts type prefix and request_next directive)
  const parsed = parseAgentResponseRaw(response, tier);
  if (!parsed) return null;

  // Validate with Zod schema
  const result = AgentResponseSchema.safeParse({
    participant_id: participantId,
    content: parsed.content,
    type: parsed.type,
    request_next: parsed.request_next,
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
    type: "challenge",
    request_next: null,
    query: null,
    evidence: null,
    summon: null,
    vote: null,
  };
}
import { getConfig } from "./config.js";
import { enforceWordLimit, getPriorityCap } from "./shared.js";
import { AgentResponseSchema, ContributionTypeSchema, parseAgentResponseRaw } from "./schemas.js";

/**
 * Parses an agent's text response into a structured AgentResponse with type and optional interjection.
 * Uses Zod schema validation for robust parsing.
 * @param {string} participantId
 * @param {string} response
 * @param {string} [tier] - Agent tier for priority cap
 * @returns {Object|null} Validated response or null if invalid
 */
export function parseAgentResponse(participantId, response, tier) {
  const text = response.trim();

  if (!text || text.length < 3) {
    return null;
  }

  if (text === "[PASS]") {
    return { participant_id: participantId, content: "[PASS]", type: "propose", interjection: null };
  }

  // Parse raw response (extracts type prefix and interjection directive)
  const parsed = parseAgentResponseRaw(response, tier);
  if (!parsed) return null;

  // Apply word limit
  const config = getConfig();
  const limitedContent = enforceWordLimit(parsed.content, config.maxContributionWords);

  // Validate with Zod schema
  const result = AgentResponseSchema.safeParse({
    participant_id: participantId,
    content: limitedContent,
    type: parsed.type,
    interjection: parsed.interjection,
    ...(parsed.governance ? { governance: parsed.governance } : {}),
  });

  if (result.success) {
    return result.data;
  }

  // Log validation failure for debugging
  console.warn('[Validation] Agent response failed schema:', result.error.flatten());

  // Fallback: return basic response with validation errors stripped
  return {
    participant_id: participantId,
    content: limitedContent,
    type: "propose",
    interjection: null,
  };
}

/**
 * Validates a contribution object for database storage.
 * @param {Object} contribution
 * @returns {Object|null} Validated contribution or null
 */
export function validateContribution(contribution) {
  // Import ContributionSchema dynamically to avoid circular deps
  const { ContributionSchema } = require("./schemas.js");
  const result = ContributionSchema.safeParse(contribution);
  return result.success ? result.data : null;
}

/**
 * Validates round data.
 * @param {Object} round
 * @returns {Object|null}
 */
export function validateRound(round) {
  const { RoundSchema } = require("./schemas.js");
  const result = RoundSchema.safeParse(round);
  return result.success ? result.data : null;
}

/**
 * Validates meeting state.
 * @param {Object} state
 * @returns {Object|null}
 */
export function validateMeetingState(state) {
  const { MeetingStateSchema } = require("./schemas.js");
  const result = MeetingStateSchema.safeParse(state);
  return result.success ? result.data : null;
}
import { buildTurnOrderPrompt } from "./prompts/turn-order.js";
import { getConfig } from "./config.js";
import { Logger, extractErrorInfo } from "./logger.js";

/**
 * Extracts the first balanced JSON array from free-form LLM text (audit 01 P6).
 * Walks the string respecting string literals and escapes so a ']' inside a
 * quoted participant ID cannot truncate the scan; returns null if no complete
 * top-level array is found.
 */
export function extractBalancedJsonArray(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      depth++;
    } else if (ch === "]") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Plans turn order for the next round based on agent [REQUEST_NEXT] tags.
 * Uses the orchestrator LLM to order participants.
 *
 * @param {Object} params
 * @param {string} params.stateOfPlay - Current state of play
 * @param {string} params.roundSummary - Summary of the completed round
 * @param {Array} params.turnRequests - Array of {participant_id, priority, reason}
 * @param {Array} params.participants - All participants
 * @param {Function} params.promptFn - Function to prompt the orchestrator LLM
 * @param {Function} params.getHighestTierModel - Function to get the highest tier model
 * @returns {Promise<string[]>} Ordered array of participant IDs
 */
export async function planTurnOrder({ stateOfPlay, roundSummary, turnRequests, participants, promptFn, getHighestTierModel }) {
  const config = getConfig();
  
  // If no requests, return default order (active participants)
  if (!turnRequests || turnRequests.length === 0) {
    return participants
      .filter((p) => p.status !== "failed" && p.status !== "muted")
      .map((p) => p.config.id);
  }

  // Filter to only valid requests (participant must exist and not be failed)
  const validRequests = turnRequests.filter((req) => {
    const p = participants.find((pp) => pp.config.id === req.participant_id);
    return p && p.status !== "failed" && p.status !== "muted";
  });

  if (validRequests.length === 0) {
    return participants
      .filter((p) => p.status !== "failed" && p.status !== "muted")
      .map((p) => p.config.id);
  }

  // Fast path: single request — no LLM call needed
  if (validRequests.length === 1) {
    const requestedId = validRequests[0].participant_id;
    const ordered = participants
      .filter((p) => p.status !== "failed" && p.status !== "muted")
      .map((p) => p.config.id);
    const idx = ordered.indexOf(requestedId);
    if (idx > 0) {
      ordered.splice(idx, 1);
      ordered.unshift(requestedId);
    }
    return ordered;
  }

  const fastPathModelObj = config.fastPathModelObj ?? (config.fastPathModel ? (() => { const idx = config.fastPathModel.indexOf("/"); if (idx === -1) return null; return { providerID: config.fastPathModel.slice(0, idx), modelID: config.fastPathModel.slice(idx + 1) }; })() : null);
  const model = fastPathModelObj ?? getHighestTierModel();
  if (!model) {
    // Fallback: sort by priority descending, then by tier
    return fallbackTurnOrder(validRequests, participants);
  }

  const prompt = buildTurnOrderPrompt(stateOfPlay, roundSummary, validRequests, participants);

  try {
    const result = await promptFn(
      "You are a turn order planner. Return only a JSON array of participant IDs.",
      model,
      prompt,
    );

    // Parse JSON array from response (audit 01 P6: balanced-bracket scan —
    // a lazy /\[.*?\]/ match stops at the first ']' inside a string and
    // truncates the array, silently discarding the plan).
    const jsonText = extractBalancedJsonArray(result);
    if (jsonText) {
      const parsed = JSON.parse(jsonText);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Validate all IDs exist
        const validIds = participants
          .filter((p) => p.status !== "failed" && p.status !== "muted")
          .map((p) => p.config.id);
        const ordered = parsed.filter((id) => validIds.includes(id));
        // Add any missing participants at the end
        for (const id of validIds) {
          if (!ordered.includes(id)) {
            ordered.push(id);
          }
        }
        return ordered;
      }
    }
  } catch (err) {
    const info = extractErrorInfo(err);
    new Logger().warn("turn_order_planning_failed", "Turn order planning failed — using fallback", info);
  }

  // Fallback: sort by priority, then tier
  return fallbackTurnOrder(validRequests, participants);
}

/**
 * Fallback turn order when LLM planning fails.
 * Sorts by priority descending, then by tier (principal > senior > mid > civilian/junior).
 * Civilian ranks at mid per utils/tier.js and the shared TIER_ORDER (audit 02 P4).
 */
function fallbackTurnOrder(turnRequests, participants) {
  const tierOrder = { principal: 0, senior: 1, mid: 2, civilian: 2, junior: 3 };

  // Sort requests by priority descending, then tier
  const sorted = [...turnRequests].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    const pA = participants.find((p) => p.config.id === a.participant_id);
    const pB = participants.find((p) => p.config.id === b.participant_id);
    const tierA = tierOrder[pA?.config.tier] ?? 3;
    const tierB = tierOrder[pB?.config.tier] ?? 3;
    return tierA - tierB;
  });

  // Build ordered list: requested participants first, then remaining
  const ordered = sorted.map((r) => r.participant_id);
  const remaining = participants
    .filter((p) => p.status !== "failed" && p.status !== "muted" && !ordered.includes(p.config.id))
    .map((p) => p.config.id);
  
  return [...ordered, ...remaining];
}

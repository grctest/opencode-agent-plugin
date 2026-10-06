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
 * Plans turn order for the next round. The orchestrator LLM decides the order
 * from the state of play and the completed round's summary — agents no longer
 * request speaking priority. Falls back to the current composition order when
 * no model is available or planning fails.
 *
 * @param {Object} params
 * @param {string} params.stateOfPlay - Current state of play
 * @param {string} params.roundSummary - Summary of the completed round
 * @param {Array} params.participants - All participants
 * @param {Function} params.promptFn - Function to prompt the orchestrator LLM
 * @param {Function} params.getHighestTierModel - Function to get the highest tier model
 * @returns {Promise<string[]>} Ordered array of participant IDs
 */
export async function planTurnOrder({ stateOfPlay, roundSummary, participants, promptFn, getHighestTierModel, getOrchestratorModel, orchestratorConfig }) {
  const config = getConfig();

  const defaultOrder = () => participants
    .filter((p) => p.status !== "failed")
    .map((p) => p.config.id);

  const fastPathModelObj = config.fastPathModelObj ?? (config.fastPathModel ? (() => { const idx = config.fastPathModel.indexOf("/"); if (idx === -1) return null; return { providerID: config.fastPathModel.slice(0, idx), modelID: config.fastPathModel.slice(idx + 1) }; })() : null);
  const model = getOrchestratorModel?.() ?? fastPathModelObj ?? getHighestTierModel();
  if (!model) {
    return defaultOrder();
  }

  const prompt = buildTurnOrderPrompt(stateOfPlay, roundSummary, participants, orchestratorConfig);

  try {
    const result = await promptFn(
      // Format contract first, before any injected operator block can erode it
      // (audit O12): identical restatement in the user prompt is reinforcement.
      "Respond with ONLY a JSON array of participant IDs, e.g. [\"id1\", \"id2\"]. You are a turn order planner.",
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
          .filter((p) => p.status !== "failed")
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
    new Logger().warn("turn_order_planning_failed", "Turn order planning failed — using default order", info);
  }

  return defaultOrder();
}

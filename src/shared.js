// Shared utilities — re-export from focused modules for backward compatibility.
// Prefer importing directly from utils/text.js, utils/tier.js, or utils/db-parsing.js in new code.

export { extractText, truncate, enforceWordLimit, withTimeout } from "./utils/text.js";
export {
  LOOKBACK,
  INTERJECTION_PRIORITY_CAP,
  getPriorityCap,
  BASE_RIGHTS,
  getRightsForTier,
  getDefaultTemperatureForTier,
  getPromptForTier,
  splitModel,
  getTierConfig,
} from "./utils/tier.js";
export { parseReflections, parseStats } from "./utils/db-parsing.js";

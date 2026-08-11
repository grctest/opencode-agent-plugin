export {
  getRightsForTier,
  getPromptForTier,
  splitModel,
  getTierConfig,
  getDefaultTemperatureForTier,
  BASE_RIGHTS,
} from "./shared.js";

/** Checks whether a participant's tier grants a specific deliberation right. */
export function can(participant, action) {
  return participant.tier_config.rights[action];
}

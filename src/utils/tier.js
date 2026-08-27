/** Lookback windows used throughout the deliberation engine. */
export const LOOKBACK = {
  SENDER_HISTORY: 6,
};

/** Priority caps per tier for turn request self-reporting. */
export const TURN_REQUEST_PRIORITY_CAP = {
  junior: 5,
  mid: 7,
  senior: 9,
  principal: 10,
  civilian: 7,
};

/** Gets the maximum turn request priority a tier can self-report. */
export function getPriorityCap(tier) {
  return TURN_REQUEST_PRIORITY_CAP[tier] ?? 5;
}

/** Default rights configuration for tiers. */
export const BASE_RIGHTS = {
  contribute: true,
  request_turn: true,
  call_vote: false,
};

/** Returns deliberation rights for a given tier. */
export function getRightsForTier(tier) {
  switch (tier) {
    case "junior":
      return { ...BASE_RIGHTS };
    case "mid":
    case "civilian":
      return { ...BASE_RIGHTS, call_vote: true };
    case "senior":
      return { ...BASE_RIGHTS, call_vote: true };
    case "principal":
      return { ...BASE_RIGHTS, call_vote: true };
    default:
      return { ...BASE_RIGHTS };
  }
}

/** Returns the default temperature for a tier. */
export function getDefaultTemperatureForTier(tier) {
  switch (tier) {
    case "junior": return 0.7;
    case "mid":
    case "civilian": return 0.5;
    case "senior": return 0.3;
    case "principal": return 0.2;
    default: return 0.5;
  }
}

/** Splits a "provider/model" string into its components. */
export function splitModel(model) {
  const idx = model.indexOf("/");
  if (idx === -1) throw new Error(`Invalid model format (expected "provider/model"): ${model}`);
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

/** Builds a complete tier config with optional model/temperature overrides. */
export function getTierConfig(tier, overrides) {
  return {
    model: overrides?.model ?? "",
    temperature: overrides?.temperature ?? getDefaultTemperatureForTier(tier),
    reasoning_effort: overrides?.reasoning_effort,
    // system_prompt_addendum removed — tier guidance now comes from persona files via participant.config.tier_guidance
    rights: getRightsForTier(tier),
  };
}

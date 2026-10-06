/** Lookback windows used throughout the deliberation engine. */
export const LOOKBACK = {
  SENDER_HISTORY: 6,
};

/** Default rights configuration for tiers. */
export const BASE_RIGHTS = {
  contribute: true,
  call_vote: false,
};

/** Returns deliberation rights for a given tier. */
export function getRightsForTier(tier) {
  switch (tier) {
    case "junior":
      return { ...BASE_RIGHTS };
    case "mid":
    case "civilian":
    case "senior":
    case "principal":
    // A non-human seat holds a vote like any other. The tier is a label for
    // how a persona was selected, not a measure of authority, and giving it
    // call_vote would make a bat's dissent procedurally weaker than a CFO's.
    case "nonhuman":
      return { ...BASE_RIGHTS, call_vote: true };
    default:
      return { ...BASE_RIGHTS };
  }
}

/** Splits a "provider/model" string into its components. */
export function splitModel(model) {
  const idx = model.indexOf("/");
  if (idx === -1) throw new Error(`Invalid model format (expected "provider/model"): ${model}`);
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

/** Builds a complete tier config with optional model overrides. */
export function getTierConfig(tier, overrides) {
  return {
    model: overrides?.model ?? "",
    reasoning_effort: overrides?.reasoning_effort,
    // system_prompt_addendum removed — tier guidance now comes from persona files via participant.config.tier_guidance
    rights: getRightsForTier(tier),
  };
}

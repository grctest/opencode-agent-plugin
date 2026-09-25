/** Lookback windows used throughout the deliberation engine. */
export const LOOKBACK = {
  SENDER_HISTORY: 6,
};

/**
 * Priority caps per tier for turn request self-reporting.
 * @deprecated Seniority no longer gates priority: urgency is judged by the
 * turn planner on evidence and reason, not rank. Kept frozen for
 * backward-compatible imports; use getPriorityCap() instead.
 */
export const TURN_REQUEST_PRIORITY_CAP = Object.freeze({
  junior: 5,
  mid: 7,
  senior: 9,
  principal: 10,
  civilian: 7,
});

/**
 * Gets the maximum turn request priority a participant can self-report.
 * Uniform across tiers by design: tiers are setup-phase labels that
 * differentiate persona purpose, and seniority plays no part in turn-order
 * decisions. The planner weighs the stated reason and evidence instead.
 */
export const UNIFORM_PRIORITY_CAP = 10;
export function getPriorityCap(_tier) {
  return UNIFORM_PRIORITY_CAP;
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

const BASE_RIGHTS = {
  contribute: true,
  interject: true,
  call_vote: false,
  veto: false,
  force_end: false,
};

/** Returns deliberation rights for a given tier. Custom tiers get base rights with voting enabled. */
export function getRightsForTier(tier) {
  switch (tier) {
    case "junior":
      return { ...BASE_RIGHTS };
    case "mid":
      return { ...BASE_RIGHTS, call_vote: true };
    case "senior":
      return { ...BASE_RIGHTS, call_vote: true, veto: true };
    case "principal":
      return { ...BASE_RIGHTS, call_vote: true, veto: true, force_end: true };
    default:
      return { ...BASE_RIGHTS, call_vote: true };
  }
}

/** Returns tier-specific behavioral guidance for agent system prompts. */
export function getPromptForTier(tier) {
  switch (tier) {
    case "junior":
      return "Think creatively and bring fresh perspectives. Wild ideas are welcome — you won't be penalized for being wrong. Challenge senior thinking with naive questions that expose hidden assumptions.";
    case "mid":
      return "Balance creativity with evidence. When you disagree, explain why with specific reasoning. Synthesize others' points before adding your own.";
    case "senior":
      return "Prioritize accuracy and risk assessment. Cite patterns from experience. Be conservative with claims but commit fully when you do. Flag irreversible decisions.";
    case "principal":
      return "See the whole system. Cut through noise and circular argument. When consensus is impossible, decide. Your primary role is to ensure this deliberation produces a clear, actionable answer.";
    default:
      return "Contribute your expertise to the deliberation. Challenge assumptions and propose alternatives.";
  }
}

/** Splits a "provider/model" string into its components. */
export function splitModel(model) {
  const idx = model.indexOf("/");
  if (idx === -1) throw new Error(`Invalid model format (expected "provider/model"): ${model}`);
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

/** Checks whether a participant's tier grants a specific deliberation right. */
export function can(participant, action) {
  return participant.tier_config.rights[action];
}

/** Builds a complete tier config with optional model/temperature overrides. */
export function getTierConfig(tier, overrides) {
  return {
    model: overrides?.model ?? "",
    temperature: overrides?.temperature ?? 0.5,
    reasoning_effort: overrides?.reasoning_effort,
    system_prompt_addendum: getPromptForTier(tier),
    rights: getRightsForTier(tier),
  };
}

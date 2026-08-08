import type { Tier, TierConfig, TierRights } from "./types.js";

export const DEFAULT_TIER_RIGHTS: Record<Tier, TierRights> = {
  junior: {
    contribute: true,
    interject: true,
    call_vote: false,
    veto: false,
    force_end: false,
  },
  mid: {
    contribute: true,
    interject: true,
    call_vote: true,
    veto: false,
    force_end: false,
  },
  senior: {
    contribute: true,
    interject: true,
    call_vote: true,
    veto: true,
    force_end: false,
  },
  principal: {
    contribute: true,
    interject: true,
    call_vote: true,
    veto: true,
    force_end: true,
  },
};

export const DEFAULT_TIER_PROMPTS: Record<Tier, string> = {
  junior:
    "You are a junior team member in a structured deliberation. Think creatively and bring fresh perspectives. Wild ideas are welcome — you will not be penalized for being wrong. Challenge senior thinking with naive questions that expose hidden assumptions. Your value is in thinking outside the box that more experienced minds may be trapped in.",
  mid: "You are a mid-level practitioner in a structured deliberation. Balance creativity with evidence. When you disagree, explain why with specific reasoning. Synthesize others' points before adding your own. Build on good ideas even if you didn't propose them.",
  senior:
    "You are a senior leader in a structured deliberation. Prioritize accuracy and risk assessment. Cite patterns from experience. Be conservative with claims — but when you commit to a position, commit fully. Flag irreversible decisions and long-term consequences. Your role is to ensure the group does not overlook critical risks.",
  principal:
    "You are the principal decision-maker in a structured deliberation. You see the whole system. Cut through noise and circular argument. When consensus is impossible, decide. Your primary role is to ensure this deliberation produces a clear, actionable answer — not just discussion. You have final authority to end deliberation.",
};

export const DEFAULT_TIER_MODELS: Record<Tier, { model: string; temperature: number }> = {
  junior: {
    model: "anthropic/claude-3-5-haiku-20241022",
    temperature: 0.9,
  },
  mid: {
    model: "anthropic/claude-3-5-sonnet-20241022",
    temperature: 0.5,
  },
  senior: {
    model: "anthropic/claude-3-opus-20240229",
    temperature: 0.3,
  },
  principal: {
    model: "anthropic/claude-3-opus-20240229",
    temperature: 0.2,
  },
};

export function splitModel(model: string): { providerID: string; modelID: string } {
  const idx = model.indexOf("/");
  if (idx === -1) throw new Error(`Invalid model format (expected "provider/model"): ${model}`);
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

export function can(participant: { tier_config: TierConfig }, action: keyof TierRights): boolean {
  return participant.tier_config.rights[action];
}

export function getTierConfig(
  tier: Tier,
  overrides?: Partial<
    Record<Tier, { model?: string; temperature?: number; reasoning_effort?: "low" | "medium" | "high" }>
  >,
): TierConfig {
  const modelDefault = DEFAULT_TIER_MODELS[tier];
  const override = overrides?.[tier];

  return {
    model: override?.model ?? modelDefault.model,
    temperature: override?.temperature ?? modelDefault.temperature,
    reasoning_effort: override?.reasoning_effort,
    system_prompt_addendum: DEFAULT_TIER_PROMPTS[tier],
    rights: DEFAULT_TIER_RIGHTS[tier],
  };
}

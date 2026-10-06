/** Lookback windows used throughout the deliberation engine. */
export const LOOKBACK = {
  SENDER_HISTORY: 6,
};

/**
 * All participants hold identical deliberation rights. Persona categories
 * (junior/mid/senior/principal/civilian/nonhuman folder names) are
 * organizational labels for browsing the catalog — they grant no authority
 * and drive no engine behavior.
 */
export const BASE_RIGHTS = Object.freeze({
  contribute: true,
  call_vote: true,
});

/** Splits a "provider/model" string into its components. */
export function splitModel(model) {
  const idx = model.indexOf("/");
  if (idx === -1) throw new Error(`Invalid model format (expected "provider/model"): ${model}`);
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

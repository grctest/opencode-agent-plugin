/**
 * Per-model input context budgeting.
 *
 * The only token quantity the system controls is how much input a single call
 * may carry, and that ceiling is a property of the *model assigned to that
 * call* — windows differ by orders of magnitude (32k, 128k, 256k, 1M), so the
 * limit is resolved per call from the call's own model id. There is deliberately
 * no meeting-wide token budget: cross-call cost is not tracked, and provider
 * rejections (rate limit, token budget exhausted, context overflow) are handled
 * reactively in utils/retry.js.
 *
 * Sizing is an estimate, not a tokenization: chat models have no in-process
 * tokenizer, and chars/token varies with code density and non-Latin scripts. The
 * estimate is therefore deliberately conservative (see HEADROOM) — under-counting
 * would mean a provider rejection, which is precisely what this guards against.
 */

/** Conservative chars-per-token ratio. Also used as TUNING.CONTEXT_CHAR_PER_TOKEN. */
export const CHARS_PER_TOKEN = 4;

/**
 * Fraction of a model's context window we allow a single prompt to occupy.
 * The remainder absorbs the estimation error above plus whatever the provider
 * counts that we cannot see (tool schemas serialized server-side, system
 * prompt injected by the host, image/attachment tokens).
 */
export const HEADROOM = 0.85;

/** Used when a model is not in the discovered list, matching discoverModels' own default. */
export const DEFAULT_CONTEXT_LIMIT = 128000;

/** Below this we do not bother trimming — a sliver of a window is not a payload. */
const MIN_BUDGET_CHARS = 4096;

/**
 * A usable context window: a positive finite number.
 *
 * Numeric strings are accepted because provider metadata sometimes stringifies
 * numerics, and silently losing the guard to a formatting quirk is worse than
 * coercing one. Booleans and objects are rejected outright — `Number(true)` is 1,
 * which would resolve a 1-token window and shred every prompt.
 */
function finitePositive(n) {
  if (typeof n !== "number" && typeof n !== "string") return null;
  if (typeof n === "string" && n.trim() === "") return null;
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Resolve the input context ceiling for a model.
 *
 * @param {{providerID?: string, modelID?: string}|null|undefined} model
 * @param {Array<{providerID?: string, modelID?: string, limit?: {context?: number}}>} [availableModels]
 * @returns {number|null} the model's context window in tokens, or null when unknown
 *   (a null result means "do not guard" — current behaviour for unknown models).
 */
export function resolveContextLimit(model, availableModels) {
  const providerID = model?.providerID;
  const modelID = model?.modelID;
  if (!providerID || !modelID) return null;
  const list = Array.isArray(availableModels) ? availableModels : [];
  const entry = list.find(
    (m) => m && m.providerID === providerID && m.modelID === modelID,
  );
  return finitePositive(entry?.limit?.context);
}

/**
 * Character budget for one prompt against one model's window.
 * @returns {number|null} max characters, or null when the model is unknown
 */
export function budgetCharsFor(model, availableModels, { headroom = HEADROOM } = {}) {
  const limit = resolveContextLimit(model, availableModels);
  if (limit === null) return null;
  const chars = Math.floor(limit * headroom * CHARS_PER_TOKEN);
  return chars >= MIN_BUDGET_CHARS ? chars : null;
}

/** Rough token count for a string. */
export function estimateTokens(text) {
  const s = typeof text === "string" ? text : String(text ?? "");
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

/**
 * Rough token count for the payload a provider will actually receive.
 * Tool schemas are serialized into the request, so they are counted too.
 */
export function estimatePayloadTokens({ system, parts, tools } = {}) {
  let chars = 0;
  if (typeof system === "string") chars += system.length;
  for (const p of Array.isArray(parts) ? parts : []) {
    if (typeof p?.text === "string") chars += p.text.length;
    else if (p != null) chars += JSON.stringify(p)?.length ?? 0;
  }
  if (tools && Object.keys(tools).length > 0) {
    try { chars += JSON.stringify(tools).length; } catch { /* unserializable: ignore */ }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/** True when the payload is estimated to exceed the model's budget. */
export function exceedsContextBudget(payload, model, availableModels, opts) {
  const maxChars = budgetCharsFor(model, availableModels, opts);
  if (maxChars === null) return false;
  const chars = estimatePayloadTokens(payload) * CHARS_PER_TOKEN;
  return chars > maxChars;
}

/**
 * Re-assemble a block-structured prompt until it fits, sacrificing the given
 * steps in order until it does.
 *
 * The caller owns the blocks; this only owns the loop, so the sacrifice order can
 * be unit-tested without a meeting around it.
 *
 * @param {() => string} assemble Re-renders the prompt from the caller's current blocks.
 * @param {number|null} budgetChars Target character count, or null for no guard.
 * @param {number} [overheadChars=0] Characters outside `assemble` (system prompt) that
 *   also consume the window.
 * @param {Array<() => void>} steps Sacrifice steps, cheapest context to lose first.
 * @param {(stepsApplied: number, value: string) => void} [onStep] Called after each sacrifice.
 * @returns {{ value: string, stepsApplied: number, overBudget: boolean }}
 */
export function fitPromptToBudget({ assemble, budgetChars, overheadChars = 0, steps = [], onStep = null }) {
  let value = assemble();
  let applied = 0;
  while (
    budgetChars !== null
    && applied < steps.length
    && value.length + overheadChars > budgetChars
  ) {
    steps[applied]();
    applied += 1;
    value = assemble();
    onStep?.(applied, value);
  }
  return {
    value,
    stepsApplied: applied,
    overBudget: budgetChars !== null && value.length + overheadChars > budgetChars,
  };
}

/**
 * Last-resort trim: cut the largest text-bearing part down to `maxChars` total.
 * Block-unaware by design — this is the backstop for callers that did not trim
 * by priority, so it prefers keeping the single largest prompt (the user turn)
 * and shrinking it over deleting parts outright.
 *
 * @returns {{parts: Array, system: string|undefined, trimmedChars: number}|null} null when no trim was needed
 */
export function trimPayloadToBudget(payload, model, availableModels, opts) {
  const maxChars = budgetCharsFor(model, availableModels, opts);
  if (maxChars === null) return null;
  const { system, parts } = payload ?? {};
  const list = Array.isArray(parts) ? parts.map((p) => (typeof p === "object" && p ? { ...p } : p)) : [];
  const currentChars =
    (typeof system === "string" ? system.length : 0) +
    list.reduce((n, p) => n + (typeof p?.text === "string" ? p.text.length : 0), 0) +
    (() => { try { return payload?.tools && Object.keys(payload.tools).length ? JSON.stringify(payload.tools).length : 0; } catch { return 0; } })();

  if (currentChars <= maxChars) return null;

  // Trim the largest text part first; it is the one carrying user-facing content
  // and is the most compressible without breaking structure.
  const candidates = list
    .map((p, i) => ({ i, len: typeof p?.text === "string" ? p.text.length : 0 }))
    .filter((c) => c.len > 0)
    .sort((a, b) => b.len - a.len);
  const target = candidates[0];
  const systemLen = typeof system === "string" ? system.length : 0;
  const toolsLen = (() => { try { return payload?.tools && Object.keys(payload.tools).length ? JSON.stringify(payload.tools).length : 0; } catch { return 0; } })();

  if (!target) {
    // Only the system prompt is oversized — cut it.
    const keep = Math.max(1, maxChars - toolsLen);
    const next = system.slice(0, keep);
    return { system: next, parts: list, trimmedChars: (systemLen - next.length) };
  }

  const keep = Math.max(1, maxChars - systemLen - toolsLen);
  const before = target.len;
  // The marker is part of the payload, so it is charged against the budget
  // rather than appended past it — otherwise the trim would leave the prompt
  // over the very limit it was fitting to.
  const marker = `\n\n[...trimmed to fit this model's ${resolveContextLimit(model, availableModels) ?? "?"}-token input window]`;
  const room = Math.max(1, keep - marker.length);
  const trimmedText = String(list[target.i].text).slice(0, room);
  list[target.i] = { ...list[target.i], text: `${trimmedText}${marker}` };
  return { system, parts: list, trimmedChars: before - room };
}

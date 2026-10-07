/**
 * Phase 3 audit: model trio kept distinct — model-discovery.js owns
 * assignModelsRandomly/sortModelsByQuality, this file is
 * the discovery+assignment service, and model-manager.js is the embedding
 * ONNX manager. Consolidating discovery into this file would be invasive
 * and conflate LLM/provider models with embedding models, so we keep the
 * separation and add this comment. parseFastPathModel dedup already done:
 * single source is src/config/utils.js (re-exported via config/loader.js).
 * A re-export alias is provided at bottom for callers expecting barrel.
 */
import { assignModelsRandomly, sortModelsByQuality } from "../model-discovery.js";
import { Logger, extractErrorInfo } from "../logger.js";

/**
 * @typedef {import("./types.js").ModelRef} ModelRef
 * @typedef {import("./types.js").ParticipantConfig} ParticipantConfig
 * @typedef {import("./types.js").AvailableModel} AvailableModel
 */

const logger = new Logger();

/**
 * Extracts the variant IDs offered by a provider catalog model entry.
 * Upstream catalogs carry them as either an array (`variants: [{id, ...}]`)
 * or a record (`variants: { high: {...}, low: {...} }`); the pinned v1 SDK
 * types declare neither, so this reads the raw field defensively and
 * returns [] when the model offers no variants.
 * @param {any} m raw catalog model entry
 * @returns {string[]}
 */
export function extractVariants(m) {
  if (!m || typeof m !== "object") return [];
  const v = m.variants;
  if (Array.isArray(v)) {
    const out = [];
    for (const entry of v) {
      const id = typeof entry === "string" ? entry : entry?.id;
      if (typeof id === "string" && id && !out.includes(id)) out.push(id);
    }
    return out;
  }
  if (v && typeof v === "object") {
    return Object.keys(v).filter((k) => typeof k === "string" && k);
  }
  return [];
}

/**
 * Parses a participant-level model override string "provider/model" with an
 * optional "#variant" suffix (e.g. "openai/gpt-5.2#high").
 * @param {string} override
 * @returns {ModelRef|null}
 */
function parseModelOverride(override) {
  if (!override || typeof override !== "string") return null;
  let variant;
  let base = override;
  const hash = override.lastIndexOf("#");
  if (hash !== -1) {
    variant = override.slice(hash + 1) || undefined;
    base = override.slice(0, hash);
  }
  const idx = base.indexOf("/");
  if (idx === -1) return null;
  const ref = { providerID: base.slice(0, idx), modelID: base.slice(idx + 1) };
  if (variant) ref.variant = variant;
  return ref;
}

/**
 * Builds a lookup map that resolves any participant-level model override.
 * Overrides may be provided on the participant object under the `model` key
 * (already an object with providerID/modelID) or via a `model_override`
 * string field with "provider/model" format.
 * @param {Array<ParticipantConfig>} participants
 * @returns {Map<string, ModelRef>}
 */
function buildOverrideMap(participants) {
  const map = new Map();
  for (const p of participants) {
    if (!p) continue;
    if (p.model && p.model.providerID && p.model.modelID) {
      const ref = { providerID: p.model.providerID, modelID: p.model.modelID };
      if (typeof p.model.variant === "string" && p.model.variant) ref.variant = p.model.variant;
      map.set(p.id, ref);
      continue;
    }
    const override = p.model_override;
    if (override) {
      const parsed = typeof override === "string" ? parseModelOverride(override) : override;
      if (parsed?.providerID && parsed.modelID) {
        const ref = { providerID: parsed.providerID, modelID: parsed.modelID };
        if (typeof parsed.variant === "string" && parsed.variant) ref.variant = parsed.variant;
        map.set(p.id, ref);
      }
    }
  }
  return map;
}

export async function discoverModels(client, directory, sessionID) {
  const available = [];
  let sessionModel = null;

  try {
    const sessionResult = await client.session.get({
      path: { id: sessionID },
      query: { directory },
    });
    const sessionData = sessionResult?.data ?? sessionResult;
    if (sessionData?.model) {
      const m = sessionData.model;
      sessionModel = {
        providerID: m.providerID,
        modelID: m.modelID ?? m.id,
        ...(typeof m.variant === "string" && m.variant ? { variant: m.variant } : {}),
      };
    }
  } catch (err) {
    const info = extractErrorInfo(err);
    logger.warn("session_model_fetch_failed", "Failed to fetch session model", info);
  }

  try {
    const fn = client.provider?.providers ?? client.provider?.list;
    if (typeof fn !== "function") return { available, sessionModel };

    const result = await fn.call(client.provider, { query: { directory } });
    const data = result?.data ?? result ?? {};
    const providers = data.providers ?? data.all ?? [];
    const connected = data.connected ?? [];

    for (const provider of providers) {
      const isConnected = connected.length === 0 || connected.includes(provider.id);
      if (!isConnected) continue;

      const models = provider.models || {};
      for (const [key, model] of Object.entries(models)) {
        const m = model;
        if (m.status === "deprecated") continue;
        available.push({
          providerID: provider.id,
          modelID: m.id || key,
          name: m.name || key,
          status: m.status || "active",
          cost: m.cost || { input: 0, output: 0 },
          limit: m.limit || { context: 128000, output: 4096 },
          reasoning: m.capabilities?.reasoning || m.reasoning || false,
          variants: extractVariants(m),
        });
      }
    }
  } catch (err) {
    const info = extractErrorInfo(err);
    logger.warn("provider_discovery_failed", "Provider discovery failed", info);
  }

  if (available.length === 0 && sessionModel) {
    available.push({
      providerID: sessionModel.providerID,
      modelID: sessionModel.modelID,
      name: "Session Model",
      status: "active",
      cost: { input: 0, output: 0 },
      limit: { context: 128000, output: 4096 },
      reasoning: false,
      variants: [],
    });
  }

  return { available, sessionModel };
}

/**
 * Assigns models to participants respecting explicit per-participant overrides.
 * Seats without an override get a random model from the available pool —
 * persona categories never influence assignment.
 *
 * @param {Array} participants - Participant configs (may carry `model` or `model_override`)
 * @param {Array} available - Discovered available models
 * @param {Object|null} _sessionModel - Unused (kept for call-site compatibility)
 * @param {() => number} [rng=Math.random] random source (injectable for tests)
 * @returns {Array} Participants with `model` set
 */
export function assignModelsToParticipants(participants, available, _sessionModel = null, rng = Math.random) {
  if (!Array.isArray(participants)) return participants;
  if (available.length === 0) return participants;

  const overrideMap = buildOverrideMap(participants);
  const needsRandom = participants.filter((p) => !overrideMap.has(p.id)).length;
  const randomAssignments = assignModelsRandomly(available, needsRandom, rng);
  let randomIdx = 0;

  return participants.map((p) => {
    const override = overrideMap.get(p.id);
    if (override) {
      return { ...p, model: override };
    }
    const drawn = randomAssignments[randomIdx++] ?? null;
    if (drawn) {
      // Random draws carry no variant — the server default applies.
      return { ...p, model: { providerID: drawn.providerID, modelID: drawn.modelID } };
    }
    return { ...p };
  });
}

/**
 * Returns the default model for orchestrator-side calls (summaries, turn
 * planning, synthesis): the first participant carrying a valid model,
 * otherwise the first available model, otherwise null. No category plays
 * any role — seat order is the only input.
 *
 * @param {Array<{model?:{providerID:string, modelID:string}}>} participants
 * @param {Array<{providerID:string, modelID:string}>} [available]
 * @returns {{providerID:string, modelID:string}|null}
 */
export function getDefaultModel(participants, available = []) {
  const firstWithModel = (participants ?? []).find((p) => p?.model?.providerID && p.model.modelID);
  if (firstWithModel) {
    const ref = { providerID: firstWithModel.model.providerID, modelID: firstWithModel.model.modelID };
    if (typeof firstWithModel.model.variant === "string" && firstWithModel.model.variant) {
      ref.variant = firstWithModel.model.variant;
    }
    return ref;
  }
  const firstAvailable = (available ?? []).find((m) => m?.providerID && m.modelID);
  if (firstAvailable) {
    const ref = { providerID: firstAvailable.providerID, modelID: firstAvailable.modelID };
    if (typeof firstAvailable.variant === "string" && firstAvailable.variant) {
      ref.variant = firstAvailable.variant;
    }
    return ref;
  }
  return null;
}

/**
 * Selects a deterministic healthy fallback model, excluding the failing model.
 * Health is determined by circuit breaker (including global unhealthy).
 * Preference is quality-sorted (active + context + reasoning), not random,
 * so the same failure always yields the same best-available fallback and
 * flaky models are not re-probed via random chance.
 * @param {{providerID: string, modelID: string}} currentModel - The model that failed
 * @param {Array<AvailableModel>} availableModels - All discovered models
 * @param {import("../utils/retry.js").CircuitBreaker} circuitBreaker - Circuit breaker instance
 * @returns {{providerID: string, modelID: string}|null} A healthy fallback model, or null if none available
 */
export function selectFallbackModel(currentModel, availableModels, circuitBreaker) {
  const healthy = circuitBreaker.getHealthyModels(availableModels)
    .filter((m) => !(m.providerID === currentModel.providerID && m.modelID === currentModel.modelID));
  if (healthy.length === 0) return null;
  // Deterministic: highest quality first (matches assignment scoring), stable tie-breaker
  const sorted = sortModelsByQuality(healthy);
  const picked = sorted[0];
  const ref = { providerID: picked.providerID, modelID: picked.modelID };
  // Keep the requested variant only when the fallback model offers it;
  // otherwise the server default applies (an unknown variant would fail resolution).
  if (typeof currentModel?.variant === "string" && currentModel.variant
    && Array.isArray(picked.variants) && picked.variants.includes(currentModel.variant)) {
    ref.variant = currentModel.variant;
  }
  return ref;
}

// Re-export alias for model-discovery barrel expectations (Phase 3) — allows
// `import { assignModelsRandomly } from "./services/model-service.js"` as consolidation alias.
export { assignModelsRandomly, sortModelsByQuality };

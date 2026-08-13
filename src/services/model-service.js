import { assignModelsByTier, sortModelsByQuality } from "../model-discovery.js";
import { Logger, extractErrorInfo } from "../logger.js";

/**
 * @typedef {import("./types.js").ModelRef} ModelRef
 * @typedef {import("./types.js").ParticipantConfig} ParticipantConfig
 * @typedef {import("./types.js").AvailableModel} AvailableModel
 */

const logger = new Logger();

/**
 * Parses a participant-level model override string "provider/model".
 * @param {string} override
 * @returns {ModelRef|null}
 */
function parseModelOverride(override) {
  if (!override || typeof override !== "string") return null;
  const idx = override.indexOf("/");
  if (idx === -1) return null;
  return { providerID: override.slice(0, idx), modelID: override.slice(idx + 1) };
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
      map.set(p.id, { providerID: p.model.providerID, modelID: p.model.modelID });
      continue;
    }
    const override = p.model_override;
    if (override) {
      const parsed = typeof override === "string" ? parseModelOverride(override) : override;
      if (parsed?.providerID && parsed.modelID) {
        map.set(p.id, parsed);
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
      sessionModel = {
        providerID: sessionData.model.providerID,
        modelID: sessionData.model.modelID,
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
          temperature: m.capabilities?.temperature || m.temperature || false,
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
      temperature: true,
    });
  }

  return { available, sessionModel };
}

/**
 * Assigns models to participants respecting explicit per-participant overrides.
 * Tier-based assignment fills in any participant that hasn't declared an override.
 *
 * For model diversity, when multiple high-quality models are available, each
 * participant within a tier gets a different model where possible.
 * @param {Array} participants - Participant configs (may carry `model` or `model_override`)
 * @param {Array} available - Discovered available models
 * @param {Object|null} sessionModel - The session default model
 * @returns {Array} Participants with `model` set
 */
export function assignModelsToParticipants(participants, available, sessionModel) {
  if (!Array.isArray(participants)) return participants;
  if (available.length === 0) return participants;

  const overrideMap = buildOverrideMap(participants);

  const tiers = [...new Set(participants.map((p) => p.tier))];
  const assignments = assignModelsByTier(available, sessionModel, tiers);

  const tierMap = new Map();
  for (const a of assignments) {
    tierMap.set(a.tier, { providerID: a.providerID, modelID: a.modelID });
  }

  // For diversity: if we have more models than tiers, try to give each agent a unique model
  const modelDiversity = getModelDiversity(available, participants, tierMap, overrideMap);

  return participants.map((p) => {
    const override = overrideMap.get(p.id);
    if (override) {
      return { ...p, model: override };
    }

    const diverse = modelDiversity.get(p.id);
    if (diverse) {
      return { ...p, model: diverse };
    }

    return {
      ...p,
      model: tierMap.get(p.tier) ?? undefined,
    };
  });
}

/**
 * Attempts to assign unique models per agent for diversity.
 * Only activates when the number of available models exceeds the number of tiers,
 * meaning there are enough models to give each agent a different one.
 * @returns {Map<string, ModelRef>} Map of participant_id -> model
 */
function getModelDiversity(available, participants, tierMap, overrideMap) {
  const diversityMap = new Map();

  const tierOrder = ["principal", "senior", "mid", "junior"];
  const uniqueTiers = [...new Set(participants.map((p) => p.tier))];

  // Need more models than tiers for diversity to make sense
  if (available.length <= uniqueTiers.length) return diversityMap;

  const sortedModels = sortModelsByQuality(available);
  const usedModels = new Set();
  const participantModels = [];

  // First pass: assign models to participants with overrides
  for (const p of participants) {
    if (overrideMap.has(p.id)) {
      const m = overrideMap.get(p.id);
      usedModels.add(`${m.providerID}/${m.modelID}`);
    }
  }

  // Second pass: assign unique models to remaining participants, preferring
  // higher-tier participants first for the best models
  const unassigned = participants
    .filter((p) => !overrideMap.has(p.id))
    .sort((a, b) => tierOrder.indexOf(b.tier) - tierOrder.indexOf(a.tier));

  for (const p of unassigned) {
    let assigned = false;
    for (const model of sortedModels) {
      const modelKey = `${model.providerID}/${model.modelID}`;
      if (usedModels.has(modelKey)) continue;
      usedModels.add(modelKey);
      participantModels.push({ participantId: p.id, model: { providerID: model.providerID, modelID: model.modelID } });
      assigned = true;
      break;
    }
    if (!assigned) {
      // All models are used; reuse with tier fallback
      const tierModel = tierMap.get(p.tier);
      if (tierModel) {
        participantModels.push({ participantId: p.id, model: tierModel });
      }
    }
  }

  // Build the diversity map
  for (const { participantId, model } of participantModels) {
    diversityMap.set(participantId, model);
  }

  return diversityMap;
}

/**
 * Returns the highest-tier model that is actually usable (principal > senior > mid > junior),
 * falling back to the first participant with a valid model.
 * @param {Array<{tier:string, model?:{providerID:string, modelID:string}}>} participants
 * @returns {{providerID:string, modelID:string}|null}
 */
export function getHighestTierModel(participants) {
  for (const tier of ["principal", "senior", "mid", "junior"]) {
    const p = participants.find((pp) => pp.tier === tier && pp.model?.providerID && pp.model.modelID);
    if (p) return { providerID: p.model.providerID, modelID: p.model.modelID };
  }
  const firstWithModel = participants.find((p) => p.model?.providerID && p.model.modelID);
  if (firstWithModel) return { providerID: firstWithModel.model.providerID, modelID: firstWithModel.model.modelID };
  return null;
}

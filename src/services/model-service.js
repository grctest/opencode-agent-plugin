import { assignModelsByTier } from "../model-discovery.js";
import { Logger, extractErrorInfo } from "../logger.js";

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
    new Logger().warn("session_model_fetch_failed", "Failed to fetch session model", info);
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
    new Logger().warn("provider_discovery_failed", "Provider discovery failed", info);
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

export function assignModelsToParticipants(participants, available, sessionModel) {
  if (available.length === 0) return participants;

  const tiers = [...new Set(participants.map((p) => p.tier))];
  const assignments = assignModelsByTier(available, sessionModel, tiers);

  const modelMap = new Map();
  for (const a of assignments) {
    modelMap.set(a.tier, { providerID: a.providerID, modelID: a.modelID });
  }

  return participants.map((p) => ({
    ...p,
    model: modelMap.get(p.tier) || undefined,
  }));
}

export function getHighestTierModel(participants) {
  for (const tier of ["principal", "senior", "mid", "junior"]) {
    const p = participants.find((pp) => pp.tier === tier);
    if (p?.model) return { providerID: p.model.providerID, modelID: p.model.modelID };
  }
  const firstWithModel = participants.find((p) => p.model);
  if (firstWithModel?.model) return { providerID: firstWithModel.model.providerID, modelID: firstWithModel.model.modelID };
  return null;
}

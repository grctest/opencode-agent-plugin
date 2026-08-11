import { createModelPlan, formatModelPlan } from "../model-discovery.js";

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
  } catch {
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
  } catch {
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
  const priorityOrder = ["principal", "senior", "mid", "junior"];
  const sortedTiers = [...tiers].sort(
    (a, b) => priorityOrder.indexOf(a) - priorityOrder.indexOf(b),
  );

  let assignments;
  if (available.length === 1 || !sessionModel) {
    assignments = sortedTiers.map((tier) => {
      const m = available[0];
      return { tier, providerID: m.providerID, modelID: m.modelID, modelName: m.name };
    });
  } else {
    const sessionIdx = available.findIndex(
      (m) => m.providerID === sessionModel.providerID && m.modelID === sessionModel.modelID,
    );
    const topModel = sessionIdx >= 0 ? available[sessionIdx] : available[0];
    const lowerModels = available.filter((_, i) => i !== sessionIdx);

    assignments = sortedTiers.map((tier, i) => {
      if (tier === "principal" || tier === "senior") {
        return { tier, providerID: topModel.providerID, modelID: topModel.modelID, modelName: topModel.name };
      }
      const lowerIdx = Math.min(i, lowerModels.length - 1);
      const m = lowerModels.length > 0 ? lowerModels[Math.max(0, lowerIdx)] : topModel;
      return { tier, providerID: m.providerID, modelID: m.modelID, modelName: m.name };
    });
  }

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

export async function promptParent(client, directory, sessionId, system, model, message) {
  const result = await client.session.prompt({
    path: { id: sessionId },
    body: { system, model, tools: {}, parts: [{ type: "text", text: message }] },
    query: { directory },
  });
  if (result.error) throw new Error(JSON.stringify(result.error));
  const parts = result.data?.parts ?? [];
  return parts.filter((p) => p.type === "text").map((p) => p.text).join("\n");
}

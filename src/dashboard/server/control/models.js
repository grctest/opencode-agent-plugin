/**
 * LLM model listing + dashboard deny-list filter routes.
 */
import { extractErrorInfo } from "../../../logger.js";
import { isControlReady, readJsonBody, getDirectory } from "./runtime.js";
import { discoverFiltered } from "./discovery.js";
import { loadGlobalFilter, migrateAllowList, persistGlobalFilter } from "./filters.js";
import { clearGlobalUnhealthy, clearAllGlobalUnhealthy } from "../../../services/global-model-health.js";
import { clearGlobalUnhealthyKey, clearAllGlobalUnhealthyKeys } from "../../../utils/retry.js";

export async function handleListLlmModels(url = null) {
  if (!isControlReady()) {
    return Response.json({ error: "dashboard control plane not ready (plugin client unavailable)" }, { status: 503 });
  }
  const force = url?.searchParams?.get("refresh") === "1";
  try {
    const { allAvailable, disabledSet, globalUnhealthy, sessionModel } = await discoverFiltered(force);
    if (allAvailable.length === 0) {
      return Response.json({ models: [], disabled: [], session_model: null, suggested: [] });
    }
    const models = allAvailable.map((m) => {
      const key = `${m.providerID}/${m.modelID}`;
      return {
        key,
        provider_id: m.providerID,
        model_id: m.modelID,
        name: m.name || m.modelID,
        cost: m.cost ?? { input: 0, output: 0 },
        context: m.limit?.context ?? 128000,
        reasoning: !!m.reasoning,
        variants: Array.isArray(m.variants) ? [...m.variants] : [],
        enabled: !disabledSet || !disabledSet.has(key),
        unhealthy: globalUnhealthy.has(key),
      };
    });
    const enabledPool = allAvailable.filter((m) => {
      const key = `${m.providerID}/${m.modelID}`;
      return (!disabledSet || !disabledSet.has(key)) && !globalUnhealthy.has(key);
    });
    let suggested = [];
    let suggestedOrchestrator = null;
    try {
      const pool = enabledPool.length > 0 ? enabledPool : allAvailable;
      suggested = pool.slice(0, 3).map((m) => ({
        provider_id: m.providerID ?? m.provider_id,
        model_id: m.modelID ?? m.model_id,
      }));
      const orch = pool[Math.floor(Math.random() * pool.length)];
      if (orch?.providerID && orch?.modelID) {
        suggestedOrchestrator = {
          provider_id: orch.providerID,
          model_id: orch.modelID,
          key: `${orch.providerID}/${orch.modelID}`,
        };
      }
    } catch {}
    return Response.json({
      models,
      disabled: disabledSet instanceof Set ? [...disabledSet] : [],
      session_model: sessionModel ? `${sessionModel.providerID}/${sessionModel.modelID}` : null,
      session_variant: typeof sessionModel?.variant === "string" && sessionModel.variant ? sessionModel.variant : null,
      suggested,
      suggested_orchestrator: suggestedOrchestrator,
    });
  } catch (err) {
    return Response.json({ error: `model discovery failed: ${extractErrorInfo(err).message}` }, { status: 500 });
  }
}

export async function handleModelFilter(req) {
  if (!isControlReady()) {
    return Response.json({ error: "dashboard control plane not ready (plugin client unavailable)" }, { status: 503 });
  }
  let body;
  try {
    body = await readJsonBody(req, 64 * 1024);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  const action = body?.action;
  const requested = Array.isArray(body?.models) ? body.models.map(String) : [];
  if (!["enable", "disable", "reset"].includes(action)) {
    return Response.json({ error: "action must be one of enable|disable|reset" }, { status: 400 });
  }
  try {
    const { allAvailable } = await discoverFiltered();
    const allKeys = new Set(allAvailable.map((m) => `${m.providerID}/${m.modelID}`));
    let disabledSet = loadGlobalFilter();
    if (disabledSet && disabledSet.__allowList) {
      disabledSet = migrateAllowList(disabledSet, allKeys);
    }
    if (!disabledSet || !(disabledSet instanceof Set)) disabledSet = new Set();

    if (action === "reset") {
      persistGlobalFilter(null);
      let cleared = 0;
      try { cleared = clearAllGlobalUnhealthy(getDirectory()); } catch {}
      try { clearAllGlobalUnhealthyKeys(); } catch {}
      return Response.json({ ok: true, disabled: [], cleared_unhealthy: cleared });
    }

    const invalid = requested.filter((id) => !allKeys.has(id));
    if (invalid.length > 0) {
      return Response.json({ error: `unknown model identifiers: ${invalid.join(", ")}`, valid: [...allKeys] }, { status: 400 });
    }
    if (action === "enable") {
      for (const id of requested) disabledSet.delete(id);
      let cleared = 0;
      for (const id of requested) {
        try { if (clearGlobalUnhealthy(id, getDirectory())) cleared++; } catch {}
        try { clearGlobalUnhealthyKey(id); } catch {}
      }
      persistGlobalFilter(disabledSet.size > 0 ? disabledSet : null);
      return Response.json({ ok: true, disabled: [...disabledSet], cleared_unhealthy: cleared });
    }
    for (const id of requested) disabledSet.add(id);
    let guardKept = null;
    if (disabledSet.size >= allKeys.size) {
      guardKept = [...allKeys].find((k) => requested.includes(k)) ?? [...allKeys][0];
      disabledSet.delete(guardKept);
    }
    persistGlobalFilter(disabledSet.size > 0 ? disabledSet : null);
    return Response.json({ ok: true, disabled: [...disabledSet], guard_kept: guardKept });
  } catch (err) {
    return Response.json({ error: `model filter failed: ${extractErrorInfo(err).message}` }, { status: 500 });
  }
}

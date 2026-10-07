/**
 * Provider model discovery with a short TTL cache. Only the raw discovery
 * result is cached — deny-list filter, global-unhealthy set, and assignment
 * are recomputed from disk on every call so filter toggles stay instant.
 */
import { discoverModels } from "../../../services/model-service.js";
import { applyModelFilter } from "../../../handlers/knit/utils.js";
import { loadGlobalHealth, getGlobalUnhealthySet } from "../../../services/global-model-health.js";
import { getDirectory, runtime } from "./runtime.js";
import { loadGlobalFilter, migrateAllowList, persistGlobalFilter } from "./filters.js";

export const DISCOVERY_TTL_MS = 60 * 1000;
let discoveryCache = { at: 0, key: null, result: null };

export async function discoverRaw(force = false) {
  const key = `${getDirectory()}|${runtime.ownerSessionId || ""}`;
  const now = Date.now();
  if (!force && discoveryCache.result && discoveryCache.key === key && (now - discoveryCache.at) < DISCOVERY_TTL_MS) {
    return discoveryCache.result;
  }
  const result = await discoverModels(
    runtime.client,
    getDirectory(),
    runtime.ownerSessionId || "",
  );
  discoveryCache = { at: now, key, result };
  return result;
}

export async function discoverFiltered(force = false) {
  const { available: allAvailable, sessionModel } = await discoverRaw(force);
  let disabledSet = loadGlobalFilter();
  if (disabledSet && disabledSet.__allowList) {
    const allKeys = new Set(allAvailable.map((m) => `${m.providerID}/${m.modelID}`));
    disabledSet = migrateAllowList(disabledSet, allKeys);
    persistGlobalFilter(disabledSet);
  }
  try {
    loadGlobalHealth(getDirectory());
  } catch {}
  const globalUnhealthy = getGlobalUnhealthySet();
  let available = applyModelFilter(allAvailable, disabledSet);
  available = applyModelFilter(available, globalUnhealthy);
  return { allAvailable, available, disabledSet, globalUnhealthy, sessionModel };
}

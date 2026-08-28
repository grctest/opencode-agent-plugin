import { createModelPlan, formatModelPlan } from "../../model-discovery.js";
import { discoverModels } from "../../services/model-service.js";
import { extractErrorInfo } from "../../logger.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync, closeSync, fsyncSync, renameSync } from "node:fs";
import { join } from "node:path";
import { resolveLoomBaseDir } from "../../paths.js";
import { applyModelFilter } from "./utils.js";

function getFilterPath(directory, sessionId) {
  const base = resolveLoomBaseDir(directory);
  if (sessionId) return join(base, `models-filter-${sessionId}.json`);
  return join(base, "models-filter.json");
}
function loadPersistedFilter(directory, sessionId) {
  try {
    const p = getFilterPath(directory, sessionId);
    if (!existsSync(p)) {
      // Migrate old global allow-list if per-session file missing and global exists
      if (sessionId) {
        const globalPath = getFilterPath(directory, null);
        if (existsSync(globalPath)) {
          try {
            const gData = JSON.parse(readFileSync(globalPath, "utf-8"));
            if (Array.isArray(gData.enabledModels)) {
              return { __allowList: new Set(gData.enabledModels) };
            }
            if (Array.isArray(gData.disabledModels)) return new Set(gData.disabledModels);
          } catch {}
        }
      }
      return null;
    }
    const data = JSON.parse(readFileSync(p, "utf-8"));
    if (Array.isArray(data.disabledModels)) return new Set(data.disabledModels);
    // Compat: old allow-list file with enabledModels — will be converted lazily when available known
    if (Array.isArray(data.enabledModels)) {
      // Return marker object for lazy conversion
      return { __allowList: new Set(data.enabledModels) };
    }
  } catch (err) {
    try { logger?.warn?.("filter_load_failed", `Failed to load filter for session ${sessionId}`, { error: err.message }); } catch {}
  }
  return null;
}
function persistFilter(directory, sessionId, disabledModels) {
  try {
    const p = getFilterPath(directory, sessionId);
    mkdirSync(resolveLoomBaseDir(directory), { recursive: true });
    if (!disabledModels || disabledModels.size === 0) {
      try { if (existsSync(p)) unlinkSync(p); } catch {}
      return;
    }
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ disabledModels: [...disabledModels] }, null, 2));
    try { const fd = openSync(tmp, "r"); fsyncSync(fd); closeSync(fd); } catch {}
    renameSync(tmp, p);
  } catch (err) {
    try { logger?.warn?.("filter_persist_failed", `Failed to persist filter for session ${sessionId}`, { error: err.message }); } catch {}
  }
}

function getDisabledSet(state, sessionId) {
  if (!sessionId) return state.disabledModelsBySession?.get("__global__") ?? null;
  return state.disabledModelsBySession?.get(sessionId) ?? null;
}
function setDisabledSet(state, sessionId, set) {
  if (!state.disabledModelsBySession) state.disabledModelsBySession = new Map();
  const key = sessionId || "__global__";
  if (!set || set.size === 0) state.disabledModelsBySession.delete(key);
  else state.disabledModelsBySession.set(key, set);
}
function getPendingForSession(state, sessionId) {
  if (!sessionId) return state.pendingModelsBySession?.get("__global__") ?? null;
  return state.pendingModelsBySession?.get(sessionId) ?? null;
}
function setPendingForSession(state, sessionId, val) {
  if (!state.pendingModelsBySession) state.pendingModelsBySession = new Map();
  const key = sessionId || "__global__";
  if (!val) state.pendingModelsBySession.delete(key);
  else state.pendingModelsBySession.set(key, val);
}

export function createModelHandlers({ client, directory, logger, state }) {
  // State is now per-session Maps; initialize if missing
  if (!state.disabledModelsBySession) state.disabledModelsBySession = new Map();
  if (!state.pendingModelsBySession) state.pendingModelsBySession = new Map();
  // Legacy compat: migrate old global enabledModels if present
  if (state.enabledModels instanceof Set) {
    // Old allow-list global — convert to per-session deny not needed, clear
    state.enabledModels = null;
  }
  async function handleListKnitModels(args, context) {
    const sessionId = context?.sessionID ?? context?.sessionId ?? context?.session_id ?? null;
    // Reload persisted per-session filter at call time (handles external edits / multi-process)
    try {
      const persisted = loadPersistedFilter(directory, sessionId);
      let disabled = null;
      if (persisted) {
        if (persisted instanceof Set) disabled = persisted;
        else if (persisted.__allowList) {
          // Lazy migration from old allow-list: disabled = allKeys - enabled
          // Need allKeys, so defer until available known
          disabled = persisted.__allowList; // marker, will convert below
        }
      }
      if (disabled !== null && !(disabled instanceof Set && disabled.__allowList)) {
        setDisabledSet(state, sessionId, disabled);
      }
    } catch {}
    let available;
    let sessionModel;
    try {
      const result = await discoverModels(client, directory, sessionId || "");
      available = result.available;
      sessionModel = result.sessionModel;
    } catch (err) {
      const info = extractErrorInfo(err);
      logger.error("model_discovery_failed", "Model discovery failed", info);
      return `Model discovery failed: ${info.message}`;
    }

    if (available.length === 0) {
      return "No active models found. Connect a provider (e.g. run `opencode auth login`).";
    }

    // Handle lazy migration marker
    let disabledSet = getDisabledSet(state, sessionId);
    if (disabledSet && disabledSet.__allowList) {
      const allKeys = new Set(available.map((m) => `${m.providerID}/${m.modelID}`));
      const enabled = disabledSet.__allowList;
      const disabledMigrated = new Set([...allKeys].filter(k => !enabled.has(k)));
      setDisabledSet(state, sessionId, disabledMigrated);
      persistFilter(directory, sessionId, disabledMigrated);
      disabledSet = disabledMigrated;
    }

    const modelKey = (m) => `${m.providerID}/${m.modelID}`;

    // Filtered preview so assignment never proposes disabled models
    const filtered = applyModelFilter(available, disabledSet);
    const plan = createModelPlan(filtered.length > 0 ? filtered : available, undefined, sessionModel);
    setPendingForSession(state, sessionId, plan.participants);

    const lines = [
      "## Available Models",
      "",
      "| Identifier | Provider | Cost | Context | Reasoning | Status |",
      "|------------|----------|------|---------|-----------|--------|",
    ];

    for (const m of available) {
      const key = modelKey(m);
      const isEnabled = !disabledSet || !disabledSet.has(key);
      const status = isEnabled ? "enabled" : "disabled";
      const cost = m.cost.input === 0 && m.cost.output === 0
        ? "free"
        : `$${m.cost.input}/$${m.cost.output}`;
      const ctx = `${Math.round((m.limit?.context ?? 128000) / 1000)}k`;
      const reason = m.reasoning ? "yes" : "—";
      lines.push(`| ${key} | ${m.providerID} | ${cost} | ${ctx} | ${reason} | ${status} |`);
    }

    lines.push("");
    lines.push(`**Total:** ${available.length} model(s)`);
    if (disabledSet && disabledSet.size > 0) {
      lines.push(`**Enabled:** ${available.length - disabledSet.size} model(s)`);
      lines.push(`**Disabled:** ${disabledSet.size} model(s)`);
    } else {
      lines.push("**All models enabled** (no filter set)");
    }
    lines.push("");
    lines.push("Copy the exact `provider/model` identifier to enable or disable a model:");
    lines.push("- `/enable_knit_models openai/gpt-4.1`");
    lines.push("- `/disable_knit_models openai/o1`");
    lines.push("- `/reset_knit_models`");
    lines.push("");
    lines.push(formatModelPlan(plan));

    return lines.join("\n");
  }

  async function handleEnableKnitModels(args, context) {
    const sessionId = context?.sessionID ?? context?.sessionId ?? context?.session_id ?? null;
    const requested = args?.models ?? [];
    if (requested.length === 0) {
      return {
        title: "Model Filter Error",
        output: `Please specify model identifiers to enable.\n\nRun \`/list_knit_models\` to see available models with their exact identifiers.`,
      };
    }

    // Reload latest per-session filter
    try {
      const persisted = loadPersistedFilter(directory, sessionId);
      if (persisted) {
        if (persisted instanceof Set) setDisabledSet(state, sessionId, persisted);
        else if (persisted?.__allowList) {
          // Defer migration until available known
        }
      }
    } catch {}

    let available;
    try {
      const result = await discoverModels(client, directory, sessionId || "");
      available = result.available;
    } catch (err) {
      const info = extractErrorInfo(err);
      logger.error("model_discovery_failed", "Model discovery failed", info);
      return `Model discovery failed: ${info.message}`;
    }

    if (available.length === 0) {
      return "No active models found. Connect a provider (e.g. run `opencode auth login`).";
    }

    const modelKey = (m) => `${m.providerID}/${m.modelID}`;
    const allKeys = new Set(available.map(modelKey));

    const invalid = requested.filter((id) => !allKeys.has(id));
    if (invalid.length > 0) {
      const suggestions = [...allKeys].join("\n");
      return {
        title: "Model Filter Error",
        output: `The following identifiers were not found:\n\n${invalid.map((i) => `- ${i}`).join("\n")}\n\nValid identifiers:\n${suggestions}\n\nRun \`/list_knit_models\` to see the full list.`,
      };
    }

    // Migrate allow-list marker if present
    let disabledSet = getDisabledSet(state, sessionId);
    if (disabledSet && disabledSet.__allowList) {
      const enabled = disabledSet.__allowList;
      disabledSet = new Set([...allKeys].filter(k => !enabled.has(k)));
      setDisabledSet(state, sessionId, disabledSet);
    }
    if (!disabledSet) disabledSet = new Set();
    const added = requested.filter((id) => disabledSet.has(id));
    for (const id of requested) disabledSet.delete(id);
    if (disabledSet.size === 0) disabledSet = null;
    setDisabledSet(state, sessionId, disabledSet);
    if (added.length > 0) setPendingForSession(state, sessionId, null);
    persistFilter(directory, sessionId, disabledSet);
    const enabledCount = disabledSet ? available.length - disabledSet.size : available.length;
    return {
      title: "Models Enabled",
      output: `Enabled ${requested.length} model(s):\n${requested.map((m) => `- ${m}`).join("\n")}\n\n${enabledCount} model(s) are now available for Loom agents.`,
    };
  }

  async function handleDisableKnitModels(args, context) {
    const sessionId = context?.sessionID ?? context?.sessionId ?? context?.session_id ?? null;
    const requested = args?.models ?? [];
    if (requested.length === 0) {
      return {
        title: "Model Filter Error",
        output: `Please specify model identifiers to disable.\n\nRun \`/list_knit_models\` to see available models with their exact identifiers.`,
      };
    }

    try {
      const persisted = loadPersistedFilter(directory, sessionId);
      if (persisted) {
        if (persisted instanceof Set) setDisabledSet(state, sessionId, persisted);
        else if (persisted?.__allowList) { /* migrate after available known */ }
      }
    } catch {}

    let available;
    try {
      const result = await discoverModels(client, directory, sessionId || "");
      available = result.available;
    } catch (err) {
      const info = extractErrorInfo(err);
      logger.error("model_discovery_failed", "Model discovery failed", info);
      return `Model discovery failed: ${info.message}`;
    }

    if (available.length === 0) {
      return "No active models found. Connect a provider (e.g. run `opencode auth login`).";
    }

    const modelKey = (m) => `${m.providerID}/${m.modelID}`;
    const allKeys = new Set(available.map(modelKey));

    const invalid = requested.filter((id) => !allKeys.has(id));
    if (invalid.length > 0) {
      const suggestions = [...allKeys].join("\n");
      return {
        title: "Model Filter Error",
        output: `The following identifiers were not found:\n\n${invalid.map((i) => `- ${i}`).join("\n")}\n\nValid identifiers:\n${suggestions}\n\nRun \`/list_knit_models\` to see the full list.`,
      };
    }

    let disabledSet = getDisabledSet(state, sessionId);
    if (disabledSet && disabledSet.__allowList) {
      const enabled = disabledSet.__allowList;
      disabledSet = new Set([...allKeys].filter(k => !enabled.has(k)));
    }
    if (!disabledSet) disabledSet = new Set();
    const toAdd = requested.filter((id) => !disabledSet.has(id));
    for (const id of requested) disabledSet.add(id);
    // Guard: never disable all models — leave one out
    let guardMessage = "";
    if (disabledSet.size >= allKeys.size) {
      const keep = [...allKeys].find(k => requested.includes(k)) ?? [...allKeys][0];
      disabledSet.delete(keep);
      guardMessage = `\n\n⚠️ Cannot disable all models — left one enabled: ${keep}. All but that one were disabled.`;
    }
    const remaining = allKeys.size - disabledSet.size;
    setDisabledSet(state, sessionId, disabledSet.size > 0 ? disabledSet : null);
    if (toAdd.length > 0) setPendingForSession(state, sessionId, null);
    persistFilter(directory, sessionId, disabledSet.size > 0 ? disabledSet : null);
    return {
      title: "Models Disabled",
      output: `Disabled ${toAdd.length} model(s):\n${toAdd.map((m) => `- ${m}`).join("\n")}\n\n${remaining} model(s) remain available for Loom agents.${guardMessage}`,
    };
  }

  async function handleResetKnitModels(args, context) {
    const sessionId = context?.sessionID ?? context?.sessionId ?? context?.session_id ?? null;
    const disabledSet = getDisabledSet(state, sessionId);
    const prevCount = disabledSet?.size ?? 0;
    setDisabledSet(state, sessionId, null);
    setPendingForSession(state, sessionId, null);
    persistFilter(directory, sessionId, null);
    // Also clear legacy global file if this was per-session reset and global exists
    try {
      const globalPath = getFilterPath(directory, null);
      if (sessionId && existsSync(globalPath)) {
        try { unlinkSync(globalPath); } catch {}
      }
    } catch {}
    return {
      title: "Model Filter Reset",
      output: `Model filter cleared for this session. All discovered models are now available for Loom agents (${prevCount} models were previously disabled).`,
    };
  }

  return { handleListKnitModels, handleEnableKnitModels, handleDisableKnitModels, handleResetKnitModels };
}

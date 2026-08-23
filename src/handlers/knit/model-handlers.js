import { createModelPlan, formatModelPlan } from "../../model-discovery.js";
import { discoverModels } from "../../services/model-service.js";
import { extractErrorInfo } from "../../logger.js";

export function createModelHandlers({ client, directory, logger, state }) {
  async function handleListKnitModels() {
    let available;
    let sessionModel;
    try {
      const result = await discoverModels(client, directory, "");
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

    const modelKey = (m) => `${m.providerID}/${m.modelID}`;

    const plan = createModelPlan(available, undefined, sessionModel);
    state.pendingModels = plan.participants;

    const lines = [
      "## Available Models",
      "",
      "| Identifier | Provider | Cost | Context | Reasoning | Status |",
      "|------------|----------|------|---------|-----------|--------|",
    ];

    for (const m of available) {
      const key = modelKey(m);
      const isEnabled = state.enabledModels === null ? true : state.enabledModels.has(key);
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
    if (state.enabledModels) {
      lines.push(`**Enabled:** ${state.enabledModels.size} model(s)`);
      lines.push(`**Disabled:** ${available.length - state.enabledModels.size} model(s)`);
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

  async function handleEnableKnitModels(args) {
    const requested = args?.models ?? [];
    if (requested.length === 0) {
      return {
        title: "Model Filter Error",
        output: `Please specify model identifiers to enable.\n\nRun \`/list_knit_models\` to see available models with their exact identifiers.`,
      };
    }

    let available;
    try {
      const result = await discoverModels(client, directory, "");
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

    if (state.enabledModels === null) state.enabledModels = new Set();
    const added = requested.filter((id) => !state.enabledModels.has(id));
    for (const id of requested) state.enabledModels.add(id);
    if (added.length > 0) state.pendingModels = null;
    return {
      title: "Models Enabled",
      output: `Enabled ${requested.length} model(s):\n${requested.map((m) => `- ${m}`).join("\n")}\n\n${state.enabledModels.size} model(s) are now available for Loom agents.`,
    };
  }

  async function handleDisableKnitModels(args) {
    const requested = args?.models ?? [];
    if (requested.length === 0) {
      return {
        title: "Model Filter Error",
        output: `Please specify model identifiers to disable.\n\nRun \`/list_knit_models\` to see available models with their exact identifiers.`,
      };
    }

    let available;
    try {
      const result = await discoverModels(client, directory, "");
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

    if (state.enabledModels === null) state.enabledModels = new Set(allKeys);
    const removed = requested.filter((id) => state.enabledModels.has(id));
    for (const id of requested) state.enabledModels.delete(id);
    if (removed.length > 0) state.pendingModels = null;
    return {
      title: "Models Disabled",
      output: `Disabled ${removed.length} model(s):\n${removed.map((m) => `- ${m}`).join("\n")}\n\n${state.enabledModels.size} model(s) remain available for Loom agents.`,
    };
  }

  async function handleResetKnitModels() {
    const prevCount = state.enabledModels?.size ?? 0;
    state.enabledModels = null;
    state.pendingModels = null;
    return {
      title: "Model Filter Reset",
      output: `Model filter cleared. All discovered models are now available for Loom agents (${prevCount} models were previously restricted).`,
    };
  }

  return { handleListKnitModels, handleEnableKnitModels, handleDisableKnitModels, handleResetKnitModels };
}

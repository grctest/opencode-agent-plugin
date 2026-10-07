/**
 * Meeting form validation + feature normalization + agent-tool assembly.
 */
import { getConfig } from "../../../config.js";
import { logger } from "./runtime.js";

export const CATEGORY_SLUG = /^[a-z0-9][a-z0-9-]*$/;

export function storedVariantFor(modelKey, storedVariant, variantsByKey) {
  if (typeof storedVariant !== "string" || !storedVariant) return null;
  if ((variantsByKey.get(modelKey) ?? []).includes(storedVariant)) return storedVariant;
  return null;
}

export function validateParticipants(list) {
  if (!Array.isArray(list) || list.length < 2) {
    return "participants must be an array of at least 2 entries";
  }
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || typeof p !== "object") return `participant #${i + 1} must be an object`;
    const category = p.category ?? p.tier;
    if (!p.name || !p.persona || !p.agenda || !category) {
      return `participant #${i + 1} is missing required fields (name, persona, agenda, category)`;
    }
    if (p.approved !== true) {
      return `participant #${i + 1} must be explicitly approved`;
    }
    if (typeof category !== "string" || !CATEGORY_SLUG.test(category)) {
      return `participant #${i + 1} has invalid category "${category}" — must match ${CATEGORY_SLUG}`;
    }
  }
  return null;
}

const FEATURE_MODES = new Set(["disabled", "optional", "mandatory"]);
const SKILL_STATE_MODES = new Set(["on", "off"]);

function normalizeFeatureMode(value, fallback = "optional") {
  if (value === true) return "optional";
  if (value === false) return "disabled";
  return typeof value === "string" && FEATURE_MODES.has(value) ? value : fallback;
}

function normalizeSkillStateMode(value, fallback = "on") {
  if (value === true) return "on";
  if (value === false) return "off";
  if (typeof value !== "string") return fallback;
  if (SKILL_STATE_MODES.has(value)) return value;
  if (value === "mandatory" || value === "optional") return "on";
  if (value === "disabled") return "off";
  return fallback;
}

export function normalizeFeatures(raw = {}) {
  raw = raw && typeof raw === "object" ? raw : {};
  const legacyAgentTools = raw.agentTools;
  const localFallback = normalizeFeatureMode(legacyAgentTools);
  const onlineFallback = normalizeFeatureMode(legacyAgentTools);
  return {
    forums: normalizeFeatureMode(raw.forums),
    skillState: normalizeSkillStateMode(raw.skillState, "on"),
    agentQueries: normalizeFeatureMode(raw.agentQueries),
    localSearch: normalizeFeatureMode(raw.localSearch, localFallback),
    onlineResearch: normalizeFeatureMode(raw.onlineResearch, onlineFallback),
    agentCommands: raw.agentCommands !== false,
    parallelQueries: raw.parallelQueries !== false,
    buildMode: raw.buildMode === true,
  };
}

export function buildMeetingAgentTools(features, base = getConfig().agentTools) {
  const tools = JSON.parse(JSON.stringify(base ?? {}));
  const localSearchEnabled = features.localSearch !== "disabled";
  const onlineResearchEnabled = features.onlineResearch !== "disabled";
  const agentQueriesEnabled = features.agentQueries !== "disabled";
  const skillStateOn = features.skillState !== "off" && features.skillState !== "disabled";
  const buildMode = features.buildMode === true;
  tools.enabled = true;
  tools.buildMode = buildMode;
  tools.builtIn = {
    ...(tools.builtIn ?? {}),
    read: localSearchEnabled,
    glob: localSearchEnabled,
    grep: localSearchEnabled,
    webfetch: onlineResearchEnabled,
    web_search: onlineResearchEnabled,
    websearch: onlineResearchEnabled,
    web_fetch: onlineResearchEnabled,
    write: buildMode,
    edit: buildMode,
    lsp: false,
    bash: tools.builtIn?.bash && typeof tools.builtIn.bash === "object"
      ? { ...tools.builtIn.bash, enabled: features.agentCommands }
      : { enabled: features.agentCommands, allowlist: [] },
  };
  tools.loom = {
    ...(tools.loom ?? {}),
    loom_forum: features.forums !== "disabled",
    loom_state_patch: skillStateOn,
    loom_query: agentQueriesEnabled,
    loom_vote: agentQueriesEnabled,
    loom_summon: agentQueriesEnabled,
    loom_pass: true,
  };
  tools.mandatory = {
    forums: features.forums === "mandatory",
    skillState: skillStateOn,
    agentQueries: features.agentQueries === "mandatory",
    localSearch: features.localSearch === "mandatory",
    onlineResearch: features.onlineResearch === "mandatory",
  };
  tools.parallelQueries = features.parallelQueries !== false;
  return tools;
}

export function dashboardCallbacks() {
  return {
    onContribution: () => {},
    onRoundComplete: () => {},
    onSynthesisStart: () => {},
    onSynthesisComplete: () => {},
    onUpdate: (state) => {
      logger.debug("dashboard_state_update", `Status: ${state.status}, Round: ${state.current_round}`);
    },
  };
}

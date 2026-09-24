import { persistentAtom } from "@nanostores/persistent";

/**
 * Setup-tab form state as a persistent nanostore — one store per opencode
 * session (mirroring how meetings get a unique DB entry per session).
 *
 * Tab switches unmount SetupTab (Base-UI panels don't keep state) and page
 * refreshes wipe useState, but this store rehydrates from localStorage in
 * both cases. Deliberation runs themselves live server-side; only the
 * pre-start draft form lives here. Transient UI (loading flags, errors,
 * dialogs, catalog/LLM snapshots) stays in useState and is refetched.
 */

const FORM_VERSION = 4;
const MAX_SEATS = 7;
const KNOWN_TIERS = new Set(["junior", "mid", "senior", "principal", "civilian"]);
const FEATURE_MODES = new Set(["disabled", "optional", "mandatory"]);
const DEFAULT_FEATURES = {
  forums: "optional",
  skillState: "mandatory",
  agentQueries: "optional",
  localSearch: "optional",
  onlineResearch: "optional",
  agentCommands: true,
};

export const DEFAULT_SETUP_FORM = {
  version: FORM_VERSION,
  question: "",
  context: "",
  maxRounds: 4,
  seats: [],
  preview: null,
  startedId: null,
  orchestratorModel: null,
  features: { ...DEFAULT_FEATURES },
};

function asString(v) {
  return typeof v === "string" ? v : "";
}

function sanitizeSeat(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (!raw.name || !raw.persona || !raw.agenda || !KNOWN_TIERS.has(raw.tier)) return null;
  const tags = Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === "string") : [];
  const expertise = Array.isArray(raw.expertise) ? raw.expertise.filter((t) => typeof t === "string") : [];
  return {
    id: asString(raw.id),
    name: String(raw.name),
    persona: String(raw.persona),
    agenda: String(raw.agenda),
    tier: raw.tier,
    tags,
    expertise,
    known_biases: Array.isArray(raw.known_biases) ? raw.known_biases.filter((v) => typeof v === "string") : [],
    communication_style: asString(raw.communication_style),
    preferred_contribution_types: Array.isArray(raw.preferred_contribution_types) ? raw.preferred_contribution_types.filter((v) => typeof v === "string") : [],
    anti_patterns: Array.isArray(raw.anti_patterns) ? raw.anti_patterns.filter((v) => typeof v === "string") : [],
    tier_guidance: asString(raw.tier_guidance),
    reflection_guidance: asString(raw.reflection_guidance),
    model: typeof raw.model === "string" ? raw.model : null,
    approved: raw.approved !== false,
  };
}

function sanitizePreview(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.participants)) return null;
  return {
    participants: [],
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t) => typeof t === "string") : [],
    estimated_rounds: Number.isFinite(+raw.estimated_rounds) ? +raw.estimated_rounds : 3,
    reasoning: asString(raw.reasoning),
    complexity: asString(raw.complexity) || null,
  };
}

function sanitizeForm(raw) {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_SETUP_FORM };
  const seats = Array.isArray(raw.seats)
    ? raw.seats.map(sanitizeSeat).filter(Boolean).slice(0, MAX_SEATS)
    : [];
  const maxRounds = Number.isFinite(+raw.maxRounds) ? +raw.maxRounds : 4;
  const rawFeatures = raw.features && typeof raw.features === "object" ? raw.features : {};
  const normalizeMode = (value, fallback) => {
    if (value === true) return "optional";
    if (value === false) return "disabled";
    return typeof value === "string" && FEATURE_MODES.has(value) ? value : fallback;
  };
  const legacyAgentTools = rawFeatures.agentTools;
  const features = {
    forums: normalizeMode(rawFeatures.forums, DEFAULT_FEATURES.forums),
    skillState: normalizeMode(rawFeatures.skillState, DEFAULT_FEATURES.skillState),
    agentQueries: normalizeMode(rawFeatures.agentQueries, DEFAULT_FEATURES.agentQueries),
    localSearch: normalizeMode(rawFeatures.localSearch, normalizeMode(legacyAgentTools, DEFAULT_FEATURES.localSearch)),
    onlineResearch: normalizeMode(rawFeatures.onlineResearch, normalizeMode(legacyAgentTools, DEFAULT_FEATURES.onlineResearch)),
    agentCommands: typeof rawFeatures.agentCommands === "boolean" ? rawFeatures.agentCommands : DEFAULT_FEATURES.agentCommands,
  };
  return {
    version: FORM_VERSION,
    question: asString(raw.question),
    context: asString(raw.context),
    maxRounds,
    seats,
    preview: sanitizePreview(raw.preview),
    startedId: typeof raw.startedId === "string" && raw.startedId ? raw.startedId : null,
    orchestratorModel: typeof raw.orchestratorModel === "string" && raw.orchestratorModel ? raw.orchestratorModel : null,
    features,
  };
}

function getStoreKey() {
  let sid = null;
  try {
    sid = new URLSearchParams(window.location.search).get("session");
  } catch {}
  const safe = sid && /^[A-Za-z0-9_-]{1,128}$/.test(sid) ? sid : "global";
  return `loom-setup-form-v1:${safe}`;
}

export const $setupForm = persistentAtom(getStoreKey(), { ...DEFAULT_SETUP_FORM }, {
  encode: (value) => JSON.stringify(value),
  decode: (stored) => {
    try {
      return sanitizeForm(JSON.parse(stored));
    } catch {
      return { ...DEFAULT_SETUP_FORM };
    }
  },
});

export function resetSetupForm() {
  $setupForm.set({ ...DEFAULT_SETUP_FORM });
}

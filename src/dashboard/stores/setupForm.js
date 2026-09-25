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

const FORM_VERSION = 5;
const MAX_SEATS = 7;
const KNOWN_TIERS = new Set(["junior", "mid", "senior", "principal", "civilian"]);
const FEATURE_MODES = new Set(["disabled", "optional", "mandatory"]);
const ORCHESTRATOR_MODES = {
  roles: new Set(["neutral_facilitator", "rigorous_auditor", "decision_focused", "custom"]),
  turnOrderPolicies: new Set(["balanced", "evidence_first", "anti_starvation"]),
  summaryStyles: new Set(["concise", "balanced", "exhaustive"]),
  decisionPostures: new Set(["preserve_spectrum", "consensus_seeking", "action_oriented"]),
  synthesisStyles: new Set(["decision_oriented", "conversational", "technical_audit"]),
};
const DEFAULT_ORCHESTRATOR = {
  model: null,
  role: "neutral_facilitator",
  customInstructions: "",
  turnOrderPolicy: "balanced",
  summaryStyle: "balanced",
  decisionPosture: "preserve_spectrum",
  synthesisStyle: "decision_oriented",
};
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
  orchestrator: { ...DEFAULT_ORCHESTRATOR },
  features: { ...DEFAULT_FEATURES },
};

export const ORCHESTRATOR_BEHAVIOR_OPTIONS = {
  role: [
    { value: "neutral_facilitator", label: "Neutral facilitator", description: "Keeps the deliberation fair, inclusive, and focused on giving every participant a useful voice." },
    { value: "rigorous_auditor", label: "Rigorous auditor", description: "Stress-tests claims, evidence, and attribution in the synthesis draft while staying neutral to all agendas." },
    { value: "decision_focused", label: "Decision-focused", description: "Emphasizes actionable options, tradeoffs, owners, and next steps without hiding disagreement." },
    { value: "custom", label: "Custom", description: "Uses the custom operating instructions below as the orchestrator's operating style." },
  ],
  turnOrderPolicy: [
    { value: "balanced", label: "Balanced", description: "Balances evidence, urgency, participant diversity, and anti-starvation when choosing who speaks next." },
    { value: "evidence_first", label: "Evidence first", description: "Prioritizes participants with strong evidence-backed challenges or requests when choosing who speaks next." },
    { value: "anti_starvation", label: "Anti-starvation", description: "Strongly favors participants who have spoken least recently, while still handling urgent requests." },
  ],
  summaryStyle: [
    { value: "balanced", label: "Balanced", description: "Produces thorough but compact summaries that preserve nuance, dissent, and unresolved tradeoffs." },
    { value: "concise", label: "Concise", description: "Produces compact summaries that emphasize decisions, major evidence, and unresolved questions." },
    { value: "exhaustive", label: "Exhaustive", description: "Retains more detail, competing positions, evidence, and open threads, even when summaries use more tokens." },
  ],
  decisionPosture: [
    { value: "preserve_spectrum", label: "Preserve spectrum", description: "Keeps meaningful disagreement visible and maps the spectrum instead of forcing consensus." },
    { value: "consensus_seeking", label: "Consensus-seeking", description: "Looks for a defensible shared direction while keeping dissent visible." },
    { value: "action_oriented", label: "Action-oriented", description: "Prioritizes concrete next actions, owners, risks, and unresolved questions." },
  ],
  synthesisStyle: [
    { value: "decision_oriented", label: "Decision-oriented", description: "Leads the final output with a clear decision or spectrum, followed by grounded reasoning and action items." },
    { value: "conversational", label: "Conversational", description: "Leads with a human-readable synthesis of the conversation before formal decision structure." },
    { value: "technical_audit", label: "Technical audit", description: "Leads with a technical audit covering files, evidence, risks, verification, and proposed fixes." },
  ],
};

export const ORCHESTRATOR_BEHAVIOR_LABELS = {
  role: "Role / Persona",
  turnOrderPolicy: "Turn-order policy",
  summaryStyle: "Summary style",
  decisionPosture: "Decision posture",
  synthesisStyle: "Synthesis style",
};

function asString(v) {
  return typeof v === "string" ? v : "";
}

function enumValue(value, allowed, fallback) {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function sanitizeOrchestrator(raw, legacyModel) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    model: asString(value.model || legacyModel) || null,
    role: enumValue(value.role, ORCHESTRATOR_MODES.roles, DEFAULT_ORCHESTRATOR.role),
    customInstructions: asString(value.customInstructions).slice(0, 4000),
    turnOrderPolicy: enumValue(value.turnOrderPolicy, ORCHESTRATOR_MODES.turnOrderPolicies, DEFAULT_ORCHESTRATOR.turnOrderPolicy),
    summaryStyle: enumValue(value.summaryStyle, ORCHESTRATOR_MODES.summaryStyles, DEFAULT_ORCHESTRATOR.summaryStyle),
    decisionPosture: enumValue(value.decisionPosture, ORCHESTRATOR_MODES.decisionPostures, DEFAULT_ORCHESTRATOR.decisionPosture),
    synthesisStyle: enumValue(value.synthesisStyle, ORCHESTRATOR_MODES.synthesisStyles, DEFAULT_ORCHESTRATOR.synthesisStyle),
  };
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
     orchestrator: sanitizeOrchestrator(raw.orchestrator, raw.orchestratorModel),
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

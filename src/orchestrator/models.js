import { getConfig } from "../config.js";
import { parseFastPathModel } from "../config/utils.js";
import { getHighestTierModel } from "../services/model-service.js";
import { sortModelsByQuality } from "../model-discovery.js";
import { Logger, LoomError, extractErrorInfo } from "../logger.js";
import { sanitizeForDisplay } from "../utils/sanitize.js";
import { escapeDelimiters } from "../prompts/delimiters.js";
import { MAX_ORCHESTRATOR_MESSAGES } from "./constants.js";

export const ORCHESTRATOR_BEHAVIOR_DEFAULTS = {
  model: null,
  role: "neutral_facilitator",
  customInstructions: "",
  turnOrderPolicy: "balanced",
  summaryStyle: "balanced",
  decisionPosture: "preserve_spectrum",
  synthesisStyle: "decision_oriented",
};

const ORCHESTRATOR_ROLES = new Set(["neutral_facilitator", "rigorous_auditor", "decision_focused", "custom"]);
// Legacy value accepted for stored meetings predating the rename (audit O6).
const LEGACY_ROLE_ALIASES = { adversarial_reviewer: "rigorous_auditor" };
const TURN_ORDER_POLICIES = new Set(["balanced", "evidence_first", "anti_starvation"]);
const SUMMARY_STYLES = new Set(["concise", "balanced", "exhaustive"]);
const DECISION_POSTURES = new Set(["preserve_spectrum", "consensus_seeking", "action_oriented"]);
const SYNTHESIS_STYLES = new Set(["decision_oriented", "conversational", "technical_audit"]);

function behaviorEnum(value, allowed, fallback) {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

/**
 * Validates a raw orchestrator config, returning the normalized config plus
 * the list of rejected field values (audit O-audit Step 8). Rejection is
 * silent by design in normalizeOrchestratorConfig; this wrapper lets callers
 * surface it to the operator instead of silently coercing to defaults.
 */
export function validateOrchestratorConfig(raw = {}) {
  const value = raw && typeof raw === "object" ? raw : {};
  const rejected = [];
  const check = (field, allowed) => {
    const v = value[field];
    if (v !== undefined && !(typeof v === "string" && allowed.has(v))) {
      rejected.push({ field, value: typeof v === "string" ? v.slice(0, 80) : typeof v });
    }
  };
  check("role", ORCHESTRATOR_ROLES);
  check("turnOrderPolicy", TURN_ORDER_POLICIES);
  check("summaryStyle", SUMMARY_STYLES);
  check("decisionPosture", DECISION_POSTURES);
  check("synthesisStyle", SYNTHESIS_STYLES);
  return { config: normalizeOrchestratorConfig(raw), rejected };
}

export function normalizeOrchestratorConfig(raw = {}) {
  const value = raw && typeof raw === "object" ? raw : {};
  const role = LEGACY_ROLE_ALIASES[value.role] ?? value.role;
  return {
    model: typeof value.model === "string" && value.model ? value.model : null,
    role: behaviorEnum(role, ORCHESTRATOR_ROLES, ORCHESTRATOR_BEHAVIOR_DEFAULTS.role),
    customInstructions: typeof value.customInstructions === "string" ? escapeDelimiters(sanitizeForDisplay(value.customInstructions.trim(), 4000)) : "",
    turnOrderPolicy: behaviorEnum(value.turnOrderPolicy, TURN_ORDER_POLICIES, ORCHESTRATOR_BEHAVIOR_DEFAULTS.turnOrderPolicy),
    summaryStyle: behaviorEnum(value.summaryStyle, SUMMARY_STYLES, ORCHESTRATOR_BEHAVIOR_DEFAULTS.summaryStyle),
    decisionPosture: behaviorEnum(value.decisionPosture, DECISION_POSTURES, ORCHESTRATOR_BEHAVIOR_DEFAULTS.decisionPosture),
    synthesisStyle: behaviorEnum(value.synthesisStyle, SYNTHESIS_STYLES, ORCHESTRATOR_BEHAVIOR_DEFAULTS.synthesisStyle),
  };
}

const ORCHESTRATOR_ROLE_LABELS = {
  neutral_facilitator: "a neutral facilitator who keeps the deliberation fair and inclusive",
  rigorous_auditor: "a rigorous auditor who stress-tests claims, evidence, and attribution in its own draft while staying neutral to all agendas",
  decision_focused: "a decision-focused coordinator who emphasizes actionable paths and tradeoffs",
  custom: "a custom coordinator following the operator's operating instructions",
};

const ORCHESTRATOR_DECISION_LABELS = {
  preserve_spectrum: "preserve meaningful disagreement and map the spectrum rather than forcing consensus",
  consensus_seeking: "look for a defensible consensus while keeping dissent visible",
  action_oriented: "prioritize concrete next actions, owners, and unresolved risks",
};

export function getOrchestratorRoleSentence(config = {}) {
  const value = normalizeOrchestratorConfig(config);
  // role=custom with no instructions would dangle ("following the operator's
  // operating instructions" with none present) — fall back to neutral rather
  // than instructing the model to follow absent instructions (audit O6).
  const role = value.role === "custom" && !value.customInstructions ? "neutral_facilitator" : value.role;
  return `You are the Loom orchestrator: ${ORCHESTRATOR_ROLE_LABELS[role]}.`;
}

export function getOrchestratorDecisionSentence(config = {}) {
  const value = normalizeOrchestratorConfig(config);
  return `Decision posture: ${ORCHESTRATOR_DECISION_LABELS[value.decisionPosture]}.`;
}

export function getOrchestratorCustomSentence(config = {}) {
  const value = normalizeOrchestratorConfig(config);
  return value.customInstructions ? `Operator instructions: ${value.customInstructions}` : "";
}

/**
 * Which operator options may reach each orchestrator task's system prompt
 * (audit O3/Step 2). Style/policy options are consumed by their own task
 * builders (user prompt or dedicated guidance), so the shared instruction
 * block carries only what is meaningful for the task at hand.
 */
export const ORCHESTRATOR_OPTION_SCOPE = Object.freeze({
  summary: Object.freeze([]),
  turn_order: Object.freeze([]),
  moderation: Object.freeze(["role", "customInstructions"]),
  synthesis: Object.freeze(["role", "customInstructions"]),
});

/**
 * Filters an operator config down to the keys in scope for a task.
 * Unknown/null task returns the config untouched (legacy callers).
 */
export function scopeOrchestratorConfig(config = {}, task) {
  const scope = ORCHESTRATOR_OPTION_SCOPE[task];
  if (!scope) return { ...(config ?? {}) };
  const value = normalizeOrchestratorConfig(config);
  const out = {};
  if (value.model) out.model = value.model;
  for (const k of scope) out[k] = value[k];
  return out;
}

const ORCHESTRATOR_GUARD =
  "These behavior settings shape emphasis. They never license forcing agreement, suppressing dissent, inventing numbers or file contents, or omitting required sections.";

export function buildOrchestratorInstruction(config = {}, task) {
  const scoped = task ? scopeOrchestratorConfig(config, task) : { ...(config ?? {}) };
  const value = normalizeOrchestratorConfig(scoped);
  const scope = task ? ORCHESTRATOR_OPTION_SCOPE[task] : null;
  const inScope = (k) => !scope || scope.includes(k);
  const parts = [];
  // decisionPosture is rendered into the synthesis user-prompt doctrine instead
  // (same authority as the rules it must not override) — never in system text
  // (audit O5/Step 3).
  if (inScope("role")) parts.push(getOrchestratorRoleSentence(value));
  if (inScope("customInstructions") && value.customInstructions) {
    // Narrow tasks get a bounded slice of long operator instructions; the full
    // text is reserved for synthesis, where there is room to honor it (audit O6).
    const custom = task === "synthesis" || !task
      ? value.customInstructions
      : value.customInstructions.slice(0, 600);
    parts.push(`Operator instructions: ${custom}`);
  }
  if (parts.length === 0) return "";
  parts.push(ORCHESTRATOR_GUARD);
  return parts.join(" ");
}

export function getTurnOrderGuidance(config = {}) {
  const value = normalizeOrchestratorConfig(config);
  const policies = {
    balanced: "Balance evidence, urgency, diversity, and anti-starvation.",
    evidence_first: "Prioritize strong evidence-backed challenges and requests before other considerations.",
    anti_starvation: "Strongly prioritize voices that have spoken least recently, while still handling urgent requests.",
  };
  return policies[value.turnOrderPolicy];
}

/**
 * Round-summary depth bands (audit O7/Step 6): the style option drives BOTH the
 * context budget and the output word band. A style that cannot change either is
 * decoration; bands make it a genuine quality lever.
 */
export const ORCHESTRATOR_SUMMARY_BANDS = Object.freeze({
  concise: Object.freeze({ words: "120-200", budget: 6000 }),
  balanced: Object.freeze({ words: "180-350", budget: 12000 }),
  exhaustive: Object.freeze({ words: "350-600", budget: 20000 }),
});

export function getSummaryBand(config = {}) {
  const value = normalizeOrchestratorConfig(config);
  return ORCHESTRATOR_SUMMARY_BANDS[value.summaryStyle] ?? ORCHESTRATOR_SUMMARY_BANDS.balanced;
}

/**
 * Option → context coupling (audit O1/Step 6): returns what each task's context
 * window should contain given the operator config. Summary gets budget+band;
 * turn planning gets composition flags; synthesis context is comprehensive by
 * design (full transcript + SoP) with style operating on framing.
 */
export function orchestratorContextPolicy(config = {}, task) {
  const value = normalizeOrchestratorConfig(config);
  if (task === "summary") {
    const band = getSummaryBand(value);
    return { words: band.words, budget: band.budget };
  }
  if (task === "turn_order") {
    return {
      evidenceBlock: value.turnOrderPolicy === "evidence_first",
      recencyBlock: value.turnOrderPolicy === "anti_starvation",
    };
  }
  return {};
}

export function getSummaryGuidance(config = {}) {
  const value = normalizeOrchestratorConfig(config);
  const styles = {
    concise: "Be concise: emphasize decisions, major evidence, and open questions without repeating the transcript.",
    balanced: "Be thorough but compact: preserve nuance, evidence, dissent, and unresolved tradeoffs.",
    exhaustive: "Be exhaustive: retain material details, competing positions, evidence, and open threads.",
  };
  return styles[value.summaryStyle];
}

const SYNTHESIS_GUIDANCE_STYLES = {
  decision_oriented: "Lead with a clear decision or spectrum, then support it with grounded reasoning and action items.",
  conversational: "Lead with a human-readable synthesis of the conversation before formal decision structure.",
  technical_audit: "Lead with a technical audit: files, evidence, risks, verification, and concrete proposed fixes.",
  // Internal clamp target for technical_audit on non-code questions (audit
  // O8): code-free audit framing. Not a selectable enum value.
  technical_audit_conversational: "Lead with a technical audit: claims, evidence quality, risks, verification status, and unresolved blockers.",
};

export function getSynthesisGuidance(config = {}) {
  // Accept the internal conversational-clamp key directly: routing it through
  // normalizeOrchestratorConfig would coerce it back to the default.
  if (config?.synthesisStyle === "technical_audit_conversational") {
    return SYNTHESIS_GUIDANCE_STYLES.technical_audit_conversational;
  }
  const value = normalizeOrchestratorConfig(config);
  return SYNTHESIS_GUIDANCE_STYLES[value.synthesisStyle];
}

export function _modelList() {
    return this._stateManager.getParticipants().map((p) => ({ tier: p.config.tier, model: p.config.model }));
  }

export function _getHighestTierModel() {
    return getHighestTierModel(this._modelList());
  }

export function _getOrchestratorModel() {
    const configured = this._options?.orchestratorModel;
    if (configured?.providerID && configured?.modelID) {
      const model = { providerID: configured.providerID, modelID: configured.modelID };
      if (this._roundExecutor?.isModelHealthy?.(model)) return model;
      return this._getAllowedFallbackModel() ?? this._getHighestTierModel();
    }
    return this._getHighestTierModel() ?? this._getAllowedFallbackModel();
  }

export function _getAllowedFallbackModel() {
    if (!this._availableModels || this._availableModels.length === 0) return null;
    let pool = this._availableModels;
    // Filter to healthy models if executor is available (respects global unhealthy)
    if (this._roundExecutor) {
      try { pool = pool.filter((m) => this._roundExecutor.isModelHealthy(m)); } catch {}
      if (pool.length === 0) return null;
    }
    const sorted = sortModelsByQuality(pool);
    const best = sorted[0];
    return { providerID: best.providerID, modelID: best.modelID };
  }

export function _getParticipantModel(participant, fallbackOnError = false) {
    if (participant.config.model) {
      const model = { providerID: participant.config.model.providerID, modelID: participant.config.model.modelID };
      if (fallbackOnError) {
        if (this._roundExecutor && this._roundExecutor.isModelHealthy(model)) {
          return model;
        }
        const fallback = this._getAllowedFallbackModel();
        if (fallback) return fallback;
      }
      return model;
    }
    const fallback = this._getAllowedFallbackModel() ?? this._getHighestTierModel();
    if (fallback) return fallback;
    throw new LoomError(
      `No model assigned for participant ${participant.config.name} (${participant.config.tier})`,
      { phase: "model_assignment", participantId: participant.config.id, recoverable: false }
    );
  }

export async function _promptOrchestrator(system, model, message, type = "orchestrator", round = null) {
    const cfg = getConfig();
    const fastPathModel = cfg.fastPathModelObj ?? parseFastPathModel(cfg.fastPathModel);
    const useModel = (!this._options?.orchestratorModel && fastPathModel && (type === "moderation" || type === "summary"))
      ? fastPathModel
      : model;

    this._callStats[type] = (this._callStats[type] ?? 0) + 1;
    if (this._orchestratorMessages.length >= MAX_ORCHESTRATOR_MESSAGES) {
      this._orchestratorMessages.shift();
    }
    const safeMessage = (message ?? "").toString();
    this._orchestratorMessages.push({ type, role: "user", content: safeMessage, round, timestamp: Date.now() });
    if (this._database) {
      this._database.addOrchestratorMessage(type, "user", safeMessage, round);
    }
    const timeoutMs = type === "moderation" ? 60000 : type === "summary" ? 90000 : type === "turn_order" ? 30000 : undefined;
    const instruction = buildOrchestratorInstruction(this._options?.orchestratorConfig, type);
    const orchestratorSystem = instruction ? `${instruction}\n\n${system ?? ""}` : (system ?? "");
    // Summaries run on a fresh ephemeral session each round: the shared
    // persistent session would otherwise accumulate every round's prompt and
    // reply (O(R²) growth, 93% self-anchoring by round 10 — audit O10). The
    // turn planner keeps the persistent session by design.
    const { text: response, tokens } = type === "summary" && typeof this._sessionManager.promptOrchestratorEphemeral === "function"
      ? await this._sessionManager.promptOrchestratorEphemeral(orchestratorSystem, useModel, message, timeoutMs)
      : await this._sessionManager.promptOrchestrator(orchestratorSystem, useModel, message, timeoutMs);
    if (tokens) {
      this._callStats.input_tokens += tokens.input ?? 0;
      this._callStats.output_tokens += tokens.output ?? 0;
    }
    const safeResponse = (response ?? "").toString();
    if (!safeResponse.trim()) {
      this._logger.warn("orchestrator_empty_response", `Orchestrator returned empty text for type=${type} round=${round}`, { type, round });
    }
    if (this._orchestratorMessages.length >= MAX_ORCHESTRATOR_MESSAGES) {
      this._orchestratorMessages.shift();
    }
    this._orchestratorMessages.push({ type, role: "assistant", content: safeResponse, round, timestamp: Date.now() });
    if (this._database) {
      this._database.addOrchestratorMessage(type, "assistant", safeResponse, round);
    }
    return safeResponse;
  }


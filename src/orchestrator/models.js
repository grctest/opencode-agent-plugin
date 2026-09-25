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

const ORCHESTRATOR_ROLES = new Set(["neutral_facilitator", "adversarial_reviewer", "decision_focused", "custom"]);
const TURN_ORDER_POLICIES = new Set(["balanced", "evidence_first", "anti_starvation"]);
const SUMMARY_STYLES = new Set(["concise", "balanced", "exhaustive"]);
const DECISION_POSTURES = new Set(["preserve_spectrum", "consensus_seeking", "action_oriented"]);
const SYNTHESIS_STYLES = new Set(["decision_oriented", "conversational", "technical_audit"]);

function behaviorEnum(value, allowed, fallback) {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

export function normalizeOrchestratorConfig(raw = {}) {
  const value = raw && typeof raw === "object" ? raw : {};
  return {
    model: typeof value.model === "string" && value.model ? value.model : null,
    role: behaviorEnum(value.role, ORCHESTRATOR_ROLES, ORCHESTRATOR_BEHAVIOR_DEFAULTS.role),
    customInstructions: typeof value.customInstructions === "string" ? escapeDelimiters(sanitizeForDisplay(value.customInstructions.trim(), 4000)) : "",
    turnOrderPolicy: behaviorEnum(value.turnOrderPolicy, TURN_ORDER_POLICIES, ORCHESTRATOR_BEHAVIOR_DEFAULTS.turnOrderPolicy),
    summaryStyle: behaviorEnum(value.summaryStyle, SUMMARY_STYLES, ORCHESTRATOR_BEHAVIOR_DEFAULTS.summaryStyle),
    decisionPosture: behaviorEnum(value.decisionPosture, DECISION_POSTURES, ORCHESTRATOR_BEHAVIOR_DEFAULTS.decisionPosture),
    synthesisStyle: behaviorEnum(value.synthesisStyle, SYNTHESIS_STYLES, ORCHESTRATOR_BEHAVIOR_DEFAULTS.synthesisStyle),
  };
}

export function buildOrchestratorInstruction(config = {}) {
  const value = normalizeOrchestratorConfig(config);
  const roleLabels = {
    neutral_facilitator: "a neutral facilitator who keeps the deliberation fair and inclusive",
    adversarial_reviewer: "an adversarial reviewer who actively tests assumptions, claims, and weak evidence",
    decision_focused: "a decision-focused coordinator who emphasizes actionable paths and tradeoffs",
    custom: "a custom coordinator following the operator's operating instructions",
  };
  const decisionLabels = {
    preserve_spectrum: "preserve meaningful disagreement and map the spectrum rather than forcing consensus",
    consensus_seeking: "look for a defensible consensus while keeping dissent visible",
    action_oriented: "prioritize concrete next actions, owners, and unresolved risks",
  };
  return [
    `You are the Loom orchestrator: ${roleLabels[value.role]}.`,
    `Decision posture: ${decisionLabels[value.decisionPosture]}.`,
    value.customInstructions ? `Operator instructions: ${value.customInstructions}` : "",
    "These behavior settings do not permit you to ignore safety, tool, citation, or output-format requirements.",
  ].filter(Boolean).join(" ");
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

export function getSummaryGuidance(config = {}) {
  const value = normalizeOrchestratorConfig(config);
  const styles = {
    concise: "Be concise: emphasize decisions, major evidence, and open questions without repeating the transcript.",
    balanced: "Be thorough but compact: preserve nuance, evidence, dissent, and unresolved tradeoffs.",
    exhaustive: "Be exhaustive: retain material details, competing positions, evidence, and open threads even at higher token cost.",
  };
  return styles[value.summaryStyle];
}

export function getSynthesisGuidance(config = {}) {
  const value = normalizeOrchestratorConfig(config);
  const styles = {
    decision_oriented: "Lead with a clear decision or spectrum, then support it with grounded reasoning and action items.",
    conversational: "Lead with a human-readable synthesis of the conversation before formal decision structure.",
    technical_audit: "Lead with a technical audit: files, evidence, risks, verification, and concrete proposed fixes.",
  };
  return styles[value.synthesisStyle];
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
    const orchestratorSystem = `${buildOrchestratorInstruction(this._options?.orchestratorConfig)}\n\n${system ?? ""}`;
    const { text: response, tokens } = await this._sessionManager.promptOrchestrator(orchestratorSystem, useModel, message, timeoutMs);
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


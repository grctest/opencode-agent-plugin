import { getConfig } from "../config.js";
import { parseFastPathModel } from "../config/utils.js";
import { getHighestTierModel } from "../services/model-service.js";
import { sortModelsByQuality } from "../model-discovery.js";
import { Logger, LoomError, extractErrorInfo } from "../logger.js";
import { MAX_ORCHESTRATOR_MESSAGES } from "./constants.js";

export function _modelList() {
    return this._stateManager.getParticipants().map((p) => ({ tier: p.config.tier, model: p.config.model }));
  }

export function _getHighestTierModel() {
    return getHighestTierModel(this._modelList());
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
    const useModel = (fastPathModel && (type === "moderation" || type === "summary"))
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
    const { text: response, tokens } = await this._sessionManager.promptOrchestrator(system, useModel, message, timeoutMs);
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


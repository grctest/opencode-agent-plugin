import { getConfig } from "../config.js";
import { getHighestTierModel } from "../services/model-service.js";
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
    // Capability-fit scoring: active(20) + context/10000 + reasoning(15). Cost is display-only.
    // Tie-breaker: recent latency metrics if available, else deterministic provider/model key.
    // Session model is scored like any other model; only preferred if it lands in top 3 by quality
    // (achieved by scoring it in the sorted list rather than blindly preferring it).
    const sorted = [...this._availableModels].sort((a, b) => {
      const score = (m) => {
        let s = 0;
        if (m.status === "active") s += 20;
        s += (m.limit?.context ?? 128000) / 10000;
        if (m.reasoning) s += 15;
        return s;
      };
      const diff = score(b) - score(a);
      if (diff !== 0) return diff;
      // Tie-breaker: if getRecentMeetingMetrics were available, use latency (lower wins).
      // For now use deterministic key to keep sorting stable.
      const aKey = `${a.providerID}/${a.modelID}`;
      const bKey = `${b.providerID}/${b.modelID}`;
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });
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
    const fastPathModel = cfg.fastPathModelObj ?? (cfg.fastPathModel ? (() => {
      const s = cfg.fastPathModel;
      if (typeof s === 'string' && s.includes('/')) {
        const idx = s.indexOf('/');
        const providerID = s.slice(0, idx).trim();
        const modelID = s.slice(idx + 1).trim();
        if (providerID && modelID) return { providerID, modelID };
      }
      return null;
    })() : null);
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
    const { text: response, tokens } = await this._sessionManager.promptOrchestrator(system, useModel, message);
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


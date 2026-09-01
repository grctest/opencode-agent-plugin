/**
 * Phase 3 note: this file is NOT a barrel — it owns capability-fit scoring
 * (sortModelsByQuality / assignModelsByTier). Service layer in
 * src/services/model-service.js consumes it; src/services/model-manager.js is
 * an unrelated embedding ONNX manager. Consolidation was deemed too invasive;
 * the model trio is therefore kept distinct. parseFastPathModel dedup is
 * already complete (single source src/config/utils.js).
 */

/**
 * @typedef {Object} AvailableModel
 * @property {string} providerID
 * @property {string} modelID
 * @property {string} name
 * @property {string} status
 * @property {{ input: number; output: number; cache_read?: number; cache_write?: number }} cost
 * @property {{ context: number; output: number }} limit
 * @property {boolean} reasoning
 */

/**
 * @typedef {Object} ModelAssignment
 * @property {string} tier
 * @property {string} providerID
 * @property {string} modelID
 * @property {string} modelName
 */

/**
 * @typedef {Object} ModelPlan
 * @property {ModelAssignment} orchestrator
 * @property {ModelAssignment[]} participants
 * @property {AvailableModel[]} available
 */

/**
 * Capability-fit scoring: prefers active, high-context, reasoning-capable models.
 * Cost is not a scoring factor — it remains a display-only column in the model plan.
 * Two models with identical capability profiles score identically (stable/deterministic).
 */
function scoreModel(model) {
  let score = 0;

  if (model.status === "active") score += 20;
  else if (model.status === "beta") score += 10;
  else if (model.status === "deprecated") score -= 50;

  score += (model.limit?.context ?? 128000) / 10000;

  if (model.reasoning) score += 15;

  return score;
}

/** Sorts models by quality score (highest first), then by provider+id for stability. */
function sortModelsByQuality(models) {
  return [...models].sort((a, b) => {
    const diff = scoreModel(b) - scoreModel(a);
    if (diff !== 0) return diff;
    const aKey = `${a.providerID}/${a.modelID}`;
    const bKey = `${b.providerID}/${b.modelID}`;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
}

export { sortModelsByQuality };

/**
 * Single model-assignment engine: quality-sorted and deterministic.
 * Principal/senior roles get the session model when available and high-scoring (top 3);
 * otherwise they get the next-best unused models. This avoids blindly preferring a
 * low-quality session model. This is the one source of truth for both the
 * list_knit_models preview plan and the real meeting assignment, so they always agree.
 * Scoring: active(20) + context/10000 + reasoning(15); cost is display-only.
 * Tie-breaker: deterministic provider/model key; future: latency from recent metrics.
 */
export function assignModelsByTier(available, sessionModel, roles) {
  if (available.length === 0) return [];

  const sorted = sortModelsByQuality(available);
  const priorityOrder = ["principal", "senior", "mid", "civilian", "junior"];
  const sortedRoles = [...roles].sort(
    (a, b) => priorityOrder.indexOf(a) - priorityOrder.indexOf(b),
  );

  const sessionIdx = sessionModel
    ? sorted.findIndex(
        (m) => m.providerID === sessionModel.providerID && m.modelID === sessionModel.modelID,
      )
    : -1;
  // Only prefer session model if it ranks in top 3 by quality score; otherwise use best available.
  // This scores sessionModel like any other model instead of blindly preferring it.
  let topModel = sorted[0];
  let sessionInTop3 = false;
  if (sessionIdx >= 0 && sessionIdx < 3) {
    topModel = sorted[sessionIdx];
    sessionInTop3 = true;
  }

  const assignments = [];
  const usedIndices = new Set();
  if (sessionInTop3) usedIndices.add(sessionIdx);

  for (const role of sortedRoles) {
    if ((role === "principal" || role === "senior") && topModel) {
      assignments.push({ tier: role, providerID: topModel.providerID, modelID: topModel.modelID, modelName: topModel.name });
      continue;
    }

    let bestIdx = -1;
    for (let i = 0; i < sorted.length; i++) {
      if (!usedIndices.has(i)) {
        bestIdx = i;
        break;
      }
    }
    if (bestIdx === -1) bestIdx = 0;

    usedIndices.add(bestIdx);
    const m = sorted[bestIdx];
    assignments.push({ tier: role, providerID: m.providerID, modelID: m.modelID, modelName: m.name });
  }

  return assignments;
}

/** Formats the cost of a model assignment for display. */
function formatCost(assignment, available) {
  const model = available.find(
    (m) => m.providerID === assignment.providerID && m.modelID === assignment.modelID,
  );
  if (!model) return "unknown";
  if (model.cost.input === 0 && model.cost.output === 0) return "free";
  return `$${model.cost.input}/$${model.cost.output}`;
}

/** Creates a complete model plan: assigns models to each role and designates the orchestrator. */
export function createModelPlan(available, roles, sessionModel) {
  const defaultRoles = ["junior", "mid", "senior", "principal", "civilian"];
  let participants = assignModelsByTier(available, sessionModel, roles ?? defaultRoles);
  // Mirror runtime diversity: when enough unique models, each agent gets distinct model (best to highest tier)
  try {
    const uniqueTiers = new Set((roles ?? defaultRoles).map((r) => r));
    if (available.length > uniqueTiers.size) {
      const sorted = sortModelsByQuality(available);
      const tierOrder = { principal: 0, senior: 1, mid: 2, civilian: 2, junior: 3 };
      participants = [...participants].sort((a, b) => (tierOrder[a.tier] ?? 9) - (tierOrder[b.tier] ?? 9));
      const used = new Set();
      for (let i = 0; i < participants.length; i++) {
        for (let j = 0; j < sorted.length; j++) {
          const key = `${sorted[j].providerID}/${sorted[j].modelID}`;
          if (!used.has(key)) {
            used.add(key);
            participants[i] = { ...participants[i], providerID: sorted[j].providerID, modelID: sorted[j].modelID, modelName: sorted[j].name };
            break;
          }
        }
      }
    }
  } catch {}
  // Orchestrator is highest-tier model (matches getHighestTierModel), not mid
  const tierOrder = { principal: 0, senior: 1, mid: 2, civilian: 2, junior: 3 };
  const sortedByTier = [...participants].sort((a, b) => (tierOrder[a.tier] ?? 9) - (tierOrder[b.tier] ?? 9));
  const orchestrator = sortedByTier[0] ?? participants[0];
  return { orchestrator, participants, available };
}



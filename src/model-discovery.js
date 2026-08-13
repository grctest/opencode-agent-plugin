/**
 * @typedef {Object} AvailableModel
 * @property {string} providerID
 * @property {string} modelID
 * @property {string} name
 * @property {string} status
 * @property {{ input: number; output: number; cache_read?: number; cache_write?: number }} cost
 * @property {{ context: number; output: number }} limit
 * @property {boolean} reasoning
 * @property {boolean} temperature
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

export { sortModelsByQuality, scoreModel };

/**
 * Single model-assignment engine: quality-sorted and deterministic.
 * Principal/senior roles get the session model when available; remaining roles get
 * the next-best unused models. This is the one source of truth for both the
 * /knit_models preview plan and the real meeting assignment, so they always agree.
 */
export function assignModelsByTier(available, sessionModel, roles) {
  if (available.length === 0) return [];

  const sorted = sortModelsByQuality(available);
  const priorityOrder = ["principal", "senior", "mid", "junior"];
  const sortedRoles = [...roles].sort(
    (a, b) => priorityOrder.indexOf(a) - priorityOrder.indexOf(b),
  );

  const sessionIdx = sessionModel
    ? sorted.findIndex(
        (m) => m.providerID === sessionModel.providerID && m.modelID === sessionModel.modelID,
      )
    : -1;
  const topModel = sessionIdx >= 0 ? sorted[sessionIdx] : sorted[0];

  const assignments = [];
  const usedIndices = new Set();
  if (sessionIdx >= 0) usedIndices.add(sessionIdx);

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

/** Formats the model assignment plan as a markdown table for user review. */
export function formatModelPlan(plan) {
  const lines = [
    "## Proposed Model Assignment",
    "",
    "| Tier | Model | Provider | Cost |",
    "|------|-------|----------|------|",
  ];

  lines.push(
    `| Orchestrator | ${plan.orchestrator.modelName} | ${plan.orchestrator.providerID} | ${formatCost(plan.orchestrator, plan.available)} |`,
  );

  for (const p of plan.participants) {
    lines.push(
      `| ${p.tier} | ${p.modelName} | ${p.providerID} | ${formatCost(p, plan.available)} |`,
    );
  }

  lines.push("");
  lines.push(`Available models: ${plan.available.length}`);

  return lines.join("\n");
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
  const defaultRoles = ["junior", "mid", "senior", "principal"];
  const participants = assignModelsByTier(available, sessionModel, roles ?? defaultRoles);
  const orchestrator = participants.find((p) => p.tier === "mid") || participants[0];
  return { orchestrator, participants, available };
}



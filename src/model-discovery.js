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

/** Scores a model for auto-selection: prefers free, active, high-context, reasoning-capable models. */
function scoreModel(model) {
  let score = 0;

  if (model.cost.input === 0 && model.cost.output === 0) {
    score += 100;
  } else {
    score -= (model.cost.input + model.cost.output) * 10;
  }

  if (model.status === "active") score += 20;
  else if (model.status === "beta") score += 10;
  else if (model.status === "deprecated") score -= 50;

  score += model.limit.context / 10000;

  if (model.reasoning) score += 15;

  return score;
}

/** Sorts models by quality score (highest first). */
function sortModelsByQuality(models) {
  return [...models].sort((a, b) => scoreModel(b) - scoreModel(a));
}

/** Assigns the best available models to each role, prioritizing principal > senior > mid > junior. */
export function selectModelsForRoles(available, roles) {
  const sorted = sortModelsByQuality(available);
  const free = sorted.filter((m) => m.cost.input === 0 && m.cost.output === 0);
  const candidates = free.length >= roles.length ? free : sorted;

  const assignments = [];
  const usedIndices = new Set();

  const priorityOrder = ["principal", "senior", "mid", "junior"];
  const sortedRoles = [...roles].sort(
    (a, b) => priorityOrder.indexOf(a) - priorityOrder.indexOf(b),
  );

  for (const role of sortedRoles) {
    let bestIdx = -1;
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (!usedIndices.has(i)) {
        bestIdx = i;
        break;
      }
    }
    if (bestIdx === -1) bestIdx = 0;

    usedIndices.add(bestIdx);
    const m = candidates[bestIdx];
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
  lines.push("");
  lines.push("To start, confirm this assignment or request changes (e.g. 'use Sonnet for senior', 'make junior use Haiku').");

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

/** Creates a complete model plan: selects models for each role and designates the orchestrator. */
export function createModelPlan(available, roles) {
  const defaultRoles = ["junior", "mid", "senior", "principal"];
  const participants = selectModelsForRoles(available, roles ?? defaultRoles);
  const orchestrator = participants.find((p) => p.tier === "mid") || participants[0];
  return { orchestrator, participants, available };
}



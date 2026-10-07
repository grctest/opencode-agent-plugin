/**
 * Phase 3 note: this file is NOT a barrel — it owns model assignment
 * (sortModelsByQuality / assignModelsRandomly). Service layer in
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
 * @property {string[]} [variants] - Variant IDs offered by this model (may be absent/empty)
 */

/**
 * @typedef {Object} ModelAssignment
 * @property {string} providerID
 * @property {string} modelID
 * @property {string} modelName
 * @property {string} [variant]
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
 * Random model assignment: every seat draws a random model from the available
 * pool (no seniority, no quality ranking — persona categories are
 * organizational labels and must not influence which model a seat gets).
 * Seats may repeat models when the pool is smaller than the seat count.
 *
 * @param {AvailableModel[]} available enabled, healthy models to draw from
 * @param {number} count how many assignments to produce
 * @param {() => number} [rng=Math.random] random source in [0,1) (injectable for tests)
 * @returns {ModelAssignment[]}
 */
export function assignModelsRandomly(available, count, rng = Math.random) {
  if (!Array.isArray(available) || available.length === 0 || !Number.isFinite(count) || count <= 0) return [];
  const out = [];
  for (let i = 0; i < Math.floor(count); i++) {
    const m = available[Math.floor(rng() * available.length)];
    out.push({ providerID: m.providerID, modelID: m.modelID, modelName: m.name });
  }
  return out;
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

export { formatCost };

/**
 * Creates a complete model plan: random per-seat assignments plus a random
 * orchestrator suggestion. Per-seat models chosen in Setup always win — this
 * plan only pre-fills pickers.
 *
 * @param {AvailableModel[]} available enabled, healthy models to draw from
 * @param {number} [count=5] how many seat suggestions to produce
 * @param {() => number} [rng=Math.random] random source (injectable for tests)
 */
export function createModelPlan(available, count = 5, rng = Math.random) {
  const pool = Array.isArray(available) ? available : [];
  const participants = assignModelsRandomly(pool, count, rng);
  const orchestrator = participants[0] ?? null;
  return { orchestrator, participants, available: pool };
}

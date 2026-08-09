export interface AvailableModel {
  providerID: string;
  modelID: string;
  name: string;
  status: string;
  cost: { input: number; output: number; cache_read?: number; cache_write?: number };
  limit: { context: number; output: number };
  reasoning: boolean;
  temperature: boolean;
}

export interface ModelAssignment {
  tier: string;
  providerID: string;
  modelID: string;
  modelName: string;
}

export interface ModelPlan {
  orchestrator: ModelAssignment;
  participants: ModelAssignment[];
  available: AvailableModel[];
}

/** Scores a model for auto-selection: prefers free, active, high-context, reasoning-capable models. */
function scoreModel(model: AvailableModel): number {
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
function sortModelsByQuality(models: AvailableModel[]): AvailableModel[] {
  return [...models].sort((a, b) => scoreModel(b) - scoreModel(a));
}

/** Assigns the best available models to each role, prioritizing principal > senior > mid > junior. */
export function selectModelsForRoles(available: AvailableModel[], roles: string[]): ModelAssignment[] {
  const sorted = sortModelsByQuality(available);
  const free = sorted.filter((m) => m.cost.input === 0 && m.cost.output === 0);
  const candidates = free.length >= roles.length ? free : sorted;

  const assignments: ModelAssignment[] = [];
  const usedIndices = new Set<number>();

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
export function formatModelPlan(plan: ModelPlan): string {
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
function formatCost(assignment: ModelAssignment, available: AvailableModel[]): string {
  const model = available.find(
    (m) => m.providerID === assignment.providerID && m.modelID === assignment.modelID,
  );
  if (!model) return "unknown";
  if (model.cost.input === 0 && model.cost.output === 0) return "free";
  return `$${model.cost.input}/$${model.cost.output}`;
}

/** Creates a complete model plan: selects models for each role and designates the orchestrator. */
export function createModelPlan(available: AvailableModel[], roles?: string[]): ModelPlan {
  const defaultRoles = ["junior", "mid", "senior", "principal"];
  const participants = selectModelsForRoles(available, roles ?? defaultRoles);
  const orchestrator = participants.find((p) => p.tier === "mid") || participants[0];
  return { orchestrator, participants, available };
}

let storedPlan: ModelAssignment[] | null = null;

/** Stores a model plan for auto-application in the next `knit` invocation. */
export function storeModelPlan(plan: ModelAssignment[]): void {
  storedPlan = plan;
}

/** Retrieves the previously stored model plan (if any). */
export function getStoredModelPlan(): ModelAssignment[] | null {
  return storedPlan;
}

/** Clears the stored model plan. */
export function clearStoredModelPlan(): void {
  storedPlan = null;
}

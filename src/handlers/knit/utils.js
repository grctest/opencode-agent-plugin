/**
 * Extracts a short one-line decision summary from a markdown artifact,
 * preferring the first non-empty line under `## Decision`.
 */
export function extractDecisionSummary(artifact) {
  if (!artifact || typeof artifact !== "string") return null;
  const match = artifact.match(/##\s*Decision\b([\s\S]*?)(?=\n##\s|\n*$)/i);
  const section = match ? match[1] : artifact;
  const firstLine = section
    .split("\n")
    .map((l) => l.replace(/^[-*#>\s]+/, "").trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}

/**
 * Filters the full list of discovered models by the enabled-models set.
 * When enabledModels is null, all models are allowed (no filter).
 */
export function applyModelFilter(allAvailable, enabledModels) {
  if (enabledModels === null) return allAvailable;
  if (enabledModels.size === 0) return [];
  return allAvailable.filter((m) => {
    const key = `${m.providerID}/${m.modelID}`;
    return enabledModels.has(key);
  });
}

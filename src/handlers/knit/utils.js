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
 * Filters the full list of discovered models by the disabled-models deny list.
 * When disabledModels is null/empty, all models are allowed (no filter).
 * Disabled models are excluded; future models are enabled by default.
 */
export function applyModelFilter(allAvailable, disabledModels) {
  if (!disabledModels || disabledModels.size === 0) return allAvailable;
  return allAvailable.filter((m) => {
    const key = `${m.providerID}/${m.modelID}`;
    return !disabledModels.has(key);
  });
}



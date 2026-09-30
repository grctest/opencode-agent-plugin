/**
 * P9/N2 — the confidence split, in one place.
 *
 * A deliberation has two confidence layers: the NAME (the qualitative
 * conclusion) and the NUMBER (any quantitative estimate it rests on). The
 * prose states both; the database stores both; and the single `confidence`
 * column is a computed roll-up of the two, so no machine reader can see
 * "high" for an artifact whose own text says Number: Low.
 *
 * Lives in utils/ (not the synthesizer or the schema) so both the artifact
 * pipeline and the v12→v13 migration read the same function.
 */

const LEVELS = ["low", "medium", "high"];
const RANK = { low: 0, medium: 1, high: 2 };

function normalizeLevel(value) {
  const key = String(value ?? "").trim().toLowerCase();
  return LEVELS.includes(key) ? key : null;
}

/**
 * Reads "Name: High; Number: Low" out of an artifact body's Confidence
 * section. Returns nulls when either layer is absent, so callers can fall
 * back to their own derivation rather than inventing a level.
 * @param {string} text
 * @returns {{name: string|null, number: string|null}}
 */
export function parseSplitConfidence(text) {
  // (?![\s\S]) is the portable "absolute end of string" assertion — JS has no
  // \z, and `/\z/` silently matches a literal "z" instead.
  const block = String(text ?? "").match(/^#{2,}\s*Confidence\b([\s\S]*?)(?=^#{2,}\s|(?![\s\S]))/im)?.[1] ?? "";
  const scope = block || String(text ?? "");
  const level = (label) => normalizeLevel(scope.match(new RegExp(`\\b${label}\\s*:\\s*(High|Medium|Low)`, "i"))?.[1]);
  return { name: level("Name"), number: level("Number") };
}

/**
 * The roll-up stored in `artifacts.confidence`: the weaker layer wins. A
 * missing layer defers to the one that is present, so pre-split artifacts
 * and degraded runs keep reporting something rather than nothing.
 * @param {string|null} confidenceName
 * @param {string|null} confidenceNumber
 * @returns {string|null}
 */
export function rollupConfidence(confidenceName, confidenceNumber) {
  const name = normalizeLevel(confidenceName);
  const number = normalizeLevel(confidenceNumber);
  if (name && number) return LEVELS[Math.min(RANK[name], RANK[number])];
  return name ?? number ?? null;
}

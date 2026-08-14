/**
 * Parses a stored reflection column into a single reflection string.
 * Handles legacy JSON arrays (takes the last element) and plain strings.
 */
export function parseReflections(raw) {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x) => typeof x === "string").at(-1) ?? "";
    }
    if (typeof parsed === "string") return parsed;
  } catch { /* legacy plain text */ }
  return raw;
}

/** Parses a stored JSON stats blob from the DB into an object (never throws). */
export function parseStats(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

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

/**
 * Safe JSON column parse — malformed rows must not 500 the endpoints that read them (audit 10 S4).
 * Handles double-stringified columns (JSON.stringify(JSON.stringify(arr))) by re-parsing once.
 * Also normalizes non-array fallback for tool_calls: if parsed value is not array-like, return fallback
 * so callers can distinguish empty vs corrupted.
 */
export function safeParseJson(value, fallback = null) {
  if (!value) return fallback;
  // Already an object/array (e.g., from SSE JSON) — return as-is
  if (typeof value !== "string") return value;
  try {
    const first = JSON.parse(value);
    // Double-stringified: first parse yields a string that is itself JSON
    if (typeof first === "string" && first.length > 0 && (first[0] === "[" || first[0] === "{" || first[0] === '"')) {
      try {
        return JSON.parse(first);
      } catch {
        return first;
      }
    }
    return first;
  } catch {
    return fallback;
  }
}

/**
 * Normalizes tool_calls column value to an array or fallback.
 * Coerces stringified, double-stringified, or already-parsed forms.
 */
export function normalizeToolCalls(raw, fallback = null) {
  const parsed = safeParseJson(raw, fallback);
  if (Array.isArray(parsed)) return parsed;
  if (parsed == null) return fallback;
  // Single object stored without array wrapper
  if (typeof parsed === "object") return [parsed];
  return fallback;
}

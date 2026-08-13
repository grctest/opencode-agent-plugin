import { getConfig } from "../config.js";

/** Extracts text content from an LLM response data object. */
export function extractText(data) {
  if (!data?.parts) return null;
  const textParts = data.parts.filter((p) => p.type === "text");
  const content = textParts.map((p) => p.text).join("\n").trim();
  return content.length > 0 ? content : null;
}

/** Truncates text to max length, adding ellipsis if needed. */
export function truncate(text, max) {
  const cleaned = text.replace(/\n/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max - 3) + "...";
}

/** Enforces a word limit on text, appending [truncated] if exceeded. */
export function enforceWordLimit(text, maxWords) {
  if (!text || typeof text !== "string") return "";
  const limit = maxWords ?? getConfig().maxContributionWords;
  const words = text.split(/\s+/);
  if (words.length <= limit) return text;
  return words.slice(0, limit - 1).join(" ") + " [truncated]";
}

/** Wraps a promise with a timeout. Rejects if the promise doesn't resolve in time. */
export function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

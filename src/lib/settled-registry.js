/**
 * Meeting-level settled registry (retrospective P0-2).
 *
 * The round clerk (LLM) designates consensus items in its `**Settled:**`
 * bullet — it detects paraphrased consensus semantically, which exact-match
 * state aggregation cannot (deliberation 2 replay: five agents, five phrasings
 * of the same consensus, zero exact normalized-text matches).
 *
 * This module parses the clerk's bullet and merges new items into the
 * meeting-level list: cumulative across rounds, deduped by normalized text,
 * capped for prompt size. Pure functions only — no I/O.
 */

const SETTLED_BULLET_RE = /(?:^|\n)\s*[-*]?\s*\*\*Settled:\*\*\s*([^\n]*)/i;
const MAX_SETTLED_ITEMS = 10;

function normalizeSettledKey(text) {
  return String(text ?? "")
    .replace(/\s*\[#\d+\]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function splitSettledItems(bulletText) {
  // Strip the "**Settled:**" header itself — it is the bullet label, not an item.
  const raw = String(bulletText ?? "")
    .replace(/^\s*[-*]?\s*\*\*Settled:\*\*\s*/i, "")
    .trim();
  if (!raw || /^none\b/i.test(raw)) return [];
  // The clerk emits either inline after the colon or as following "- " lines.
  const items = [];
  const parts = raw.split(/\n|(?<=\])\s+(?=-)/);
  for (const part of parts) {
    const cleaned = part.replace(/^[-*]\s*/, "").trim();
    if (!cleaned || /^none\b/i.test(cleaned)) continue;
    if (cleaned.length < 8) continue;
    items.push(cleaned);
  }
  return items;
}

/**
 * Parses the `**Settled:**` bullet from a round summary.
 * @param {string} summary - the clerk's round summary markdown
 * @returns {string[]} settled item texts (may be empty)
 */
export function parseSettledBullet(summary) {
  if (!summary) return [];
  const lines = String(summary).split("\n");
  const bulletIdx = lines.findIndex((l) => /^\s*[-*]?\s*\*\*Settled:\*\*/i.test(l));
  if (bulletIdx < 0) return [];
  // Capture the bullet line plus any following "- " list lines, stopping at
  // the next ** bullet (the clerk may wrap the list across lines).
  const collected = [];
  for (const line of lines.slice(bulletIdx)) {
    if (collected.length > 0 && /^\s*[-*]?\s*\*\*(?:Established|Contested|Evidence|Open|Code)\b/i.test(line)) break;
    collected.push(line);
  }
  return splitSettledItems(collected.join("\n"));
}

/**
 * Merges clerk-designated settled items into the meeting-level registry.
 * Cumulative (items persist across rounds), deduped by normalized text,
 * newest-last, capped. Returns { items, changed }.
 *
 * @param {Array<{text: string}>} existing - current registry
 * @param {string} summary - round summary containing the Settled bullet
 * @param {number} round - current round number (stamped on new items)
 * @returns {{ items: Array, changed: boolean }}
 */
export function mergeSettledBullet(existing, summary, round) {
  const current = Array.isArray(existing) ? existing.filter((it) => it && typeof it.text === "string") : [];
  const seen = new Set(current.map((it) => normalizeSettledKey(it.text)));
  const additions = [];
  for (const text of parseSettledBullet(summary)) {
    const key = normalizeSettledKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    additions.push({ text, holders: [], round });
  }
  if (additions.length === 0) return { items: current, changed: false };
  const merged = [...current, ...additions].slice(-MAX_SETTLED_ITEMS);
  return { items: merged, changed: true };
}

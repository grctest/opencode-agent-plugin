/**
 * Pipe-table repair for LLM-generated markdown.
 *
 * Synthesis prompts ask for spectrum tables (`| Position | Holder(s) | … |`),
 * but models frequently omit the mandatory GFM delimiter row
 * (`| --- | --- | … |`). Without it, `marked` (GFM) does not recognize the
 * block as a table and the dashboard shows raw pipe text.
 *
 * `normalizePipeTables` inserts a missing delimiter row so such tables render.
 * Pure string transform with no dependencies — safe to import from both the
 * dashboard bundle and node unit tests.
 */

const FENCE_RE = /^\s*(`{3,}|~{3,})/;

function splitCells(line) {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|");
}

function isPipeRow(line) {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return false;
  // Header/body rows start and end with a pipe (the shape synthesis emits).
  return /^\|.*\|\s*$/.test(trimmed);
}

function isDelimiterRow(line) {
  const trimmed = line.trim();
  if (!/^\|?[\s:|\-]+\|?[\s]*$/.test(trimmed)) return false;
  const cells = splitCells(trimmed);
  return cells.length > 0 && cells.every((c) => /^\s*:?-{1,}:?\s*$/.test(c));
}

function delimiterRow(colCount) {
  return `|${" --- |".repeat(colCount)}`;
}

/**
 * Insert a `| --- | … |` row after any pipe-table header row that is
 * directly followed by another pipe row which is not already a delimiter.
 * Fenced code blocks are left untouched. Idempotent: tables that already
 * have a delimiter row pass through unchanged.
 */
export function normalizePipeTables(content) {
  if (!content || typeof content !== "string" || !content.includes("|")) return content;
  const lines = content.split("\n");
  const out = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    out.push(line);
    if (inFence) continue;
    const next = lines[i + 1];
    if (next === undefined) continue;
    if (!isPipeRow(line) || !isPipeRow(next) || isDelimiterRow(line) || isDelimiterRow(next)) continue;
    // Only the first row of a pipe block is a header candidate — body rows
    // (predecessor is also a pipe row) must never trigger an insertion.
    const prev = i === 0 ? null : lines[i - 1];
    if (prev !== null && isPipeRow(prev)) continue;
    const cols = splitCells(line).length;
    const nextCols = splitCells(next).length;
    // Require ≥2 columns and a matching body row so isolated prose lines
    // containing pipes (e.g. `a | b`) are never rewritten.
    if (cols >= 2 && nextCols === cols) {
      out.push(delimiterRow(cols));
    }
  }
  return out.join("\n");
}

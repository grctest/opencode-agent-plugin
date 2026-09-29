// Shared evidence cache (retrospective P5): a read-side view over tool_audit.
//
// The room re-searched what it had already retrieved (analysis C5: 5 near-duplicate
// query pairs, one participant re-asking the identical seat query twice in a single
// round). tool_audit already stores every websearch/webfetch query text and output —
// this module turns that write-side log into a per-meeting (normalized query →
// result digest) cache surfaced in prompt context, so agents cite-or-supersede a
// past result instead of re-searching it.
//
// Pure functions over already-fetched audit rows: no DB access here. The caller
// (prompt-session.js) reads db.getToolAudits() once per turn and passes the rows in.

const RESEARCH_TOOLS = new Set(["websearch", "webfetch"]);

/**
 * Normalizes a query for dedup: lowercase, strip punctuation, collapse whitespace.
 * "F1 2027 calendar!!!" and "f1 2027 calendar" normalize to the same key.
 */
export function normalizeQuery(query) {
  return String(query ?? "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts the searchable query string from a tool_audit row's input.
 * websearch stores {query}; webfetch stores {url} (or {urls:[...]}).
 * Returns null when the input is unparseable or carries no query.
 */
export function extractQueryFromAudit(audit) {
  if (!audit || typeof audit !== "object") return null;
  let input = audit.input;
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { return null; }
  }
  if (!input || typeof input !== "object") return null;
  if (audit.tool === "websearch") {
    const q = input.query ?? input.q ?? input.search;
    return typeof q === "string" && q.trim() ? q.trim() : null;
  }
  if (audit.tool === "webfetch") {
    const u = input.url ?? input.urls?.[0];
    return typeof u === "string" && u.trim() ? u.trim() : null;
  }
  return null;
}

/**
 * Builds the deduplicated evidence cache from tool_audit rows.
 *
 * Keeps only websearch/webfetch rows with an extractable query, normalizes each
 * query, and dedupes by normalized form — the LATEST occurrence wins (most recent
 * round's result digest is the one a re-searcher would be superseding). Each entry
 * carries a bounded result digest so the prompt stays small.
 *
 * @param {Array} toolAudits rows from getToolAudits()
 * @param {object} [opts]
 * @param {number} [opts.maxEntries=20]   cap on returned entries (prompt budget)
 * @param {number} [opts.digestLength=300] cap on each result digest (chars)
 * @returns {Array<{query, normalized, participantId, round, tool, digest, searches}>}
 */
export function buildEvidenceCache(toolAudits, { maxEntries = 20, digestLength = 300 } = {}) {
  if (!Array.isArray(toolAudits) || toolAudits.length === 0) return [];
  const byNormalized = new Map();
  for (const audit of toolAudits) {
    if (!audit || !RESEARCH_TOOLS.has(audit.tool)) continue;
    const query = extractQueryFromAudit(audit);
    if (!query) continue;
    const normalized = normalizeQuery(query);
    if (!normalized) continue;
    const digest = String(audit.output ?? "").replace(/\s+/g, " ").trim().slice(0, digestLength);
    const prev = byNormalized.get(normalized);
    // Latest wins; accumulate a search count so the agent can see a query that
    // has been asked repeatedly (a near-duplicate cluster signal).
    byNormalized.set(normalized, {
      query,
      normalized,
      participantId: audit.participant_id ?? null,
      round: audit.round ?? null,
      tool: audit.tool,
      digest,
      searches: prev ? prev.searches + 1 : 1,
    });
  }
  return [...byNormalized.values()].slice(-maxEntries);
}

/**
 * Renders the cache as a prompt block. Returns "" for an empty cache so callers
 * can interpolate unconditionally and flag-off prompts stay byte-identical.
 *
 * The returned markdown is raw (not delimited): digests are tool output —
 * untrusted content the caller must wrap in delimitContext (contract §3), the
 * same treatment SoP/transcript blocks get.
 */
export function formatEvidenceCacheForPrompt(cache, { digestLength = 300 } = {}) {
  if (!Array.isArray(cache) || cache.length === 0) return "";
  const lines = cache.map((e) => {
    const who = e.participantId ?? "unknown";
    const when = Number.isFinite(e.round) ? `r${roundLabel(e.round)}` : "r?";
    const digest = String(e.digest ?? "").slice(0, digestLength).replace(/\n/g, " ").trim();
    const repeat = e.searches > 1 ? ` (×${e.searches})` : "";
    return `- "${e.query}" — ${who} ${when}${repeat}: ${digest || "(no result captured)"}`;
  });
  return `## Prior Searches — shared evidence cache (cite-or-supersede, don't re-search)

${lines.join("\n")}

_These queries already ran this meeting. Before calling websearch/webfetch, scan this list: if your question is answered by a prior result, cite it ([#id] if it reached a contribution, or the query text) — or explicitly supersede it with a new search and say why the old result is stale. A near-duplicate of a listed query is a re-search unless you name what changed._`;
}

function roundLabel(r) {
  return Number.isFinite(r) ? String(r) : "?";
}

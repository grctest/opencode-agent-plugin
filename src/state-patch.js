import { formatStateOfPlay } from "./state-of-play.js";

/**
 * SKILL.state complementary per-agent execution state (plan §5.2–5.3, §5.8).
 * Pure functions only — no I/O. Deterministic, total on validated input.
 */

export const AGENT_STATE_SEED = {
  stance: "",
  established: [],
  contested: [],
  open: [],
  facts: [],
  files: [],
  version: 0,
  updated_round: 0,
  updated_contribution_id: null,
};

export const STATE_PATCH_CAPS = {
  buckets: 8,
  // Storage bounds, NOT admission bounds. applyStatePatch trims to these; it
  // never rejects on them. A patch that arrives longer than the bound is kept
  // (trimmed for the prompt render) instead of refused — the agent's reasoning
  // is the input we want, and a hard max() here silently discarded 6 of 21
  // patches in one meeting for being a few characters over.
  stanceMax: 1200,
  bulletMax: 800,
  fileMax: 240,
  addsPerCall: 3,
  removesPerCall: 5,
  // Bounded pin tier. Evidence with Source:/[#id] is exempt from FIFO eviction
  // because its relevance is often recognized late — but an *unbounded* pin set
  // breaks the paper's sufficient-statistic property: only the first `buckets`
  // entries are ever rendered, so pins beyond that are invisible AND
  // un-removable (the model cannot remove text it cannot see), growing O(T) in
  // storage and structuredClone cost for no reasoning value. Instead the newest
  // `pinnedFacts` pins are protected and older pins degrade to evictable.
  //
  // Invariant: pinnedFacts + reserve <= buckets, so protected entries never
  // exceed what the prompt renders — stored ⊆ visible ⊆ removable (audit A8).
  // (Previously pinnedFacts === buckets, which allowed reserve + pinnedFacts = 10
  // protected entries against an 8-entry render window, hiding mixed
  // pinned/unpinned buckets from the model.)
  pinnedFacts: 6,
  // Newest N entries per bucket are never FIFO-evicted, so a single 3-add call
  // cannot immediately churn the context it just wrote.
  reserve: 2,
};

export function emptyAgentState() {
  return structuredClone(AGENT_STATE_SEED);
}

const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ");
const key = (s) => norm(s).toLowerCase();

/** Bucket names that take a flat string[] in canonical form. */
export const PATCH_LIST_KEYS = ["established_add", "contested_add", "open_add", "facts_add", "files_add", "remove"];
export const PATCH_KEYS = ["stance", ...PATCH_LIST_KEYS];

const MAX_COERCE_DEPTH = 8;

/**
 * Collect every string leaf under `value`, depth-first, preserving order.
 *
 * A small model asked for `established_add: string[]` will sometimes answer
 * with the shape the key *looks* like — `established_add: { contested_add:
 * { contested_add: { item: [...] } } }` — by mirroring the `_add` suffix into
 * a nesting of its own. That is a shape question, not a reasoning question, so
 * it must be normalized rather than refused. Measured: a recursive
 * `{item:[...]}` nest cost 2 of 21 patches in one meeting.
 *
 * @param {unknown} value
 * @param {string[]} out
 * @param {number} depth
 * @param {Set<object>} seen cycle guard (JSON input cannot cycle; JS callers can)
 */
function collectStrings(value, out, depth = 0, seen = new Set()) {
  if (value == null) return;
  if (typeof value === "string") {
    const s = value.trim();
    if (s) out.push(s);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return;
  }
  if (depth >= MAX_COERCE_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1, seen);
    return;
  }
  if (typeof value === "object") {
    if (seen.has(value)) return;
    seen.add(value);
    for (const k of Object.keys(value)) {
      // A nested key that merely *names* another bucket carries no extra
      // meaning — the leaf strings are the content. Skip `_add`-suffixed keys
      // that hold nothing, keep everything else.
      collectStrings(value[k], out, depth + 1, seen);
    }
  }
}

/**
 * Coerce arbitrary tool input into the canonical patch shape. Total: it cannot
 * throw, and it never rejects. Shape problems become notes, not errors.
 *
 * Handles, at minimum, every failure observed in production:
 *   - string where a string[] was expected            → wrapped
 *   - nested object where a string[] was expected     → string leaves collected
 *   - more bullets than the (now advisory) per-call cap → all kept, FIFO caps them
 *   - stance/bullet longer than any previous max()     → kept, trimmed on store
 *   - unknown / misspelled keys                        → ignored, noted
 *   - an entirely empty/unusable patch                 → empty:true (benign no-op)
 *
 * @param {unknown} input
 * @returns {{ patch: {stance?: string, established_add: string[], contested_add: string[], open_add: string[], facts_add: string[], files_add: string[], remove: string[]}, notes: string[], empty: boolean, droppedKeys: string[] }}
 */
export function coerceStatePatch(input) {
  const notes = [];
  const droppedKeys = [];
  const src = (input && typeof input === "object") ? input : {};
  const out = {
    established_add: [], contested_add: [], open_add: [],
    facts_add: [], files_add: [], remove: [],
  };

  for (const k of Object.keys(src)) {
    if (!PATCH_KEYS.includes(k)) droppedKeys.push(k);
  }
  if (droppedKeys.length) {
    notes.push(`ignored unknown key(s): ${droppedKeys.slice(0, 5).join(", ")}`);
  }

  // stance: any scalar/collection that can yield one string.
  if (src.stance !== undefined && src.stance !== null) {
    const leaves = [];
    collectStrings(src.stance, leaves);
    if (leaves.length) {
      out.stance = leaves.join(" ");
      if (leaves.length > 1) notes.push("stance was not a single string — joined its parts");
    } else {
      notes.push("stance had no readable text — ignored");
    }
  }

  for (const k of PATCH_LIST_KEYS) {
    const raw = src[k];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string" && !Array.isArray(raw) && typeof raw !== "object") continue;
    const items = [];
    collectStrings(raw, items);
    if (!Array.isArray(raw) && typeof raw === "string") {
      notes.push(`${k} was a bare string — wrapped in a list`);
    } else if (!Array.isArray(raw) && typeof raw === "object") {
      notes.push(`${k} was an object, not a list — flattened to its text`);
    }
    // Advisory only: the per-call caps are NOT enforced. applyStatePatch dedups
    // and FIFO-caps each bucket, so an over-long add list degrades by evicting
    // its own oldest entry rather than failing the whole call.
    out[k] = items;
  }

  const empty = out.stance === undefined && PATCH_LIST_KEYS.every((k) => out[k].length === 0);
  if (empty && Object.keys(src).length > 0) {
    notes.push("no readable fields in this patch");
  }
  return { patch: out, notes, empty, droppedKeys };
}

/**
 * Merge a later patch into an already-queued one for the same turn. A second
 * loom_state_patch in one turn is a formatting accident, not a rule violation,
 * so it folds in rather than being refused.
 */
export function mergeStatePatches(earlier, later) {
  const a = coerceStatePatch(earlier).patch;
  const b = coerceStatePatch(later).patch;
  const merged = { established_add: [], contested_add: [], open_add: [], facts_add: [], files_add: [], remove: [] };
  for (const k of PATCH_LIST_KEYS) merged[k] = [...a[k], ...b[k]];
  if (b.stance !== undefined) merged.stance = b.stance;
  else if (a.stance !== undefined) merged.stance = a.stance;
  return merged;
}

function normalizeFileSnippet(raw) {
  let s = norm(raw).toLowerCase().replace(/[,).\]]+$/, "");
  // Keep src/... or file= basename chop to ≤80ch for snippet (state-of-play.js:64-68 analogue)
  const m = s.match(/(?:file\s*=\s*)([^\s`'"]+)/) || s.match(/(src\/[^\s`'"]+)/);
  if (m) s = (m[1] ?? m[0]).slice(0, 80);
  return s.slice(0, STATE_PATCH_CAPS.fileMax);
}

/**
 * Typed flat-array equivalent of paper Eq. 4 Σ_{t+1} = Σ_t ⊕ ΔΣ_t.
 * remove[] plays null-keys; *_add plays key-mutation; FIFO + pinning bounds retention.
 * Returns { next, applied, unmatched, evicted }.
 */
export function applyStatePatch(prev, patch) {
  const base = prev ?? emptyAgentState();
  const next = {
    ...base,
    stance: base.stance ?? "",
    established: [...(base.established ?? [])],
    contested: [...(base.contested ?? [])],
    open: [...(base.open ?? [])],
    facts: [...(base.facts ?? [])],
    files: [...(base.files ?? [])],
    version: base.version ?? 0,
    updated_round: base.updated_round ?? 0,
    updated_contribution_id: base.updated_contribution_id ?? null,
  };
  const applied = { stance: false, added: {}, removed: [], evicted: [], overCap: [], skipped: [] };  const unmatched = [];

  const removeKeys = new Set((patch.remove ?? []).map(key));

  // 1. Null-deletion: remove normalized matches (trim + collapse whitespace +
  // lowercase) from every bucket + stance. Not literal string equality — see
  // STATE_PATCH_REMOVE_MATCH_NOTE for the contract the tool description advertises.
  if (removeKeys.size) {
    for (const bucket of ["established", "contested", "open", "facts", "files"]) {
      const before = next[bucket].length;
      next[bucket] = next[bucket].filter((item) => !removeKeys.has(key(item)));
      if (next[bucket].length !== before)
        applied.removed.push(...Array(before - next[bucket].length).fill(bucket));
    }
    if (next.stance && removeKeys.has(key(next.stance))) {
      next.stance = "";
      applied.removed.push("stance");
    }
    // report removes that matched nothing
    for (const r of patch.remove ?? []) {
      const k = key(r);
      const matched =
        ["established", "contested", "open", "facts", "files"].some((b) =>
          (base[b] ?? []).some((it) => key(it) === k),
        ) ||
        (base.stance && key(base.stance) === k);
      if (!matched) unmatched.push(String(r).slice(0, 120));
    }
  }

  // 2. Stance overwrite (paper's key mutation). Clearing is done by `remove`ing
  // the current stance (step 1) — the schema requires stance to be non-empty.
  if (patch.stance !== undefined) {
    next.stance = norm(patch.stance).slice(0, STATE_PATCH_CAPS.stanceMax);
    applied.stance = true;
  }

  // 3. Adds with dedup + FIFO cap 8, pinned facts + reserve protection (§5.2)
  const isPinned = (bucket, item) =>
    bucket === "facts" && /(source:|#\d+)/i.test(item);

  // FIFO eviction honoring the pin tier + the newest-entry reserve. Reusable so
  // the ungrounded-fact quarantine (which appends to `open` from inside the
  // facts pass) is capped and reported like any other write.
  //
  // Pin policy (facts only): a bullet carrying `Source:`/`[#id]` is evidence,
  // and evidence whose relevance is recognized late must survive. The newest
  // `pinnedFacts` pins are protected outright; older pins *degrade* to
  // evictable rather than accumulating forever. Demotions are reported so the
  // model learns its oldest evidence fell off instead of silently forgetting.
  const enforceCap = (bucket, cap) => {
    const reserve = STATE_PATCH_CAPS.reserve;
    const evictableRange = () => Math.max(0, next[bucket].length - reserve);
    const isProtected = (idx) => {
      if (idx >= evictableRange()) return true;
      if (bucket !== "facts" || !isPinned(bucket, next[bucket][idx])) return false;
      // A pin is protected only while fewer than `pinnedFacts` newer pins exist.
      let newerPins = 0;
      for (let j = idx + 1; j < next[bucket].length; j++) {
        if (isPinned(bucket, next[bucket][j])) newerPins++;
      }
      return newerPins < STATE_PATCH_CAPS.pinnedFacts;
    };
    while (next[bucket].length > cap) {
      let victimIdx = -1;
      for (let i = 0; i < evictableRange(); i++) {
        if (!isProtected(i)) { victimIdx = i; break; }
      }
      if (victimIdx < 0) {
        // Everything left is a protected pin or inside the reserve. Over-cap is
        // tolerated (never silently drop live evidence) but must be reported.
        applied.overCap.push({ bucket, length: next[bucket].length, cap });
        break;
      }
      const wasPin = bucket === "facts" && isPinned(bucket, next[bucket][victimIdx]);
      applied.evicted.push({ bucket, item: next[bucket].splice(victimIdx, 1)[0], demoted: wasPin });
    }
  };

  const addTo = (bucket, items, cap = STATE_PATCH_CAPS.buckets, limit = bucket === "files" ? STATE_PATCH_CAPS.fileMax : STATE_PATCH_CAPS.bulletMax) => {
    applied.added[bucket] = applied.added[bucket] ?? [];
    const seen = new Set(next[bucket].map(key));
    for (const raw of items ?? []) {
      const item = bucket === "files" ? normalizeFileSnippet(raw) : norm(raw).slice(0, limit);
      if (!item || seen.has(key(item))) continue;
      // Cross-bucket move: if the same text lives in a sibling bucket, drop it
      // there first so buckets stay disjoint without model bookkeeping. A
      // pinned fact is never auto-moved — explicit remove is required. When
      // that blocks the move we skip the add entirely, otherwise the pinned
      // fact would be duplicated into the destination bucket.
      let moveBlocked = false;
      if (bucket !== "files") {
        for (const sib of ["established", "contested", "open", "facts"]) {
          if (sib === bucket) continue;
          const idx = next[sib].findIndex((it) => key(it) === key(item));
          if (idx < 0) continue;
          if (isPinned(sib, next[sib][idx])) {
            moveBlocked = true;
            break;
          }
          next[sib].splice(idx, 1);
          applied.removed.push(`${sib}→${bucket}`);
        }
      }
      if (moveBlocked) {
        applied.skipped.push({ bucket, item, reason: "pinned_in_facts" });
        continue;
      }
      // Ungrounded fact quarantine (§5.1a): facts without Source/[#id] land in
      // `open` marked unverified, and go through the same cap/FIFO path.
      if (bucket === "facts" && !isPinned(bucket, item)) {
        const q = item.endsWith("(unverified)") ? item : `${item} (unverified)`;
        if (!next.open.some((it) => key(it) === key(q))) {
          next.open.push(q);
          applied.added.open = [...(applied.added.open ?? []), q];
          enforceCap("open", STATE_PATCH_CAPS.buckets);
        }
        continue;
      }
      next[bucket].push(item);
      seen.add(key(item));
      applied.added[bucket].push(item);
    }
    enforceCap(bucket, cap);
  };

  addTo("established", patch.established_add);
  addTo("contested", patch.contested_add);
  addTo("open", patch.open_add);
  addTo("facts", patch.facts_add);
  addTo("files", patch.files_add);

  next.version = (base.version ?? 0) + 1;
  return { next, applied, unmatched, evicted: applied.evicted, overCap: applied.overCap, skipped: applied.skipped };
}

/** Renders one agent's Σⁱ as markdown inner block (A.2). Empty → affordance placeholder. */
export function renderMyStateMarkdown(state) {
  const s = state ?? emptyAgentState();
  const hasAny = (s.stance && s.stance.trim()) || (s.established ?? []).length || (s.contested ?? []).length ||
    (s.open ?? []).length || (s.facts ?? []).length || (s.files ?? []).length;
  if (!hasAny) return "(empty — patch it this turn)";
  const lines = [];
  lines.push(`Stance: ${s.stance?.trim() ? norm(s.stance) : "(none)"}`);
  const section = (title, items) => {
    if (!items || items.length === 0) return;
    lines.push(`${title}:`);
    for (const it of items.slice(0, STATE_PATCH_CAPS.buckets)) lines.push(`- ${it}`);
  };
  section("Established", s.established);
  section("Contested", s.contested);
  section("Open", s.open);
  section("Facts", s.facts);
  section("Files", s.files);
  return lines.join("\n");
}

/**
 * Primary SoP path: deterministic aggregation over per-agent states (§5.8).
 * allStates: Array<AgentState | { id, name, tier, state, updated_round }> —
 *   raw states attributed by index when no holder info present.
 * Output markdown shape identical to formatStateOfPlay() for downstream consumers.
 * Falls back to "" when every state is empty (caller uses legacy updateStateOfPlay).
 */
export function buildStateEntries(allStates) {
  const entries = (allStates ?? []).map((e, i) => {
    if (e && Array.isArray(e.established)) {
      return { index: i, id: e.id ?? `agent_${i}`, name: e.name ?? e.id ?? `agent_${i}`, tier: e.tier ?? "", state: e };
    }
    return {
      index: i,
      id: e?.id ?? `agent_${i}`,
      name: e?.name ?? e?.id ?? `agent_${i}`,
      tier: e?.tier ?? "",
      state: e?.state ?? emptyAgentState(),
    };
  }).filter((e) => e.state);
  return entries.filter((e) => {
    const s = e.state;
    return (s.stance && s.stance.trim()) || (s.established ?? []).length || (s.contested ?? []).length ||
      (s.open ?? []).length || (s.facts ?? []).length || (s.files ?? []).length;
  });
}

// bucket -> normalized key -> ranked slot. Ranking is consensus-first
// (holders desc), then freshness (round desc, then contribution id desc);
// lexicographic text is only the final deterministic tiebreak, never the
// deciding signal (audit A2).
export function rankStateSlots(entries, get, { minHolders = 1 } = {}) {
  const map = new Map();
  for (const e of entries ?? []) {
    for (const item of get(e.state) ?? []) {
      const k = key(item);
      if (!k) continue;
      if (!map.has(k)) map.set(k, { key: k, text: norm(item), holders: new Set(), holderIds: new Set(), recency: 0, updatedContributionId: 0, primaryId: e.id });
      const slot = map.get(k);
      slot.holders.add(e.name);
      slot.holderIds.add(e.id);
      slot.recency = Math.max(slot.recency, e.state.updated_round ?? 0);
      slot.updatedContributionId = Math.max(slot.updatedContributionId, e.state.updated_contribution_id ?? 0);
    }
  }
  return [...map.values()]
    .filter((slot) => slot.holders.size >= minHolders)
    .sort((a, b) => b.holders.size - a.holders.size || b.recency - a.recency ||
      b.updatedContributionId - a.updatedContributionId || (a.text < b.text ? -1 : 1));
}

// Selection with representation guarantee: pass 1 covers every holder with
// their highest-ranked item (multi-holder items cover several at once), pass 2
// fills by rank subject to a per-holder cap — so no single agent can monopolise
// a section when nothing is shared yet (audit A2).
export function takeStateSlots(ranked, cap = STATE_PATCH_CAPS.buckets, perHolderCap = 3) {
  const taken = [];
  const used = new Set();
  const covered = new Set();
  const counts = new Map();
  const take = (slot) => {
    taken.push(slot);
    used.add(slot.key);
    for (const id of slot.holderIds) {
      covered.add(id);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  };
  for (const slot of ranked) {
    if (taken.length >= cap) break;
    if ([...slot.holderIds].some((id) => !covered.has(id))) take(slot);
  }
  for (const slot of ranked) {
    if (taken.length >= cap) break;
    if (used.has(slot.key)) continue;
    if ((counts.get(slot.primaryId) ?? 0) >= perHolderCap) continue;
    take(slot);
  }
  return taken;
}

/**
 * Settled registry (F-A): the consensus subset of per-agent `established`
 * buckets — items held by ≥2 agents, ranked and capped exactly like the SoP
 * Agreements section. Derived per turn from live state (never stored), so it
 * cannot go stale. Returns [{ text, holders: [names] }].
 */
export function getSettledItems(allStates, { cap = STATE_PATCH_CAPS.buckets } = {}) {
  const entries = buildStateEntries(allStates);
  if (entries.length === 0) return [];
  return takeStateSlots(rankStateSlots(entries, (s) => s.established, { minHolders: 2 }), cap)
    .map((slot) => ({ text: slot.text, holders: [...slot.holders] }));
}

export function aggregateStateOfPlay(allStates, question, tags) {
  const nonEmpty = buildStateEntries(allStates);
  if (nonEmpty.length === 0) return "";

  const slotText = (v) => v.holders.size > 1 ? `${v.text} (${v.holders.size} holders)` : v.text;

  const collect = (get, opts) => takeStateSlots(rankStateSlots(nonEmpty, get, opts)).map(slotText);

  const established = collect((s) => s.established);
  const contested = collect((s) => s.contested);
  const open = collect((s) => s.open);
  // Decisions & Proposals and Agreements both require ≥2 holders — a single
  // agent's self-assertion must not render with the visual authority of
  // consensus. Single-holder established items remain in the agent's private
  // state but are excluded from the shared SoP (audit A4, P11 fix).
  const decisions = collect((s) => s.established, { minHolders: 2 });
  const agreements = collect((s) => s.established, { minHolders: 2 });

  // Key Facts: stances ranked alongside evidence with an evidence floor, never
  // 8/0 in either direction (audit A3). Stances lead (positions first), then
  // grounded facts; at least EVIDENCE_MIN fact slots survive whenever they exist.
  const EVIDENCE_MIN = 3;
  const CAP = STATE_PATCH_CAPS.buckets;
  const stanceTaken = nonEmpty
    .filter((e) => e.state.stance && e.state.stance.trim())
    .map((e) => ({
      key: `stance:${e.id}`,
      text: `**${e.name}${e.tier ? ` (${e.tier})` : ""} stance**: ${norm(e.state.stance).slice(0, STATE_PATCH_CAPS.stanceMax)}`,
      holders: new Set([e.name]),
      holderIds: new Set([e.id]),
      recency: e.state.updated_round ?? 0,
      updatedContributionId: e.state.updated_contribution_id ?? 0,
      primaryId: e.id,
      index: e.index,
    }))
    .sort((a, b) => b.recency - a.recency || a.index - b.index);
  const factTaken = takeStateSlots(rankStateSlots(nonEmpty, (s) => s.facts));
  const factKeep = Math.min(factTaken.length, Math.max(Math.min(EVIDENCE_MIN, factTaken.length), CAP - stanceTaken.length));
  const stanceKeep = Math.min(stanceTaken.length, CAP - factKeep);
  const keyFacts = [
    ...stanceTaken.slice(0, stanceKeep).map((s) => s.text),
    ...factTaken.slice(0, factKeep).map(slotText),
  ];

  // Files: union, dedupe, most-recent-first by (round, contribution id) — not
  // roster-tail-first (audit A5). Stable sort keeps first-seen order on ties.
  const fileMap = new Map();
  for (const e of nonEmpty) {
    for (const f of e.state.files ?? []) {
      const k = key(f);
      if (!k) continue;
      const round = e.state.updated_round ?? 0;
      const cid = e.state.updated_contribution_id ?? 0;
      const prev = fileMap.get(k);
      if (!prev || round > prev.round || (round === prev.round && cid > prev.cid)) {
        fileMap.set(k, { text: norm(f), round, cid });
      }
    }
  }
  const filesInvolved = [...fileMap.values()]
    .sort((a, b) => b.round - a.round || b.cid - a.cid)
    .slice(0, STATE_PATCH_CAPS.buckets)
    .map((v) => v.text);

  return formatStateOfPlay(
    {
      decisions,
      agreements,
      disagreements: contested,
      openQuestions: open,
      keyFacts,
      filesInvolved,
    },
    question,
    tags,
  );
}

/** Seed for legacy fallback rebuild marker. */
export function rebuiltSeedState() {
  return { ...emptyAgentState(), rebuilt: true };
}

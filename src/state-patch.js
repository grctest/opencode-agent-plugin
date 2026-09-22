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
  stanceMax: 400,
  bulletMax: 280,
  fileMax: 160,
  addsPerCall: 3,
  removesPerCall: 5,
};

export function emptyAgentState() {
  return structuredClone(AGENT_STATE_SEED);
}

const norm = (s) => String(s ?? "").trim().replace(/\s+/g, " ");
const key = (s) => norm(s).toLowerCase();

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
  const applied = { stance: false, added: {}, removed: [], evicted: [] };
  const unmatched = [];

  const removeKeys = new Set((patch.remove ?? []).map(key));

  // 1. Null-deletion: remove exact matches from every bucket + stance
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

  // 2. Stance overwrite (paper's key mutation; empty string clears)
  if (patch.stance !== undefined) {
    next.stance = norm(patch.stance).slice(0, STATE_PATCH_CAPS.stanceMax);
    applied.stance = true;
  }

  // 3. Adds with dedup + FIFO cap 8, pinned facts + reserve protection (§5.2)
  const isPinned = (bucket, item) =>
    bucket === "facts" && /(source:|#\d+)/i.test(item);

  const addTo = (bucket, items, cap = STATE_PATCH_CAPS.buckets, limit = bucket === "files" ? STATE_PATCH_CAPS.fileMax : STATE_PATCH_CAPS.bulletMax) => {
    applied.added[bucket] = [];
    const seen = new Set(next[bucket].map(key));
    for (const raw of items ?? []) {
      let item = bucket === "files" ? normalizeFileSnippet(raw) : norm(raw).slice(0, limit);
      if (!item || seen.has(key(item))) continue;
      // cross-bucket move: if same text lives in a sibling bucket, remove it there first
      // (keeps established/contested disjoint without model bookkeeping;
      //  never auto-moves a pinned fact out — explicit remove required)
      if (bucket !== "files") {
        for (const sib of ["established", "contested", "open", "facts"]) {
          if (sib === bucket) continue;
          const idx = next[sib].findIndex((it) => key(it) === key(item));
          if (idx >= 0) {
            if (isPinned(sib, next[sib][idx]) && sib === "facts") continue;
            next[sib].splice(idx, 1);
            applied.removed.push(`${sib}→${bucket}`);
          }
        }
      }
      // ungrounded fact quarantine (§5.1a): facts without Source/[#id] land in open as unverified
      if (bucket === "facts" && !isPinned(bucket, item)) {
        const q = item.endsWith("(unverified)") ? item : `${item} (unverified)`;
        if (!seen.has(key(q)) && !next.open.some((it) => key(it) === key(q))) {
          next.open.push(q);
          applied.added.open = [...(applied.added.open ?? []), q];
        }
        continue;
      }
      next[bucket].push(item);
      seen.add(key(item));
      applied.added[bucket].push(item);
    }
    // FIFO respecting pins + 2-newest reserve
    while (next[bucket].length > cap) {
      const victimIdx = next[bucket].findIndex(
        (it, idx) => !isPinned(bucket, it) && idx < next[bucket].length - 2,
      );
      if (victimIdx < 0) break; // all pinned or only reserve remains — over cap tolerated, reported
      applied.evicted.push({ bucket, item: next[bucket].splice(victimIdx, 1)[0] });
    }
  };

  addTo("established", patch.established_add);
  addTo("contested", patch.contested_add);
  addTo("open", patch.open_add);
  addTo("facts", patch.facts_add);
  addTo("files", patch.files_add);

  next.version = (base.version ?? 0) + 1;
  return { next, applied, unmatched, evicted: applied.evicted };
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
export function aggregateStateOfPlay(allStates, question, tags) {
  const entries = (allStates ?? []).map((e, i) => {
    if (e && Array.isArray(e.established)) {
      return { id: e.id ?? `agent_${i}`, name: e.name ?? e.id ?? `agent_${i}`, tier: e.tier ?? "", state: e };
    }
    return {
      id: e?.id ?? `agent_${i}`,
      name: e?.name ?? e?.id ?? `agent_${i}`,
      tier: e?.tier ?? "",
      state: e?.state ?? emptyAgentState(),
    };
  }).filter((e) => e.state);
  const nonEmpty = entries.filter((e) => {
    const s = e.state;
    return (s.stance && s.stance.trim()) || (s.established ?? []).length || (s.contested ?? []).length ||
      (s.open ?? []).length || (s.facts ?? []).length || (s.files ?? []).length;
  });
  if (nonEmpty.length === 0) return "";

  // bucket -> normalized key -> { text, holders:Set, recency }
  const collect = (get) => {
    const map = new Map();
    for (const e of nonEmpty) {
      for (const item of get(e.state) ?? []) {
        const k = key(item);
        if (!k) continue;
        if (!map.has(k)) map.set(k, { text: norm(item), holders: new Set(), recency: e.state.updated_round ?? 0, holderId: e.id });
        const slot = map.get(k);
        slot.holders.add(e.name);
        slot.recency = Math.max(slot.recency, e.state.updated_round ?? 0);
      }
    }
    return [...map.values()]
      .sort((a, b) => b.holders.size - a.holders.size || b.recency - a.recency || (a.text < b.text ? -1 : 1))
      .slice(0, STATE_PATCH_CAPS.buckets)
      .map((v) => v.holders.size > 1 ? `${v.text} (${v.holders.size} holders)` : v.text);
  };

  const established = collect((s) => s.established);
  const contested = collect((s) => s.contested);
  const open = collect((s) => s.open);
  // Stances surface as Key Facts lines with holder attribution
  const stances = nonEmpty
    .filter((e) => e.state.stance && e.state.stance.trim())
    .map((e) => `**${e.name}${e.tier ? ` (${e.tier})` : ""} stance**: ${norm(e.state.stance).slice(0, 400)}`);
  const keyFacts = [...stances, ...collect((s) => s.facts)].slice(0, STATE_PATCH_CAPS.buckets);

  // Files: union, dedupe, last 8
  const fileMap = new Map();
  for (const e of nonEmpty) {
    for (const f of e.state.files ?? []) {
      const k = key(f);
      if (!k) continue;
      if (fileMap.has(k)) fileMap.delete(k);
      fileMap.set(k, norm(f));
    }
  }
  const filesInvolved = [...fileMap.values()].slice(-8);

  return formatStateOfPlay(
    {
      decisions: [],
      agreements: established,
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

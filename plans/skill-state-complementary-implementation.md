# SKILL.state — Complementary Per-Agent Implementation for Loom

> **Status:** Planning — approved direction, not yet implemented.
> **Reference:** Badhe, Tiwari, Chung — *SKILL.state: Scalable Long-Horizon Agent Skills* (arXiv:2608.26263v3, 2 Sep 2026). Referred to below as "the paper".
> **Loom refs:** `ORCHESTRATION_ARCHITECTURE.md`, `src/prompts/agent.js`, `src/round-executor/agent/prompt-session.js`, `src/round-executor/agent/execute-turn.js`, `src/state-of-play.js`, `src/schemas.js`, `src/plugin/tools/pass.js`, `src/plugin/tools/query-evidence.js`.
> **Decisions locked in prior conversation:** (1) per-agent stance slice, not quorum joint-write; (2) mandatory `loom_state_patch` tool call every primary turn; (3) tool-channel, never prose-JSON parsing; (4) complement provenance, never replace it; (5) operational logging only — no benchmark/evaluation harness.

---

## Table of Contents

1. [Goal and Non-Goals](#1-goal-and-non-goals)
2. [Background: What SKILL.state Is](#2-background-what-skillstate-is)
3. [Mapping Paper → Loom](#3-mapping-paper--loom)
4. [Design Principles](#4-design-principles)
5. [Detailed Specification](#5-detailed-specification)
   - [5.1 The triple (P, Σⁱ_t, O_t)](#51-the-triple-p-%CF%83%CA%B3_t-o_t)
   - [5.1a Deliberation action a_t and validity](#51a-deliberation-action-at-and-validity-paper-app-b-analogue)
   - [5.2 Schema](#52-schema)
   - [5.3 Merge operator ⊕](#53-merge-operator-)
   - [5.4 Tool `loom_state_patch`](#54-tool-loom_state_patch)
   - [5.5 Prompt construction](#55-prompt-construction)
   - [5.6 Executor integration](#56-executor-integration)
   - [5.7 Persistence](#57-persistence)
   - [5.8 Shared State-of-Play read-view](#58-shared-state-of-play-read-view)
   - [5.9 Downstream consumers](#59-downstream-consumers)
   - [5.10 Operational logging](#510-operational-logging-not-a-benchmark-harness)
   - [5.11 Configuration](#511-configuration)
6. [Complexity Analysis](#6-complexity-analysis)
7. [Worked Example](#7-worked-example)
8. [File-by-File Implementation Plan](#8-file-by-file-implementation-plan)
9. [Testing Plan](#9-testing-plan)
10. [Rollout and Compatibility](#10-rollout-and-compatibility)
11. [Appendix A: Exact Artefacts](#appendix-a-exact-artefacts)
12. [Appendix B: Paper Traceability](#appendix-b-paper-traceability)

---

## 1. Goal and Non-Goals

### Goal

Give every Loom deliberator a **bounded, validated, per-agent execution state** `Σⁱ_t` maintained via a **mandatory first-class tool** `loom_state_patch`, following the paper's runtime as closely as an open-ended deliberation system allows — while keeping the full deliberation transcript as the immutable provenance record.

Concretely, after this feature:

- Every primary agent turn produces **two artefacts**: (a) untyped prose contribution (as today), (b) one validated `ΔΣⁱ_t` patch via tool call.
- The next turn's prompt for agent `i` is `Aⁱ_t = (P, Σⁱ_t, O_t)` — immutable spec, own structured state, latest observation — all bounded, independent of total turns `T`.
- Raw reasoning and tool telemetry are **evicted from future prompts** (bounded context) but **retained in DB** for dashboard / synthesis / audit. This is the deliberate deviation from the paper (which discards `R_t` entirely): deliberation's product *is* its trajectory (paper §7 limitation #3), so we evict-from-context without deleting-from-store.
- Prompt footprint per turn is flat; cumulative tokens grow `O(T)` not `O(T²)`; stance flips apply in zero recovery steps; noise is projected once and never re-enters.

### Non-goals

- No replacement of `weave` / `contributions` table / timeline / synthesis transcript.
- No joint multi-agent writes to a single shared `Σ` (paper is single-agent; §7 flags concurrent writes as open — we sidestep by per-agent ownership + deterministic aggregation).
- No change to room composition, model assignment, voting, summoning, forum, or termination semantics.
- No per-turn pre-emption on token budget (existing post-round `maxTotalTokens` check unchanged).
- No change to persona voice, tier doctrine, or prose length contracts.

---

## 2. Background: What SKILL.state Is

Paper runtime (Algorithm 1):

```
Require: P, Σ_0
for t = 0..T:
  1. Receive O_t
  2. Construct prompt (P, Σ_t, O_t)
  3. Generate (R_t, ΔΣ_t, a_t) via LLM
  4. Validate ΔΣ_t
  5. Σ_{t+1} ← Σ_t ⊕ ΔΣ_t
  6. Execute a_t
```

Definitions (paper §3, Eq. 1–4):

| Symbol | Meaning | Loom analogue |
|---|---|---|
| `P` | Immutable procedural specification | Knit question + tags + user context + system rules + tier doctrine. Fixed for the meeting (extension appends, never rewrites). |
| `Σ_t` | Structured execution state at step `t` | **New:** per-agent `Σⁱ_t` (this spec). |
| `O_t` | Latest environment observation | State-of-Play digest + live recent contributions + inline peer answers for this turn. Never full history. |
| `R_t` | Multi-step chain-of-thought | Agent prose + reasoning blocks. Used within-turn, evicted from *future prompts* (kept in DB). |
| `ΔΣ_t` | JSON dict of key mutations/deletions | `loom_state_patch` args. |
| `a_t` | Action string | The prose contribution itself (+ any `loom_*` interaction effects). Loom has no single shell command; the "action" is the contribution + votes/queries/summons issued. |
| `⊕` | Dictionary merge with null-deletion | `applyStatePatch` (§5.3). Keys mapped to null / listed in `remove` are deleted. |

Complexity (paper §3.3, Eq. 5–7):

- Conversational: `|C_t| = O(t)`, cumulative `Σ|C_t| = O(T²)`.
- SKILL.state: `|P_t| = O(|P|+|Σ|+|O|)`, cumulative `Σ|P_t| = O(T)`.

Key empirical claims we are reproducing in spirit: flat prompt (§5.2 Table 1), noise robustness (§5.3 Table 2 — distractors filtered at patch time), zero-step state recovery (§5.4 Table 3), public-benchmark gains from not repeating failed commands (§5.5 Table 4), structure-beats-compression (§5.6 Table 5).

---

## 3. Mapping Paper → Loom

| Paper concept | Loom instantiation | Notes |
|---|---|---|
| Single agent loop | **Per-agent loop** `i ∈ participants`. Each agent owns `Σⁱ_t`. Rounds interleave agents deterministically; within an agent's own subsequence the paper's loop holds exactly. | Sidesteps paper §7 concurrent-write problem: no two agents ever write the same `Σⁱ`. |
| `P` | `question + tags + userContext + system prompt + roster` | Immutable within a meeting. `/knit` extension creates `P' = P + new brief`, bumps `meeting.revision`, carries all `Σⁱ` forward. |
| `Σ_t` | `Σⁱ_t = { stance, established[], contested[], open[], facts[], files[], version, updated_round }` (§5.2) | Bounded (caps below). Fully replaces keyword-derived per-agent view. |
| `O_t` | `SoP digest (shared read-view, ≤2000ch) + live current-round contribs only (≤12, ≤800/1200ch each) + inline peer answers for this turn` | **Faithfulness note:** strict paper `O_t` is latest-observation-only with zero history. Loom needs same-round peer engagement (`[#id]` cites), so this is `Stateful-minus-full-history`: shared digest + current-round live only, never prior rounds, never full weave. Tightened from today's `round >= r-1, ≤20` window (see §5.1). SoP block is sourced from `Σ`-aggregation instead of full-scan keywords. |
| `(R_t, ΔΣ_t, a_t)` | `(prose contribution, loom_state_patch args, deliberation action — see §5.1a)` | `R_t` = prose + thinking blocks. Paper generates all three in **one LLM call** with a `{"state_patch","action"}` fence (App. A.4) and validates `ΔΣ` **before** executing `a_t`. We split into prose + separate `loom_state_patch` tool call (same turn, patch-retry last) and store prose before/adjacent to patching — a deliberate tool-channel adaptation. Ordering deviation is documented in §5.6. |
| Validate + rollback | Tool `execute()` Zod-validation (`.strict()`, caps, non-empty refine); on failure return `error + issues[0..5]`, mutate nothing, executor retries once | Paper §3.2 "deterministic validation & rollback". Provider function-calling schema acts as first-pass grammar constraint (paper §7 future work); Zod is the second pass. |
| Evict `R_t` | Evict from *prompt context*, retain in *store* | Intentional complementary deviation (see §1). Prompt-eviction gives the `O(1)` win; store-retention preserves synthesis/audit. |
| Schema authored once per domain | One static deliberation schema for all meetings (this §5.2) | Paper §3.1 ("authored once per domain rather than per task"; CTF reuses one 5-field schema across 100 tasks). Ours reuses one 6-bucket schema across all knit questions. |

---

## 4. Design Principles

1. **Per-agent ownership.** Agent `i` reads/writes only `Σⁱ`. Nobody else writes it. The orchestrator and peers may *read* it (for SoP aggregation, peer prompts, synthesis). Eliminates write conflicts by construction.
2. **Tool channel only.** No ` ```json ` parsing, no bracket tags, no prose directives. `ΔΣ` arrives exclusively via `loom_state_patch` function-calling channel, exactly like `loom_pass` (`src/plugin/tools/pass.js`) and `loom_query` (`src/plugin/tools/query-evidence.js`). Persona voice cannot corrupt it.
3. **Mandatory every primary turn.** System + user prompt instruct one `loom_state_patch` call per primary contribution turn. Sub-turns (query/evidence/vote/summon targets, clerk summaries, synthesis) never call it.
4. **Validated merge, versioned.** Every patch is Zod-validated, length-capped, deduped, applied via `⊕`, persisted with `version++`. Invalid patches are rejected with a machine-readable error and retried once; persistent state is never corrupted.
5. **Complement provenance.** `weave` remains the append-only truth for humans (dashboard, report, audit). `Σ` is the bounded truth for the *next model call*. The two are linked by `contributionId` / `batchId`.
6. **Flat, small schema.** String arrays only, no nesting beyond one level, tight per-item and per-call caps so weak-model tool calls succeed and prompts stay flat. Provider `tool.schema` + Zod `.strict()` together serve as the paper §7 grammar-constraint mitigation; no separate constrained-decoding step.
7. **Lightweight operational logging only.** Per-turn patch coverage + prompt-size guardrails for debugging; never gating control flow (except the pre-existing `maxTotalTokens` post-round check). No paper-style benchmark harness, statistics, or token-cost comparisons — explicitly out of scope per project decision.
8. **Adaptation over literalism.** Where the paper assumes a single agent acting on ground-truth world state with executable commands, Loom has a quorum deliberating open-ended questions with prose. Every such divergence is labelled `Faithfulness note` with the paper behavior, our behavior, and why.

---

## 5. Detailed Specification

### 5.1 The triple (P, Σⁱ_t, O_t)

**P — Procedural specification (immutable per meeting revision).**

```
P = {
  question: string (≤10000ch, sanitized),
  tags: string[0..8] (≤1000ch total),
  userContext: string (≤5000ch, only if /knit context given),
  rules: system prompt OUTPUT CONTRACT + tool ladder + citation rules,
  roster: [{id, name, tier, status}] (≤12 shown, persona ≤120ch each),
  revision: int (0 at creation, ++ on /knit extension)
}
```

Built once at meeting creation (`knit-handler` + `composeRoomWithSimilarity`), stored on `meetings` row. Extension appends a dated brief to `userContext` and bumps `revision`; `Σⁱ` values are carried forward untouched (this is the zero-step recovery path: new facts arrive as `O`, agent patches `Σⁱ` immediately).

**Σⁱ_t — Per-agent structured execution state (mutable, bounded).**

```ts
type AgentState = {
  stance: string;            // ≤400ch — "where I stand now"
  established: string[];     // ≤8 items, each ≤280ch
  contested: string[];       // ≤8 items, each ≤280ch
  open: string[];            // ≤8 items, each ≤280ch
  facts: string[];           // ≤8 items, each ≤280ch
  files: string[];           // ≤8 items, each ≤160ch, lowercased path snippets
  version: number;           // ++ per applied patch
  updated_round: number;     // last round that mutated it
  updated_contribution_id: number | null;
};
```

Initial `Σⁱ_0` = all arrays empty, `stance = ""`, `version = 0`. Empty sections are omitted from prompts.

**O_t — Latest observation (bounded, latest-only).**

For agent `i` speaking in round `r`:

```
Oⁱ_r = {
  shared_sop_digest: markdown (≤2000ch, §5.8),
  live: current-round contributions only (round == r, excl. vote_response, ≤12 items, each ≤800ch prose / ≤1200ch code, sentence-truncated),
  inline: results of this turn's loom_query/vote/summon already executed server-side (each ≤800ch, total ≤3500ch),
  forum_topics: ≤10 (title ≤100ch),
  steering_hint: ≤1, consumed once by round's first speaker (existing)
}
```

**Faithfulness note:** paper `O_t` is the single latest environment observation — no prior-round history at all. Prior-round context in Loom arrives exclusively via `Σⁱ_r` (own carried state) + `shared_sop_digest` (quorum-aggregated state), never via raw contribution replay. This tightens today's `round >= r-1, ≤20` window down to current-round-only. The one retained history slice is same-round live contribs, required so agents can engage `[#id]`s published minutes earlier in the same round; everything older must have been projected into `Σ` or it is gone from context (still in DB for audit/synthesis). Recall (vector-RAG prior context) is **removed** from the agent user prompt under this spec — it is subsumed by `Σ + digest`; keep the `loom_vector_search` tool for on-demand recall instead of auto-injection.

**Prompt invariant:** `Aⁱ_r = (P, Σⁱ_r, Oⁱ_r)`. No previous `O`, no previous `R`, no full `weave`, no prior-round replay ever enters the model context. Second-pass (same-turn synthesis / patch-retry) reuses the same ephemeral session with `Aⁱ_r + inline outputs`, still bounded.

### 5.1a Deliberation action `a_t` and validity (paper App. B analogue)

**Faithfulness note:** paper actions are executable, environment-validated commands (`Ship item_12 shelf_42`, `Merge(pr_id)`) with deterministic transition rules and a ground-truth score (`Successful / Total Actionable`). Loom has no shell/DB transition per turn; the action is the deliberation move itself.

Definitions for this spec:

```
aⁱ_r = {
  contribution: prose (120-180 words, existing OUTPUT CONTRACT),
  interactions: loom_query/vote/summon/request_next/pass effects issued this turn,
  patch_ref: Σⁱ version produced this turn (linkage, not content)
}
```

**Validity** (checked deterministically at store time, never by a second LLM):

- `valid_prose`: non-empty after sanitize, 3–20000ch (existing `parseAgentResponseRaw` floor).
- `valid_patch`: exactly one applied `loom_state_patch` per primary turn (pass turns exempt).
- `grounded`: every `facts_add` item must contain `Source:` or `[#id]`; otherwise rejected with `ungrounded_fact` (non-fatal: patch applies, item quarantined to `open` with `(unverified)` prefix — mirrors paper's "local error observation, reject transition" without losing the turn).
- `non_repetitive`: adds deduped case-insensitively against own `Σⁱ` (existing); cross-agent repetition is allowed (agreement signal for the aggregator's holder-count rank).

There is deliberately **no correctness score** — deliberation quality is judged by the existing synthesizer + human report, not a ground-truth simulator. The runtime guarantees *well-formed, grounded, non-duplicative* actions, not *right* ones.

---

### 5.2 Schema

Single canonical schema used by Zod validation, `tool.schema` declaration, DB storage, and prompt rendering. Field names deliberately mirror paper + deliberation vocabulary (`established/contested` map to paper's "state that survives"; they render as Agreements/Disagreements in markdown).

**Zod schema** (new export in `src/schemas.js`):

```js
export const StatePatchSchema = z.object({
  stance: z.string().min(1).max(400).optional(),
  established_add: z.array(z.string().min(1).max(280)).max(3).default([]),
  contested_add: z.array(z.string().min(1).max(280)).max(3).default([]),
  open_add: z.array(z.string().min(1).max(280)).max(3).default([]),
  facts_add: z.array(z.string().min(1).max(280)).max(3).default([]),
  files_add: z.array(z.string().min(1).max(160)).max(3).default([]),
  remove: z.array(z.string().min(1).max(280)).max(5).default([]),
}).strict().refine(
  (p) => (p.stance !== undefined) || p.established_add.length || p.contested_add.length ||
          p.open_add.length || p.facts_add.length || p.files_add.length || p.remove.length,
  { message: "empty patch — at least one field must be set" }
);
```

**Tool args** mirror this 1:1 with `tool.schema` builders + `.describe()` strings (see §5.4). At least one field required; all-empty call is rejected as `empty_patch` (counts as a miss, triggers retry).

**Normalization before merge** (deterministic, in runtime, not model):

- Trim, collapse internal whitespace (`\s+ → single space`), strip leading bullets/numbers/`[#id]` prefixes for match purposes only (display text preserved as written for adds).
- `files_add`: lowercase, strip trailing `[,).]]`, keep `src/...` or `file=` basename chop to ≤80ch for snippet (same as `state-of-play.js:64-68`).
- Drop adds that are empty after normalization or duplicates (case-insensitive) of existing items.
- `remove` matches case-insensitively against all four text buckets + `stance` (exact normalized equality). No fuzzy matching — if it doesn't match exactly, it's reported as `unmatched` (non-fatal, other ops still apply).

**Caps enforcement with late-relevance guard (paper §7 failure mode #2):** each text bucket holds ≤8 items. `facts` items containing `Source:` or `[#id]` are **pinned** (never FIFO-evicted; only explicit `remove` deletes them) — tool-backed evidence is exactly the content whose relevance is most often recognized late. The remaining buckets evict oldest-first (FIFO); evictions are reported in the tool result (`evicted: [...]`) so the model sees what fell off. Additionally the two newest items per bucket are **reserve-protected**: FIFO eviction skips them unless the bucket is over cap by ≥2, preventing a single 3-add call from churning just-written context. `remove` continues to require exact normalized match; paraphrase renames are handled as add-new + remove-old in the same call (both reported), never fuzzy-matched — deterministic, no embedding threshold to tune.

---

### 5.3 Merge operator ⊕

Paper Eq. 4: `Σ_{t+1} = Σ_t ⊕ ΔΣ_t` with null-deletion semantics. Our typed equivalent:

```js
// src/state-patch.js (new)
export function applyStatePatch(prev, patch) {
  // prev: AgentState, patch: validated StatePatchSchema output
  // returns { next, applied, unmatched, evicted }
  const norm = (s) => s.trim().replace(/\s+/g, " ");
  const key = (s) => norm(s).toLowerCase();
  const next = {
    ...prev,
    established: [...prev.established],
    contested: [...prev.contested],
    open: [...prev.open],
    facts: [...prev.facts],
    files: [...prev.files],
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
    if (prev.stance && removeKeys.has(key(prev.stance))) {
      next.stance = "";
      applied.removed.push("stance");
    }
    // report removes that matched nothing
    for (const r of patch.remove ?? []) {
      const k = key(r);
      const matched =
        ["established","contested","open","facts","files"].some((b) => prev[b].some((it) => key(it) === k)) ||
        (prev.stance && key(prev.stance) === k);
      if (!matched) unmatched.push(r.slice(0, 120));
    }
  }

  // 2. Stance overwrite (paper's key mutation; empty string clears)
  if (patch.stance !== undefined) {
    next.stance = norm(patch.stance).slice(0, 400);
    applied.stance = true;
  }

  // 3. Adds with dedup + FIFO cap 8, pinned facts + reserve protection (§5.2)
  const isPinned = (bucket, item) =>
    bucket === "facts" && /(source:|#\d+)/i.test(item);
  const addTo = (bucket, items, cap = 8, limit = bucket === "files" ? 160 : 280) => {
    applied.added[bucket] = [];
    const seen = new Set(next[bucket].map(key));
    for (const raw of items ?? []) {
      const item = norm(raw).slice(0, limit);
      if (!item || seen.has(key(item))) continue;
      // cross-bucket move: if same text lives in a sibling bucket, remove it there first
      // (keeps established/contested disjoint without model bookkeeping;
      //  never auto-moves a pinned fact out — explicit remove required)
      if (bucket !== "files") {
        for (const sib of ["established","contested","open","facts"]) {
          if (sib === bucket) continue;
          const idx = next[sib].findIndex((it) => key(it) === key(item));
          if (idx >= 0) {
            if (isPinned(sib, next[sib][idx]) && sib === "facts") continue;
            next[sib].splice(idx, 1); applied.removed.push(`${sib}→${bucket}`);
          }
        }
      }
      // ungrounded fact quarantine (§5.1a): facts without Source/[#id] land in open as unverified
      if (bucket === "facts" && !isPinned(bucket, item)) {
        const q = item.endsWith("(unverified)") ? item : `${item} (unverified)`;
        if (!seen.has(key(q)) && !next.open.some((it) => key(it) === key(q))) {
          next.open.push(q); applied.added.open = [...(applied.added.open ?? []), q];
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
        (it, idx) => !isPinned(bucket, it) && idx < next[bucket].length - 2
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

  next.version = prev.version + 1;
  return { next, applied, unmatched, evicted: applied.evicted };
}
```

Properties: pure function (no I/O), deterministic, total (never throws on validated input), idempotent re-application of the same `remove` is a no-op reporting `unmatched`, overwrite-only-own-slice (caller guarantees ownership).

**Faithfulness note:** paper `⊕` is a recursive JSON merge with null-deletion over nested dicts (JS reference `mergeWithNullDelete`). Ours is the typed flat-array equivalent: `remove[]` plays the role of null-keys, `*_add` plays key-mutation, FIFO + pinning plays bounded-state retention (paper leaves retention unbounded — buckets grow with distinct keys; deliberation needs the cap or `|Σ|` drifts). Cross-bucket moves and `unmatched`/`evicted` echoes have no paper counterpart; they exist so a stance flip (`contested → established`) costs one call instead of two and the model always sees what survived. The `updated_*` metadata fields are never patchable via tool args (set by runtime), preserving paper's "schema ownership in deterministic runtime" (§7).

---

### 5.4 Tool `loom_state_patch`

**File:** `src/plugin/tools/state-patch.js` (new), following `src/plugin/tools/pass.js:1-25` and `src/plugin/tools/query-evidence.js:25-48` patterns.

```js
import { tool } from "@opencode-ai/plugin";

export function createStatePatchTool({ config, resolveMeeting, activeLooms }) {
  return {
    loom_state_patch: tool({
      description:
        "Project what should survive to the next round. Call ONCE per turn with your stance " +
        "and any new established/contested/open/facts/files bullets (1-3 each), plus exact-text " +
        "`remove` entries for your own outdated bullets. Prose alone does not carry forward — " +
        "only what you patch here appears in your future State. At least one field required.",
      args: {
        stance: tool.schema.string().min(1).max(400).optional()
          .describe("Where you stand now in one sentence (overwrites previous stance)"),
        established_add: tool.schema.array(tool.schema.string().min(1).max(280)).max(3).optional()
          .describe("Points you consider settled (up to 3, each ≤280 chars)"),
        contested_add: tool.schema.array(tool.schema.string().min(1).max(280)).max(3).optional()
          .describe("Points still disputed (up to 3)"),
        open_add: tool.schema.array(tool.schema.string().min(1).max(280)).max(3).optional()
          .describe("Unresolved questions (up to 3)"),
        facts_add: tool.schema.array(tool.schema.string().min(1).max(280)).max(3).optional()
          .describe("Tool-backed or cited facts with Source/[#id] (up to 3)"),
        files_add: tool.schema.array(tool.schema.string().min(1).max(160)).max(3).optional()
          .describe("File paths touched (up to 3, e.g. src/auth/jwt.ts)"),
        remove: tool.schema.array(tool.schema.string().min(1).max(280)).max(5).optional()
          .describe("Exact text of YOUR outdated bullets to delete (up to 5)"),
      },
      async execute(args, context) {
        const cfg = config.getValue("agentTools");
        if (!cfg?.enabled || !cfg?.loom?.loom_state_patch)
          return { output: JSON.stringify({ error: "loom_state_patch not enabled" }), metadata: { error: true }, title: "loom_state_patch error" };
        if (!context?.sessionID)
          return { output: JSON.stringify({ error: "session context unavailable" }), metadata: { error: true }, title: "loom_state_patch error" };
        try {
          const meetingInfo = await resolveMeeting(context.sessionID);
          if (!meetingInfo)
            return { output: JSON.stringify({ error: "meeting not resolved", queued: false }), metadata: { error: true }, title: "loom_state_patch error" };
          const engine = activeLooms.get(meetingInfo.meetingId);
          const sm = engine?.getStateManager?.();
          const db = engine?.getDatabase?.();
          if (!sm || !db)
            return { output: JSON.stringify({ error: "state not ready" }), metadata: { error: true }, title: "loom_state_patch error" };

          // Resolve caller (same helper as query-evidence.js: resolveCaller)
          const { resolveCaller } = await import("./shared.js");
          const caller = resolveCaller(sm.getParticipants(), sm.getWeave?.() ?? [], context.sessionID);
          if (!caller?.config?.id)
            return { output: JSON.stringify({ error: "caller identity unavailable" }), metadata: { error: true }, title: "loom_state_patch error" };

          // Validate via Zod (same StatePatchSchema as §5.2)
          const { StatePatchSchema } = await import("../../schemas.js");
          const parsed = StatePatchSchema.safeParse({
            stance: args.stance, established_add: args.established_add ?? [],
            contested_add: args.contested_add ?? [], open_add: args.open_add ?? [],
            facts_add: args.facts_add ?? [], files_add: args.files_add ?? [],
            remove: args.remove ?? [],
          });
          if (!parsed.success)
            return { output: JSON.stringify({ error: "invalid patch", issues: parsed.error.issues.slice(0, 5) }), metadata: { error: true, validationFailed: true }, title: "loom_state_patch error" };

          const { applyStatePatch } = await import("../../state-patch.js");
          const prev = sm.getParticipantState(caller.config.id); // §5.7 API
          const { next, applied, unmatched, evicted } = applyStatePatch(prev, parsed.data);
          next.updated_round = sm.getCurrentRound?.() ?? 0;
          // updated_contribution_id filled by executor post-store (§5.6); set provisional here
          sm.setParticipantState(caller.config.id, next);
          try { db.setParticipantState(caller.config.id, next); } catch {}
          try {
            const { auditLoomTool } = await import("./audit.js");
            auditLoomTool({ db, stateManager: sm, caller, meetingId: meetingInfo.meetingId,
              tool: "loom_state_patch", input: args,
              output: JSON.stringify({ applied: true, version: next.version, appliedCounts: applied }),
              status: "completed", title: `loom_state_patch:v${next.version}` });
          } catch {}

          return {
            output: JSON.stringify({ applied: true, version: next.version, added: applied.added,
              removed: applied.removed, unmatched: unmatched.slice(0, 5), evicted,
              note: "Patch applied to YOUR state only. Shared State of Play aggregates all agents." }),
            metadata: { applied: true, version: next.version },
            title: `loom_state_patch:v${next.version}`,
          };
        } catch (e) {
          return { output: JSON.stringify({ error: `loom_state_patch failed: ${e.message}` }), metadata: { error: true }, title: "loom_state_patch error" };
        }
      },
    }),
  };
}
```

**Semantics:**

- Fire-and-apply (like `loom_request_next`): result is an acknowledgement + echo of what applied, returned inline in the same turn for citation if desired. No peer fan-out (unlike `loom_query`).
- Ownership enforced: tool resolves caller from session; patch applies only to caller's `Σⁱ`. No `target` param exists by design.
- Validation failures return `error + issues[0..5]`, mutate nothing (paper's rollback). Executor treats as miss → single retry.
- Empty patch (`{}`) rejected as `empty_patch` via Zod refine.
- Idempotent: duplicate `remove` → `unmatched` (non-fatal); duplicate adds deduped silently.
- Audit row written via existing `auditLoomTool` so Tool-use tab + DB `tool_calls` show patches even if `ToolPart` extraction misses them (same rationale as `query-evidence.js:237-238`).

---

### 5.5 Prompt construction

**System prompt** (`src/prompts/agent.js:48-57`, `buildAgentSystemPrompt`): append one bullet to the OUTPUT CONTRACT interaction section (after `loom_pass` line at ~line 123) and one line to the tool ladder:

```
- **loom_state_patch**: call ONCE per turn to project what survives — your stance + 1-3 bullets.
  Prose alone does not carry forward. Only patched state appears in your future State block.
```

Tool list line: add `loom_state_patch` to the `tools.push(...)` roster and the `Available:` line. Cache key already includes `agentTools` digest (`agent.js:38`), so enabling the tool busts `systemPromptCache` correctly — no extra work.

**User prompt** (`src/prompts/agent.js:236-336`, `buildAgentUserPrompt`): insert a new delimited block between State of Play and Live, and **remove auto-injected Recall**:

```
## Your State — CARRIED FORWARD (you wrote this via loom_state_patch; update it this turn)

<<<LOOM_MY_STATE>>>_BEGIN_
Stance: Short-lived JWTs with server-side refresh rotation.
Established:
- phased migration Q1-Q2 starting with auth service
Contested:
- client-side refresh storage theft risk
Open:
- session handover downtime budget?
Facts:
- 12-15% YoY growth (Source: https://… [#7])
Files:
- src/auth/jwt.ts
<<<LOOM_MY_STATE>>>_END_
```

- Empty state renders as `(empty — patch it this turn)` so round-1 agents see the affordance.
- Full `Σⁱ` JSON is never shown; only the rendered markdown. Worst-case block size: `400 + 5×8×280 + 8×160 ≈ 13k` chars; typical (2-4 bullets) < 1.5k. Still `O(1)`.
- **Recall removal:** the `## Recall — Vector-Retrieved Prior Context` block is deleted from the auto-prompt (its content is subsumed by `Σ + digest`). The `loom_vector_search` tool remains for on-demand recall; nothing else changes. This is what makes the prompt strictly `(P, Σ, O_latest)` instead of Stateful-style state-plus-history.
- Add to **Your Turn — Weighted Guidance**:
  ```
  - **Your State is yours to maintain** — call loom_state_patch once per turn. Stale bullets you don't remove stay. Pinned facts (with Source/[#id]) are never auto-evicted.
  - **State of Play is shared truth** unless you challenge it with [#id] + Source/tool output.
  - **Live is current round only** — anything older you still need must already be in Your State; if it isn't, re-establish it from the digest (don't quote full old prose).
  ```
- `delimitContext` wrapping for the new block (same as SoP) to preserve injection boundaries.

**Token budgets** (unchanged, restated): per-contrib `800/1200ch` (`agent.js:242-245`), roster `12×120ch`, forum `10×100ch`, question `10k`, userContext `5k`, inline synthesis `12k/3.5k` (`execute-turn.js:154-189`). New block adds ≤13k worst-case, ~1-2k typical; Recall removal saves ~1-3k — per-turn prompt stays ~30-55k chars, flat in `T`.

---

### 5.6 Executor integration

**Turn flow** (`src/round-executor/agent/prompt-session.js:109-120` → `execute-turn.js`):

1. `prompt-session.js`: fetch `myState = stateManager.getParticipantState(participant.config.id)` alongside `recentForPrompt` — now `weave.filter(c.round === currentRound && c.type !== "vote_response").slice(-12)` (tightened from `round >= cur-1, ≤20`), `forumTopics`, `otherParticipants`. Pass into `buildAgentUserPrompt` as new param. Include `loom_state_patch: true` in `toolsMap` when `agentTools.enabled && agentTools.loom.loom_state_patch` (mirror `tools.js:21` `loom_pass` line). **Ordering note (paper deviation):** paper validates `ΔΣ` before executing `a_t` in a single model call; we execute prose + inline peer tools first, then apply the state patch in the same turn (tool result lands before the turn closes, patch-retry last). Validation still gates the *state transition* (invalid patch mutates nothing), just not the prose store — prose is never rolled back, only state is. This is the price of the tool-channel adaptation and is safe because `Σ` (not prose) is the next turn's source of truth.
2. `execute-turn.js` (after existing `loomPassCall` at `:152`): scan `effective1` tool results for `loom_state_patch` with `metadata.applied === true`. Record `{ version }`.
3. **Mandatory retry (one shot):** if no applied patch and turn was not a `loom_pass`/`failed` and produced text:
   - Send a second prompt **on the same ephemeral session** (same pattern as same-turn synthesis `:170-189`): the within-step reasoning from the primary pass is still in-session (paper §3.2: multi-step reasoning stays intact during generation), tools = full map (patch must be available), instruction:
     ```
     Your contribution is recorded. Now call loom_state_patch ONCE to project what should
     survive: your current stance (1 sentence) + 1-3 bullets across established/contested/
     open/facts/files (facts need Source: or [#id], optionally with Strength: strong/weak) +
     exact-text remove entries for outdated bullets. At least one field.
     No prose needed beyond the call.
     ```
   - On validation-failure retry, append the Zod `issues[0..5]` text to the instruction so the retry does not repeat identical args blindly.
   - If retry applies a patch, attach its `version` to the contribution's `tool_calls` (already persisted via `mapToolResults`); if it fails/empty, log `state_patch_missed` and continue (never fail the turn — prose is preserved, state simply stays at its prior version).
   - **Telemetry rule (paper App. C analogue):** raw `bash`/`webfetch`/`grep` dumps are never patch-eligible verbatim. Only `Finding + Source (+ Strength)`-shaped lines may enter `facts_add` (Strength convention: `Strength: strong|weak` prefix when the evidence tool reported one; carried through pins verbatim). Everything else belongs in prose or not at all — the patch step is the noise filter.
4. **Post-store link:** after contribution persisted with its `id`, call `stateManager.linkStateToContribution(participantId, contributionId)` → sets `Σⁱ.updated_contribution_id`. Best-effort; missing link never blocks.
5. **Pass turns:** `loom_pass` turns skip the retry (passing means "nothing new" — state correctly unchanged). Tool-evidence stub turns (`tool_only_turn`) still get the retry if no patch (evidence should be projected to `facts_add`).
6. **Same-turn synthesis interaction:** if `sameTurnSynthesis` fires (loom_query/vote/summon succeeded), the synthesis pass runs first (existing), then the patch-retry runs last on the final text — so cited `[#id]`s from inline answers can enter `facts_add`. Order: `primary → synthesis → patch`. All on the same round-scoped session (`execute-turn.js:19-26` reuse).
7. **Logging:** `state_patch_applied {participant, version, addedCounts, evictedCount}`, `state_patch_missed {participant, reason}`, `state_patch_retry {participant, ok}`. Never log full state at INFO (size); DEBUG may include it.

**What does NOT change:** circuit breaker / fallback-model ladder, timeout (`agentTimeoutMs` 240s), `maxToolCallsPerTurn`/`maxToolOutputTokens` warn-only behavior, `resolveCaller`/`batchId` grouping, `request_next` extraction.

---

### 5.7 Persistence

**In-memory** (`src/services/state-manager.js`):

```js
// new map alongside participants/weave
this.participantStates = new Map(); // id -> AgentState

getParticipantState(id) // returns clone; lazily initializes Σ_0
setParticipantState(id, next) // stores clone; emits statepatched event for dashboard live-update
linkStateToContribution(id, contributionId)
getAllParticipantStates() // for SoP aggregation + synthesis
```

`buildSharedState` includes a **summary** (counts + versions, not full bullets) to avoid inflating the `structuredClone` per-round cost noted in exploration. Full states persist via DB, not via shared-state clone.

**Database** (fresh-slate, bump `LATEST_SCHEMA_VERSION` in `src/database/schema.js:10`, e.g. 2→3):

```sql
-- participants gains one TEXT column (JSON AgentState); existing rows backfill Σ_0
ALTER TABLE participants ADD COLUMN state_json TEXT NOT NULL DEFAULT '{"stance":"","established":[],"contested":[],"open":[],"facts":[],"files":[],"version":0,"updated_round":0,"updated_contribution_id":null}';

-- audit table for patches (append-only, complements contributions)
CREATE TABLE IF NOT EXISTS state_patches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  contribution_id INTEGER,
  version INTEGER NOT NULL,
  patch_json TEXT NOT NULL,   -- the validated ΔΣ
  applied_json TEXT NOT NULL, -- {added, removed, evicted, unmatched}
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(meeting_id, participant_id, version)
);
```

Helpers in `src/database/*`: `setParticipantState(id, state)`, `getParticipantState(id)`, `addStatePatch(row)`, `listStatePatches(meetingId, participantId?)`. All wrapped in existing `degrade()` best-effort pattern where appropriate (state lost in crash rebuilds from weave via fallback below — never fatal).

**Resume/extension:** states load with the meeting (`session-index.js` restore path). `/knit` extension keeps all `Σⁱ`, bumps `meetings.revision`, appends extension brief to `P.userContext`. Agents see new `O` next turn and patch immediately — the paper's zero-step recovery.

**Fallback reconciliation:** if `Σⁱ` missing/corrupt (old DB, manual delete), rebuild a seed from the legacy `updateStateOfPlay` keyword scan filtered to that participant's contributions, mark `version: 0, rebuilt: true`. Deterministic, runs once.

**Single source of truth for stance.** `Σⁱ.stance` **is** the agent's reflection. Legacy `participants.reflection` / `reflectionHistory` (last-5, written by `perspective`-mode queries) is kept for backward compatibility but is no longer a second authority:
- `perspective`-mode answer writes `reflection` (existing) **and** marks the responder `state_dirty=true`; the responder's next mandatory `loom_state_patch` picks the new position up as `stance` (one-turn lag max, no extra LLM call).
- Peer prompts render one line only: `Your position (from your state vN): "<stance or reflection fallback>"` — never both side by side.
- Skip-passed logic and synthesis read `stance` first, `reflection` only when `stance` is empty (meeting start / flag-off / old DB).
- Dashboard participant card shows `stance@vN`; `reflectionHistory` remains visible in the audit trail but is not injected into prompts.

**Versioning rule (paper Algorithm 1 steps 4–6).** `version++` happens **only** on successfully applied patches. Failed Zod validation, empty patches, and misses leave `version` unchanged, mutate nothing, and write no `state_patches` row (paper's rollback). Prose is never rolled back — only state is. A repeatedly-invalid patcher still contributes prose every turn and only logs `state_patch_missed`.

**Negative recovery (paper Tables 3/10: Canceled Order / PR Closed — all runtimes correctly fail).** When an external change invalidates state instead of updating it (file deleted out-of-band, question retracted, summoned guest removed, claim disproven by tool output), the expected behavior is explicit removal, not silent persistence: agent `remove`s the dead bullet(s) and adds one `open` bullet (`"<X> no longer exists — repropose?"`). Hallucinating defense of removed state is treated as a correctness bug, not a merge edge.

**Lifecycle edges.**
- `loom_summon` guest: starts at `Σ_0` empty, sees the current aggregated digest as `O` on its first turn (bootstrap, no backfill of prior rounds).
- `passed`/`failed` participants: state frozen at last applied version. No patch-retry, no clerk backfill, no `state_dirty` propagation. Passing means "nothing new" so frozen state is correct; failed means the turn never completed.
- Flag toggled mid-meeting (`loom_state_patch` off → on or reverse): meeting continues without interruption. Off→on starts every agent at `Σ_0` + digest bootstrap; on→off falls back to legacy keyword SoP with `rebuilt:true` logged once. No migration, no rewrite of existing rows.
- Meeting timeout / cancel / token-budget stop with partial-round patches: applied patches persist as-is; synthesis uses final versions with no reconciliation pass. `state_patches` rows cascade-delete with the meeting (`ON DELETE CASCADE`).

---

### 5.8 Shared State-of-Play read-view

`updateStateOfPlay(weave, question, tags)` (`src/state-of-play.js:43-93`) is **kept as fallback**, but the primary path becomes **aggregation**:

```js
// src/state-of-play.js — new primary
export function aggregateStateOfPlay(allStates, question, tags) {
  // allStates: AgentState[] (one per participant)
  // For each bucket: collect bullets with holder attribution, dedupe case-insensitively,
  // rank by (holders desc, recency desc), take top 8 per bucket, each ≤500ch (existing format caps).
  // Stances: list each holder's 1-line stance under Key Facts as "**Name (tier) stance**: …" (≤400ch).
  // Files: union, dedupe, last 8.
  // Render via existing formatStateOfPlay() — output shape UNCHANGED for downstream prompts.
}
```

- Output markdown shape identical to today (`## Decisions & Proposals / Agreements / Disagreements & Concerns / Open Questions / Key Facts / Files Involved`), so every consumer (`agent.js`, `interaction-prompts.js`, `turn-order.js`, synthesis) works untouched.
- Attribution: bullets carry holder count; synthesis `Contested` holders stay explicit (existing clerk prompt requires it).
- Tie-breaks deterministic (holders → `updated_round` → participant id) so dashboards are stable across reloads.
- If all states empty (meeting start / flag off), fall back to legacy `updateStateOfPlay(weave)` — zero behavior cliff.

Per-turn cost drops from `O(T)` full-weave scan to `O(P × buckets)` (`P` = participants ≤7, buckets ≤8×5) — the paper's flat-footprint win applied to the orchestrator path.

---

### 5.9 Downstream consumers

- **Peer prompts** (`src/prompts/interaction-prompts.js`, `blocks.js`): replace `Your current position: <reflection>` with `Your position (from your state vN): "<stance>"` (fallback to `reflection` only when `stance` empty), plus `Your top bullets (≤4, ≤600ch total)` using the existing SoP cap pattern (`:26,106,161-162`). One position line, never two. No new queries.
- **Turn order** (`src/prompts/turn-order.js`, `moderation.js`): unchanged inputs (`SoP 2000ch`, summary 1000ch). Benefits automatically from cleaner aggregated SoP. Skip-passed active-check reads `stance` first (`passed` + empty stance + no recent patch = skippable; carrying a stance keeps the agent active — same rule as reflection today).
- **Round summary** (`round-summarizer.js`): unchanged prompt; add `Σ versions` line to `Evidence/Tool Signals` hint when patches exist (e.g. `state: senior@v3, mid@v2`). No new LLM call.
- **Synthesis** (`src/prompts/synthesis.js`, `artifact-operations.js`, `synthesis-coordinator.js`): transcript logic untouched (digest + last-full + 24k cap). Append `### Agent States (final)` block from `getAllParticipantStates()` (stances + top bullets, ≤4k chars) before `Final Reflections`. **Grounding rule:** synthesizer must cite weave `[#id]` (and `Source:`/`file=` where present) for every contested claim; the Agent States block is positions-only, never evidence. State bullets without a `[#id]` trail are reported as unattributed positions, not findings. Clerk + critique passes unchanged; snippet/draft caps (`12k`, `8k`) unchanged.
- **Dashboard**: participant cards show `stance + version` (from existing reflection indicator slot); new `State` tab or Timeline filter renders per-agent buckets + `state_patches` audit trail. Live-update via `statepatched` event on the existing websocket channel. Markdown export appends `## Agent States` section.
- **Forum**: untouched (`listTopicsForPrompt(10)` bound already).

---

### 5.10 Operational logging (not a benchmark harness)

Explicit non-goal: no paper-style evaluation (no Tables 1–11 reproduction, no seeds/statistics/token-cost comparisons). Logging exists so developers can see the feature working, nothing more. None of it gates control flow:

Per turn (DEBUG only): `patch_applied` (bool), `patch_version`, `added/removed/evicted/unmatched` counts, `ungrounded_quarantined` count. `prompt_chars`/`state_bytes` logged at DEBUG for prompt-construction debugging only.

Per meeting (dashboard Overview tooltip, not report footer): `state_patch_coverage` (% primary turns with applied patch). No averages, no cumulative token totals, no SoP-size curves.

Functional smoke checks (manual, during development — not a harness, no infra):
- Fixed 2-agent fixture roster + one scripted peer injection (e.g. mid-meeting file edit); confirm the affected agent's next `stance` reflects it within one turn (paper Table 3 behavior, eyeballed once).
- One noisy-tool-output turn (large `bash`/`webfetch` dump); confirm only the projected `facts_add` survives into the next prompt's state block.
- No measurements are recorded or compared across runs.

---

### 5.11 Configuration

```js
// src/config/defaults.js — additions
agentTools: {
  enabled: true,
  loom: {
    // ... existing
    loom_state_patch: true,   // new; gated like loom_pass
  },
  sameTurnSynthesis: true,    // unchanged; patch-retry runs after it
  patchRetry: true,           // new; one clerk retry when mandatory call missed
},
tuning: {
  STATE_PATCH: {
    buckets: 8, stanceMax: 400, bulletMax: 280, fileMax: 160,
    addsPerCall: 3, removesPerCall: 5,
  },
}
```

Schema entries in `CONFIG_SCHEMA`: `'agentTools.loom.loom_state_patch': { type: 'boolean' }`, `'agentTools.patchRetry': { type: 'boolean' }`. `LOOM_AGENT_TOOLS_LOOM_LOOM_STATE_PATCH` env override works via existing scalar-env mechanism. Invalid values fall back with startup warning (existing behavior).

`systemPromptCache` key already includes `agentTools` digest (`agent.js:38`) — no change needed.

---

## 6. Complexity Analysis

Let `R` = rounds, `N` = participants (≤7), `T` = total primary turns (`T ≈ R×N`).

| Path | Today | With this spec |
|---|---|---|
| Agent prompt size | `O(20×1k + SoP_scan + Q + ctx)` — bounded in practice, but SoP derived from `O(T)` scan | `O(\|P\| + \|Σⁱ\| + \|O\|)` — bounded by construction; `\|Σⁱ\| ≤ ~13k`, typical ~1–2k. Strict paper Eq. 6. |
| Cumulative prompt | `O(T)` with a large constant (re-scans + clones) | `O(T)` with small flat constant (paper Eq. 7). No history re-sent. |
| SoP derivation per round | `O(T)` full-weave scan + keyword classify | `O(N × buckets)` aggregation; full scan only as cold-start fallback. |
| State persistence per round | `structuredClone(weave)` `O(T)` → `O(T²)` total | States persisted per-patch `O(\|Σⁱ\|)`; shared-state clone carries counts only. |
| Prompt_context storage | Full system+user+SoP+recent per row → `O(T × prompt)` | Unchanged shape (audit needs it), but SoP block inside it is now flat; future optimization: store SoP hash + version pointer (not in scope). |
| Recovery after external change | Multi-turn lag (stale weave dominates) | 0–1 turns: new `O` → immediate `ΔΣⁱ` overwrite (paper Table 3 behavior). Unrecoverable drift → explicit remove + `open` bullet (§5.7), never silent persistence. |

**Deliberate residuals (kept for provenance/audit, explicitly out of the `O(1)` claim).** The bounded-prompt guarantee covers agent turns only. These paths still grow with history and are unchanged by this spec: orchestrator persistent session (`O(R)` reuse for summary/turn-order), `summarizeRound` full-round formatting, synthesis transcript/digest caps, per-row `prompt_context` retention, `structuredClone(weave)` per-round persistence, skip-passed contribution lookback, forum topic listing. They are audit/provenance costs, not next-turn reasoning costs, and none feed the agent prompt window.

---

## 7. Worked Example

Question `P`: "Should we migrate auth to JWT?"

**Round 1 — Architect (Σ⁰ = empty):**
- Sees `P + (empty state) + O(empty SoP, no live)`. Writes prose proposing phased migration + calls:
  `loom_state_patch({ stance: "Phased JWT migration Q1-Q2, short-lived access + rotating refresh.", established_add: ["phased migration starting with auth service"], open_add: ["session handover downtime budget?"] })`
- Result: `Σ^arch_1 = {stance, established:[1], open:[1], version:1}`. Weave gets prose contribution (with `[#id]`).

**Round 1 — Security (Σ⁰ = empty):**
- Sees `P + (empty own state) + O(SoP digest: {phased…}, live: [#arch])`. Writes challenge re theft risk + calls:
  `loom_state_patch({ stance: "Short-lived JWTs OK only with server-side refresh rotation.", contested_add: ["client-side refresh storage theft risk"], facts_add: ["Refresh tokens client-side recoverable by design [#arch]"] })`
- `Σ^sec_1 = {… version:1}`. Shared read-view now shows `Established: phased… (arch) / Contested: theft risk (sec) / Open: downtime?`.

**Round 2 — Architect:**
- Sees `P + Σ^arch_1 (own stance+bullets) + O(updated digest + live [#sec])`. Concedes point, calls:
  `loom_state_patch({ stance: "Phased JWT with server-side refresh rotation.", established_add: ["server-side refresh rotation required"], remove: [] })`
- No re-read of full round-1 prose needed; convergence visible in versions (`arch@v2`, `sec@v1`). Synthesis later cites weave `[#id]`s for proof, states block for positions.

**Wire trace (one turn, exact shapes):**

```json
// tool input (function-calling channel, never prose)
{"stance": "Short-lived JWTs OK only with server-side refresh rotation.",
 "contested_add": ["client-side refresh storage theft risk"],
 "facts_add": ["Refresh tokens client-side recoverable by design [#4] (Strength: strong)"]}

// tool result (inline, same turn)
{"applied": true, "version": 2,
 "added": {"contested": ["client-side refresh storage theft risk"],
           "facts": ["Refresh tokens client-side recoverable by design [#4] (Strength: strong)"]},
 "removed": [], "unmatched": [], "evicted": [],
 "note": "Patch applied to YOUR state only. Shared State of Play aggregates all agents."}

// state diff (persisted)
{"version": "1 → 2", "updated_round": 2,
 "stance": "…rotation.",
 "+contested": ["client-side refresh storage theft risk"],
 "+facts[pinned]": ["Refresh tokens client-side recoverable by design [#4] (Strength: strong)"]}
```

**Security note (Loom-specific, no paper counterpart).** `MY_STATE` renders only from runtime-validated `Σⁱ`, never from model prose; delimiter blocks (`<<<LOOM_*>>>`) around it preserve the existing injection boundary. The tool cannot address another agent's buckets, cannot set `version` / `updated_round` / `updated_contribution_id` (runtime-owned, §5.3), and cannot exceed per-field caps to bloat prompts — oversized input is rejected before merge.

---

## 8. File-by-File Implementation Plan

| # | File | Change | Est. |
|---|---|---|---|
| 1 | `src/schemas.js` | Add `StatePatchSchema` (§5.2) + export. | S |
| 2 | `src/state-patch.js` | **New.** `applyStatePatch`, `emptyAgentState()`, `renderMyStateMarkdown`, `aggregateStateOfPlay`. Pure functions + unit tests. | M |
| 3 | `src/plugin/tools/state-patch.js` | **New.** `createStatePatchTool` (§5.4). | M |
| 4 | `src/plugin/tools.js` (or aggregator) | Register `createStatePatchTool` alongside pass/query/vote/summon/forum/meta. | S |
| 5 | `src/round-executor/tools.js` | Add `loom_state_patch` to `toolsMap` (mirror `:21` `loom_pass`). | S |
| 6 | `src/config/defaults.js` + `CONFIG_SCHEMA` | `agentTools.loom.loom_state_patch`, `agentTools.patchRetry`, `tuning.STATE_PATCH` (§5.11). | S |
| 7 | `src/prompts/agent.js` | System bullet + tool-list entry; user-prompt `MY_STATE` block + guidance lines; **remove auto-injected Recall block** (§5.5). | M |
| 8 | `src/round-executor/agent/prompt-session.js` | Fetch `myState`, pass to `buildAgentUserPrompt`, include tool flag; tighten `recentForPrompt` to current-round `≤12` (`:58-135` area). | S |
| 9 | `src/round-executor/agent/execute-turn.js` | Detect applied patch (`:152` area), patch-retry second pass, link contribution id, logging (§5.6). | M |
| 10 | `src/services/state-manager.js` | `participantStates` map + 4 methods (§5.7); summary-only shared-state inclusion. | M |
| 11 | `src/database/schema.js` + `meeting-operations.js` + new `state-patch-operations.js` | `user_version` bump, `participants.state_json`, `state_patches` table + helpers (§5.7). | M |
| 12 | `src/state-of-play.js` | Add `aggregateStateOfPlay` primary + keep `updateStateOfPlay` fallback (§5.8). | S |
| 13 | `src/prompts/interaction-prompts.js` + `blocks.js` | Append `Your State` snippet to peer prompts (caps as existing). | S |
| 14 | `src/prompts/synthesis.js` + `state-of-play.js:formatFinalRoundTranscript` | Append `Agent States (final)` block (≤4k). | S |
| 15 | Dashboard (`src/dashboard/...`) | Cards (`stance@v`), State view, export section (§5.9). | M |
| 16 | Logging | DEBUG patch/version counts + coverage tooltip (§5.10). | S |
| 17 | Tests + docs | Unit (merge pins/reserve/quarantine/remove), integration (fixed-roster fixture, mandatory-retry, resume carries state), `ORCHESTRATION_ARCHITECTURE.md` §4/§11 update, README bullet. | M |

Order: 1→2→3→6→4/5→10→11→7→8→9→12→13/14→15→16→17. Each step independently testable; flag off = zero behavior change until step 9 lands.

---

## 9. Testing Plan

- **Unit** (`state-patch`): empty Σ + adds; dedup case-insensitive; cross-bucket move (pinned facts never auto-moved); `remove` exact-match + `unmatched` report; FIFO eviction at 8 respecting pins + 2-newest reserve; over-cap all-pinned tolerated without throw; stance overwrite/clear; `files` lowercasing; ungrounded-fact quarantine to `open` with `(unverified)` suffix; idempotent re-apply. Mirror paper's null-deletion semantics test from the JS reference (`mergeWithNullDelete`).
- **Validation:** oversize strings, >3 adds, >5 removes, empty patch, unknown keys (strict), wrong types, ungrounded `facts_add` — rejected or quarantined per §5.1a/§5.2, state otherwise untouched.
- **Integration:** 2-agent 2-round mock meeting with **fixed fixture roster** (deterministic stand-in for paper App. B's seeded generator — same participants, same question, same scripted injection each run) — assert every primary turn yields `state_patches` row with `version++`; `loom_pass` turn yields none and is not retried; missed-call turn triggers exactly one retry; corrupt/old DB rebuilds seed via fallback; extension preserves versions.
- **Prompt bounds:** assert user-prompt contains no prior-round raw contributions (live window is current-round-only; Recall block absent); 1-round vs 6-round fixtures differ only within live/digest/state caps, never full weave.
- **Regression:** flag-off run byte-identical prompts (minus version-only cache-bust); all existing tests green; dashboard loads old meetings (fallback path).

---

## 10. Rollout and Compatibility

- **Flag:** `agentTools.loom.loom_state_patch` (default true on merge; set false to restore legacy keyword SoP instantly). `agentTools.patchRetry` independent kill-switch for the second pass.
- **Fresh-slate DB:** bump `user_version`, `ALTER TABLE` + new table on creation; no migration for existing DBs (documented project convention — session wipe on delete). Old meetings render via fallback.
- **Docs:** `ORCHESTRATION_ARCHITECTURE.md` §§4/7/11/15 (prompt shape, session reuse with patch-retry order, SoP aggregation, state management) + README Features bullet ("per-agent carried state via `loom_state_patch`").
- **No breaking changes** to commands, personas, models config, termination, or report schema (additive `Agent States` section only).

---

## Appendix A: Exact Artefacts

### A.1 `AgentState` seed

```json
{"stance":"","established":[],"contested":[],"open":[],"facts":[],"files":[],"version":0,"updated_round":0,"updated_contribution_id":null}
```

### A.2 `MY_STATE` render (rounds through `delimitContext`, omitted when all empty → `(empty — patch it this turn)`)

```
## Your State — CARRIED FORWARD (you wrote this via loom_state_patch; update it this turn)

<<<LOOM_MY_STATE>>>_BEGIN_
Stance: <stance or (none)>
Established:
- <≤8 × ≤500ch>
Contested:
- …
Open:
- …
Facts:
- …
Files:
- <≤8 × ≤160ch>
<<<LOOM_MY_STATE>>>_END_
```

### A.3 Patch-retry instruction (same session, tools = full map)

```
Your contribution is recorded. Now call loom_state_patch ONCE to project what should
survive: your current stance (1 sentence) + 1-3 bullets across established/contested/
open/facts/files + exact-text remove entries for outdated bullets. At least one field.
No prose needed beyond the call.
```

### A.4 SQL (see §5.7 for full statements)

`participants.state_json TEXT NOT NULL DEFAULT '<seed>'`; `state_patches(...)` with `UNIQUE(meeting_id, participant_id, version)` + `REFERENCES meetings(id) ON DELETE CASCADE`.

---

## Appendix B: Paper Traceability

| Paper | This plan |
|---|---|
| Eq. 1–2 `A_t=(P,Σ_t,O_t)` | §5.1 `Aⁱ_r=(P,Σⁱ_r,Oⁱ_r)` with latest-only `O` (current-round live ≤12 + digest; Recall removed). Deviates from Stateful-style history toward strict paper shape. |
| Eq. 3 `(R_t,ΔΣ_t,a_t)` | §3 table + §5.1a: prose + patch-args + deliberation action. Single-call fence adapted to separate tool call + retry; ordering deviation (store-prose-then-patch) documented in §5.6. |
| Eq. 4 `Σ_{t+1}=Σ_t⊕ΔΣ_t` | §5.3 `applyStatePatch` (typed flat-array equivalent; `remove[]` = null-keys; pins/reserve/quarantine are deliberation retention extensions). |
| §3.1 schema authored once per domain | §5.2 one static deliberation schema for all meetings |
| §3.2 reasoning eviction + validation/rollback | §5.4–5.6: prompt-eviction + store-retention (complementary deviation), Zod + `tool.schema` double validation, error-no-mutation |
| §3.3 Eq. 5–7 complexity | §6 table |
| §4.3 metrics | Explicitly out of scope; §5.10 is DEBUG/coverage logging only |
| §5.2–5.6 Tables (scaling/noise/recovery/compression) | Not reproduced. Functional analogues only: project-once `facts_add` (§5.4), 0–1-turn stance recovery via extension path (§5.7), dedup/non-repetition (§5.3/§5.1a) — verified by eyeball smoke checks, not measurements |
| §5.7 error taxonomy | Tool-channel + flat caps + retry (§5.4, §5.6); provider schema as grammar constraint (§4.6); `unmatched`/miss/quarantine DEBUG logs |
| §7 limitations (unknown schema; late relevance; trajectory-as-output; concurrent writes) | Per-agent ownership (§4.1) + deterministic aggregation (§5.8) + store-retention (§1) + seed fallback (§5.7) + pinned facts + reserve + paraphrase add/remove (§5.2–5.3) for late relevance |
| Appendix A prompts | §5.5 blocks + A.2/A.3 verbatim strings (tool-call wording replaces JSON-fence wording) |
| Appendix B SkillExecBench | Fixed-roster deterministic fixture in §9 (same roster/question/injection per run) as lightweight analogue; no generator, transitions, or scoring |

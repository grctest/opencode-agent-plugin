# Audit 17 — Performance & Resource Discipline

**Current grade: C− · Target grade: A−**

No pathological hot spots at current scale, but several O(n·m) rebuilds, leaked timers, and unconditional polling will degrade exactly during the flagship scenario: a 15-minute live meeting watched on the dashboard.

## Issues

### PF1 — Guard timers leak every round (minor)
`orchestrator.js:362-365, 544-552`: `Promise.race` timeout timers are never cleared/unref'd; losing the race doesn't cancel `indexRound`/`indexContext` — embedding writes continue after the op was declared failed. (Fix detailed in audit 05 LS6.)

### PF2 — Timeline rebuild cost (major)
`TimelineTab.jsx:470-872`: full timeline recomputation per incremental contribution; nested per-round scans (`:488-493`); `Charts.jsx:28-37` ParticipationMatrix refilters/sorts all contributions once per round inside a memo. During a live meeting with N contributions arriving one by one this is O(N²) aggregate work on the UI thread. (Fix approach in audit 11 UF5.)

### PF3 — Unconditional background polling (minor)
Three independent timers (`app.jsx:261`, `hooks.js:292`, gap-fallback `:69/180`) run regardless of tab visibility; SSE fallback polls three endpoints every 3s. Hidden tabs burn API calls against SQLite for hours.

### PF4 — Meeting resolution cost per knit (minor)
`findMeetingBySessionId` O(n)-scans all meeting DBs on readonly connections without `busy_timeout` (`database.js:1320-1376`); the 30s resolve cache in `index.js:62-114` softens but doesn't remove it.

### PF5 — Repeated weave scans for counts (minor)
Every contribution path recomputes `contributions_count` via `getWeave().filter(...)` (`round-executor.js:382, 539, 775, 866, 967`; `index.js:510`) — O(N) per contribution, O(N²) per round. Trivial today (N<100), free to fix while touching those lines anyway.

### PF6 — Persona re-embedding per meeting (minor)
`orchestrator.js:334-339`: persona embeddings are stored per-meeting DB (FK to meetings), so every new meeting re-embeds all 89 personas (~89 inference calls) before round 1. Adds startup latency and compute to every `/knit`.

### PF7 — SSE backpressure unbounded (minor)
Covered in audit 10 S5 — slow dashboard clients queue unbounded during heavy rounds.

## Proposed fixes

1. **Timer/abort hygiene** per audit 05 (AbortSignal into indexing; clearTimeout + unref).
2. **Per-round memoization** of timeline items and matrix data (audit 11).
3. **Visibility-aware polling**: single timer owner pauses on `document.hidden`.
4. **Index-backed resolution**: maintain `session_id → db_path` in the session index at registration time so knit-start lookup is O(1); keep dir-scan as fallback.
5. **Increment participant counters** instead of recomputing filters.
6. **Cache persona embeddings globally**: store embeddings keyed by `(persona_name, model_revision, content_fingerprint)` in a shared cache DB (or reuse an existing meeting's embeddings); copy rows into the per-meeting tables instead of re-inference when revision matches. The content fingerprint (hash of the serialized persona JSON, or file mtime+size) is critical — without it, a user who edits a persona file would keep receiving stale embeddings indefinitely, trading a performance cost for a silent-correctness bug.

## Justification

PF2/PF3 are user-facing (janky live view, battery/CPU burn). PF6 taxes the most frequent operation (`/knit`) with nearly 100 model calls before the first agent speaks — removing it shortens time-to-first-word noticeably. All fixes are code-level; no dependency changes.

## Verification (2026-08-21)

| Item | Status | Notes |
|------|--------|-------|
| PF1 | ✅ verified | `Promise.race` timers at `orchestrator.js:362-365, 544-552` never cleared/unref'd; losing the race doesn't cancel indexing. |
| PF2 | ✅ consistent | Structural claim (single large memo + nested scans) confirmed; perf figures treated as estimates pending measurement. |
| PF3 | ✅ verified | Three unconditional timers confirmed (5s meetings, 5s models, 3s fallback poll); no visibility handling. |
| PF4/PD6 | ✅ verified | Last-insertion-order index entry + O(n) readonly scan of all meeting DBs per knit resolution (`database.js:1320-1376`). |
| PF5 | ✅ verified | `getWeave().filter(...)` count recomputation present at all cited call paths in round-executor/index. |
| PF6 | ✅ verified | `orchestrator.js:334-339`: persona embeddings stored per-meeting DB → ~89 re-embeddings per new meeting when the vec table is empty. The proposed global cache keyed by `(persona_name, model_revision)` dovetails with V1's `model.json` revision stamping — sequence it after V1 or cache entries will need invalidation twice. |
| PF7 | ✅ verified via S5 | See audit 10. |

## Priority & benefit

| Item | Priority | Effort | Benefit |
|------|----------|--------|---------|
| PF2 timeline/matrix memos | P1 | M–L (1–2 days; pairs with audit 11 UF5) | Smooth live dashboard during 15-min meetings |
| PF6 persona embedding cache | P1 | M (after V1 lands; needs revision keying) | ~90 fewer embed calls per `/knit`; noticeably faster time-to-first-word |
| PF3 visibility pause | P1 | S (one timer owner + visibilitychange) | No idle CPU/API burn from hidden tabs |
| PF1 abort hygiene | P1 | S (pairs with audit 05 LS6) | Stopped work actually stops |
| PF4/5 | P2 | S each | Faster knit start; less redundant scanning |

**Recommendation: carry out PF1+PF3 cheaply in Wave 2, defer PF6 until after V1 pooling fix (otherwise double cache invalidation), and fold PF2 into the audit 11 store/timeline refactor rather than doing it twice.**

### Second-pass review (2026-08-21) — fix-plan soundness

- **PF6 cache-key design flaw found:** the proposed key `(persona_name, model_revision)` does not detect **persona content edits** — README explicitly invites users to edit `personas/*.json`, and user-authored personas are merged from `~/.config/opencode/loom/personas/`. A user who edits a persona would keep receiving stale embeddings indefinitely. The key must include a content fingerprint (hash of the serialized persona, or file mtime+size) in addition to model revision. With that correction the design is sound; without it, PF6 trades a performance cost for a silent-correctness bug of exactly the class this audit series criticizes.
- **PF2 measurement caveat:** before investing 1–2 days in memoization, capture a profile during a live meeting (React DevTools profiler suffices) to confirm the memo rebuild is actually the dominant frame cost at realistic N (~100–200 contributions). The structural analysis predicts it will be, but the fix should be justified by measurement, especially since audit 19's suite won't cover UI perf.
- **PF4 fix note:** the proposed session-index-backed resolution is correct and also fixes PD6's wrong-order selection if the index stores `created_at` and resolution sorts by it — worth doing together.

**Post-fix grade:** A−.

# Audit 04 — Persistence & Data Layer

**Current grade: D · Target grade: A−**

`bun:sqlite` with per-meeting databases is a reasonable choice for a local plugin. But the layer loses writes silently, has no migration story, broken retention, and a racing session index. Most critically: the *only* durable record of a deliberation can silently miss rows.

## Issues

### PD1 — Contribution persistence has no uniform failure policy (critical) — **corrected 2026-08-21**
The original claim ("all call sites wrap the DB write in bare `catch {}`") was **partially stale at verification**. Current state of the 17 `addContributionWithTurnRequest` call sites:
- `index.js:275, 443, 511, 566, 666` now use `catch (dbErr) { logger.warn(...) }` — a partial improvement already landed; failure is logged but the contribution still exists in memory only, with no metric and no user-visible signal.
- `round-executor.js:411, 437, 596, 620, 804, 828, 881, 973, 1047` are **unguarded** — a failed insert throws into whatever wraps the executor (fan-out aborts mid-way or is swallowed upstream depending on caller). Only `:248` (pass evidence) and `:1092` have explicit warn-and-continue handling.

The substance stands: **the meeting transcript can be quietly incomplete**, the failure surface is inconsistent across files, and there is zero telemetry aggregation. Full treatment now lives in audit 07 EH1 (the shared degradation helper this fix should consume).

### PD2 — No schema versioning or migrations (major)
No `PRAGMA user_version`; header in `database/schema.js:1-4` claims "no migration machinery" while the constructor patches columns via redundant `ALTER TABLE … ADD COLUMN batch_id` inside an empty try/catch (`database.js:187-188`) — the column already ships in `schema.js`. Any future drift is undetectable and unpatchable.

### PD3 — Retention/GC never runs where it matters (major)
`database.js:190-198`: cleanup only fires when file mtime age >24h — an actively written DB resets mtime on every write, so `agent_errors`/`error_log` cleanup never executes for busy meetings; `contributions`, `orchestrator_messages`, `fabric_chunks`, `persona_embeddings` have no retention path at all. Additionally `:230-231` compares ISO-8601 strings (`2026-08-21T…Z`) against SQLite `datetime('now',…)` output (`2026-08-21 14:00:00`) — mixed formats make the boundary comparison wrong.

### PD4 — Session index races across processes (major)
`database/session-index.js:7-75`: process-global Map plus read-modify-write JSON persistence with no inter-process lock — two opencode processes clobber each other's index (last writer wins). Stale entries are filtered in memory but the compacted result is never persisted; if `loadSessionIndex()` was never called, indexing silently becomes memory-only (`:38` warn).

### PD5 — Non-atomic multi-write paths (major)
`database.js:1095-1106`: `fabric_chunks` row insert and its vector insert are two statements; an embed failure leaves permanent vectorless rows that are never retried. `chunk_index = MAX()+1` (`:1097`) computed outside a transaction races under concurrent writers.

### PD6 — Meeting resolution is slow and wrong-order (minor)
`database.js:1320-1376`: `findMeetingBySessionId` picks the last *insertion-order* entry of the index (not most recent), then O(n)-scans every `*.db` in the meetings dir per query on readonly connections opened without `busy_timeout`. Invoked on every knit call.

### PD7 — Two divergent deletion implementations (major)
`handlers/knit-handler.js:184-190` deletes `.db/-wal/-shm` inline **without** `unindexMeeting`, leaving dangling `session-index.json` entries forever; neither variant coordinates with open handles (orchestrator connection, dashboard readonly cache at `dashboard/api.js:26-68`).

### PD8 — Dead code and duplication (minor)
Entire dead module `database/meetings-index.js` (zero importers); contribution INSERT SQL duplicated (`database.js:576-594` vs `:676-709`), participant INSERT duplicated (`:268-307` vs `:348-376`), row-mapping triplicated (`:596-615`, `:617-636`, `:921-980`); `dashboard/api.js:224,358` reimplements `getMaxOrchestratorMessageId`/`getContributionContext`.

### PD9 — Weak relational integrity (minor)
`contributions.participant_id` has no FK; the app-level existence check that compensates is itself swallowed by an empty catch (`database.js:666-673`) → orphan rows possible. `turn_requests.target_participant_id` unindexed. Four JSON blob columns on `meetings` (`reflecting/querying/evidence/summoning_participants`) duplicate `participants.status` — drift-prone denormalization.

## Proposed fixes

1. **Replace bare catches with a degradation helper** (PD1): one utility, e.g. `swallow(context, fn)` that logs once per key via the existing `warnThrottled` and increments a `db_write_failures` metric. Sweep all call sites mechanically. This alone converts silent loss into visible degradation.
2. **Adopt `PRAGMA user_version`** + a tiny ordered-migrations runner (~40 lines of plain SQL execution, no new deps). Remove the redundant ALTER TABLE patch.
3. **Fix retention**: track last-maintenance time in a `meta(key,value)` table instead of file mtime; store timestamps consistently as unix epoch (or ISO everywhere) so comparisons work; extend coverage to the unbounded tables with configurable limits.
4. **Serialize session-index access**: use an exclusive-lock file (`openSync` with `'wx'` + retry/backoff) around read-modify-write, and persist the compacted result after filtering.
5. **Wrap chunk+vector inserts in one transaction**; on embed failure mark the row `pending_vector` and retry on next write; compute `chunk_index` inside the transaction.
6. **Unify deletion** into the `database.js` implementation (with `unindexMeeting`), close known handles first, and add a cache-invalidation hook for the dashboard readonly API.
7. **Delete dead module/methods; collapse duplicated SQL** into single prepared statements with mappers.
8. **Add the missing FK/indexes**; drop the four status JSON columns in favor of `participants.status` reads.

## Justification

PD1 is the worst finding in the project: the transcript is the deliverable, and its durability currently depends on luck. PD2–PD5 are the root causes of future data corruption as the schema evolves. All fixes use existing dependencies only.

## Verification (2026-08-21)

| Item | Status | Notes |
|------|--------|-------|
| PD1 | ⚠️ **corrected** | See rewritten issue above. index.js sites now warn; round-executor sites unguarded; "bare catch" census moved to audit 07 (44 across 10 files). |
| PD2 | ✅ verified | `batch_id` ships in `schema.js:60,131`; redundant `ALTER TABLE` at `database.js:187-188` inside empty try/catch. No `PRAGMA user_version` anywhere. |
| PD3 | ✅ verified, one nuance | mtime gate at `database.js:191` confirmed (`>86400000`). Format mismatch confirmed: rows written via `new Date().toISOString()` (`database.js:101`) vs `datetime('now','-30 days')` comparison — note the comparison still works *approximately* at day granularity since the ISO date prefix dominates lexicographic order; the boundary-day behavior is wrong but the practical effect is ±1 day, not total failure. The unbounded-tables half of the finding is fully accurate. |
| PD4 | ✅ verified | Read-modify-write JSON with atomic single-file rename (`session-index.js:46`) but no inter-process lock around the RMW itself — two processes still clobber. In-memory-only warning path confirmed. |
| PD5 | ✅ not re-verified line-by-line | Consistent with surrounding code patterns; low risk of being stale. |
| PD6 | ✅ verified | `findMeetingBySessionId` uses last insertion-order index entry (`database.js:1323`) then O(n) scans all `.db` files on readonly connections. |
| PD7 | ✅ verified | `knit-handler.js:180-195` deletes `.db/-wal/-shm` inline with no `unindexMeeting`. |
| PD8/PD9 | ✅ spot-checked | Dead `meetings-index.js`, duplicated INSERT paths, missing FK confirmed via grep. |

### Second-pass review (2026-08-21)

| Item | Status | Notes |
|------|--------|-------|
| PD5 | ✅ verified | `storeFabricChunk` (`database.js:1095-1106`): `MAX(chunk_index)+1` computed outside any transaction; row insert and vector insert are separate statements with independent failure handling — vectorless rows and index races confirmed. |
| PD8 line refs | ✅ minor drift only | Duplicated `INSERT INTO participants` at `:269, :350`; duplicated `INSERT INTO contributions` at `:579, :678` (audit said 576/676 — same statements). |
| Fix-plan soundness | ➕ assessed | The proposed fixes remain technically sound on re-review. Two implementation cautions: (1) the PD4 lock file must handle stale locks after crashes (lock-file with PID + age-based steal), otherwise a killed process permanently wedges the index; (2) PD9's "drop four status JSON columns" interacts with the dashboard's `state.*_participants` fields (`app.jsx:400-418`) and SSE payloads — the columns must be replaced by a derived read in `api.getState()` in the same change or the UI loses reflecting/querying indicators. |

## Priority & benefit

| Item | Priority | Effort | Benefit |
|------|----------|--------|---------|
| PD1 swallow-helper sweep (via audit 07 EH1) | P0 | M (1 day incl. sweep once helper exists) | No more silent transcript loss; counted degradation |
| PD7 unified deletion | P0 | S (~half day incl. handle coordination) | No dangling index entries; clean deletes |
| PD2 user_version+migrations | P1 | S–M (~half day; unlocks EH2 flags + Phase 3 tests) | Safe schema evolution from here on |
| PD3 retention fix | P1 | S (half day) | Bounded disk growth; correct cutoffs |
| PD4 index locking | P1 | S–M (lock-file + retry logic) | Multi-process correctness |
| PD5 transactions | P1 | S | No vectorless rows; race-free indexes |
| PD6/8/9 | P2 | M aggregate | Faster knit startup; maintainable layer |

**Recommendation: carry out PD1+PD7 in Wave 1–2 as planned, and pull PD2 forward aggressively — it is small and is the prerequisite for three other audits' fixes (EH2 degradation flags, V1 reindex metadata, testing Phase 3 fixtures).**

**Post-fix grade:** A−.

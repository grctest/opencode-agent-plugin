# Audit 07 — Error Handling & Observability

**Current grade: F · Target grade: A−**

> **Note:** This document was referenced by `audit-index.md` but was missing from the repository. It was written retroactively on 2026-08-21 as part of the audit verification pass, against the current tree.

Error handling is rot pattern #1 ("silent failure") and the lowest-graded aspect in the index — every other audit keeps citing it. The problem is not that errors occur; it is that the codebase has **no error-handling policy**: three incompatible idioms coexist, degradation is invisible to users, and the observability fragments that do exist (a decent throttled logger, per-meeting error tables, a stub metrics module) are not wired into the paths where things actually fail.

## Issues

### EH1 — No error-handling policy: three idioms coexist on the same operation class (critical)

The same operation — persisting a contribution row — is handled three different ways depending on which file you are in:

| Idiom | Where | Failure outcome |
|-------|-------|-----------------|
| **Warn-and-continue** | `index.js` loom-tool paths (`index.js:275, 443, 511, 566, 666`) | Contribution stays memory-only; one log line |
| **Unguarded throw** | `round-executor.js` directive fan-out (`:411, 437, 596, 620, 804, 828, 881, 973, 1047`) | Throw propagates into whatever wraps the executor — either aborts the remaining targets mid-fan-out or is swallowed upstream, depending on caller |
| **Bare `catch {}`** | 44 occurrences across 10 files (measured 2026-08-21; the index's "48 across 9 files" was close) | Fully silent |

There is no rule for which idiom applies when, no classification of *transient* vs *permanent* vs *degrade-and-continue*, and no shared helper. Every future call site invents its own policy.

### EH2 — Degradation is invisible to users (major)

The system has many designed degradation modes — embedder unavailable → keyword fallback (`composer.js`), vector search failure → tag matching (`database.js:1227-1230`, see audits 03/06), round indexing timeout → keyword fallback for that round, LLM round-summary failure → heuristic summary. In every case the user sees at most a log line (which nobody reads in a plugin host) and usually nothing at all:

- No `semantic_degraded` flag on the meeting row, so the dashboard cannot show "this meeting is running without embeddings".
- Fallback chains step down silently level-by-level (audit 06 V5) — an operator cannot tell whether composition is semantic or substring-matching.
- `warnThrottled` exists in `logger.js:55` precisely for this and is barely used in the relevant paths.

### EH3 — Metrics module is a stub wired to the wrong consumers (major)

`src/metrics.js` is 57 lines of process-wide counters. It is imported by exactly three modules (`dashboard/server.js`, `round-executor.js`, `synthesis-coordinator.js`), most keys are never populated, counters are lost on restart, and none of the persistence-layer failures flagged in audit 04 increment anything. The README's Known Limitations already admits this. Meanwhile `meeting_metrics` (the durable per-meeting table) is underused, so there is neither live nor historical visibility into DB-write failures, retries, breaker trips, or fallback activations.

### EH4 — Two overlapping error tables with divergent semantics (minor)

`agent_errors` and `error_log` serve similar purposes with different retention (both cleaned only when the file-mtime gate opens — audit 04 PD3, which itself never fires for busy meetings). The dashboard reads only `agent_errors`; `error_log` is write-mostly. Nothing deduplicates or correlates them, and `getAgentErrors()` full-scans on every SSE poll tick just to filter `id > prevErrorId` in JS (see audit 10 S8).

### EH5 — User-visible failure reporting is inconsistent (minor)

Some failures produce a progress message (`vector_index_timeout` posts "⚠️ Vector indexing timed out…"), others of equal severity only log (`persist_state_failed`, persona indexing failure). Progress messages use ad-hoc emoji prefixes with no severity convention. A user watching the dashboard cannot distinguish cosmetic warnings from "your transcript is now incomplete".

### EH6 — Log destination/severity is environment-variable folklore (minor)

`LOOM_LOG_LEVEL` works ad hoc but is undocumented in README/Configuration; there is no way to surface plugin logs in the dashboard (which would be the natural observability UI for this product).

## Proposed fixes

1. **One degradation helper** (the single highest-leverage change in the audit series): export `swallow(context, fn)` / `attempt(context, fn, {fallback})` from a small util — logs once per key via `warnThrottled`, increments a `db_write_failures` counter in both `metrics.js` and the meeting's `meeting_metrics`, and returns the typed fallback. Sweep all bare catches and unguarded persist calls mechanically (audits 04 PD1 and 05 LS* consume this). The helper must ship with a documented three-tier policy:

   | Policy | When | Behavior | Examples |
   |--------|------|----------|----------|
   | **abort** | Failure should halt the operation | Rethrow after persisting status | Synthesis artifact write, terminal status transitions |
   | **degrade** | Operation can continue degraded | Swallow + count + flag `*_degraded` on meeting row | Contribution persist, vector indexing, embedding init |
   | **ignore-with-count** | Pure telemetry, never affects flow | Increment counter only | Non-critical metric writes |

   Without this policy table, the sweep relocates the inconsistency rather than eliminating it — some catch sites *should* abort (the synthesis artifact write), and a generic swallow would turn data-corruption into silent degraded output.
2. **Degradation flags on the meeting record**: add `semantic_degraded INTEGER DEFAULT 0` (via audit 04 PD2's migration runner) set whenever any semantic feature steps down; render a banner on Overview/Timeline. Same pattern for `persistence_degraded`.
3. **Wire the metric points that matter**: DB write failures, retry exhaustion, breaker state changes, embedding-init status, fallback-chain steps. Both process counters (for the running dashboard) and per-meeting rows (for history).
4. **Collapse `agent_errors`/`error_log`** into one table during the PD2 migration; add the `WHERE id > ?` incremental variant (fixes S8 too).
5. **Severity convention for progress messages**: `[info|warn|error]` prefix contract, documented next to `postProgress`; route error-severity events into the dashboard's error badge.
6. **Document `LOOM_LOG_LEVEL`** and add a lightweight `/api/logs` tail (ring buffer of recent logger lines) so the dashboard becomes the observability surface.

## Justification

This audit is the keystone of the series: four other audits' fixes (PD1 swallow sweep, LS timer hygiene, V5 degradation surfacing, S8 poll scan) all land as instances of the same two helpers. Without EH1/EH2, every repair ships blind and regresses silently; with them, the "silent failure" rot pattern disappears as a class rather than as a list of patches. Cost is small: the helpers are ~40 lines, the sweep is mechanical, and the migration vehicle already exists (PD2).

## Verification (2026-08-21)

- EH1 idioms: ✅ verified. `index.js` sites now log warnings (a partial improvement over the original "all bare catches" claim in audit 04 PD1 — see that document's correction); `round-executor.js` sites measured unguarded at the listed lines; `grep -rc "catch {}"` = 44 across 10 files.
- EH3: ✅ verified — `metrics.js` is 57 lines; importers confirmed via grep; README Known Limitations corroborates.
- EH4/EH5/EH6: ✅ verified (`getAgentErrors()` full scan at `api.js:215-222`; `warnThrottled` present at `logger.js:55`; `LOOM_LOG_LEVEL` absent from README Configuration section).
- Grade F assessed as fair given the breadth of silent paths; the fix cost/benefit ratio is the best in the series.

## Priority & benefit

| Item | Priority | Effort | Benefit |
|------|----------|--------|---------|
| EH1 degradation helper + sweep | P0 | M (1–2 days incl. sweep) | Converts the entire silent-failure class into visible, counted degradation; unblocks PD1/LS/V5 fixes |
| EH2 degradation flags + banners | P0 | S (half day, needs PD2 runner) | Users and operators finally see degraded mode |
| EH3 wire metric points | P1 | S–M | Durable evidence for tuning; feeds PV5 telemetry later |
| EH4 collapse error tables (+S8 fix) | P2 | S | One retention story; cheaper polls |
| EH5 progress severity convention | P2 | S | Consistent user-facing failures |
| EH6 log docs + `/api/logs` | P2 | S–M | Dashboard becomes ops surface |

**Recommendation: carry out EH1+EH2 in Wave 2 before almost anything else in Waves 3–4.** Best benefit-per-effort in the entire audit series.

### Second-pass review (2026-08-21) — fix-plan soundness

- **The `swallow()` helper needs a policy table, not just a signature.** A generic swallow is wrong for writes whose failure *should* abort (e.g., the synthesis artifact write, terminal status transitions). The helper should ship with a documented three-tier policy: **abort** (rethrow; artifact/status writes), **degrade** (swallow + count + flag; contribution persists, indexing), **ignore-with-count** (pure telemetry). Without this codification the sweep just relocates the inconsistency EH1 describes.
- **EH2 flag placement confirmed feasible:** the meetings row already carries per-meeting state readable by the dashboard's `/api/meeting` (`api.getState()`); a `semantic_degraded` column rides PD2's migration runner and surfaces with a one-line addition to that endpoint plus a banner component.
- **EH3 scope note:** wiring metric points should prefer the durable `meeting_metrics` table over process counters wherever the datum is meeting-scoped, so history survives restarts and PV5 can derive quality metrics from the same rows retroactively.

**Post-fix grade:** A−.

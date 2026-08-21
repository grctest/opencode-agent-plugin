# Loom Project Audit — Index & Grade Card

**Date:** 2026-08-21 · **Scope:** full `src/` (~19.4k LOC), `scripts/`, `personas/`, `commands/`, README, `ORCHESTRATION_ARCHITECTURE.md`
**Method:** line-by-line read of the orchestration core (`index.js`, `orchestrator.js`, `round-executor.js`), plus three deep-dive sweeps (persistence/services, dashboard server+frontend, prompts/personas/config/scripts). Every finding carries a `file:line` reference.

**Verification pass — 2026-08-21.** All 18 original documents were re-checked against the current tree. Outcome: **the large majority of claims verified exactly**, with these exceptions now corrected in-place in the affected documents:

- Audit 11 UF1 rewritten — the claimed literal `useSSE` duplication no longer exists; the surviving issue is the window-event-bus data layer.
- Audit 04 PD1 corrected — `index.js` persist sites now log warnings (partial fix already landed); `round-executor.js` sites are *unguarded* rather than bare-caught. Substance stands via audit 07.
- Audit 02 P1 superseded — the loom_* tool migration (`docs/tool-interactions-as-tools.md`) resolved bracket-tag advertising; replaced by a new doc-drift finding (audit 15 DOC9).
- Line-number drift noted where found (e.g., round-executor timeout comment :1000→:1120); empty-catch census re-measured at ~44 across 10 files.
- The previously missing **Audit 07** document has been written and linked below; a new **Audit 19** (testing/CI) covers an area outside the original scope.

**Second pass — 2026-08-21 (same day).** Every previously-unmeasured claim was then verified, and each document gained a "fix-plan soundness" review. Highlights:

- **V1's model-spec premise externally confirmed** against the official Snowflake arctic-embed sources (CLS pooling + query prefix, verbatim as audited) — Wave 3's centerpiece is grounded in vendor truth, not inference.
- **New design flaw caught before implementation:** PF6's proposed embedding-cache key `(persona_name, model_revision)` would serve stale embeddings after user persona edits — key must include a content fingerprint (audit 17).
- **Residual-risk honesty added:** SEC2's "drop bracket stripping" transfers injection defense entirely to fencing; a narrow line-start directive neutralizer should accompany it (audit 12).
- **Implementation-order constraints surfaced:** E2's aborted-status persist-before-rethrow; PD9's status-column removal vs dashboard `state.*_participants` consumers; LS7's fabric-marker regex coupling; MA1's interface must cover same-turn synthesis; C1's object-vs-scalar merge conflict case.
- **Feasibility spike identified:** PV2's human-in-loop depends on unproven SDK read-side of parent sessions; fallback steering channel documented.
- Remaining previously-unverified claims (UF5/UF6/UF10 details, PD5/PD8, PC5/PC6, E5, S4, RH1/RH4 git state) all **verified**, with two minor corrections: cfo.json lives under `principal/` not `senior/`, and PC7's doctrine duplication was partially refactored away since original writing.

No finding in the second pass changed any grade or priority assignment; all changed *how* or *in what order* fixes should be implemented. The execution plan below is unchanged except for the cautions now embedded in each document.

## Overall grade today: **C-**

Four systemic rot patterns explain most low grades:

1. **Silent failure** — ~44 empty `catch {}` blocks across 10 files plus unguarded write paths; DB writes fail invisibly or inconsistently; degraded modes engage without telemetry.
2. **Copy-paste divergence** — inline tool implementations duplicate `RoundExecutor` methods (now the *advertised* path, raising severity); markdown exporters duplicated; fetch/SSE field shapes drift apart and already produce user-visible bugs.
3. **A semantic layer broken at its foundation** — embeddings use mean pooling where the model spec requires CLS (+ query prefixes); no similarity thresholds; silent keyword fallbacks. Vector features run but cannot be trusted.
4. **Docs describing a system that no longer exists** — wrong counts, wrong config precedence, a superseded interaction protocol in the primary technical reference, behavior claims contradicted by code comments in the same repo.

A fifth gap was outside the original series' scope but gates everything else: **zero tests and zero CI** (audit 19). Several audit claims were already stale within days of writing because churn is unverifiable.

## Grade Card

| # | Aspect | Grade | Doc |
|---|--------|-------|-----|
| 1 | Core deliberation engine | B− | [audit-core-deliberation-engine.md](audit-core-deliberation-engine.md) |
| 2 | Agent protocol & prompt engineering | C+ | [audit-agent-protocol-prompts.md](audit-agent-protocol-prompts.md) |
| 3 | Persona system & room composition | D+ | [audit-personas-composition.md](audit-personas-composition.md) |
| 4 | Persistence & data layer | D | [audit-persistence-data-layer.md](audit-persistence-data-layer.md) |
| 5 | Lifecycle, resume & state machine | D− | [audit-lifecycle-state-machine.md](audit-lifecycle-state-machine.md) |
| 6 | Vector/RAG/embedding pipeline | D | [audit-vector-rag-pipeline.md](audit-vector-rag-pipeline.md) |
| 7 | Error handling & observability | F | [audit-error-handling-observability.md](audit-error-handling-observability.md) *(written during verification)* |
| 8 | Config system | C− | [audit-config-system.md](audit-config-system.md) |
| 9 | Resilience (retry/fallback/CB) | B− | [audit-resilience-retry-fallback.md](audit-resilience-retry-fallback.md) |
| 10 | Dashboard server (HTTP/SSE) | C− | [audit-dashboard-server.md](audit-dashboard-server.md) |
| 11 | Dashboard frontend | C | [audit-dashboard-frontend.md](audit-dashboard-frontend.md) |
| 12 | Security posture (non-auth) | D+ | [audit-security-posture.md](audit-security-posture.md) |
| 13 | Install/update/distribution scripts | D | [audit-install-update-scripts.md](audit-install-update-scripts.md) |
| 14 | Repo hygiene & packaging | D+ | [audit-repo-hygiene-packaging.md](audit-repo-hygiene-packaging.md) |
| 15 | Documentation accuracy | C− | [audit-documentation-accuracy.md](audit-documentation-accuracy.md) |
| 16 | Module architecture & boundaries | C+ | [audit-module-architecture.md](audit-module-architecture.md) |
| 17 | Performance & resource discipline | C− | [audit-performance-resource-discipline.md](audit-performance-resource-discipline.md) |
| 18 | Product vision delivery (coding collab) | D | [audit-product-vision-coding-collab.md](audit-product-vision-coding-collab.md) |
| 19 | Testing & CI infrastructure *(new)* | F | [audit-testing-ci-infrastructure.md](audit-testing-ci-infrastructure.md) |

## Priority definitions

- **P0 — Correctness triage.** Crashes, silent data loss, data-corruption paths, security exposures, and bugs that produce wrong output *today*. Fix before anything else.
- **P1 — Structural repair.** Root causes of the rot patterns: degradation/error-handling policy, state-machine enforcement, deduplication, embedding correctness, test safety net. Unlocks everything else.
- **P2 — Quality & capability.** Frontend perf/a11y, product gaps (coding collaboration, budgets, telemetry), documentation truth, hygiene.

## Suggested execution order (revised after verification)

0. **Wave 0 (hours):** RH3 track docs · S2 localhost bind · S3 param clamp · SC1 two-line crasher fix · E1 status reorder. Individually trivial; collectively they close every "today" exposure. Start audit 19 Phase 1 (pure-unit suite) alongside so subsequent fixes land with enforcement.
1. **Wave 1 (P0):** SC2 safe-update w/ rollback → S4 guarded parses + S1/S5 SSE registry/ping → UF2/UF3 turn-request dedup/field-shape bugs → LS1/LS2/LS7 resume+extension hardening → MA2 tally unification → DOC2 config truth (+08 C1 merge).
2. **Wave 2 (P1a):** audit 07 EH1 degradation helper + PD1 sweep (keystone) → EH2/PD2 migration runner + degradation flags → transactions for multi-write paths (PD5) → session-index locking (PD4) → SEC2 sanitizer rewrite (tests first) → LS3 transition table.
3. **Wave 3 (P1b):** V1 CLS pooling + prefixes + `model.json` revision stamping → V2 chunker fix → reindex script → PC1 civilian tier + PC3 post-filter → PC2 thresholds (after V1!) → prompt limit unification (02 P2/P3) + P5 delimiter hardening → MA1 interaction-engine extraction (plan exists in tool-interactions doc §12) → testing Phases 2–4.
4. **Wave 4 (P2):** frontend one-store refactor (UF1 revised + UF4 + PF2 together) → visibility polling (PF3) → a11y pass → PV6 grounding check → PV4 token budgets → PV5 quality telemetry (rides EH3 wiring) → docs regeneration incl. DOC9 architecture sections → persona embedding cache (PF6, after V1).

## What to actually carry out (benefit-ranked shortlist)

If capacity is limited, this ordering captures most of the value:

1. **Wave 0 entirely** (~half a day) — highest benefit-per-hour in the series.
2. **Audit 07 EH1+EH2** (~2 days) — eliminates the silent-failure class; unblocks five other audits' fixes.
3. **SC2 safe update** (~1 day) — removes the only flow that can destroy working installations.
4. **V1+V2 embedding correctness** (~2 days) — makes the project's differentiator real.
5. **PC1 civilian composition** (~half a day) — turns 45% of dead inventory into features.
6. **UF2/UF3 dashboard data bugs** (~3 hrs) — two user-visible bugs gone.
7. **Audit 19 Phases 1–4** (~3–5 days spread across waves) — makes all of the above durable.

Everything else can follow opportunistically per the per-document recommendations without changing the trajectory.

## Cross-document dependencies and design decisions

Several fixes interact across audits. These must be coordinated:

| Dependency | Audits | What to decide/do together |
|------------|--------|---------------------------|
| Degradation helper policy table | 07 EH1 → 04 PD1, 05 LS*, 06 V5 | Define abort/degrade/ignore tiers *before* sweeping call sites |
| Config merge object-vs-scalar | 08 C1 | Decide conflict resolution before implementing deep-merge |
| Dashboard localhost configurability | 10 S2 | Make `dashboard.host` configurable (default 127.0.0.1) rather than hardcoded |
| SEC2 directive neutralizer | 12 SEC2 | Narrow line-start `[` neutralizer must ship alongside fencing, not instead of it |
| PF6 cache content fingerprint | 17 PF6 | Key must include persona content hash, not just name+revision |
| LS7 fabric-marker regex coupling | 05 LS7 | Sanitization must preserve `**User Input:**` marker; also update `TimelineTab.jsx:492` hardcoded `extensions.length * 4` |
| MA1 same-turn synthesis interface | 16 MA1 | Extracted engine must expose interaction-execution separately from synthesis |
| PV2 SDK read-side feasibility | 18 PV2 | Spike before scheduling — if reads aren't possible, fall back to `/knit --inject` steering |
| C4 config hot-path priority | 08 C4 | `prompts.js:817` and breaker construction should migrate to constructor injection first |
| S5 slow-consumer drop policy | 10 S5 | Drop clients after bounded queue-pause timeout, not just skip enqueues |
| PD9 status-column removal | 04 PD9 | Must derive `state.*_participants` in `api.getState()` in the same change or dashboard loses indicators |
| SEC2 landing order | 12 SEC2 + 19 TC1 | Sanitizer rewrite should land *after* Phase 1 sanitize tests exist |

## Constraints respected by all proposals

No TypeScript migration, no replacement of `Bun.serve` (configuration only), no authentication work, no package downgrades, no new dependencies. All fixes use the existing dependency surface (`bun:sqlite`, `sqlite-vec`, `onnxruntime-node`, `@huggingface/tokenizers`, esbuild, React 19, react-window v2, marked + DOMPurify) — including the test suites, which use built-in `node:test`/`bun:test`. The original "no new tests" constraint is explicitly **retired** by audit 19; it was the largest single risk to reaching A+.

## Does C− → A+ hold? (verification verdict)

Yes, conditionally. The audits' individual post-fix grades are realistic: nearly all findings were confirmed against code, and fixes are as contained as claimed (several are genuinely minutes of work). Two qualifications:

1. **The grade path runs through audit 07 and audit 19**, not around them — without the degradation policy and a regression net, Wave 1–3 repairs decay back (drift between audit-writing and verification already demonstrated this within days).
2. **A+ requires Wave 4's product work** (PV1 coding collaboration, PV4/PV5 economics+telemetry), exactly as audit 18 argues — Waves 1–3 alone top out at a well-repaired A−.

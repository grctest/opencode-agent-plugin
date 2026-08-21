# Audit 19 — Testing & CI Infrastructure (new area, outside original scope)

**Current grade: F · Target grade: B+ → A**

The original audit series (01–18) imposed a constraint of "no new tests" to keep proposals contained. That constraint was reasonable for triage scoping but it left the single biggest systemic gap undocumented: **this repository has no automated tests at all, and no CI.** Every fix proposed across the other 18 audits would land with no way to prove correctness or catch regressions.

This matters more than any individual finding because the codebase demonstrably churns fast without a safety net: during the 2026-08-21 verification pass, several audit claims were found stale (line numbers drifted by ~120 lines in `round-executor.js`, one frontend finding no longer matched the code, one persistence finding was partially addressed) — all within days of the audits being written. Nobody could have said *what else* changed in those edits.

## Issues

### TC1 — Zero test suite; zero test runner (critical)
`testing/` contains only a runtime artifact (`.opencode/`). `package.json` has no `test` script. No test framework is configured — and none needs to be installed: `node:test` is built into Node ≥18 and `bun:test` ships with Bun, both already in this project's runtime surface. The zero-dependency excuse does not apply here.

### TC2 — "Checks" are syntax-only (major)
`npm run check` runs `node --check` on six hand-listed `src/` files plus `dist/loom.js`. This catches syntax errors only — not type errors, not logic errors, not contract drift. `jsconfig.json` enables `checkJs` + strict over `src/**`, which helps, but covers neither `scripts/` (where audit 13 found a guaranteed ReferenceError crasher that syntax check cannot see) nor behavior. The `DOM` lib in jsconfig is unnecessary for a Node plugin and masks accidental DOM usage.

### TC3 — No CI pipeline (major)
No `.github/` directory exists. Nothing runs on push or PR. Combined with TC1/TC2, the only quality gate is "the author ran it once".

### TC4 — High-value pure modules are trivially testable today (opportunity)
A meaningful regression suite requires **no refactoring** for the purest modules:

| Module | What to test | Why it's urgent |
|--------|-------------|-----------------|
| `utils/sanitize.js` | Bracket stripping, sentinel restoration, out-of-range index (`SEC2` bugs are unit-testable in minutes) | Security-critical, currently has known bugs |
| `utils/retry.js` | Retryable classifier (`R5` gaps), backoff timing, breaker half-open transitions | Resilience core |
| `services/state-manager.js` | Full transition table incl. the invalid ones (`LS3`) | Lifecycle honesty |
| `composer.js` role planning | Complexity scoring, seniority boost, tier clamps (`PC1` fix target) | Product entry point |
| `prompts.js` builders | Golden-file snapshots of system/user prompts | Prompt regressions (audit 02's whole P1–P8 class) currently ship silently |
| vote tally / `extractVoteLetter` (post-MA2 unification) | Quirky regex cases | Known duplication trap |
| `vector-index.js #chunkText` | Oversized-paragraph behavior (`V2` fix target) | Silent content loss |

### TC5 — DB layer untestable as structured (minor, blocked by MA3/PD2)
`database.js` (1,432 lines) can be exercised with in-memory `bun:sqlite` (`new Database(":memory:")`) plus the schema module, but the PD2 migration runner must exist first so tests can assert schema-version transitions. Sequencing note: write the migration runner, then its tests, together.

### TC6 — Install/update scripts are the least-tested, most-destructive code (minor)
Scripts hold the series' two P0 crashers (SC1, SC2). A smoke check is cheap: build → install into a temp `OPENCODE_CONFIG_DIR` → assert expected files exist → run `node --check` on deployed artifacts. No user-machine risk if sandboxed to a temp dir.

## Proposed fixes

1. **Phase 1 — pure-unit suite (~20–25 tests, zero deps):** add `"test": "node --test testing/unit/"`; cover the TC4 table. One day of work; immediately catches SEC2/R5/LS3-class regressions.
2. **Phase 2 — prompt golden files:** serialize `buildAgentSystemPrompt`/`buildAgentUserPrompt`/moderator/synthesis prompts into `testing/golden/*.txt`; diff on change with an explicit `--update-goldens` escape hatch. Makes prompt changes reviewable.
3. **Phase 3 — DB fixtures:** in-memory `bun:sqlite` harness for schema init, contribution round-trip, retention cutoffs (after PD2/PD3 fixes), session-index locking.
4. **Phase 4 — CI:** single GitHub Actions workflow on push/PR: `node --check` over **all** `src/**` + `scripts/*` (fixes RH5), `npm run bundle`, `node --test`, script smoke test from TC6. Runs in <2 min on a free runner.
5. **Widen jsconfig**: include `scripts/`, drop the `DOM` lib, keep strict.
6. **Rule going forward:** every P0/P1 fix from the other audits lands with at least one test exercising the fixed path. This converts the audit series from a list of trust-me claims into enforced behavior.

## Justification

Testing is what makes every other grade improvement *durable*. Without it, the realistic trajectory after Waves 1–3 is a brief A− followed by silent decay back toward C — exactly the drift already observed between audit-writing and verification. With Phases 1–4, each wave becomes verifiable and the project gains the regression safety that its own velocity demands. Total investment across all four phases is roughly 3–5 days; no new dependencies at any point.

## Verification (2026-08-21)

- ✅ `testing/` empty except `.opencode/`; no `test` script in `package.json`; no `.github/`.
- ✅ `check` hand-list confirmed in `package.json` (six src files + dist).
- ✅ `jsconfig.json` scope/lib claim confirmed.
- ✅ `node:test` availability: Node ≥18 required by toolchain already in use (esbuild scripts run on plain `node`).

## Priority & benefit

| Item | Priority | Effort | Benefit |
|------|----------|--------|---------|
| TC4 Phase 1 unit suite | P0 | S–M (1 day) | First real safety net; catches known-bug classes immediately |
| TC3+TC6 CI pipeline w/ smoke install | P0 | M (1 day) | Quality gate exists; installer crashers can never return silently |
| Phase 2 prompt goldens | P1 | S (half day) | Prompt/prompt-injection fixes become reviewable |
| Phase 3 DB fixtures | P1 | M (with PD2 work) | Migration safety; durability claims enforced |
| TC2/TC5 check widening + jsconfig | P2 | S (hours) | Scripts under syntax check; cleaner types |

**Recommendation: carry out fully, starting Wave 1-adjacent (before or alongside the P0 fixes), because every subsequent wave depends on it.**

**Post-fix grade:** B+ after Phases 1–2; A with CI + DB fixtures.

### Second-pass review (2026-08-21) — grounding & feasibility

- **`node:test` availability:** confirmed — the toolchain already runs plain `node` (build/check scripts), so the built-in runner requires zero installs. `bun:test` covers modules importing `bun:sqlite`; both are within the existing runtime surface, so the "no new dependencies" constraint genuinely holds.
- **CI assumption made explicit:** the Phase 4 workflow assumes GitHub hosting. The working tree currently has no configured remote visible from this environment; if the project is hosted elsewhere, translate Phase 4 to that system's equivalent — the *check list* (syntax-all → bundle → test → smoke install) is portable as-is.
- **Testability re-confirmed against current tree:** sanitize.js, retry.js classifier, state-manager transition table, composer role planning (`generateRolesFromComplexity` is pure given `count`/`complexity`), and vote-tally logic are all side-effect-free and directly unit-testable with no refactoring — the Phase 1 scope is realistic at ~1 day.
- **One sequencing sharpening:** SEC2's sanitizer rewrite (audit 12) should land *after* Phase 1's sanitize round-trip tests exist, not before — otherwise the security fix itself lands untested, repeating the pattern this audit exists to break.
- **Smoke-test caveat:** TC6's install smoke test writes to a temp `OPENCODE_CONFIG_DIR` and downloads/skips the embedding model; pin it to skip network (assert the model-download *failure path* exits cleanly rather than asserting model presence) so CI stays hermetic and fast.

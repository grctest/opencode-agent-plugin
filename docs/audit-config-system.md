# Audit 08 — Config System

**Current grade: C− · Target grade: A−**

Three-layer config (opencode.json `"loom"` key / `.loomrc.json` / defaults) with validation and startup warnings is the right shape. But precedence contradicts the README, merging doesn't exist, and threading relies on module-global mutable state.

## Issues

### C1 — Precedence is first-found-wins with no merge; README wrong (major)
`src/config.js:281-317`: resolution order is project `.loomrc.json` → home `~/.config/opencode/.loomrc.json` → **home** `opencode.json` "loom" key. A *project-level* `opencode.json` with a `"loom"` key is never consulted (candidates are home-dir only), directly contradicting `README.md:223`. Partial overrides of a home config from a project are impossible.

### C2 — Validation gaps (minor)
Unknown *top-level* keys warn (`config.js:419-429`) but unknown *nested* subkeys (typo'd `agentTools.builtIn.websearchh`) pass silently through deepMerge. `agentTools.builtIn.bash.allowlist` contents are unvalidated yet interpolated straight into system prompts (`prompts.js:730`). The enum branch in `validateConfigKey` (`:172-173`) is dead — no schema defines `enum`.

### C3 — Dormant config that nags (minor)
`turnRequestThresholds.autoGrant`, `maxTurnRequestsPerRound`, `maxTurnRequestWords` ship as schema defaults but are unused by the planner (`ORCHESTRATION_ARCHITECTURE.md` §9 admits it); the validator then warns on every non-default use (`config.js:434-438`). No cross-check that `stallTimeoutMs < defaultMeetingTimeoutMs`.

### C4 — Global mutable threading (major-ish, architectural)
Module-level `defaultDirectory` set once by the plugin entry (`config.js:487-491`, `index.js:25`), a process-wide TTL/mtime cache (`:483-540`), and ~40 bare `getConfig()` call sites. Works today for one plugin instance; makes reasoning about testability/isolation hard and bites the moment two directories matter.

### C5 — No env-var overrides (minor)
Every loom setting is file-only; `LOOM_LOG_LEVEL` and `LOOM_CONFIG_DIR` exist ad hoc but nothing systematic. `process.env.HOME || '/root'` bakes a Linux-root fallback into library code (`config.js:286,291`; same pattern in `database.js:42`).

## Proposed fixes

1. **Deep-merge resolution**: candidates in order project `opencode.json("loom")` + project `.loomrc.json` → home equivalents; deep-merge with more-specific wins; record the winning source per key so warnings can say where a value came from. Update README to describe the real rule. **Design decision required before implementation:** define behavior for *object-vs-scalar* conflicts (e.g., home sets `agentTools.builtIn.bash = {enabled, allowlist}`, project writes `bash: false`). The existing polymorphic guard at `config.js:126-127` shows this case already bites — specify whether scalar always wins, object always wins, or merge promotes scalar to `{value: scalar}`. Without this decision, the merge introduces its own silent-precedence bugs.
2. **Recursive unknown-key detection**: walk the schema during validation, not just top level; validate allowlist entries are strings; delete the dead enum branch.
3. **Retire or implement dormant keys**: either wire them into `planTurnOrder` or remove them from the schema and document removal — silent dormancy plus nagging warnings is the worst of both.
4. **Instance-based config object**: `createConfig(directory)` already returns an instance; thread it through constructors (orchestrator/round-executor already receive options objects) and keep `getConfig()` as a deprecated alias resolving to the last-created instance. Migrate call sites incrementally. **Priority sites:** two hot paths read config at call time by design — `prompts.js:817` (tool-limit advertised per call) and breaker construction (`round-executor.js:63-67`) — should move to constructor injection first since audits 02 P3 and 09 R3 both depend on it.
5. **Env override pass**: after file resolution, apply `LOOM_<KEY>` overrides for numeric/duration/boolean keys; replace `/root` fallbacks with `os.homedir()`.

## Justification

C1 means users who follow the README get silently ignored configuration — trust damage at the setup step. C2/C3 erode confidence that any setting does what it claims. All fixes are contained within `config.js` plus call-site plumbing; no new dependencies.

## Verification (2026-08-21)

| Item | Status | Notes |
|------|--------|-------|
| C1 | ✅ verified | `findConfigFile` (`config.js:281-317`): project `.loomrc.json` → home `.loomrc.json` → **home-only** `opencode.json(c)` `"loom"` key. Project `opencode.json` never consulted; first-found-wins; no merge. |
| C2 | ✅ verified | Enum branch at `config.js:172-173` present but no schema entry defines `enum` (grep confirms only the check itself). Allowlist contents unvalidated. |
| C3 | ✅ verified | Dormant keys ship as defaults (`config.js:7,13-14`) with schema entries (`:70,81,92`) and a validator comment literally reading "Dormant autoGrant check" (`:434`). |
| C4/C5 | ✅ verified | `/root` fallbacks confirmed at the cited resolution lines; global cache and bare `getConfig()` spread confirmed via grep during MA5 cross-check. |

## Priority & benefit

| Item | Priority | Effort | Benefit |
|------|----------|--------|---------|
| C1 deep-merge + project opencode.json + README truth | P0 | M (1 day incl. per-key source tracking) | Config behaves as documented; layered setups work |
| C2 recursive validation | P1 | S–M (schema walk + allowlist string check) | Typos surface immediately; closes SEC6's config vector |
| C3 dormant-key cleanup | P2 | S (decide wire-or-remove) | Honest schema; no spurious warnings |
| C4 instance threading | P2 | L if done fully (incremental path proposed is right) | Isolation; enables future multi-directory use — do opportunistically, not as a wave item |
| C5 env overrides + os.homedir() | P2 | S | CI/headless tunability; removes `/root` landmine |

**Recommendation: carry out C1 in Wave 1–2 — it is the audit series' clearest trust-repair item and pairs with DOC2. Resist doing full C4 now; the incremental alias strategy in fix 4 is correct, but threading ~40 call sites is wave-sized work whose payoff arrives only with multi-directory support.**

### Second-pass review (2026-08-21) — fix-plan soundness

- **C1 merge semantics need one decision up front:** deep-merge with "more-specific wins" must define behavior for *object-vs-scalar* conflicts (e.g., home sets `agentTools.builtIn.bash = {enabled, allowlist}`, project writes `bash: false` — the existing polymorphic guard at `config.js:126-127` shows this case already bites). Spec this before implementing or the merge introduces its own silent-precedence bugs.
- **C1 per-key source tracking:** feasible cheaply — the resolver walks candidates in order anyway; recording the winning file per top-level key during the walk adds ~10 lines.
- **C4 reality check:** a grep-level recount confirms roughly 40 `getConfig()` sites; incremental threading as proposed is right, but note two hot paths (`prompts.js:817`, breaker construction) read config at call time by design — those specific sites should move to constructor injection first since audits 02 P3 and 09 R3 both depend on it.

**Post-fix grade:** A−.

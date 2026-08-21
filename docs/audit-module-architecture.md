# Audit 16 — Module Architecture & Boundaries

**Current grade: C+ · Target grade: A−**

The services-layer split (`services/` with state-manager, round-service, moderator-service, persistence-service…) shows the right instincts. But a parallel universe of inline implementations has grown inside `index.js`'s tool definitions that duplicates `RoundExecutor` logic — and it has already drifted. `database.js` is a 1,432-line god-file sitting next to a half-finished `database/` split.

## Issues

### MA1 — Inline tool implementations duplicate the executor (major)
`src/index.js` defines `loom_query`, `loom_evidence`, `loom_vote`, `loom_summon` tools whose execute bodies are hand-copied variants of `RoundExecutor.executeQueries/executeEvidenceRequests/executeVote/executeSummons` (~500 duplicated lines). Drift already visible: inline versions slice content differently (`content.slice(0,2000)` vs executor's full text), build prompts with slightly different context windows (`slice(-12)` filters repeated but subtly different), and handle status restore differently.

### MA2 — Vote tally generation exists twice, verbatim (major)
Tally construction including the quirky line-rewriting regex (`existing.match(/\((.+)\)/)`) is duplicated between `index.js:524-550` and `round-executor.js:891-944`; `extractVoteLetter` likewise duplicated (`index.js:415-425` vs `round-executor.js:16-28`). A parsing fix must land in two places or votes disagree depending on entry path.

### MA3 — database.js god-file vs half-done split (minor)
1,432 lines containing schema concerns, retention, vector tables, session index, and meeting lookup — while `database/schema.js`, `session-index.js`, `meetings-index.js` (dead) exist separately. Two mental models for one layer.

### MA4 — Scattered dynamic imports as hidden coupling (minor)
Mid-function `await import("./shared.js")` in tool bodies (`index.js:249,350,491,638`), `import("./composer.js")` inside executors (`round-executor.js:583`), a dead import of orchestrator from round-executor (`:650`). These hide dependency edges from any static analysis and exist mainly to dodge load-order issues.

### MA5 — Config global threading couples everything (see audit 08 C4)
~40 bare `getConfig()` call sites mean no module declares what configuration it actually needs.

## Proposed fixes

1. **Extract shared interaction engine**: move query/evidence/vote/summon execution into one module (or keep them on RoundExecutor) parameterized by `{sessionManager, stateManager, db, getParticipantModel, callStats}`; the `index.js` tools become thin adapters resolving the active engine via `activeLooms` and delegating. Delete the inline copies. This single refactor removes ~500 lines and both drift bugs at once. **Interface constraint:** the extracted engine must expose "execute interaction + return outputs" separately from "synthesize into caller's turn" — the tool migration added a ReAct-style same-turn synthesis loop in `round-executor.js` (~`:1385-1420`) that the inline tools currently lack. The interface must make this distinction explicit or the two paths will drift again in the opposite direction.
2. **One tally module**: `utils/vote-tally.js` exporting `extractVoteLetter` + `buildTally(votes)`; both call sites consume it.
3. **Finish the database split**: extract retention/GC, vector-table ops, and meeting-lookup into `database/` modules; delete dead `meetings-index.js`; `database.js` becomes the connection/facade only.
4. **Hoist dynamic imports to static** now that load order is stable (they were likely workarounds); delete the dead orchestrator import.
5. **Constructor-inject config slices** per module as part of audit 08's instance threading.

## Justification

MA1/MA2 are not aesthetic: they have already produced behavioral divergence between two code paths users can trigger (agent-initiated vs tool-initiated votes/queries behave differently). Deduplication is the highest-leverage maintainability move available; every future protocol feature (new directive type) currently costs double implementation.

## Verification (2026-08-21)

| Item | Status | Notes |
|------|--------|-------|
| MA1 | ✅ verified, updated framing | Inline `loom_query`/`loom_evidence`/`loom_vote`/`loom_summon` tools confirmed in `index.js:175-670` with hand-copied executor variants. Note: these inline tools are now the **advertised** interaction path (the loom_* migration), which *raises* MA1's severity — the tool path users are told to use is the divergent copy. The proposed extraction (shared engine parameterized by deps) matches exactly what `docs/tool-interactions-as-tools.md` §3 sketched as "interactionService" — the refactor doc and this audit converge on the same design. |
| MA2 | ✅ verified | `extractVoteLetter` duplicated (`index.js:415`, `round-executor.js:16`); tally construction duplicated including the `(…)` line-rewrite regex. |
| MA3/MA4/MA5 | ✅ verified | Dead `meetings-index.js`; scattered dynamic imports confirmed (`round-executor.js:662,729,1481,1522`; `index.js:249,350,491,587,598,611,638`) including the discarded orchestrator import at `:729`. |

## Priority & benefit

| Item | Priority | Effort | Benefit |
|------|----------|--------|---------|
| MA2 tally unification | P0 | S (one util module + two imports) | Vote results consistent across entry paths |
| MA1 interaction-engine extraction | P1 | M–L (2–3 days; the tool-interactions doc's checklist §12 is a ready-made plan) | One implementation of each interaction; drift class eliminated; makes the advertised tool path trustworthy |
| MA3 finish DB split | P2 | M (ride PD work) | Navigable persistence layer |
| MA4 static imports | P2 | S (after load-order confirmation) | Visible dependency graph |
| MA5 config injection | P2 | L if full; incremental per audit 08 C4 | Testable, isolated modules |

**Recommendation: carry out MA2 immediately (trivial) and treat MA1 as the Wave 2/3 anchor — it has an unusual property for a refactor: a detailed implementation plan already exists in `docs/tool-interactions-as-tools.md`, so execution risk is low relative to its payoff.**

### Second-pass review (2026-08-21) — fix-plan soundness

- **MA1 extraction must cover the same-turn synthesis loop.** The tool migration added a ReAct-style second turn in `round-executor.js` (~`:1385-1420`: loom-call detection, deadline-aware synthesis turn, loom-free tools map). The extracted interaction engine's interface must expose "execute interaction + return outputs" separately from "synthesize into caller's turn", or the inline tools (which currently lack same-turn synthesis) will drift from the executor again in the opposite direction. This is an interface-design constraint, not an obstacle.
- **MA2 verified trivial:** both copies are pure functions over vote text; extraction is mechanical with no async or state concerns.
- **MA3 sequencing:** finish the DB split *after* PD2's migration runner exists so the split modules don't have to move twice.

**Post-fix grade:** A−.

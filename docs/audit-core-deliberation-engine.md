# Audit 01 — Core Deliberation Engine

**Current grade: B− · Target grade: A−**

The engine's design decisions are sound: deterministic termination, ephemeral stateless sessions, bounded "golden sandwich" prompts, mid-round reflections targeted by persona similarity. The problems are correctness bugs in lifecycle handling and missed opportunities in deliberation dynamics.

## Issues

### E1 — Persisted status lags the real state (major)
`src/orchestrator.js:357-358`: `persistState()` writes `"initializing"`, *then* `transitionTo("weaving")` happens in memory only. The DB status stays stale until the next `persistState()` after a round completes (`orchestrator.js:638`). The dashboard and `findMeetingBySessionId` readers report a wrong status for the entire first round.

### E2 — `#finalizeRound` swallows all errors as "converged" (critical)
`src/orchestrator.js:640-645`: the catch-all logs and returns `false`, which is indistinguishable from a clean convergence. A failed `persistState()` or an invalid-transition throw inside finalization leads to synthesis running on inconsistent state with only a log line. There is no distinction between "round ended normally", "meeting ended early", and "finalization broke".

### E3 — Sequential turn-taking has no dynamics control (design)
Speaker 1 cannot react to speaker 5's challenge until the next round; mid-round reflections only partially compensate. Nothing steers contribution-type mix (e.g., five consecutive `[CHALLENGE]`s with no `[SYNTHESIZE]` pass), so rounds can end in pure conflict with no consolidation step.

### E4 — Dead code in hot paths (minor)
`src/round-executor.js:650-652`: `executeSummons` imports `getParticipantModel` from `orchestrator.js` inside a `try{}` and discards it — a no-op dynamic import executed per summon.

### E5 — Vote execution ignores round-scoped sessions (minor)
`src/round-executor.js:788`: `executeVote` creates fresh ephemeral sessions for every voter while `executeQueries`/`executeEvidenceRequests` reuse `#roundSessionIds`. Inconsistent session churn for the heaviest fan-out operation.

### E6 — Three separate timeout authorities (minor)
Deadline logic is duplicated across `#checkTimeout()` (`orchestrator.js:479-486`), the pre-round `<5000ms` check (`:494-501`), and the weaving-loop check (`:467-472`). Each posts its own progress message and transition; they can disagree near the boundary.

## Proposed fixes

1. **Reorder persist/transition** (E1): call `transitionTo("weaving")` before `await this.#persistState()`, or make `persistState` accept an explicit status override. One-line fix, removes the whole lying-window class.
2. **Error taxonomy in `#finalizeRound`** (E2): catch → classify. If the failure is in persistence/indexing: warn, continue (degrade). If it is a state-machine or logic error: `transitionTo("aborted")` with a reason persisted, and rethrow to `runMeeting` so synthesis is skipped or explicitly runs in degraded mode. Never return `false` on an unexpected exception.
3. **Contribution-mix steering** (E3): after each round's prompt phase, compute type counts; if `challenge + dissent ≥ 3` and `synthesize = 0`, inject a directive into the next speaker's prompt ("consolidate the positions above before challenging again"). Cheap, prompt-level, no new LLM calls.
4. **Delete** the dead import block (E4).
5. **Reuse round-scoped sessions in `executeVote`** exactly like queries/evidence (E5).
6. **Single deadline authority**: one `#remainingMs()` helper consulted everywhere; remove the three ad-hoc checks.

## Justification

E1/E2 directly corrupt the persisted record that resume and the dashboard depend on — they undermine the project's own crash-recovery story. E3 is the cheapest lever to improve output *quality* (the product's core promise) without new infrastructure.

## Verification (2026-08-21)

| Item | Status | Notes |
|------|--------|-------|
| E1 | ✅ verified | `orchestrator.js:357-358`: `await this.#persistState();` then `transitionTo("weaving")` — DB lags memory for the entire first round, exactly as claimed. |
| E2 | ✅ verified | `orchestrator.js:640-645` catch-all logs `finalize_round_failed` and returns `false`, indistinguishable from the clean-convergence returns above it. |
| E4 | ✅ verified | Dead dynamic import confirmed at `round-executor.js:729` (`getParticipantModel` imported from orchestrator inside `executeSummons` and discarded, while the class already receives its own via constructor at `:48,55`). Line ref drifted from :650. |
| E5 | ✅ **verified (2nd pass)** | `executeQueries`/`executeEvidenceRequests` check `#roundSessionIds` first and reuse the round-scoped session when present (`round-executor.js:302-306`); `executeVote` unconditionally creates a fresh ephemeral session per voter (`:893`). Inconsistency confirmed at code level, not just by inference. |
| E6 | ✅ verified | Three timeout authorities confirmed at `orchestrator.js:467-472` (weaving loop), `:479-486` (`#checkTimeout`), `:494-501` (pre-round <5000ms), each posting independently-worded progress messages. |
| E3 | ➕ design note validated | Still the cheapest output-quality lever available; nothing in the tool migration addresses contribution-mix steering. |

### Second-pass review (2026-08-21) — fix-plan soundness

- **E2 rethrow ordering requirement:** `transitionTo("aborted")` + a final `persistState()` must complete *before* the rethrow, or the aborted status itself is lost — the fix text implies this; treat it as mandatory during implementation.
- **E1 reorder safety:** confirmed safe as a one-liner — `transitionTo("weaving")` performs no I/O and no validation can fail for this transition (it is in the table).
- **E3 steering mechanism:** the proposed prompt-injection approach (no new LLM calls) is compatible with the current single-prompt-phase loop and with round-scoped sessions; no architectural obstacle found. Effect size is genuinely unknown, which reinforces pairing it with audit 18 PV5 quality telemetry so the steering is measured rather than assumed.

## Priority & benefit

| Item | Priority | Effort | Benefit |
|------|----------|--------|---------|
| E1 reorder | P0 | S (~15 min + test) | Correct status from second zero; resume/dashboard trustworthy |
| E2 taxonomy | P0 | S–M (half day incl. degraded-synthesis decision) | No more silent convergence-on-error; aborted meetings are diagnosable |
| E3 mix steering | P1 | M (needs prompt-design iteration) | Higher synthesis quality; fewer deadlock rounds |
| E5 vote session reuse | P2 | S | ~N fewer session creates/deletes per vote |
| E6 deadline helper | P2 | S | Removes boundary double-transitions |
| E4 dead import deletion | P2 | S (minutes) | Hygiene |

**Recommendation: carry out E1+E2 immediately — combined under a day and they repair the persisted record that resume, dashboard, and synthesis all depend on. E3 is the one item here worth prototyping early because it directly improves the product's core output rather than its plumbing.**

**Post-fix grade:** A− (only remaining gap: richer deliberation structures such as explicit steel-manning phases, which are roadmap, not repair).

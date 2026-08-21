# Audit 05 — Lifecycle, Resume & State Machine

**Current grade: D− · Target grade: A**

A validated state machine exists (`services/state-manager.js`) — and then every path that matters routes around it. Resume ignores persisted status; extension interpolates unsanitized input; watchdog restart silently extends deadlines. The lifecycle layer gives false confidence.

## Issues

### LS1 — `restore()` hardcodes status (critical)
`src/meeting-restorer.js:60`: resume always sets `status: "weaving"`, ignoring what was persisted. Crashed, cancelled, or aborted meetings all silently reopen as if mid-deliberation. The persisted terminal states (`converged/cancelled/timeout/aborted/…`) are never honored on the resume path.

### LS2 — Unguarded parse aborts entire resume (major)
`src/meeting-restorer.js:58`: `JSON.parse(meeting.tags)` is unguarded — one corrupt blob throws and the whole resume fails, inconsistently with the defensive `parseReflections`/`parseStats` used two lines away.

### LS3 — Transition validation bypassed where it matters most (major)
`src/services/state-manager.js:135-170`: the transition table has no modeling for resumed meetings and makes `timeout` unreachable from `initializing`; callers respond by adding `forceTransitionTo()` (`:165`) and restoring via direct assignment. The "validated" machine guarantees nothing on extension/resume/recovery — exactly the paths that need it.

### LS4 — Freeze claim is shallow (minor)
`state-manager.js:40-49`: only `participants`/`weave`/`rounds` shells are frozen; `artifact`, `objections`, `tags`, `stats`, `planned_turn_order`, `state_of_play` are handed out by reference and mutable. Frozen participant shells share nested `config` objects.

### LS5 — Watchdog double-start hazard (minor)
`services/stall-watchdog.js:40-61`: `start()` early-returns when a timer exists but still resets `#lastActivityAt` and reads fresh config — a second `start()` extends the deadline while the interval keeps running the *first* closure's predicates. `WATCHDOG_TICK_MS = 30000` hardcoded.

### LS6 — Timer leaks in deadline guards (minor)
`orchestrator.js:362-365, 544-552`: `Promise.race` guard timers are never cleared or unref'd — each round leaks a pending 5–10s timer; losing the race does not cancel the underlying `indexRound`/`indexContext`, so embedding writes continue after the operation was declared failed.

### LS7 — Extension path weaknesses (major)
`services/meeting-extender.js:34-44`: the user's extension prompt is interpolated into shared fabric **unsanitized** (`**User Input:** ${newPrompt}`) despite `sanitizeForPrompt` existing — a direct injection surface into all subsequent agent prompts. Fabric/maxRounds/per-participant status are three non-transactional write batches that can half-apply. `EXTENSION_EXTRA_ROUNDS = 4` hardcoded at `:4` ignores any user max-rounds intent.

### LS8 — Shutdown handlers can't do async work (minor)
`index.js:702-720`: abort-on-exit runs synchronous best-effort writes inside `process.on("exit")` (where async DB ops cannot complete) and SIGINT/SIGTERM handlers call `process.exit()` immediately, racing `markActiveMeetingsAborted`.

## Proposed fixes

1. **Honor persisted status on resume**: if the DB status is terminal, refuse resume (return an explanatory error to `/knit`) unless `fresh:true`; only non-terminal statuses reopen. Fix the corrupt-tags parse with the existing defensive helpers.
2. **Extend the transition table honestly**: add `initializing → weaving` already present plus explicit `resumed` handling (`weaving → weaving` legal via `extendMeeting`), make `timeout` reachable from all active states, then *delete* `forceTransitionTo`. If a transition is missing, fix the table — don't bypass it.
3. **Deep-freeze or project**: either deep-freeze state once (cheap at these sizes) or return readonly projections from getters; document that `getState()` must not be mutated.
4. **Watchdog idempotency**: `start()` while running should be a no-op (no deadline reset); make tick interval configurable.
5. **Timer hygiene**: keep timer handles and `clearTimeout` them when the race resolves first; `.unref()` guards; pass an AbortSignal into indexing so cancelled races actually stop embedding work.
6. **Harden extension**: sanitize the prompt through `sanitizeForPrompt`; wrap fabric+maxRounds+status updates in one transaction; derive extra rounds from current config rather than a constant. **Implementation note:** the dashboard's ExtensionBanner parses `**User Input:**` out of fabric via regex (`app.jsx:344-363`) — sanitization must preserve that exact marker or both features break together. Also note `EXTENSION_EXTRA_ROUNDS = 4` interacting with the timeline's extension-marker math (`TimelineTab.jsx:492` hardcodes `extensions.length * 4`) — deriving extra rounds from config requires updating both consumers in the same change.
7. **Shutdown sequencing**: for SIGINT/SIGTERM, await async abort persistence with a short grace timeout before exiting; drop the futile sync work in `exit`.

## Justification

Resume correctness is the difference between "a meeting you can extend" and "a database that lies to you." LS1/LS3 mean the documented schema statuses are not actually enforced anywhere end-to-end. All fixes are local logic changes; no dependency or architecture change required.

## Verification (2026-08-21)

| Item | Status | Notes |
|------|--------|-------|
| LS1 | ✅ verified | `meeting-restorer.js:60`: `status: "weaving"` hardcoded in the restore call. |
| LS2 | ✅ verified | `meeting-restorer.js:58`: unguarded `JSON.parse(meeting.tags)` next to defensive `parseReflections`. |
| LS3 | ✅ verified | Transition table (`state-manager.js:135-149`) has no `weaving → weaving` and no `timeout` from `initializing`; `forceTransitionTo` exists and is used by the extender. |
| LS5 | ✅ verified | `stall-watchdog.js:40-61`: second `start()` resets `#lastActivityAt` and re-reads config *before* the `if (this.#timer) return` guard — deadline extension with the first closure's interval confirmed. |
| LS7 | ✅ verified | `meeting-extender.js:42`: unsanitized `` `${database.getFabric()}\n\n**User Input:** ${newPrompt}` ``; `EXTENSION_EXTRA_ROUNDS = 4` hardcoded; three sequential non-transactional writes. Note the dashboard's ExtensionBanner parses this fabric pattern back out via regex (`app.jsx:344-363`) — sanitizing the prompt must keep the `**User Input:**` marker parseable or both features break together. |
| LS4/LS6/LS8 | ✅ consistent | Spot-checked; LS8 confirmed at `index.js:703-719` (sync writes in `exit`, immediate `process.exit` in SIGINT/SIGTERM). |

## Priority & benefit

| Item | Priority | Effort | Benefit |
|------|----------|--------|---------|
| LS1 + LS2 resume honesty | P0 | S (~half day incl. fresh:true interplay tests) | Terminal meetings stay terminal; corrupt data degrades gracefully |
| LS7 extension hardening | P0 | S–M (sanitize + one transaction; mind the banner regex coupling) | Closes injection surface; no half-applied extensions |
| LS3 real transition table | P1 | M (table redesign + delete bypass API + call-site fixes) | State machine becomes trustworthy end-to-end |
| LS6 timer hygiene | P1 | S (pairs with audit 17 PF1 fix) | No leaked timers; cancelled work actually stops |
| LS4/LS5/LS8 | P2 | S each | Predictable freezing/watchdog/shutdown |

**Recommendation: carry out LS1/LS2/LS7 in Wave 1 as planned — they are small and protect the two most user-visible flows (resume and extend). LS3 is the right Wave 2 anchor once audit 07's degradation helper exists, since several transitions want to route through it.**

### Second-pass review (2026-08-21) — fix-plan soundness

- **LS3 table design caution:** "delete `forceTransitionTo`" is the right end state, but the extender legitimately needs `weaving → weaving` and resume needs terminal→active rejection *with a good error*. The redesigned table should model these explicitly (`weaving` self-transition legal only via extension entry point; `restore()` refuses terminal states per LS1) before the bypass API is deleted — deleting first would break extension.
- **LS7 coupling confirmed:** the dashboard's extension banner parses `**User Input:**` out of fabric via regex (`app.jsx:344-363`); sanitization must preserve that exact marker. Also note `EXTENSION_EXTRA_ROUNDS = 4` interacting with the timeline's extension-marker math (`TimelineTab.jsx:492` hardcodes `extensions.length * 4`) — deriving extra rounds from config requires updating both consumers in the same change.
- **LS6 AbortSignal feasibility:** `indexRound`/`indexContext` are CPU-bound ONNX inference loops; an AbortSignal must be checked between chunks/embeddings to have effect — a cooperative-cancel pattern, not preemption. Still worth doing; just not a one-line change.

**Post-fix grade:** A.

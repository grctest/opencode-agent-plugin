# Audit 11 — Dashboard Frontend

**Current grade: C · Target grade: A−**

The UI is feature-rich (Overview/Timeline/Output tabs, themes, markdown export, virtualized lists) but is held together by duplicated data layers and window events, with two user-visible data bugs caused by fetch/SSE shape drift.

## Issues

### UF1 — ~~`useSSE` implemented twice~~ Two parallel data layers coupled by window events (major) — **corrected 2026-08-21**
The original claim ("~150 near-verbatim duplicated lines, `hooks.js` copy dead") **no longer matches the code** and appears to describe an earlier revision. Current reality: there is exactly one `useSSE` (`app.jsx:13-175`), and `hooks.js` exports (`useMeetingApi`, `useSSEHandlers`, `useSSEReset`, `useEmbeddingStatus`) are all actively imported by `app.jsx:9`. However, the *architectural* critique survives in modified form: live data flows **SSE → `useSSE` → seven window CustomEvents → `useSSEHandlers` → React state**, while initial loads take a separate fetch path inside `useMeetingApi`. Consequences visible today:
- Duplicate `lastPollIdRef` tracking (one in `app.jsx useSSE`, one in `hooks.js useMeetingApi`) synced via yet another synthetic event (`loom-initial-contributions`).
- Ordering between fetch responses and SSE events is unguaranteed (the original concern, unchanged).
- The dedup/shape bugs below (UF2/UF3) exist *because* the two paths normalize rows differently.

The fix is the same as originally proposed — one store owning `{meetings, meeting, deltas}` with an `applyDelta()` consumed by both paths — just motivated by event-bus indirection rather than literal duplication.

### UF2 — Turn-request dedup key drops real requests (critical)
`hooks.js:58-59` keys dedupe on `` `${tr.participant_id}:${tr.target}` `` while incremental SSE events carry `target_participant_id` (`api.js:290-297`) → every key is `"pid:undefined"`. After the first batch, **any subsequent turn request from the same participant is silently filtered out of the UI**.

### UF3 — Field-shape mismatch renders empty cards (major)
`Cards.jsx:222-226` renders `turnRequest.reason` / `.target`, but the initial `/api/meeting` fetch path returns `content` / `target_participant_id` (only SSE aliases `content AS reason`, `api.js:293`). Initial-load turn-request rows render with empty bodies.

### UF4 — Refetch storm on every connect (major)
`hooks.js:369-373` increments `resetKey` on *every* SSE `onopen`, re-triggering the heavy `/api/meeting` call plus sequential pagination loop (`:343-357`) — runs twice per page load and fully again on every reconnect — while a parallel gap-fill fetch in `onopen` (`app.jsx:94-103`) races it redundantly.

### UF5 — Timeline memo is an O(rounds × contributions) rebuild (major)
`TimelineTab.jsx:470-872`: a single ~400-line `flatItems` useMemo regroups everything (pairing reflections/queries/votes via batch-id fallback maps and orphan sweeps) whenever any contribution, participant status, or collapse toggle changes; nested rescans like per-round `contribs.map(created_at)` + `Math.min(...)` (`:488-493`). Every incremental SSE contribution during a live meeting re-runs all of it.

### UF6 — Fixed-height virtualization clips content (minor)
react-window v2 is used (`TimelineTab.jsx:7-27`, `Sidebar.jsx:251`) but row heights are hardcoded constants unrelated to markdown length — long contributions are clipped inside fixed rows with no expand affordance. Sidebar list gets `height="100%"` inside an auto-height parent (`Sidebar.jsx:251-259` + `app.css:172-174, 2079-2092`), so the participant list can collapse, especially in the single-column layout.

### UF7 — State flows through six window CustomEvents (minor)
`app.jsx:159-172, 305-327`, `hooks.js:42-124`: live data detours through synthetic window events instead of React state; ordering between fetch responses and SSE events is unguaranteed; three independent polling timers run unconditionally with no `document.hidden` pause (`app.jsx:261`, `hooks.js:292`, `app.jsx:69/180`).

### UF8 — Accessibility gaps (minor)
ARIA tabs pattern incomplete (no roving tabindex/arrow keys; **correction:** `aria-controls` *is* present at `app.jsx:515`, the original claim overstated this); stacked dialogs each bind document keydown listeners so Escape closes *all* layers at once (`Cards.jsx:29-59`); dialog focuses container not first focusable, no background scroll lock; ExtensionBanner "✕" has no accessible name (`app.jsx:235`).

### UF9 — Theme system double-booked (minor)
Bootstrap shell leaves `data-theme` unset for "system" relying on media queries while `ThemeProvider` force-sets an explicit attribute even in system mode (`app.jsx:194`) — CSS must satisfy both `[data-theme="dark"]` and `prefers-color-scheme`.

### UF10 — Misc hygiene (minor)
Markdown cache holds up to 200 rendered HTML blobs keyed by full strings; sanitized links lack `rel="noopener"` (`Cards.jsx:10-23`). Dead exports: `ReflectionInline`, `AgentPerspective`; unused `ThinkingCard` import; `POLLING_FALLBACK_INTERVAL` defined twice; `SummonedResponseRow.requesterName` returns a constant in both branches (`Cards.jsx:385-389`). Server's HTML shell is a string-duplicated `index.html` that has already drifted (`server.js:66-86`).

## Proposed fixes

1. **One store**: delete the dead `hooks.js` useSSE copy; keep a single hook owning `{ meetings, meeting, deltas }` in React state (drop CustomEvents), exposing `applyDelta()` used by both SSE messages and fetch responses.
2. **Fix UF2/UF3 immediately** and then *remove the divergence class*: normalize turn-request rows to one shape (`{participant_id, target_participant_id, reason}`) server-side so fetch and SSE emit identical objects from a shared mapper in `api.js`.
3. **Connect once**: resetKey only on genuine desync (gap detected), not every open; make gap-fill the sole recovery path.
4. **Partition the timeline memo**: precompute per-round item lists (memoized per round number), concatenate cheaply; move pairing into a per-round helper. Replace hardcoded heights with measured/dynamic row heights (react-window v2 supports dynamic sizing) or add expand toggles.
5. **Pause polling when hidden** via `document.visibilitychange`; single timer owner in the store hook.
6. **A11y pass**: implement roving tabindex on tablists; central dialog manager (stack-aware Escape, focus first focusable, scroll lock); name the dismiss button.
7. **Single theme authority**: let ThemeProvider own `data-theme` exclusively; bootstrap only sets an inline default before hydration.
8. **Build-time inject** the HTML shell from `index.html` in `scripts/build.mjs` instead of the drifted string copy.

## Justification

UF2/UF3 are silent data loss in the primary visualization of the product. The rest compounds: every future dashboard feature multiplies across two SSE implementations and an event bus. Normalization + one store eliminates the whole bug class rather than patching instances.

## Verification (2026-08-21)

| Item | Status | Notes |
|------|--------|-------|
| UF1 | ⚠️ **corrected** | No literal `useSSE` duplication exists today; rewritten above as window-event-bus critique. Line ranges in original were stale. |
| UF2 | ✅ verified, **worse than stated** | `hooks.js:58-59` keys on `${tr.participant_id}:${tr.target}`; server sends `target_participant_id` (`api.js:293`). All keys become `"pid:undefined"`, so *even initial-load rows* collapse per participant — every subsequent turn request from the same participant is dropped regardless of source path. |
| UF3 | ✅ verified | `getTurnRequests()` (`api.js:276-285`) returns raw `content`/`target_participant_id`; `Cards.jsx:222-226` renders `.reason`/`.target` → empty bodies on initial load. |
| UF4 | ✅ verified (refs drifted) | Reset is dispatched on *every* SSE open at `app.jsx:110`; resetKey consumer is `hooks.js:24-36, 247`; gap-fill race at `app.jsx:94-103`. Original `hooks.js:369-373` reference doesn't exist in current file. |
| UF5/UF6 | ✅ not re-measured in depth | Timeline memo scale confirmed structurally (`TimelineTab.jsx` ~400-line memo present); treat perf numbers as estimates. |
| UF7 | ✅ verified | Seven CustomEvents; three unconditional timers (`app.jsx:261` 5s meetings, `hooks.js:150` 5s models, `app.jsx:11,69` 3s fallback poll); no `document.hidden` handling anywhere. |
| UF8 | ⚠️ corrected | See revised text above. Escape-stack and unnamed dismiss button confirmed. |
| UF9 | ✅ verified in substance | For "system", the main effect removes `data-theme` but the matchMedia handler (`app.jsx:190-199`) sets an explicit attribute — CSS must satisfy both selectors as claimed. |
| UF10 | ✅ spot-checked | Dead exports + duplicated HTML shell (`server.js`) confirmed present. |

### Second-pass review (2026-08-21) — previously unmeasured items

| Item | Status | Notes |
|------|--------|-------|
| UF5 | ✅ verified structurally | `flatItems` is a single `useMemo` at `TimelineTab.jsx:485` inside a 1,357-line component; per-round regrouping over `groupedContributions` with `agentErrors.filter` nested per round (`:489`). The O(rounds × contributions) rebuild-per-update characterization holds; exact perf numbers remain estimates. |
| UF6 | ✅ verified in substance | Row heights come from type-based constants via `getRowHeight()` (`:98`, used at `:889-891, 900`) — variable *per item type*, but unrelated to rendered markdown length, so long contributions still clip. Sidebar `<List height="100%">` inside auto-height parent confirmed at `Sidebar.jsx:251-259`. |
| UF10 details | ✅ verified with one correction | Markdown cache cap 200 confirmed (`Cards.jsx:8-23`); DOMPurify sanitize adds no `rel="noopener"` (no hook configured); `ThinkingCard` imported at `TimelineTab.jsx:3` but never rendered — unused-import claim correct; `SummonedResponseRow.requesterName` returns the literal `"a participant"` in **both** branches of its ternary (`Cards.jsx:394-397`) — even stronger than claimed. HTML shell drift confirmed by diffing `server.js` against `index.html`. **Correction:** `POLLING_FALLBACK_INTERVAL` is now defined only once (`app.jsx:11`) — that sub-claim is stale. |
| Fix-plan soundness | ➕ assessed | The one-store + shared-server-mapper plan remains the right shape after UF1's rewrite: normalizing turn-request rows server-side (`{participant_id, target_participant_id, reason}` from a single mapper in `api.js`) fixes UF2 and UF3 at once and prevents recurrence through either data path. No architectural obstacle found. |

## Priority & benefit

| Item | Priority | Effort | Benefit |
|------|----------|--------|---------|
| UF2/UF3 key + shape fix | P0 | S (~2–3 hrs incl. server-side row normalization) | Turn requests actually visible; kills two user-visible bugs |
| UF1 one store (revised) | P1 | M–L (2–3 days; touches both data paths) | Single place for realtime logic; kills event-ordering bugs as a class |
| UF4 refetch storm | P1 | S (half day) | Halves load-time API load; reconnects are cheap |
| UF5/UF6 timeline perf + heights | P1 | M (1–2 days) | Smooth during live 15-min meetings; no clipped content |
| UF7–UF10 | P2 | M aggregate | Accessibility, theme sanity, less dead code |

**Recommendation: carry out UF2/UF3 immediately (trivial, high user impact); UF1+UF4 together as one store refactor when Wave 2 capacity allows; defer UF7–UF10 unless dashboard work is planned anyway.**

**Post-fix grade:** A−.

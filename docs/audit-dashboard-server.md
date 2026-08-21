# Audit 10 — Dashboard Server (HTTP / SSE)

**Current grade: C− · Target grade: A−**

`Bun.serve` + SSE is a good fit for a local real-time dashboard. The issues are a leaked client registry, missing parameter validation with data-exposure consequences, and unguarded parsing that can 500 the main endpoint. (Authentication is explicitly out of scope per project direction; the fixes below assume localhost-only exposure, which makes that assumption *safe*.)

## Issues

### S1 — Disconnected SSE clients never leave the registry (major)
`src/dashboard/server.js:580`: `ReadableStream.cancel(controller)` receives the cancel *reason*, not the controller — `sseClients.get(meetingId)?.delete(controller)` deletes nothing. Disconnected clients linger until a later broadcast throws and lazy cleanup removes them (`:120-146`); for quiet meetings they persist indefinitely and receive queued writes.

### S2 — Binds all interfaces while messaging says localhost (major)
`server.js:323-325`: `Bun.serve({ port })` sets no hostname → Bun binds `0.0.0.0`; meanwhile tool output tells users to open `http://localhost:<port>` (`index.js:885`). The dashboard — including full transcripts and prompt-context blobs — is reachable from the LAN.

### S3 — Negative limit = unlimited dump (major)
`server.js:349, 478`: `Math.min(Number(limit)||100, 500)` passes negatives through; `?limit=-1` yields SQL `LIMIT -1`, which SQLite treats as unlimited — a full-table dump including `prompt_context` blobs (which contain every raw prompt sent to every agent). `offset` likewise unvalidated.

### S4 — Unguarded JSON.parse can 500 the primary endpoint (major)
`dashboard/api.js:244-245, 270-271, 383`: `JSON.parse(r.tool_calls)` / `(r.prompt_context)` unguarded, unlike every other JSON column in the same file (`cf. :123-165, :181-189`). One malformed row throws through the outer handler (`server.js:608-611`) and the entire `/api/meeting` request fails.

### S5 — SSE lacks heartbeat and backpressure (minor)
`server.js:564-592`: no comment ping on idle connections (proxies/timeouts kill them silently), and `controller.enqueue` ignores `desiredSize`, so slow clients queue unboundedly during heavy rounds.

### S6 — Asset-path check edge cases (minor)
`server.js:112-118`: `resolved.startsWith(ASSETS_DIR)` lacks a trailing-separator guard (sibling dir `.../dashboardX` passes); extension extraction via `slice(lastIndexOf("."))` returns the last char when no dot exists — safe only by accident. Symlink escape unconsidered.

### S7 — Registry/pruning leaks (minor)
Prune loop (`:301-313`) deletes state keys for client-less meetings but never removes the empty `Set` from `sseClients` — one dead entry per meeting ever connected.

### S8 — Per-poll full-table scan (minor)
Poll loop calls `api.getAgentErrors()` (full scan, `api.js:215-222`) on every change only to filter `id > prevErrorId` in JS; no `WHERE id > ?` variant exists.

### S9 — Header/CSP inconsistency (minor)
CSP applies to the HTML shell only (`server.js:334` vs `:602-604`); `/assets/*` responses carry no `nosniff`/frame headers at all.

### S10 — CommonJS require inside ESM (minor)
`api.js:661-677`: `listDownloadedModels` uses `require("os"/"path"/"fs")` in an ESM module that already imports `join` from `node:path`.

## Proposed fixes

1. **Fix client removal**: capture the controller in the stream `start()`, and in `cancel()` close via the captured reference; additionally remove clients whose enqueue throws (already partially done) and prune empty Sets.
2. **Bind explicitly**: add `hostname: "127.0.0.1"` to the `Bun.serve` options (configuration, not replacement). Make it configurable via `dashboard.host` in the loom config (default `127.0.0.1`) so the safe default ships without removing the legitimate LAN-access scenario — document that non-loopback binding re-opens the S3 exposure. This makes the out-of-scope auth decision safe by construction.
3. **Clamp pagination**: `limit = Math.min(Math.max(0, Number(limit) || 100), 500)`; same floor for offset; reject non-integers.
4. **Guard the remaining parses** with the existing safe-parse helper used elsewhere in `api.js`.
5. **Add an SSE ping**: enqueue `: ping\n\n` every ~15s per meeting with clients; skip enqueues when `desiredSize <= 0`. When a client's queue stays paused (slow consumer), drop it after a bounded timeout (e.g., 30s of `desiredSize <= 0`) rather than letting its queue grow again immediately on resume — otherwise the meeting poll loop keeps paying broadcast cost for a client that never catches up.
6. **Harden asset check**: compare against `ASSETS_DIR + sep`; derive content type from a whitelist map keyed by extension with a default of `application/octet-stream`; resolve symlinks before comparison.
7. **Delete empty sets in prune**; **add `getAgentErrorsAfter(id)`** using `WHERE id > ?`.
8. **Serve security headers on all routes** (nosniff, frame-options DENY); keep CSP as-is on HTML.
9. **Convert requires to ESM imports.**

## Justification

S2+S3 together mean any device on the network can pull complete deliberation transcripts today — that's a real exposure even for a local dev tool, fixable with two lines. S1/S5 determine whether the "real-time" dashboard actually stays connected through a 15-minute meeting behind ordinary proxies.

## Verification (2026-08-21)

| Item | Status | Notes |
|------|--------|-------|
| S1 | ✅ verified | `server.js:580-582`: `cancel(controller)` receives the cancel *reason* per the WHATWG Streams spec, so `.delete(controller)` never matches. Real bug; disconnected clients linger. |
| S2 | ✅ verified | `Bun.serve({ port })` at `:323-325` — no `hostname`, binds all interfaces while users are told to open localhost (`index.js`). Two-line fix, highest value in doc. |
| S3 | ✅ verified | `Math.min(Number(limit) \|\| 100, 500)` at `:349, 478`; SQLite treats negative LIMIT as unlimited; prompt_context blobs included unless `include_context=0`. |
| S4 | ✅ consistent | Unguarded parses at cited lines vs safe-parse pattern used elsewhere in same file. |
| S5/S6/S7 | ✅ verified | Asset prefix check without separator guard (`:112-118`); prune loop deletes state keys but not empty client Sets (`:301-313`); no SSE heartbeat/backpressure handling. |
| S8 | ✅ verified | `api.js:215-222`: full-scan `getAgentErrors()` per poll tick. Fix should ride audit 07 EH4's table consolidation. |
| S9/S10 | ✅ verified | Security headers on HTML route only; `require("os"/"path"/"fs")` at `api.js:664-680` in ESM module. |

## Priority & benefit

| Item | Priority | Effort | Benefit |
|------|----------|--------|---------|
| S2 bind localhost | P0 | S (**one line**) | LAN exposure eliminated by default |
| S3 param clamping | P0 | S (~15 min for both endpoints) | No unlimited-dump endpoint |
| S1 SSE client removal + S5 ping | P0/P1 | M (half day incl. backpressure) | Reliable live updates through 15-min meetings |
| S4 guarded parses | P0 | S (minutes) | Main endpoint survives corrupt rows |
| S6–S10 | P2 | M aggregate | Hygiene; faster polls; smaller surface |

**Recommendation: carry out S2+S3+S4 today — under an hour combined and they close a real network exposure plus two crash paths. S1/S5 matter most for the flagship "watch a live meeting" scenario.**

### Second-pass review (2026-08-21) — fix-plan soundness

- **S2 caveat worth documenting:** binding `127.0.0.1` breaks one legitimate scenario — opening the dashboard from a phone/second machine on the LAN, which some users may currently rely on. Make it configurable (`dashboard.host`, default `127.0.0.1`) rather than hardcoded, so the safe default ships without removing the capability; document that non-loopback binding re-opens the S3 exposure.
- **S1 fix shape confirmed:** capturing the controller in `start()` and deleting the captured reference in `cancel()` is correct per WHATWG streams semantics (`cancel(reason)` receives the reason). The broadcast-time lazy cleanup already present remains as belt-and-braces.
- **S5 backpressure nuance:** with Bun's default queuing strategy `desiredSize` reflects the stream's internal queue; skipping enqueue when `desiredSize <= 0` is right, but the client should then also be *dropped* (slow-consumer policy) rather than left to resume — otherwise a paused tab's queue grows again immediately on resume and the meeting poll loop keeps paying broadcast cost for a client that never catches up.
- **S8 rides EH4:** confirmed the `WHERE id > ?` variant belongs in the audit 07 table-consolidation change, avoiding two schema-touching PRs.

**Post-fix grade:** A−.

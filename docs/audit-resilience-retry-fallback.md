# Audit 09 — Resilience (Retry / Fallback / Circuit Breaker)

**Current grade: B− · Target grade: A**

This is the best-engineered subsystem in the project: `withRetry` with exponential backoff + jitter and a proper retryable-error classifier (`utils/retry.js:60-96`), a half-open circuit breaker per model (`retry.js:102-160`), unhealthy-model pre-check with immediate fallback (`round-executor.js:1060-1070`), fixed-attempt fallback loops with documented off-by-one fixes, and breaker reset on transient success. The remaining issues are consistency nits — which is exactly why they're worth fixing before they calcify.

## Issues

### R1 — Watchdog double-start silently extends deadlines (minor)
`services/stall-watchdog.js:40-61`: calling `start()` while running resets `#lastActivityAt` and re-reads config but keeps the *first* interval closure. A second `start()` therefore extends the stall deadline without any indication. (Full treatment in audit 05, LS5.)

### R2 — Docs/code contradiction on adaptive timeout (minor)
`ORCHESTRATION_ARCHITECTURE.md` §5 claims timeouts are "reduced by up to 50% as more agents fail"; the code comment at `round-executor.js:1000-1001` says "Fixed timeout — no reduction when failing (previously punished survivors)". The code is right; the doc describes removed behavior.

### R3 — Inconsistent config freshness for circuit-breaker settings (minor)
The breaker is constructed once from `getConfig().circuitBreaker` (`round-executor.js:63-67`) while `#recordModelFailure` re-reads config per call (`:94-101`). If config were hot-reloaded or instance-threaded (audit 08), thresholds could disagree between construction and reporting.

### R4 — Swallowed breaker-reset errors (minor)
`round-executor.js:1120-1122`: `try { this.#circuitBreaker.recordSuccess(activeModel); } catch {}` — recordSuccess cannot realistically throw; the empty catch adds noise and hides nothing real, but it perpetuates the swallow idiom flagged in audit 07.

### R5 — Retry classification gaps (minor)
`isRetryableError` matches ECONNREFUSED/ETIMEDOUT/ENOTFOUND, message-based timeout regex, 5xx, 429. Missing common cases: `ECONNRESET`, `EPIPE`, 408. These currently fall through to non-retryable and burn a fallback attempt instead of a cheap retry.

## Proposed fixes

1. **Watchdog idempotent start** (see audit 05 fix 4).
2. **Fix the architecture doc** to describe the fixed-timeout behavior (handled in audit 15).
3. **Single config read**: pass breaker thresholds into `RoundExecutor` options once; remove the per-call `getConfig()` in `#recordModelFailure`.
4. **Drop the pointless try/catch** around `recordSuccess`.
5. **Extend `isRetryableError`**: add `ECONNRESET`, `EPIPE`, HTTP 408. Three lines, fewer unnecessary model fallbacks.

## Justification

Resilience code only stays trustworthy if its story is uniform. R3/R4 are small now but become bugs the moment audit 08's instance-config lands. R5 has direct cost impact: every misclassified transient error triggers a full fallback-model attempt (new session, new prompt) instead of an 8s retry.

## Verification (2026-08-21)

| Item | Status | Notes |
|------|--------|-------|
| R1 | ✅ verified | See audit 05 LS5 — confirmed, including the reset-before-guard ordering. |
| R2 | ⚠️ line drift only | Comment now at `round-executor.js:1120` (was :1000-1001); text verbatim: "Fixed timeout — no reduction when failing (previously punished survivors)". Doc contradiction stands. |
| R3 | ✅ consistent | Breaker construction/per-call config split matches surrounding code. |
| R4/R5 | ✅ verified | `isRetryableError` (`retry.js:25`) matches ECONNREFUSED/ETIMEDOUT/ENOTFOUND + message/5xx/429 only — no `ECONNRESET`, `EPIPE`, or 408. |

## Priority & benefit

| Item | Priority | Effort | Benefit |
|------|----------|--------|---------|
| R5 classifier extension | P1 | S (**three lines**) | Cheaper recovery from common transient faults; fewer full fallback-model attempts |
| R1 watchdog idempotency | P1 | S (reorder two statements) | No silent deadline extensions |
| R3 single config read | P2 | S | Consistency with future config threading |
| R2 doc fix | P2 | S (minutes; ride DOC5) | Honest docs |

**Recommendation: carry out R5+R1 opportunistically whenever Wave 1 touches round-executor/watchdog anyway. Best-engineered subsystem in the repo — the goal here is just keeping it that way.**

**Post-fix grade:** A.

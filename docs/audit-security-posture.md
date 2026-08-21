# Audit 12 — Security Posture (Non-Auth)

**Current grade: D+ · Target grade: A−**

Authentication is out of scope by project decision (and becomes safe-by-default once the dashboard binds to localhost — see audit 10, S2). This audit covers everything else: prompt injection, sanitizer correctness, supply-chain integrity for downloaded models, and path handling.

## Issues

### SEC1 — Heading injection into highest-authority prompts (major)
Moderator and synthesizer prompts interpolate raw contribution text with only `<<<>>>` escaping (`prompts.js:459-464`, `:638-639`). A participant (or a webfetched page quoted into evidence) containing forged `##` headings can inject structure under the moderator's rubric or the synthesis artifact's required sections. The correct primitive — `delimitContext` — exists but is only used in `buildAgentUserPrompt`. Full treatment: audit 02, P5.

### SEC2 — Sanitizer corrupts legitimate content (major)
`src/utils/sanitize.js`: `sanitizeForPrompt` strips **all** `[ ] { }` from user question/context — destroying code arrays and markdown links; its `\x00<index>\x00` sentinel scheme is forgeable by input containing literal NUL-delimited digits, and an out-of-range index splices the literal string `"undefined"` into output (`:26-29`). Length truncation happens *after* restoration. Separately `escapeDelimiters` rewrites `>>>` in legitimate JS (unsigned right shift) into fullwidth characters, silently corrupting quoted code.

### SEC3 — Stale directive whitelist survives sanitization (minor)
The directive whitelist preserves `[NEXT:…]` patterns the parser abandoned (`sanitize.js:7` vs `schemas.js`) — dead surface that still shapes what users may write.

### SEC4 — Model download integrity is size-only (major)
`scripts/model.mjs:98-106`: download verification compares byte counts against `content-length`; no sha256 pinning or HF revision/etag lock for ONNX weights and `tokenizer.json` fetched over redirect-following HTTPS. A compromised CDN hop or hijacked repo yields executable-adjacent binaries loaded by `onnxruntime-node`.

### SEC5 — Path-handling edge cases (minor)
Asset serving prefix check without separator guard + accidental extension extraction (`server.js:112-118`), symlink escape unconsidered; `limit=-1` full-dump exposure of prompt-context blobs is treated in audit 10 (S3).

### SEC6 — Unvalidated allowlist interpolated into prompts (minor)
`agentTools.builtIn.bash.allowlist` contents pass validation untouched yet are embedded verbatim in system prompts (`prompts.js:730`) — a config-file vector for instruction injection.

## Proposed fixes

1. **Fence, don't mangle**: replace bracket-stripping with strict delimiter fencing — wrap untrusted blocks in `delimitContext` everywhere (audit 02 fix 5) and drop `[ ] { }` stripping entirely. Keep only control-character removal. **However**, fencing prevents *structural* injection (forged headings/sections) yet bracket-tag text still reaches the model, where weaker models may obey a fenced-but-plausible `[DISSENT]` embedded in user context. Add a *narrow* directive neutralizer that breaks only line-start directive-looking tokens in user-supplied blocks (e.g., zero-width joiner after a leading `[`), rather than global bracket destruction. This preserves code/links while closing the imitation vector. This fixes both corruption and injection with less code.
2. **Harden escapeDelimiters**: use unique random per-prompt sentinels instead of fixed `\x00N\x00`; validate index bounds before restoration; truncate before escaping.
3. **Delete the stale whitelist entries**.
4. **Pin model integrity**: record sha256 + HF revision in `model.json` at download; verify on load; fail loudly on mismatch. Use the existing `crypto` module — no new dependencies.
5. **Asset serving hardening** per audit 10 S6; validate allowlist as string array during config validation (audit 08 C2).

## Justification

This project's threat model is unusual: the "untrusted input" includes LLM output from arbitrary models and web-fetched evidence, injected directly into prompts that decide when deliberation ends and what the final artifact says. SEC1+SEC2 mean the current defenses are simultaneously too weak (headings) and too strong (bracket destruction) at the same time. All fixes are local code changes plus standard-library hashing.

## Verification (2026-08-21)

| Item | Status | Notes |
|------|--------|-------|
| SEC1 | ✅ verified | Moderator/synthesizer prompts interpolate with only `escapeDelimiters`+`sanitizeForDisplay` (see audit 02 P5 check). Note the loom_* tool migration widened this surface: tool outputs are now also synthesized into prompts. |
| SEC2 | ✅ verified | `sanitize.js`: `[\[\]{}]` stripping confirmed; `\x00<index>\x00` sentinels forgeable by literal NUL-delimited input; out-of-range index splices `"undefined"` (replace callback returns `undefined` → literal string); truncation after restoration (`return sanitized.slice(0, maxLen)` last line of `sanitizeForPrompt`). |
| SEC3 | ✅ verified, updated | Whitelist preserves `[YIELD]`, `[CONTEST…]`, `[NEXT:…]`, and now also `[CALL_VOTE]`/`[REQUEST_NEXT:]` — the former two are dead parser history, the latter two are deprecated-but-fallback-supported per `docs/tool-interactions-as-tools.md`. Prune to migration-fallback tags only. |
| SEC4 | ✅ consistent | Size-only verification matches surrounding script code; no sha256/revision pinning found. |
| SEC5/SEC6 | ✅ verified via audits 10/08 | See those docs' verification tables. |

## Priority & benefit

| Item | Priority | Effort | Benefit |
|------|----------|--------|---------|
| SEC1 delimiting everywhere | P0 | S–M (~half day shared with audit 02 P5 — same fix) | Highest-authority prompts resistant to structured injection |
| SEC2 sanitizer rewrite ("fence, don't mangle") | P0 | M (1 day incl. golden-file tests for sanitize round-trips) | Legitimate content survives; forgeable sentinels gone; *less* code than today |
| SEC4 checksum + revision pinning | P1 | S–M (crypto is stdlib) | Supply-chain integrity for model weights |
| SEC3 whitelist pruning | P2 | S (minutes) | Dead surface removed |
| SEC5/SEC6 | P2 | S (ride audits 10/08 fixes) | Smaller surface |

**Recommendation: carry out SEC2 with audit 07's helper work in Wave 2 and write its tests first (testing Phase 1) — the sanitizer is exactly the kind of function where a regression silently breaks every prompt. SEC1 shares a single PR with audit 02 P5.**

### Second-pass review (2026-08-21) — fix-plan soundness

- **SEC2 residual risk, stated honestly:** "drop `[ ] { }` stripping entirely" is correct for *content preservation* but transfers all injection defense to delimiter fencing. Fencing prevents *structural* injection (forged headings/sections) yet the bracket-tag text itself still reaches the model, where weaker models may obey a fenced-but-plausible `[DISSENT] ...` embedded in user context. Mitigation: keep a *narrow* neutralization pass that breaks only line-start directive-looking tokens in user-supplied blocks (e.g., zero-width joiner after a leading `[`), rather than global bracket destruction. This preserves code/links while closing the imitation vector. The audit's direction stands; this refinement should be folded into the rewrite.
- **SEC1 + tool migration interaction:** loom_* tool outputs are now synthesized into prompts and can carry web-fetched content; when wrapping moderator/synthesizer interpolations in `delimitContext`, tool-result text must be included in the same fencing treatment or the fix is incomplete.
- **SEC4 feasibility:** sha256 pinning via `crypto` is confirmed realistic — downloads already stream to disk, so hashing is a wrap-around change; HF revision lock requires storing the resolved commit SHA at download time (available from the redirect target URL), which fits the existing `model.json` metadata pattern proposed by audit 06 V1 — do both metadata extensions in one schema change.

**Post-fix grade:** A− (localhost binding from audit 10 closes the network story).

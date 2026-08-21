# Audit 15 — Documentation Accuracy

**Current grade: C− · Target grade: A**

The documentation volume is a genuine strength — `ORCHESTRATION_ARCHITECTURE.md` is a real technical reference, and the README's "Known Limitations" section is honest and unusually good. The problem is accuracy drift: several load-bearing claims are wrong *today*, in both directions (describing removed behavior, miscounting shipped data).

## Issues

### DOC1 — Persona census wrong (minor)
`README.md:190-199`: claims 91 personas (junior 14 / mid 15 / senior 11 / principal 9 / civilian 42). Actual count is **89** (junior 15 / mid 14 / civilian 40). The table is the first thing a contributor auditing the catalog checks.

### DOC2 — Config precedence claim false (major)
`README.md:223`: says config works "via a `"loom"` key in your `opencode.json`" — but project-level `opencode.json` is never consulted (`config.js:281-317`, see audit 08 C1). Users following the README get silently ignored settings.

### DOC3 — Stale TIER_CONFIG warning (minor)
`README.md:209`: "`civilian` tier maps to mid temperature pending explicit `TIER_CONFIG` entry in `src/shared.js`" — no `TIER_CONFIG` exists anywhere; `utils/tier.js` handles civilian explicitly. The warning describes a refactored-away implementation detail.

### DOC4 — Dangling doc references (minor)
README cites `docs/dead-code-review.md` (`:88`) and `docs/metrics-and-observability.md` (`:249`) which do not exist locally or in the repo (see audit 14 RH3).

### DOC5 — Architecture doc describes removed timeout behavior (minor)
§5 claims agent timeouts are "reduced by up to 50% as more agents fail"; code comment at `round-executor.js:1000-1001` documents fixed timeouts ("previously punished survivors"). Doc contradicts code in the exact subsystem people tune.

### DOC6 — RAG bound misstated (minor)
§5/§4 say retrieval returns "up to 5 chunks"; the call site requests 10 (`round-executor.js:1022`). Small, but it changes token-budget reasoning for anyone sizing prompts from the docs.

### DOC7 — domains.json role misstated (minor)
README:199 says `domains.json` "defines the tag vocabulary"; nothing reads it as data (audit 03 PC4). §Persona-Structure of the architecture doc correctly disclaims it ("not part of the selection pipeline") — the two documents disagree with each other *and* one of them is wrong.

### DOC8 — Unreachable statuses documented as live (minor)
Both README:256 and architecture §3 list `exhausted`/`deadlocked` in the status schema; §10 admits they are "reserved… not produced by current orchestration paths." The schema line presents them without that caveat.

### DOC9 — Architecture doc still documents the bracket-tag protocol (major, added 2026-08-21)
`ORCHESTRATION_ARCHITECTURE.md` §4 presents a system-prompt example built on `[QUERY]/[EVIDENCE]/[SUMMON]/[CALL_VOTE]/[REQUEST_NEXT]` bracket directives, and §22 documents them as the live contract. The shipped prompt (`prompts.js:805-817`) instead directs agents to `loom_query`/`loom_evidence`/`loom_vote`/`loom_summon`/`loom_request_next` **tools** and explicitly deprecates bracket tags (see `docs/tool-interactions-as-tools.md`). The single most-read technical reference describes a superseded interaction protocol. Related: the same sections' "no persistent agent sessions" and golden-sandwich descriptions should be re-diffed against `session-contract.js` while regenerating.

## Proposed fixes

1. **Generate the census**: a tiny script (or extend existing persona tooling) that counts JSON files per tier and rewrites the README table block between markers. Counts can never drift again.
2. **Fix README config section** to describe actual resolution order (after audit 08 fix lands, describe the merged rule).
3. **Delete DOC3's stale sentence**; point to `utils/tier.js` behavior.
4. **Remove dangling references** or replace them with this audit series.
5. **Correct DOC5/DOC6** to match code (fixed timeouts; top-k 10).
6. **Add a "docs truth" convention**: any PR that changes turn-taking, termination, timeouts, or selection must update the matching ORCHESTRATION_ARCHITECTURE section in the same PR; keep the "last verified" version stamps per section (already present at the header — extend per-section).

## Justification

Docs are this project's interface to contributors and to future-you. Wrong claims about config precedence and timeout behavior cause misconfiguration and mistuning — failures that look like bugs but are documentation. The fixes are cheap; the convention is the durable part.

## Verification (2026-08-21)

| Item | Status | Notes |
|------|--------|-------|
| DOC1 | ✅ verified exactly | Measured census: junior 15 / mid 14 / senior 11 / principal 9 / civilian 40 = **89** (README claims 91 with different per-tier splits; the 90th JSON is `domains.json`, not a persona). |
| DOC2 | ✅ verified | `findConfigFile` (`config.js:281-317`) never consults project-level `opencode.json`. |
| DOC3 | ✅ verified | No `TIER_CONFIG` in `src/shared.js`; `utils/tier.js:33-67` handles civilian explicitly. |
| DOC4 | ✅ verified | Neither cited doc exists locally; note `/docs` is also gitignored (audit 14 RH3). |
| DOC5 | ⚠️ line drift | Code comment now at `round-executor.js:1120` (not :1000-1001); claim itself confirmed verbatim. |
| DOC6 | ✅ verified | `retrieveRelevant(queryText, 10, currentRound)` at `round-executor.js:1142`; default top-K remains 5 in `vector-index.js:94`. |
| DOC7 | ✅ consistent | Cross-checked against composer — nothing reads `domains.json` as data. |
| DOC8 | ✅ verified | Caveat appears only in §10 prose, not the schema lines. |
| DOC9 | ➕ added | New finding from verification pass; see above. |

## Priority & benefit

| Item | Priority | Effort | Benefit |
|------|----------|--------|---------|
| DOC2 config truth | P0 (paired with audit 08 C1) | S | Users' configs actually work |
| **DOC9 regenerate architecture §4/§22 for loom_* tools** | P0 (new) | M (half day–1 day; careful diff of builders) | Primary technical reference matches shipped behavior |
| DOC1 census generator | P1 | S (~2 hrs incl. marker script) | Self-maintaining accuracy |
| DOC5/DOC6 corrections | P1 | S (minutes) | Tuning decisions based on reality |
| DOC3/4/7/8 cleanups + docs-truth convention | P2 | S | Internal consistency |

**Recommendation: carry out DOC9 and DOC2 first — both are trust-critical and cheap relative to their blast radius. Adopt the "docs truth" convention immediately (it costs nothing) so this audit doesn't need a third pass.**

**Post-fix grade:** A−.

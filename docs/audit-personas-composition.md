# Audit 03 — Persona System & Room Composition

**Current grade: D+ · Target grade: A−**

89 well-structured persona JSONs with a uniform schema (verified: all share the same 12-key shape) is a real asset. But the selection pipeline squanders it: your largest tier cannot be auto-selected, similarity has no quality floor, and the shipped vocabulary file is dead weight.

## Issues

### PC1 — Civilian tier unreachable via auto-composition (critical)
`src/composer.js:228-250`: `generateRolesFromComplexity`/`applySeniorityBoost` emit only junior/mid/senior/principal — the tier list at `:241` excludes `civilian`. **40 of 89 personas can never be selected automatically**; they are only reachable via hand-built rooms. Dead inventory masquerading as features.

### PC2 — No relevance floor on persona selection (major)
`src/database.js:1220-1226` + `src/composer.js:364-368`: `searchPersonaEmbeddings` returns pure top-K by distance and the composer takes the first unused candidate regardless of score. An off-topic question still seats a full room; distances are never logged, so selection quality is unmeasurable.

### PC3 — Metadata filter inside KNN query can silently fail (major)
`src/database.js:1224`: `WHERE v.tier = ?` inside the sqlite-vec KNN query errors on older sqlite-vec builds; combined with the catch-all at `database.js:1227-1230` (returns `[]`), selection invisibly downgrades to tag matching.

### PC4 — `domains.json` is dead weight (minor)
The vocabulary (~200 keywords) is never read as data — its only consumer is an `existsSync` probe (`composer.js:20`). The 427 actual freeform persona tags are nearly disjoint from it. README's claim that it "defines the tag vocabulary" is false.

### PC5 — Keyword fallback is low-quality (minor)
Substring matching (`haystack.includes(token)`, `composer.js:433,436`) produces false positives ("rate" matches "generate"); dedupe is by display name only across tiers (`:300/:368`); no tag-diversity mechanism beyond per-tier quotas. The >5-role branch (`:235-237`) is dead because `count` clamps to 5 first (`:291-297`).

### PC6 — Data integrity nits (minor)
`personas/senior/../cfo.json:24` ships a truncation artifact (dangling quote, cut-off sentence). `scripts/update-persona-tags.js:20` contains `" devil advocacy"` with a leading space in TAG_MAP — re-running the script would write the malformed tag into the shipped data.

### PC7 — `tier_guidance` boilerplate duplicates doctrine (minor)
Persona `tier_guidance` largely restates `buildTierDoctrine` strings verbatim (e.g., `personas/principal/cfo.json` repeats the exact principal doctrine from `prompts.js:138`). Double-maintenance for zero differentiation.

## Proposed fixes

1. **Add civilian to composition**: extend the role-plan generator with civilian slots (e.g., low-complexity rooms get one generalist; civilian maps to mid seniority as `utils/tier.js` already treats it). This instantly makes 45% of the persona pool useful.
2. **Similarity threshold + logging**: reject candidates above a configurable max distance (default ~0.85 cosine distance); log selected distances per seat; if a tier has no candidate under threshold, fall back to a *deliberate* generalist pick with a progress message rather than an arbitrary nearest neighbor.
3. **Post-filter instead of in-query metadata filter**: run KNN without `WHERE v.tier`, filter by tier in JS over the top-50. Works on every sqlite-vec build; delete the silent `catch → []`.
4. **Decide domains.json's fate**: either wire it as a real fallback keyword index for when embeddings are unavailable, or delete it and fix the README claim.
5. **Harden fallback matching**: word-boundary regex tokens; dedupe by normalized id across tiers; remove the dead >5 branch or make the clamp honest.
6. **Data lint pass**: fix `cfo.json` truncation, fix the TAG_MAP space, add a tiny validation step to existing scripts (no new deps) that fails loudly on malformed persona fields.
7. **Differentiate `tier_guidance`**: strip doctrine-restating text from personas; keep only persona-specific guidance. Doctrine lives in prompts.js alone.

## Justification

PC1 means the headline feature ("auto-composed rooms") draws from barely half the catalog. PC2/PC3 mean room composition quality is unknown and silently degradable — this is the entry point of the entire product, and it currently has no quality floor. All fixes are local JS changes plus data edits; no new dependencies.

## Verification (2026-08-21)

| Item | Status | Notes |
|------|--------|-------|
| PC1 | ✅ verified | `generateRolesFromComplexity` (`composer.js:228-238`) emits only junior/mid/senior/principal; `applySeniorityBoost` tier list (`:246`) also excludes civilian. 40 of 89 personas auto-unreachable. |
| PC2 | ✅ verified | `composer.js:364-368`: first-unused-candidate selection with no distance floor; distances never logged. |
| PC3 | ✅ verified | `database.js:1224`: `WHERE v.tier = ? AND v.embedding MATCH ? AND k = ?` — metadata filter inside the KNN query; catch-all returns `[]` at `:1227-1230`. |
| PC4/PC5/PC6/PC7 | ✅ consistent | Keyword substring matching confirmed at `composer.js:433-437` (`.includes(token)`); census verified at 89 (15/14/11/9/40) in the DOC1 check. |

### Second-pass review (2026-08-21)

| Item | Status | Notes |
|------|--------|-------|
| PC5 clamp | ✅ verified exactly | `composer.js:306`: `count = Math.max(2, Math.min(7, getDefaultCount(complexity)))` where `getDefaultCount` maxes at 5 — the 7-role branch in `generateRolesFromComplexity` is unreachable, as claimed. |
| PC6 | ⚠️ **path corrected** | The truncated persona is at `personas/principal/cfo.json` (**not** `personas/senior/`). The file parses as valid JSON (no dangling-quote syntax error), but its `tier_guidance` contains a garbled mid-sentence quoted fragment ("turn "Force decisions through the lens of ROI, capital allocation " into one measurable claim") consistent with a truncation/edit artifact. Substance stands; description refined. |
| PC6 TAG_MAP | ✅ verified exactly | `scripts/update-persona-tags.js:20` ships `" devil advocacy"` with the leading space. |
| PC7 | ⚠️ **partially superseded** | `buildTierDoctrine` (`prompts.js:132-149`) has been refactored since the audit: it now wraps a tier doctrine line *and appends* persona `tier_guidance` as voice ("Guidance is already persona-specific and now diversified"). The claimed verbatim duplication no longer exists mechanically. However, cfo.json's guidance is still a paraphrase of the principal doctrine rather than persona-specific voice, so the drift risk survives in weaker form — recommend the data-lint pass include a "guidance must not restate doctrine" heuristic rather than a mechanical strip. |
| Fix 1 note | ➕ validated | The proposed "low-complexity rooms get one generalist" mapping is coherent with `utils/tier.js`, which already ranks civilian as mid-equivalent. |

## Priority & benefit

| Item | Priority | Effort | Benefit |
|------|----------|--------|---------|
| PC1 civilian tier in composition | P0 | S–M (~half day; role plans + boost map + tests via testing Phase 1) | 45% of persona pool becomes selectable; better rooms |
| PC3 post-filter instead of in-query filter | P1 | S (top-50 fetch + JS filter) | Vector selection works on all sqlite-vec builds |
| PC2 threshold + distance logging | P1 | S–M (needs a deliberate-generalist fallback design) | Measurable, bounded composition quality |
| PC4 domains.json decision | P2 | S | Removes false README claim + dead code |
| PC5/PC6 data lint + fallback hardening | P2 | S | Data integrity; smaller drift surface |
| PC7 tier_guidance dedup | P2 | M (touches 89 files or ships as loader-time strip) | Single-source doctrine |

**Recommendation: carry out PC1+PC3 together — combined roughly a day and they convert the headline feature ("auto-composed rooms") from half-broken to trustworthy. PC2's threshold needs a small design decision (what happens when no candidate passes) so schedule it with a reviewer available.**

**Post-fix grade:** A−.

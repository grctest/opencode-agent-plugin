# Audit 14 — Repo Hygiene & Packaging

**Current grade: D+ · Target grade: A**

Small items, but they are the first things any new contributor or publish pipeline touches.

## Issues

### RH1 — Placeholder copyright (minor)
`LICENSE:3`: "Copyright (c) 2026 R" — placeholder never filled in.

### RH2 — Manifest gaps (minor)
`package.json` lacks `engines`, `repository`, `author`, `license` field, `files`, and `types`. Peer/dev version skew: peers `^1.18.15` vs devDependencies `^1.18.16`. Non-standard `allowScripts` block sits at top level (fine for some tooling, undocumented here). `"main": "dist/loom.js"` points at a build artifact absent on fresh clone until `npm run bundle`.

### RH3 — Docs gitignored yet cited; some citations dangling (major)
`.gitignore:3` ignores `/docs`, yet README cites `docs/dead-code-review.md` and `docs/metrics-and-observability.md` (`README.md:88,249`) — files that no longer exist even locally (docs/ currently holds only two other files). Anyone cloning gets broken links and no docs directory in the repo.

### RH4 — Runtime artifacts tracked (minor)
`.opencode/loom/session-index.json`, root `loom/session-index.json`, and `testing/.opencode/` are committed/tracked — runtime state that will churn diffs and cause merge noise.

### RH5 — Check coverage mismatched to risk (minor)
`npm run check` hand-lists six files for `node --check`; the seven plain-JS scripts in `scripts/` — which contain the crash bugs from audit 13 — are excluded, as is everything else in src not on the list. `jsconfig.json:17-18` enables strict + checkJs but covers `src/**/*` only; the `DOM` lib is unnecessary for a Node-target plugin.

## Proposed fixes

1. **Fill in LICENSE** with the real holder.
2. **Complete the manifest**: add `engines` (bun-compatible node ≥18), `repository`, `author`, `"license": "MIT"`, `files` whitelist (dist, personas, commands), align peer/dev versions to the same minor. Keep `main` pointing at dist but add a `prepare`-style note or make `bundle` part of install flows (already is via `install:plugin`).
3. **Track docs**: remove `/docs` from `.gitignore`, delete or fix the two dangling README references (this audit series can replace them).
4. **Untrack runtime state**: add `.opencode/loom/`, `/loom/`, `testing/.opencode/` patterns to `.gitignore` and `git rm --cached` the tracked artifacts.
5. **Widen cheap checks**: make `check` iterate all of `src/**` plus `scripts/*.mjs|js` programmatically instead of a hand-list; scope jsconfig to Node libs and include `scripts/`.

## Justification

RH3 actively misleads users following README instructions today. RH2 blocks clean publishing/consumption. All fixes are minutes of work with zero code risk.

## Verification (2026-08-21)

| Item | Status | Notes |
|------|--------|-------|
| RH2/RH5 | ✅ verified | Manifest gaps confirmed in `package.json` (no engines/repository/author/license/files/types; peer `^1.18.15` vs dev `^1.18.16`); `check` hand-list confirmed. |
| RH3 | ✅ core claim verified, one correction | `.gitignore:3` ignores `/docs` while README cites two nonexistent docs — confirmed. **Correction:** "docs/ currently holds only two other files" is stale; docs/ now holds 20 files including this 19-document audit series. The important implication is bigger than originally stated: **the entire audit series is currently untracked and would not ship with the repo** — fixing RH3 is what makes these documents durable. |
| RH4 | ✅ verified | `loom/session-index.json`, root `loom/`, and `testing/.opencode/` present as tracked runtime state (testing/ contains nothing else). |

### Second-pass review (2026-08-21)

- **RH4 refined via git:** `git ls-files` confirms `.opencode/loom/session-index.json` and `loom/session-index.json` are tracked; no `testing/` paths are tracked (that directory's `.opencode` content is untracked) — so the untrack fix covers two confirmed files plus a preventive pattern.
- **RH1 verified exactly:** `LICENSE:3` reads `Copyright (c) 2026 R`.
- **Fix-plan soundness:** all five proposed fixes remain correct and trivial-risk. One addition: when untracking runtime state, also add `.loomrc.json` to `.gitignore` guidance *or* explicitly decide it is project-committed config — currently nothing documents the intent, and the C1 fix (audit 08) will make project-level config meaningful, at which point teams will want a documented convention.

## Priority & benefit

| Item | Priority | Effort | Benefit |
|------|----------|--------|---------|
| RH3 track docs / fix refs | P0 | S (**one .gitignore line + minutes**) | Documentation — now including the audit series — actually ships |
| RH4 untrack runtime state | P1 | S (minutes incl. `git rm --cached`) | Clean diffs; no merge churn |
| RH2 manifest completion | P1 | S (~1 hr) | Publishable, installable-by-default package |
| RH1 LICENSE + RH5 check widening | P2 | S | Professional finish; checks cover where bugs live (ride testing Phase 4) |

**Recommendation: carry out everything — total effort is under half a day for the whole document. RH3 first, since it gates whether any of this audit work survives a fresh clone.**

**Post-fix grade:** A.

# Audit 13 — Install / Update / Distribution Scripts

**Current grade: D · Target grade: A−**

The installer's ambitions are good (config detection, model download, persona deployment). But the update flow can destroy a working installation, and the model downloader contains a crash bug on its own warning path.

## Issues

### SC1 — Downloader crashes on missing metadata; spurious install warnings (critical)
`scripts/model.mjs:137`: `logWarn(...)` is called but never imported (imports at `:18` are only `logInfo, logError`) — any model whose `model_max_length` is missing/placeholder throws ReferenceError instead of taking the coded 512 fallback. Additionally `:170-174` treats "already downloaded" as `process.exit(1)`, so `install.mjs:234-237` logs a spurious WARN on every re-install.

### SC2 — Update deletes before installing, with no rollback, and without rebuilding (major)
`scripts/update.mjs:175-193`: `cleanOldInstallation` removes the installed plugin, commands, and personas *before* spawning install — if `dist/loom.js` is stale or absent the user ends up broken with no rollback path. Worse, `package.json:12` runs `update:plugin` **without** a bundle step (unlike `install:plugin` at `:11`), so updating reinstalls whatever old `dist/loom.js` happens to be on disk.

### SC3 — Overzealous cleanup regex (minor)
`scripts/utils.mjs:76`: fallback pattern `/^(knit|loom)_/` can delete user-authored command files that happen to share the prefix during updates.

### SC4 — Persona redeploy destroys user edits without backup (minor)
`scripts/install.mjs:102-108`: `rmSync`s the deployed personas tree on every run. Users who customized deployed personas lose their edits silently (bundled personas are also overwritten by design on reinstall).

### SC5 — Pinning and environment assumptions (minor)
`install.mjs:246` pins `onnxruntime-node@^1.27.0` / `tokenizers@^0.1.3` but leaves `sqlite-vec` fully unpinned in native-dep installs; both `execSync("npm …")` calls assume npm-on-PATH POSIX environments.

### SC6 — Build externals verified correct (context)
`scripts/build.mjs:46-53,65`: esbuild externals correctly cover `onnxruntime-node`, `@huggingface/tokenizers`, `sqlite-vec`, `bun:sqlite` for both bundles — listed here so nobody "fixes" them later.

## Proposed fixes

1. **Fix SC1 immediately**: import `logWarn`; return success (exit 0) with an "already present" message when files verify.
2. **Safe update sequence**: bundle → build to temp dir → verify (`node --check dist/loom.js`, file sizes > 0) → atomic swap (rename old to `.bak`) → install → on failure restore `.bak`. Add `npm run update:plugin` = `bundle && update` so updates always ship current code.
3. **Constrain cleanup**: delete only files matching a known manifest of shipped command/persona filenames rather than a prefix regex.
4. **Back up personas**: copy existing deployed personas to `personas.bak-<timestamp>/` (or merge: keep user files whose names don't exist in the bundle).
5. **Pin sqlite-vec** alongside the other natives; use `process.platform` checks with clear errors where npm/POSIX assumptions bite.

## Justification

SC1 means the default-model bootstrap can crash mid-install for users with unusual network responses — the exact moment you least want a stack trace. SC2 is the difference between "update tool" and "footgun"; the fix is pure script sequencing using facilities already present (esbuild, fs rename).

## Verification (2026-08-21)

| Item | Status | Notes |
|------|--------|-------|
| SC1 | ✅ verified exactly | `model.mjs` imports only `logInfo, logError` (`:18`) yet calls `logWarn(...)` in the maxTokens fallback path → ReferenceError instead of the coded 512 fallback. "Already downloaded" → `logError` + `process.exit(1)` → spurious WARN spam via `install.mjs:234-237`'s catch. |
| SC2 | ✅ verified exactly | `update.mjs:175+` runs `cleanOldInstallation` before spawning install with no rollback; `package.json` `"update:plugin": "node scripts/update.mjs"` — no bundle step (vs `install:plugin` which chains one). |
| SC3 | ✅ verified | `utils.mjs:76`: `/^(knit|loom)_/` fallback regex confirmed. |
| SC4/SC5/SC6 | ✅ verified | Persona tree `rmSync` on every install; `sqlite-vec` unpinned in the runtime-deps execSync while the other natives are pinned; build externals correct as documented. |

## Priority & benefit

| Item | Priority | Effort | Benefit |
|------|----------|--------|---------|
| SC1 import + exit codes | P0 | S (**two lines**) | Installer stops crashing/warn-spamming |
| SC2 safe update w/ rollback + bundle chaining | P0 | M (half day–1 day: temp build, verify, `.bak` swap, restore-on-fail) | Updates can't brick installations |
| SC3 manifest-based cleanup | P1 | S | User command files survive updates |
| SC4 persona backup | P1 | S | User edits preserved |
| SC5 pinning/platform guards | P2 | S | Reproducible native deps |

**Recommendation: carry out all of SC1–SC4. This is the most user-facing audit in the series — every install and update flows through it — and SC1 is literally a two-line fix for a guaranteed crasher on the default-model bootstrap path. Add the TC6 smoke test when landing SC2 so the sequencing can't regress.**

**Post-fix grade:** A−.

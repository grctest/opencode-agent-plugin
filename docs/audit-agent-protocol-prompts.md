# Audit 02 — Agent Protocol & Prompt Engineering

**Current grade: C+ · Target grade: A−**

The contribution contract (`[PROPOSE]…[PASS]`, `[REQUEST_NEXT]`, `[QUERY]/[EVIDENCE]/[SUMMON]/[CALL_VOTE]`) is a genuinely good design, and the golden-sandwich user prompt with delimited untrusted blocks is the right pattern. But rules are inconsistent across builders, a headline feature is invisible to agents, and the two most consequential prompts (moderator, synthesizer) lack the delimiting discipline applied elsewhere.

## Issues

### P1 — ~~`[CALL_VOTE]` is wired but never advertised~~ Interaction advertising: **resolved by the loom_* tool migration**; new doc-drift created (updated 2026-08-21)
The original finding is **no longer true as stated**: `buildAgentSystemPrompt` now directs agents to real `loom_query`/`loom_evidence`/`loom_vote`/`loom_summon`/`loom_request_next` tools (`prompts.js:805-817`) with per-tool gating (`index.js:175-670`), and explicitly deprecates bracket tags ("Bracket tags … are removed and will not execute"). Voting *is* advertised via the `loom_vote` tool. See `docs/tool-interactions-as-tools.md`.

What replaced it is a **documentation drift problem**: `ORCHESTRATION_ARCHITECTURE.md` §4 still presents the bracket-tag system-prompt example and §22 still documents `[QUERY]/[EVIDENCE]/[SUMMON]/[CALL_VOTE]` as the live contract, while `sanitize.js:7`'s DIRECTIVE_PATTERN still preserves `[CALL_VOTE]`/`[REQUEST_NEXT:]`/stale `[NEXT:]`/`[CONTEST]` forms. The parser fallback path and the prompt now disagree about which protocol is canonical. Fix: regenerate the architecture sections from the current builders (audit 15 DOC9) and prune the sanitizer whitelist to the migration-fallback tags only.

### P2 — Conflicting length contracts (minor)
Reflection: "80–150 words" (`prompts.js:195`) vs system contract "120–180" (`:810`). Query "2–4 sentences" (`:233`), evidence "100–180" (`:270`), summon "100–150" (`:389`). Length/grounding rules duplicated verbatim in both system and user prompts (`:810` vs `:912-916`). Agents receive contradictory instructions depending on which builder they read.

### P3 — Silent tool-limit mismatch (minor)
`prompts.js:817`: `Math.min(5, getConfig().agentTools.maxToolCallsPerTurn)` caps the advertised limit at 5 while config allows 1–20 (`config.js:116`). A user configuring 12 gets agents told "5". Also `.agentTools.maxToolCallsPerTurn` is dereferenced unguarded here while line 46 uses optional chaining — inconsistent null-safety in one file.

### P4 — Tier order copy-pasted; civilian mishandled (minor)
The `TIER_ORDER` literal is inlined three times (`prompts.js:158,207,245`) instead of shared. `src/moderation.js:235`'s fallback tier map omits `civilian` entirely (defaults to junior rank) while prompts rank civilian as mid.

### P5 — Heading injection into moderator/synthesizer prompts (major)
`prompts.js:459-464` and `:638-639` interpolate recent contributions/transcript with only `escapeDelimiters` (`<<<>>>` handling). The `delimitContext` wrapper exists but is used only in `buildAgentUserPrompt`. A contribution containing forged markdown headings (`## Required Sections`) embeds under the moderator's rubric / synthesis section headings with no structural isolation — injection into exactly the prompts that steer convergence and produce the final artifact.

### P6 — Fragile turn-order JSON extraction (minor)
`src/moderation.js:203`: lazy regex `result.match(/\[.*?\]/s)` stops at the first `]` — breaks on any nested bracket or bracketed string. No fence stripping, no duplicate-ID rejection before use.

### P7 — Prompt bloat via duplication (minor)
Evidence tool-ladder guidance duplicated between `buildEvidenceGuidance` (`prompts.js:70-104`) and inline ladder in `buildAgentSystemPrompt` (`:720-744`); synthesis doctrine near-duplicated between `buildSynthesisPrompt` (`:641-648`) and `NEUTRAL_SYNTHESIZER_SYSTEM` (`synthesizer.js:104-111`). Duplicated rules *will* drift (they already have different wordings).

### P8 — User context barely reaches the deliberation (design)
Raw user `context` is only indexed for vector recall (`orchestrator.js:360-363`); it never appears directly to agents or the synthesizer. Constraints stated by the user ("must be ≤ $50k", "Linux only") may simply never be retrieved.

## Proposed fixes

1. **Advertise `[CALL_VOTE]`** in the system prompt rules with rights gating (only include the rule if `tier_config.rights.call_vote`).
2. **Single source of truth for limits**: export `LENGTH_LIMITS = { reflection: [80,150], agent: [120,180], … }` from one module and interpolate into every builder; delete all hardcoded numbers.
3. **Honest tool limit**: advertise `getConfig().agentTools.maxToolCallsPerTurn` as-is (schema already validates range); add optional chaining consistent with the rest of the file.
4. **Shared `TIER_ORDER` export** from `shared.js`; add `civilian` to the moderation fallback map.
5. **Wrap moderator/synthesizer interpolations** in `delimitContext` blocks like the agent prompt; additionally demote injected markdown headings (strip leading `#` from contribution content when embedding into these prompts).
6. **Balanced-bracket extraction**: replace the lazy regex with a small scan that respects nesting and quoted strings; reject arrays containing duplicate/unknown IDs before applying.
7. **Deduplicate doctrine strings**: keep one canonical constant per rule block; import it in both places.
8. **Pass user context as a delimited block** (`<<<LOOM_USER_CONTEXT>>>_BEGIN_…END_`) in agent and synthesis prompts alongside vector recall.

## Justification

P5 is a correctness/security issue in the highest-authority prompts. P1/P2/P8 are direct quality levers: features agents can't discover, instructions that contradict themselves, and user constraints that evaporate. All fixes are pure-JS refactors of existing prompt code.

## Verification (2026-08-21)

| Item | Status | Notes |
|------|--------|-------|
| P1 | ⚠️ **superseded** | Resolved by loom_* tool migration (see rewritten issue). New doc-drift item created; folded into audit 15 DOC9. |
| P2 | ✅ verified | Confirmed at `prompts.js:195` (80–150), `:233` (2–4 sentences), `:270` (100–180), `:389` (100–150), `:810` vs `:912` (120–180 duplicated verbatim). |
| P3 | ✅ verified | `Math.min(5, getConfig().agentTools.maxToolCallsPerTurn)` at `prompts.js:817`. |
| P4 | ✅ verified | `TIER_ORDER` literal inlined at `prompts.js:158, 207, 245` (all rank civilian as mid); `moderation.js:235` fallback map omits `civilian`. |
| P5 | ✅ verified | Moderator prompt uses only `escapeDelimiters(sanitizeForDisplay(...))` (`prompts.js:459-464`); synthesis transcript interpolated as `safeTranscript` without delimiter fencing (`:638-639`). `delimitContext` still used only in the agent user-prompt path. Still the highest-authority injection surface in the repo. |
| P6 | ✅ verified | `moderation.js:203`: lazy `result.match(/\[.*?\]/s)` confirmed. |
| P7/P8 | ✅ consistent with surrounding code | Not individually re-measured; low drift risk. |

## Priority & benefit

| Item | Priority | Effort | Benefit |
|------|----------|--------|---------|
| P5 delimiter hardening | P0 | S (~half day; wrap + heading demotion) | Injection-resistant moderation/synthesis |
| ~~P1 vote advertising~~ → doc-drift fix | P0 (paired with audit 15 DOC9) | S | Docs, sanitizer, and prompts agree on one protocol |
| P8 context block | P1 | S | User constraints actually bind the outcome |
| P2/P3 limit unification | P1 | S (one constants module + interpolation) | Consistent agent behavior; config does what it says |
| P4 shared TIER_ORDER | P2 | S (trivial) | Less drift surface |
| P6 balanced-bracket extraction | P2 | S | Robust turn ordering |
| P7 doctrine dedup | P2 | S | Single canonical rule strings |

**Recommendation: carry out P5 before any long-meeting or untrusted-model usage; P2/P3/P4 are cheap wins to batch with any other prompts.js touch. The original P1 work item is done — do not re-implement it.**

### Second-pass review (2026-08-21) — fix-plan soundness

- **P5 heading-demotion nuance:** "strip leading `#` from contribution content" must not strip `#` inside fenced code blocks (comments like `# TODO` are legitimate content and the output contract encourages code blocks). Demote headings only outside fences, or rely on `delimitContext` fencing alone and skip demotion inside fenced regions.
- **P2 unification target confirmed:** the duplicated contract at `prompts.js:810` (system) vs `:912` (user prompt) is verbatim-identical today, so a shared constant is a mechanical, low-risk change — good first candidate for the testing Phase 2 prompt goldens.
- **P6 scope note:** the balanced-bracket scanner should also tolerate JSON containing escaped quotes; the existing fallback path (priority-sorted deterministic order) stays as the failure mode either way, so risk is bounded.

**Post-fix grade:** A−.

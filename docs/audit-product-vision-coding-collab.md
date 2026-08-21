# Audit 18 — Product Vision Delivery (Coding Collaboration & Beyond)

**Current grade: D · Target grade: B+ → A (roadmap)**

The project's stated purpose is two-sided: deliberating conversational topics *and* agents collaborating on coding projects. The first side is genuinely built. The second side exists only as a sentence in the README — there is no code path that treats "we're deciding something about this codebase" differently from "should we use JWTs." This gap, plus missing cost/quality instrumentation, is what separates the current C− from an A+ product.

## Issues

### PV1 — Coding collaboration is claimed but not implemented (critical for vision)
No repo-aware defaults: `bash/glob/grep/lsp` tools are only offered when explicitly enabled in config (`round-executor.js:1385-1406`); composition never considers the workspace; synthesis artifacts have no code-shaped sections (no files-touched, no patch proposals); evidence citations can reference web sources but not repository files. A `/knit` about a refactor produces meeting prose identical in shape to a stock-picking debate.

### PV2 — No human in the loop mid-meeting (major)
Once `/knit` starts, the user can only watch or cancel/extend. There's no channel to answer a participant question, redirect scope, or inject a constraint between rounds — even though the progress pipe (`postProgress`) proves bidirectional plumbing exists.

### PV3 — No participant management after start (minor)
Summon adds a one-shot guest; nothing can add/remove/mute a full participant mid-deliberation, which real meetings need when a perspective turns out to be missing.

### PV4 — No cost/token budget enforcement (major)
`meeting_timeout` bounds time, not money. `callStats` tracks input/output tokens (`orchestrator.js:55, 741-744`) but nothing enforces a ceiling and the dashboard doesn't surface burn-down. A runaway 10-round debate on expensive models has no brake besides the clock.

### PV5 — No quality telemetry (major)
The system generates the raw signals of deliberation quality — challenge→response chains, reflection adoption, dissent survival into the final artifact, vote convergence — and records none of them. You cannot currently answer: "do minority reports actually change decisions?" or "which personas produce challenges that get resolved?"

### PV6 — Synthesis is single-shot with weak grounding checks (minor)
Draft + critique passes exist, but nothing verifies each Decision cites at least one contribution ID from the transcript, so hallucinated consensus is possible under timeout pressure.

## Proposed fixes (roadmap)

1. **Coding-collaboration mode** (the headline gap):
   - Workspace-aware room composition: include `read/glob/grep` (and `bash` behind allowlist) by default when a workspace directory is present.
   - New contribution/artifact type `[PATCH_PROPOSAL]`: agents may attach fenced file-blocks (the parser already extracts file blocks — `extractFileBlockTools`, `shared.js`); synthesis gains "Proposed Changes" and "Files Affected" sections aggregating them.
   - File-grounded evidence: evidence prompts accept `file:<path>` sources alongside URLs, rendered distinctly in the dashboard Output tab.
   - Composition reads top-level repo signals (languages via extension counts) to bias persona tags toward engineering domains present in the repo.
2. **Human-in-the-loop checkpoint**: optional `pause_between_rounds` flag; at round end post a progress line inviting input, then check for new parent-session messages before continuing (bounded wait). No new infrastructure — reuses existing session plumbing.
3. **Participant management**: orchestrator actions `addParticipant(persona)` / `mute(id)` / `release(id)` wired to dashboard buttons and a `/knit` sub-argument; state machine already persists participants, so this is lifecycle bookkeeping.
4. **Token/cost budgets**: extend config with `maxTotalTokens`; enforce in `#promptOrchestrator`/`#promptChildSession` pre-flight (refuse with clear message, transition to `timeout`); surface tokens-so-far vs budget in Overview using data already persisted to `meeting_metrics`.
5. **Quality telemetry**: persist derived metrics per meeting — challenge count vs resolved-via-reflection/query/evidence count, dissent-present-in-final-dissent-list rate, votes cast/converged. Render as a small "Deliberation Health" panel. This is the measurement backbone for tuning everything else in these audits.
6. **Grounded synthesis pass**: after draft, verify each Decision line references ≥1 `[#id]` present in the transcript; ungrounded lines are flagged in a "Needs verification" section rather than silently dropped.

## Justification

PV1 is why the project exists per its own description; delivering it converts Loom from "debate simulator" into a decision tool for real repositories. PV4/PV5 make it *economically sane* and *improvable* — without telemetry, every other fix ships blind.

## Verification (2026-08-21)

| Item | Status | Notes |
|------|--------|-------|
| PV1 | ✅ verified, updated framing | Tool gating confirmed (`round-executor.js` builds research-only maps unless explicitly enabled). **Update:** the loom_* tool migration landed since this audit was written, including `sameTurnSynthesis`, code-diff length allowances in the output contract (`150-350 words when contributing code diffs`, `prompts.js:810`), and file-block extraction — i.e., the *plumbing* for coding collaboration now partially exists; what's missing is exactly what PV1 names: workspace-aware defaults, `[PATCH_PROPOSAL]`-shaped synthesis sections, and repo-signal-aware composition. The gap is narrower than originally stated but still real. |
| PV2/PV3 | ✅ consistent | No human-in-loop or participant-management paths found. |
| PV4 | ✅ verified | `callStats` tracks input/output tokens (`orchestrator.js:55, 237-249`) with no ceiling enforcement anywhere; dashboard has no burn-down. |
| PV5/PV6 | ✅ consistent | No quality-telemetry persistence found; grounding check absent from synthesis flow. |
| Sequencing note | ➕ strengthened | The verification pass confirmed the audit's own warning empirically: capability work (tool migration) landed while P0-class defects (S3, SC1, LS1) were still open — precisely the "capability built on silent failures" pattern this audit warns against. Testing infrastructure (audit 19) should precede PV1 so the new contribution types ship with enforcement. |

## Priority & benefit

| Item | Priority | Effort | Benefit |
|------|----------|--------|---------|
| PV4 token/cost budgets | P1 | S–M (pre-flight check + config + Overview widget from existing data) | Predictable spend; hard brake beyond the clock |
| PV5 quality telemetry | P1 | M–L (metric definitions + persistence + panel) | Evidence-based tuning of prompts/personas/rounds; measurement backbone for everything else |
| PV1 coding-collaboration mode | P1 (after Waves 1–3) | L (multi-week: composition, parser/artifact types, dashboard rendering) | Delivers the stated core purpose; converts "debate simulator" into a repository decision tool |
| PV2 human checkpoints | P2 | M (bounded-wait plumbing exists) | Steering without killing momentum |
| PV6 grounded-synthesis check | P2 | S–M | Trustworthy final artifacts; cheap hallucination guard |
| PV3 participant management | P2 | M | Real-meeting flexibility |

**Recommendation: carry out PV4+PV6 early (small, high trust payoff), PV5 as soon as audit 07's metric wiring exists (it is the same infrastructure), and PV1 only after Waves 1–3 plus testing Phase 1–2 — it is the A+ maker but every week spent on it before the foundation is honest is a week of building on off-spec embeddings and silent write loss.**

### Second-pass review (2026-08-21) — feasibility caveats

- **PV2 has one unverified dependency:** "check for new parent-session messages before continuing" assumes the opencode SDK exposes a way to *read* new parent-session messages on demand. The write side (`postProgress`/`promptAsync`) is proven in-code; the read side is not exercised anywhere in this repo and needs a small feasibility spike before PV2 is scheduled. If reading isn't possible, fall back to a `/knit` sub-argument steering channel (user re-invokes with an `--inject` payload) which uses only proven plumbing.
- **PV1 scope refinement from current code:** the tool migration already delivered same-turn synthesis, code-diff length allowances, and file-block extraction — so PV1's remaining work is composition defaults, `[PATCH_PROPOSAL]` artifact typing, synthesis sections, and repo-signal biasing. This narrows PV1's estimate at the low end of L but does not change its sequencing.
- **PV4 enforcement point confirmed realistic:** `#promptOrchestrator`/`#promptChildSession` are the two chokepoints through which all token-bearing calls flow (`callStats` accumulates at `orchestrator.js:237-249`), so a pre-flight budget check is a contained change as described.
- **PV5 dependency made explicit:** quality-telemetry metrics should be defined as *derivations over persisted data* (contributions/turn_requests/orchestrator_messages), not new instrumentation, so historical meetings can be scored retroactively and the dashboard panel needs no schema change beyond meeting_metrics rows.

**Sequencing note:** do not start this wave before Waves 1–3 (audits 07, 04, 05, 06) — capability built on silent failures and off-spec embeddings would inherit both defects. This is the wave that takes the project from "solid repaired tool" (A−) to **A+**: differentiated capability, measured quality, and trustworthy economics.

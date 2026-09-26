# Persona Agent Turn — Prompt Engineering Audit (v2)

**Scope:** the persona agent's turn, end to end.
Primary: `src/prompts/agent.js`, `src/prompts/blocks.js`, `src/prompts/constants.js`,
`src/prompts/interaction-prompts.js`, `src/prompts/delimiters.js`.
Turn wiring: `src/round-executor/agent/prompt-session.js`, `src/round-executor/agent/execute-turn.js`,
`src/round-executor/tools.js`.
Tool surfaces (also prompts): `src/plugin/tools/{state-patch,pass,query-evidence,vote-summon}.js`.
Corpus: `personas/*/*.json` (100 files), `src/composer/persona-loader.js`, `src/composer/room.js`.
Config: `src/config/defaults.js`, `src/dashboard/server/control.js`.
Docs making claims about prompts: `README.md`, `ORCHESTRATION_ARCHITECTURE.md`.
Tests: `test/prompt-invariants.test.js`, `test/forum.test.js`, `test/state-lifecycle.test.js`.

**Method:** source read; **live prompt rendering** under three tool configurations (default config,
mandatory-on config, solo) to test claims rather than infer them; tool-description review; config
default reconciliation; test-suite gap analysis.
**v2 date:** 2026-09-25. **v1:** same repo state, first pass.
**Limits of this audit (stated so the grade isn't over-read):** no LLM was executed. Behavioural claims
("the model will X") are inferences from prompt text plus the runtime that consumes it. The one
behavioural number in evidence is the repo's own: **1 applied `loom_state_patch` across 9 primary
turns** (`ORCHESTRATION_ARCHITECTURE.md:383`). Everything else is verifiable by running the commands in
Appendix A.

---

## 1. Executive summary (v2)

v1 graded this **C+** and called the design sound with a leaky implementation. I still agree with that
verdict — and after a second pass I found that two of the leaks are worse than anything v1 reported,
and that several of v1's findings were stated with more confidence than the evidence supports.

The three things that matter most, in order:

1. **The mandatory-capability retry can silently destroy the contribution it was supposed to rescue.**
   `execute-turn.js:361` overwrites `finalText` with whatever the nag prompt returned. The nag's own
   instruction says *"Do not repeat the prose"* — so a compliant model returns a one-liner and a
   500-word contribution is replaced by it. This is a data-loss bug created by prompt wording, in the
   exact turn that was already failing. It is the single highest-severity finding in this audit.
2. **A miss costs two extra LLM calls, saying the same thing twice.** The `loom_state_patch` retry
   (`execute-turn.js:248`) runs, misses, and then the mandatory-capability retry (`:313`) independently
   re-detects "SKILL.state" and nags again — on the same session, with the system prompt re-sent.
3. **The prompt advertises a hard cap that does not exist, and a salience mechanism that is off by
   default.** "Up to 12 loom calls per turn" is never enforced (warn-only, `execute-turn.js:33-44`); and
   `agentTools.mandatory` is **absent from `DEFAULT_CONFIG` and from `NESTED_SCHEMA`**, so on any path
   that doesn't go through the Setup tab, three of the four "mandatory patch" surfaces documented in the
   architecture never render while the retry still fires.

Against that: the Golden Sandwich user prompt, the delimiter discipline, `LENGTH_LIMITS` as a single
source, the bounded `(P, Σⁱ, O)` turn shape, and the 20-test invariant suite are all genuinely good and
should not be touched structurally. The corpus has real voices. The `loom_state_patch` tool description
is the best-written prompt surface in the repo.

**Overall grade: C+ (confirmed).** Two dimension revisions (2.4 B−→C, 2.7 C→C−), five new dimensions,
and a new **A-grade exit criterion**: this project cannot reach A by editing prose. It needs a
*prompt-lint* (mechanical contradiction detection in CI) and an *outcome harness* (turn metrics
asserted per release), because every defect in §5 is a class that a human reviewer reads past.

---

## 2. Grade report v2

| # | Dimension | v1 | v2 | Verdict |
|---|-----------|----|----|---------|
| 2.1 | System prompt: structure & attention ordering | C- | **C-** | "Read this last" isn't last; tools section buries the contract |
| 2.2 | Signal consistency (no contradictions) | D+ | **D** | Now 7 distinct contradictions, incl. a self-contradictory pass/patch pair (N4) |
| 2.3 | User prompt: Golden Sandwich & boundedness | A- | **A-** | Unchanged; best artifact in the repo |
| 2.4 | State-patch salience vs instruction fatigue | B- | **C** ↓ | Gates too tight (off by default) *and* restated 5×; two retries say the same thing |
| 2.5 | Tool ladder & mode (PLAN/BUILD, solo, forum) | C | **C-** ↓ | Forum block unconditional; solo roster contradicts tool map; cap unenforced |
| 2.6 | Identity/persona injection & precedence | C+ | **C+** | Sanitize/escape good; no precedence rule; corpus field is dead (N2) |
| 2.7 | Persona corpus quality | C | **C-** ↓ | Every system prompt ships broken grammar (N9); tradeoff-number tic; thin text |
| 2.8 | Caching & invalidation correctness | D | **D-** ↓ | Cache key omits injected text **and** is a 32-bit hash (collision ⇒ wrong identity) |
| 2.9 | Test coverage of prompt contracts | A- | **B+** ↓ | Exempt *static* contracts superbly; zero coverage of runtime-consumed claims (N5) |
| 2.10 | Token economy | C | **C** | ~14k chars/turn before SoP/transcript; ~15–20% compressible |
| **2.11** | **Retry paths: prompt↔runtime contract** | — | **F** (new) | Contribution-overwrite bug; duplicate nags; unenforced advertised cap |
| **2.12** | **Cross-surface consistency** (primary ↔ peer sub-turns ↔ tool descriptions) | — | **D** (new) | Bracket tags "obsolete" in one prompt, demanded in another; two dead policy defaults |
| **2.13** | **Round-phase awareness in primary turns** | — | **D** (new) | Excellent `buildRoundContext` doctrine, wired to peer turns only — never to primary turns |
| **2.14** | **Docs ↔ implementation fidelity** | — | **C-** (new) | `reflection_guidance` documented as active, read by nothing |
| **2.15** | **Outcome measurement & prompt regression harness** | — | **F** (new) | Per-turn outcome enum recorded, never aggregated or asserted |

**Overall: C+.** Weighted toward the F/D dimensions because they are behavioural: a wrong prompt served
from cache, a lost contribution, a duplicated LLM call. An A here is not a prose quality judgement.

---

## 3. Agreement with v1 — what I stand behind, what I'd revise

I re-derived every v1 claim by rendering the prompts. **I agree with 14 of 16.** Two need qualification
and one was materially incomplete.

| v1 claim | Status after re-audit |
|---|---|
| Contract isn't last; tools section buries it | ✅ Confirmed (`agent.js:211` header vs `:242` tool section) |
| Length contradiction ("don't yap" vs "verbosity is welcome") | ✅ Confirmed — both strings present in one rendered prompt |
| `[#12]` is a contribution id, not a participant id | ✅ Confirmed; `:221` wording is wrong |
| SoP "is truth" vs PROVISIONAL header | ✅ Confirmed (`:389` vs `:290`) |
| Forum description block renders when forum is off | ✅ Confirmed by render (descriptions present, tools absent) |
| Cache key omits persona/agenda/style/anti-patterns | ✅ Confirmed; **worse than reported** — also a 32-bit hash (N6) |
| Cache invalidation disagrees with the 60s persona cache + watcher | ✅ Confirmed |
| Mode info vanishes when tools are off | ✅ Confirmed (`:82` gates the whole section including `:116-118`) |
| BUILD inferred from `builtIn.write/edit` | ✅ Confirmed (`:95`) |
| Roster example id `dr_sarah_3` is fabricated | ✅ Confirmed — **now S2, not cosmetic** (N7) |
| 4× patch salience is honest but expensive | ⚠️ **Revised**: true where `mandatory.skillState` is on. On the config-file path **three of the four surfaces never render** and only the "optional" tool line does. The v1 framing followed the architecture doc, which describes the Setup-tab path (N1). |
| "First-speaker [#id] demand is nonsensical" | ⚠️ **Softened**: the bullet has an escape clause ("or explain why you're opening a new thread"), so it's clumsy in round 1, not broken. S4, not S2. |
| Corpus "tradeoff number" tic trains fake quantification | ✅ Confirmed, and broader: the tic is in `agenda` corpus-wide and is duplicated inside `tier_guidance` ("measured by one capital allocation tradeoff number") |
| Token economy ~15–20% compressible | ✅ Confirmed (9,597 + 4,449 chars measured) |
| Tests exemplary, 2 gaps | ✅ Confirmed — and the gap is larger than 2 tests: it's a *category* (§5 N5) |

**What v1 missed entirely** — §5, N1–N15 plus the tool-description findings T1–T4. N0 (contribution
overwrite) is more severe than anything in v1, and v1's §3.3 (patch nagging) is the visible symptom of
the same root cause: the prompt is doing enforcement work that the runtime then double-enforces.

---

## 4. What is already strong — do not regress

- **Weighted Golden Sandwich** with epistemic labels (CANONICAL/PROVISIONAL, CARRIED FORWARD, Live) and
  hard bounds. Question-dedup (A10), ≤12 live contributions with 800/1200 budgets, Σⁱ gated on the
  *rendered* state rather than the config flag. Genuinely A-.
- **Delimiter discipline** applied uniformly, including to the two most attack-shaped blocks (SoP, Σⁱ).
  `escapeDelimiters` neutralises `<`/`<<` as well as `<<<`, and the per-call sentinel in
  `sanitize.js` prevents sentinel forgery. This is the most mature part of the codebase.
- **`LENGTH_LIMITS` as a single source**, consumed by the contract and pinned by test B1. The "fence,
  don't mangle" sanitisation policy (brackets/braces/links survive) is a considered decision, documented
  at the point of implementation.
- **`loom_state_patch` tool description** (`state-patch.js:6-26`): documents eviction semantics, the
  pin tier, and exact-match removal in the model-facing text. This is what the system prompt should be
  *pointing at* instead of restating three times.
- **`evicted` echo is real** — I checked the claim in the guidance line (`:366`) against
  `state-patch.js:79-105`; the tool does return `evicted`/`overCap`/`skipped`. Prompts here usually
  describe mechanisms that exist. That's a meaningful prior in the repo's favour, and it's why the
  unenforced call cap (N3) stands out.
- **Solo gating, bias rotation, per-turn patch-outcome enum** (`execute-turn.js:381-393`) — the enum is
  the raw material for the harness the project doesn't have (N8).
- **100 personas with distinct voices** and positive-form anti-patterns ("Never say X without Y —
  instead, state what you observed with [#id] or Source").

---

## 5. Findings v2 — new material

Severity: **S1** silent data loss / wrong prompt served · **S2** misleading or self-contradictory
instruction · **S3** cost/latency · **S4** cosmetic-but-visible.

### N0 [S1] The mandatory-capability retry can overwrite the contribution it was sent to rescue
`src/round-executor/agent/execute-turn.js:356-366`

```js
const retryResponse = extractAgentResponse(resultM.data);
const effectiveM = truncateToolResults(retryResponse.toolResults ?? [], agentToolsConfig);
if (effectiveM.length > 0) finalToolResults = truncateToolResults([...finalToolResults, ...effectiveM], agentToolsConfig);
if (retryResponse.text && retryResponse.text.trim().length > 0) finalText = retryResponse.text;   // ← unconditional
```

The retry instruction (`:329`) tells the model: *"Do not repeat the prose; make the required tool
call(s), then finish your contribution."* A compliant model returns "Called loom_state_patch, stance
projected." — 8 words — and that becomes the contribution. The weave stores the one-liner; the 500-word
argument is gone with no log line, because there is no guard and no warning. The synthesis path is
milder but same-shaped: `>= 10` chars is a low enough bar (`:213`) to displace a full contribution with a
sentence, and even that case only logs on the *empty* branch.
**This is a prompt-wording bug that became a data-loss bug.** Any capability-mandatory turn (forums,
local search, online research, peer interaction) is a candidate for silent content loss.
Fix: harvest tool calls only; never overwrite `finalText` from an enforcement retry.

### N1 [S2] Two different defaults for one policy; three of four salience surfaces off by default
`src/config/defaults.js:60-95` (no `mandatory` key) vs `src/dashboard/server/control.js:486,527-534`
and `src/dashboard/stores/setupForm.js:36` (`skillState: "mandatory"`).

Verified by render under `DEFAULT_CONFIG`: contract item 7 **absent**, final-line patch instruction
**absent**, guidance reads *"Your State is optional here"*, tool list reads *"optional"* — while
`patchRetry: true` still fires the retry that says *"call loom_state_patch ONCE"*. So on the config-file
path the agent is told the patch is optional and then told it is mandatory, in the same turn, by two
different prompts. `mandatory` is also missing from `NESTED_SCHEMA`, so it cannot be set through the
validated `opencode.json` path at all — only via the Setup tab. `ORCHESTRATION_ARCHITECTURE.md:383-388`
describes the four surfaces as the primary mechanism without noting they are gated off on that path.

### N2 [S2] `reflection_guidance` is documented as active and read by nothing
Grep across `src/prompts/**` and `src/plugin/tools/**`: the field is **persisted, migrated
(`schema.js:137`), restored (`meeting-restorer.js:56`), editable in the Setup tab (`control.js:689`),
and copied into summoned configs (`vote-summon.js:352`) — and consumed by **no prompt builder**.
`README.md:181` states it is "used when peers solicit their stance via `loom_query mode=perspective`";
`buildQueryPrompt` never reads it. `ORCHESTRATION_ARCHITECTURE.md:116,161,181,203` presents it as part
of the persona contract. Cost: 100 corpus files carry a field that costs author attention and review
surface for zero prompt effect, and the docs actively mislead the next person to touch persona
authoring. Either wire it into the perspective-mode task block (the honest fix — it *is* good
guidance) or delete it from the corpus, the schema path, and both docs.

### N3 [S2] "Up to 12 loom calls per turn" is a limit the runtime does not apply
`agent.js:219` vs `execute-turn.js:33-44`: `truncateToolResults` **logs a warning and stores everything**.
No cap is enforced anywhere; `maxToolCallsPerTurn` is documented in the schema as if it were a limit
(`defaults.js:145`) and in the prompt as a hard ceiling. Either enforce it (drop the excess ToolParts
before synthesis) or reword to guidance ("aim for ≤N"). A prompt ceiling that doesn't exist teaches the
model that ceilings here are advisory, which weakens the ones that matter (patch ONCE per turn *is*
enforced — `state-patch.js:52-54`).

### N4 [S2] `loom_pass` and `loom_state_patch` are mutually exclusive; the prompt never says so
`state-patch.js:49-51` rejects a patch after a pass; `pass.js:20-23` rejects a pass after a patch. The
contract only implies exclusivity ("every non-pass turn"). A model that patches and *then* decides to
pass gets a hard error and no recovery path in that turn — the reverse order is the only one that
works, and it isn't stated. This belongs in the contract as a hard rule and in the `loom_pass`
description, which currently says only *"Pass on your current turn… The deliberation ends when all
participants pass"* (also inaccurate: the round limit and timeouts also end it).

### N5 [S2, category] Prompts assert runtime contracts that no test covers
The invariant suite pins **static** properties (A1–A12, B1–B12, C1–C5, D10–D12, X4–X6) superbly. It
pins **zero** of the claims the prompt makes *about the runtime*:
`maxToolCallsPerTurn` is a cap (N3) · `evicted` is echoed (true, unpinned) · patch/pass exclusivity
(N4) · mode is PLAN when `write`/`edit` are off · forum tools are callable when described · the
question appears once in *peer* prompts (B3 covers one builder only). Every one of these is a five-line
test. This is the gap that lets the same bug class survive four audits.

### N6 [S1] The prompt cache is a 32-bit hash of a key that omits the identity text
`agent.js:33-45`. Two independent problems: (a) **omission** — `persona`, `agenda`,
`communication_style`, `preferred_contribution_types`, `anti_patterns` are rendered into the prompt but
absent from the key, so an edited persona serves a stale prompt until LRU eviction (v1 finding, now with
a reproduction); (b) **collision** — `h = ((h << 5) - h + charCode) | 0` is a 32-bit hash, and a collision
silently serves participant A's *identity and agenda* to participant B. Probability is low per pair,
non-zero across a 50-entry cache with 100+ personas and meetings that add per-meeting `agentTools`
variants, and the failure mode is the worst kind: wrong persona, no error.
Fix: key on the full string (or FNV-1a 64-bit) and include every rendered field.

### N7 [S2] Solo turns are told to use `loom_query` targets they cannot query
`prompt-session.js:149` passes `queryEnabled = loom.enabled && loom.loom_query` — it never receives
`activeCount`. So a solo agent gets the full `## Other Participants — valid loom_query targets` roster
and *"Use these ids verbatim for loom_query"* (`agent.js:357-361`) while the system prompt correctly
suppresses `loom_query` (`:99`) and `buildToolsMap` correctly omits it (`tools.js:17`). Verified by
render. Two of three surfaces say no, one says yes with a concrete example. Also in that block: the
example target `dr_sarah_3` is **hardcoded and not in the roster** — the prompt teaches targeting by
example using an id that does not exist — and the roster includes `passed` participants
(`prompt-session.js:99` filters only `failed`) while the block text says *"Passed/failed are not
queryable"*.

### N8 [S2, category] No outcome measurement, so prompt quality cannot be defended or regressed
`execute-turn.js:381-393` computes a six-value per-turn enum (`applied | exempt_pass | rejected |
unverified | never_attempted | skipped_deadline`) and persists it on
`contributions.prompt_context.state_patch_outcome`. Nothing aggregates it. The architecture doc's
"1 applied patch across 9 turns" was read out of logs by hand. There is no metric for citation density,
tool-call success rate, word-count compliance, pass rate, or tool-only turns — and therefore no way to
show that any of the §6 fixes improved anything, or that a future edit regressed. The enum is the
harness; it just needs a query and a threshold.

### N9 [S4, but in every single system prompt] The bias line ships broken English
`agent.js:168`: `` `… you tend to ${biasList.join("; ")}` `` while the corpus writes biases as
third-person verb phrases. Rendered, verbatim, in the Security Engineer's system prompt:

> Bias awareness: you tend to **Assumes** malicious intent by default; **May** over-weight low-likelihood
> attacks; Resists convenience that trades away safety.

This is the first thing the model reads about its own disposition, in all 100 personas. Fix in the
template (lowercase the first clause, strip the leading verb) *and* add a loader lint for
biases that begin with a third-person verb. Cheap, and it's the difference between a prompt that looks
generated and one that looks authored.

### N10 [S2] Primary turns have no round-phase doctrine — good doctrine, wrong wiring
`buildRoundContext` (`blocks.js:179-191`) is the best behavioral writing in the repo (DIVERGE → MAP &
REFINE → CONSOLIDATE, with the "Position: held|revised|expanded" closer). Its consumers are
`interaction-prompts.js` (peer sub-turns) and `round-summarizer.js`. **The primary agent turn never
receives it.** Primary agents get only the PROVISIONAL/CANONICAL SoP label — a statement about how
*much* to trust the digest, not about what to *do* this round. So the 7-agent room has no mechanism
telling round-1 speakers to diverge and late-round speakers to consolidate, even though the code that
would do it is written, tested-adjacent, and 12 lines away. The primary prompt does have a round-phase
nudge in one place only: the contribution-mix steering hint.
Caveat for whoever wires it: the late-phase text demands an output shape (`Position: …`). Introduce it
as guidance in the user prompt, not as a contract item, or you will have added a new format
requirement to every late turn.

### N11 [S2] Cross-surface contradiction on bracket tags
Primary contract (`agent.js:220`): *"Bracket tags like [QUERY: @id] are obsolete"*; the file's own
comment (`:295`): *"There is no type-tag rule anywhere in the contract"*;
`sanitize.js:16-18` drops legacy forms. Meanwhile `buildVotePrompt` (`interaction-prompts.js:104,123`)
**requires** `[Vote: A]` and calls it "backward compat", and `buildEvidencePrompt:73` says "No
contribution tags" one line before demanding a three-field tag-shaped structure. Ballots and evidence
reports are legitimately structured; the problem is that the primary prompt declares the whole notation
obsolete without exception, which trains models to distrust it in exactly the place where it is required.
One sentence fixes it: bracket tags are legacy, still required for `loom_vote` ballots, and ignored
everywhere else.

### N12 [S4] Silent truncation ceilings the corpus author can't see
`persona-loader.js:77,80` accepts `persona` ≤ 4000 and `agenda` ≤ 2000; `agent.js:64-65` truncates to
2000/1000. `control.js:689` sanitises `tier_guidance` at 1600; `blocks.js:202` truncates at 1500. Personas
are explicitly user-editable, so a user who writes to the documented limit loses half their text with an
ellipsis and no warning. Align the ceilings, or log a warning at load when a field exceeds the *injected*
budget.

### N13 [S4] Tier doctrine and persona `tier_guidance` restate each other
Rendered side by side: *"Senior doctrine: name the irreversible commitment and its mitigation/rollback"*
followed immediately by *"Senior security doctrine: name the irreversible commitment and its mitigation
or rollback."* The persona files carry a template with the tier prefix baked in
(`security-engineer.json:24`). The persona field should carry only the *domain-specific* test
("Your security test: …") and let `blocks.js` own the tier doctrine. This is ~1 redundant sentence per
agent per turn.

### N14 [S3] The `evicted` echo is documented but not signposted
The guidance line tells the model to *"check the `evicted` echo"* — the tool does return it
(`state-patch.js:86`), so this is honest, but nothing in the prompt says *where* to look (the tool
result). A model that skips the tool call obviously can't read it; a model that reads the tool result
already sees it. The sentence is pure overhead in exactly the turns it's shown. Delete it and keep the
mechanism.

### N15 [S3] `windowNote` makes an unverified claim about the model, then uses it to license verbosity
`agent.js:52` defaults to `"200k"` when the model's window is unknown, and that string appears three
times: *"concise but thorough — 200k window"*, *"Verbosity is welcome — 200k window"*, *"Thoroughness
welcome — 200k window"*. When `contextWindow` is null the prompt asserts a fact about itself it cannot
know, three times, and uses it as the tiebreak for the §2.2 length contradiction. Either resolve the
window from the model registry reliably or drop the number and the licence.

### T1–T4 [tool descriptions are prompt surfaces]
- **T1** `loom_pass` doesn't mention patch exclusivity (N4) or that a round limit/timeout can end the
  meeting first.
- **T2** `loom_state_patch` is excellent — but the same eviction/pin semantics are restated in three
  other places (contract item 7, tool list `:142`, guidance `:366`). The tool description should be the
  single authority; the prompt should point at it.
- **T3** `buildSummonPrompt` (`interaction-prompts.js:132-195`) renders only persona/expertise/style. The
  summoned guest gets **no `tier_guidance`, no biases, no anti-patterns** — even though `vote-summon.js:352`
  dutifully copies them into the summoned config, where nothing reads them. Guests are the flattest voices
  in the system, and they're the ones brought in for domain authority. Adding the tier lens + 1 bias +
  1 anti-pattern is ~4 lines.
- **T4** `buildQueryPrompt` calls `buildEvidenceGuidance(kind)` with no `activeCount`, so the solo branch
  (`blocks.js:100`) is unreachable from peer prompts. Harmless today (a solo agent can't be queried) but
  it means that branch is untested and will rot.

---

## 6. Consolidated fix list

### P0 — bugs that change behaviour (≈3h)

| ID | Fix | File:line | S |
|---|---|---|---|
| **P0-A** | **Never overwrite `finalText` from an enforcement retry.** Harvest tool calls only; log when a retry returned text. Raise the synthesis replacement bar from 10 chars to "substantive" (e.g. ≥ 200 chars or ≥ 50% of the prior text). | `execute-turn.js:361`, `:213` | S1 |
| **P0-B** | **Make the two retries mutually exclusive.** If the patch-retry already ran and missed, suppress the `SKILL.state` entry from `missingMandatory`. | `execute-turn.js:248-371` | S3 |
| **P0-C** | **Cache key = full rendered input.** Include `persona`, `agenda`, `communication_style`, `preferred_contribution_types`, `anti_patterns`, `name`; use FNV-1a 64-bit (or the key string itself) instead of a 32-bit hash. | `agent.js:33-45` | S1 |
| **P0-D** | **Gate the forum description block** on `loom.loom_forum`, same as the tool list. | `agent.js:143-147` | S2 |
| **P0-E** | **Reconcile the `mandatory` default.** Add `mandatory` to `DEFAULT_CONFIG.agentTools` **and** to `NESTED_SCHEMA`; pick one default policy (recommend: `skillState: true` everywhere, matching the Setup tab) and log when the two paths disagree. | `defaults.js:60-95`, `:118-151` | S2 |
| **P0-F** | **Stop advertising an unenforced cap.** Either enforce `maxToolCallsPerTurn` (trim ToolParts before synthesis, keep them for audit) or reword to "aim for ≤N tool calls". | `agent.js:219`, `execute-turn.js:33-44` | S2 |
| **P0-G** | **State pass/patch exclusivity** in the contract and in the `loom_pass` description. | `agent.js:227-241`, `pass.js:6` | S2 |
| **P0-H** | **Solo roster fix.** Pass `activeCount` into `buildAgentUserPrompt`; suppress the roster when solo; make the example id the first roster id; filter the roster to `listening`/`speaking`. | `prompt-session.js:149`, `agent.js:345-362` | S2 |
| **P0-I** | **Fix the bias-line grammar** in the template + add a loader lint for third-person-verb biases. | `agent.js:168`, `persona-loader.js:71-86` | S4 |

### P1 — prompt quality (≈half day)

| ID | Fix | File:line |
|---|---|---|
| **P1-A** | Contract truly last: move `WHEN TO PASS` above it, reword the header to "read last; in conflict it wins"; one idea per numbered item (split current 5 and 6). | `agent.js:211-243` |
| **P1-B** | Fix `[#12]`-is-a-participant-id, the "loom calls" budget wording, delete "don't yap", add a one-line tiebreak: *"keep the evidence, cut the framing — never cut citations, numbers, or dissent to hit a length."* | `agent.js:213,219,221` |
| **P1-C** | Add the **precedence paragraph** (contract > persona/tier guidance > SoP > Live) and label the persona lens as subordinate in the doctrine join. | `agent.js:~222`, `blocks.js:204` |
| **P1-D** | Delete the user-prompt Rules restatements; keep `§` pointers. Move the steering hint **before** the final patch line. Condition the `[#id]`-engagement bullet on non-empty live. | `agent.js:389-405`, `prompt-session.js:165` |
| **P1-E** | Patch salience 5→2: keep the final user line + the tool description as authority; demote contract item 7 to one line; delete the tool-list sentence and the "evicted echo" sentence; keep the self-interest clause (it's the only true-fact hook). | `agent.js:142,224,366` |
| **P1-F** | Mode (PLAN/BUILD) rendered unconditionally; BUILD sourced only from `buildMode`; replace the `has()` string-replace matcher with an explicit alias map. | `agent.js:86,95,116-118` |
| **P1-G** | Wire `buildRoundContext` into the primary user prompt as *guidance* (not contract), with the late-phase "Position:" closer demoted to optional. | `agent.js:~390`, `prompt-session.js:137` |
| **P1-H** | One bracket-tag sentence reconciling primary/peer surfaces. | `agent.js:220`, `interaction-prompts.js:104,123` |
| **P1-I** | Give summoned guests a voice: tier lens + 1 bias + 1 anti-pattern in `buildSummonPrompt`. | `interaction-prompts.js:132-195` |
| **P1-J** | Drop `windowNote` when the window is unknown; stop using it as a verbosity licence. | `agent.js:52,151,213,392` |
| **P1-K** | Fix N12 ceilings (injected budget == validated budget) with a load-time warning. | `persona-loader.js:77,80`; `control.js:689` |

### P2 — corpus (≈1 day, scriptable)

- **P2-A** Corpus-wide: delete "— measured by one X tradeoff number" from `agenda` and its duplicate in
  `tier_guidance`, **or** define the number's units in the contract. Pick one; today it's pure cargo cult.
- **P2-B** `tier_guidance` files: strip the leading "<Tier> <domain> doctrine:" prefix — `blocks.js` owns
  tier doctrine (N13).
- **P2-C** Normalize `preferred_contribution_types` to lowercase prose and reword the label to "Natural
  moves": the uppercase values (`CHALLENGE`, `DISSENT`) are the **removed** type-tag vocabulary
  (`DEPRECATED_KEYS['agentTools.loom.loom_type']`; `sanitize.js:16-18` drops them), and the prompt default
  is lowercase — the corpus and prompt disagree about the same field.
- **P2-D** Rewrite `known_biases` as noun phrases ("assumption of malicious intent by default") — fixes N9
  at source for all 100 files.
- **P2-E** Senior/principal `persona` floor 200 chars (today the floor is 50 and Security Engineer's is
  ~40 words); reject `expertise` entries that are traits, not domains (`eager`, `inexperienced`) — they
  pollute both the keyword scorer (`room.js:332`) and the embedding index.
- **P2-F** Civilian files: cut the incoherent "then add one expert check only you would know (code,
  material, procedure)" extension; keep the Tuesday test from `blocks.js:199`.
- **P2-G** **Decide `reflection_guidance`**: wire into perspective-mode task block, or delete from corpus
  + schema path + `README.md:181` + `ORCHESTRATION_ARCHITECTURE.md` (N2).

### P3 — the actual route to A (≈1–2 days, then permanent)

Editing prose raises quality once. Two mechanisms keep it there:

**P3-A · Prompt-lint (mechanical contradiction detection in CI).** Every defect in §5 is textual and
machine-checkable. A ~120-line `test/prompt-lint.test.js` asserting:
1. contract claims "read last" and *is* the final block;
2. every advertised limit is enforced somewhere in `src/` (grep the constant, assert a comparator);
3. tools described in the system prompt == tools in `buildToolsMap` (name-by-name, per config combo);
4. no prompt contains a bare third-person-verb bias;
5. no contradictory length directives (positive/negative sentinels, one source of truth);
6. bracket-tag policy stated identically in primary and peer prompts;
7. persona fields declared in `types.js` are each read by ≥1 prompt builder (kills the N2 class
   permanently);
8. injected text ≤ validated ceilings (N12).

**P3-B · Outcome harness.** Aggregate the enum that already exists:
`SELECT json_extract(prompt_context,'$.state_patch_outcome') AS o, COUNT(*) FROM contributions GROUP BY o`
plus citation density, tool-call success, mean prose words vs the 350–700 contract, pass rate,
tool-only turns. Publish per release; assert floors (e.g. `never_attempted` ≤ 10%, prose-in-band
≥ 70%, tool error rate ≤ 15%). This is what turns the §6 P0/P1 edits from *claims* into *evidence* — and
it directly retires the manual "1 patch / 9 turns" measurement that motivated the whole salience
strategy in the first place.

**P3-C · Golden-turn fixture.** One recorded, redacted meeting with 3 agents × 3 rounds; snapshot the
exact system+user prompts and assert structural hashes per section. Any accidental prompt edit shows up
as a diff to review, which is exactly the review discipline prose changes currently lack.

---

## 7. Exit criteria for an A

An A is not "the prose reads better." It is:

| Criterion | Currently | Target |
|---|---|---|
| Zero S1 findings | 3 (N0, N6) | 0 |
| Zero prompt assertions contradicted by runtime | ≥5 (N1, N3, N4, N5, N7) | 0, enforced by P3-A |
| Every persona field reaches a prompt | 1 of 2 documented fields dead (N2) | 100%, lint-enforced |
| Primary-turn round-phase guidance | absent (N10) | present, guidance-tier |
| Prompt-lint in CI | absent | 8 checks, blocking |
| Outcome metrics published per release | manual (N8) | 6 metrics + floors |
| Corpus artifacts (tradeoff tic, dead vocabulary, bias grammar) | present | zero, script-verified |
| Turn prompt size | ~14k chars | ~11k chars, same signal |

## 8. Grade trajectory

| Band | Work | Expected |
|---|---|---|
| Today | — | **C+** |
| P0 (3h) | data-loss fix, cache, defaults, contradictions | **B** |
| + P1 (half day) | structure, precedence, salience, round phase, budget | **B+ / A-** |
| + P2 (1 day) | corpus | **A-** |
| + P3 (1–2 days) | lint + outcome harness | **A** (sustainable) |

The P3 band is the one that matters. Four audits have now found the same defect classes (contradictions,
dead fields, unenforced claims) — that pattern says the missing thing is a *machine*, not more prose.

---

## Appendix A — reproduction

```bash
# 1. Render prompts under the three configs discussed in §5 (needs no DB, no LLM)
node --input-type=module -e "
import { buildAgentSystemPrompt, buildAgentUserPrompt } from './src/prompts/agent.js';
import { DEFAULT_CONFIG } from './src/config/defaults.js';
const p = { config: { id:'senior_x', name:'X', tier:'senior',
  persona:'A persona description long enough to pass the fifty character floor here.',
  agenda:'An agenda that is definitely longer than twenty characters for sure.' },
  status:'listening' };
const sys = buildAgentSystemPrompt(p, { activeCount:5, agentTools: DEFAULT_CONFIG.agentTools });
console.log('mandatory default :', DEFAULT_CONFIG.agentTools.mandatory);        // undefined  (N1)
console.log('contract item 7   :', sys.includes('REQUIRED — loom_state_patch')); // false      (N1)
console.log('forum desc present:', sys.includes('loom_forum_create_topic'));      // true       (N3-v1)
console.log('bias line         :', sys.split('\n').find(l=>l.includes('Bias awareness')));
"

# 2. Cache staleness (N6) — same id, DIFFERENT persona text
#    Verified output today:
#      cache busts on persona edit: false
#      second prompt still shows old persona: true      ← serves the wrong identity
node --input-type=module -e "
import { buildAgentSystemPrompt } from './src/prompts/agent.js';
import { DEFAULT_CONFIG } from './src/config/defaults.js';
const at = DEFAULT_CONFIG.agentTools;
const mk = (persona) => ({ config: { id:'p0', name:'X', tier:'senior', persona, model:{} }, status:'listening' });
const a = buildAgentSystemPrompt(mk('First persona text long enough to be rendered verbatim here.'), { activeCount:5, agentTools: at });
const b = buildAgentSystemPrompt(mk('A COMPLETELY DIFFERENT persona text that is also long enough to render.'), { activeCount:5, agentTools: at });
console.log('cache busts on persona edit:', a !== b);
console.log('second prompt still shows old persona:', b.includes('First persona text'));
"

# 3. Dead-field proof (N2)
grep -rn "reflection_guidance" src/prompts/ src/plugin/tools/   # no prompt consumer
grep -n "loom_state_patch" src/config/defaults.js               # no mandatory key

# 4. Retry overwrite (N0) — read src/round-executor/agent/execute-turn.js:356-366
```

## Appendix B — claim → evidence index

| Claim | Evidence |
|---|---|
| Contract not last | `agent.js:211` vs `:227` (WHEN TO PASS) vs `:242` (toolSection) |
| Length contradiction | rendered strings `agent.js:213` vs `:150-151` |
| `[#12]` mislabeled | `agent.js:221` vs `agent.js:273` (`- [#${c.id}] [${c.participant_id}]`) |
| Forum block unconditional | `agent.js:143-147` (no flag guard) vs `:105-107` (guarded) |
| Cache omission + collision | `agent.js:33-45` |
| Cap unenforced | `agent.js:219` vs `execute-turn.js:33-44` (warn only) |
| Contribution overwrite | `execute-turn.js:361` vs instruction at `:329` |
| Duplicate nags | `execute-turn.js:248` (patch retry) then `:313` (`missingMandatory` includes SKILL.state) |
| `mandatory` off by default | `defaults.js:60-95`; `control.js:527-534`; `setupForm.js:36`; render check above |
| `reflection_guidance` dead | grep; `README.md:181`; `ORCHESTRATION_ARCHITECTURE.md:116` |
| Round phase absent in primary | `blocks.js:179-191` consumers = `interaction-prompts.js`, `round-summarizer.js` only |
| Solo roster contradiction | `prompt-session.js:149` vs `tools.js:17` vs `agent.js:357` |
| Bias grammar | `agent.js:168` + `personas/senior/security-engineer.json:12-16` |
| Bracket-tag split | `agent.js:220`/`:295` vs `interaction-prompts.js:104,123` |
| Pass/patch exclusivity | `state-patch.js:49-51` vs `pass.js:20-23` |
| Tradeoff-number tic | `personas/senior/security-engineer.json:4`, `personas/principal/cfo.json:4`, `personas/civilian/suburban-parent-of-three.json:4` |
| Prompt size | rendered: system 9,597 chars, user 4,449 chars (minimal fixture) |
| Only behavioural datapoint | `ORCHESTRATION_ARCHITECTURE.md:383` ("1 applied patch across 9 primary turns") |

---

## Appendix C — Implementation record (2026-09-26)

Every P0/P1/P2/P3 item was implemented and verified: **full suite 85/85 green**
(pre-existing 63 + prompt-lint 19 + golden 3), `scripts/check.mjs` OK,
`scripts/docs-verify.mjs` passed, and a 22-point render check passed
(contract-last, salience, gates, grammar, ordering, sizes).

### P0 — all done
- **P0-A** `execute-turn.js:361` no longer overwrites `finalText` from the
  mandatory retry (tools harvested only, prose ignored with a debug log); the
  retry instruction now says "make ONLY the required tool call(s)". Synthesis
  replacement bar raised from 10 chars to substantive (≥200 chars or ≥50% of
  the prior text) with a `synthesis_too_short` warn. Pinned by lint test 13.
- **P0-B** `patchRetryAttempted` flag suppresses the duplicate `SKILL.state`
  mandatory retry when the patch-retry already ran (`execute-turn.js`).
- **P0-C** Cache key covers every rendered persona field and uses FNV-1a
  64-bit (`agent.js`). Verified: edited persona now busts the cache (was:
  second prompt still showed the old persona). Pinned by lint test 8.
- **P0-D** Forum description block gated on `loom.loom_forum` (`agent.js`).
  Pinned by lint tests 3/3b.
- **P0-E** `mandatory` added to `DEFAULT_CONFIG.agentTools`
  (`skillState: true`, matching the Setup tab) and to `NESTED_SCHEMA`
  (5 keys). `deepMerge` handles the new object key; `buildMeetingAgentTools`
  overwrites the same shape — no control.js change needed. One test in
  `test/forum.test.js` updated to the new default (it had pinned the old one).
- **P0-F** Budget reworded to guidance ("overages are logged, not
  hard-stopped") and now reads the per-meeting override instead of global
  config. Pinned by lint test 2.
- **P0-G** Mutual exclusivity stated in the contract, WHEN TO PASS, the tool
  list, and the `loom_pass` tool description (which also corrected the
  termination claim). Pinned by lint test 14.
- **P0-H** Roster filtered to listening/speaking in `prompt-session.js`;
  `queryEnabled` suppressed when solo; example id drawn from the live roster
  (`agent.js`). Pinned by lint tests 3 (solo combo) and 10.
- **P0-I** Bias template rewritten ("watch for these tendencies…");
  `lintPersonaStyle` added and wired as a load-time warn. Corpus migrated to
  lowercase continuation form (see P2).

### P1 — all done
Contract truly last (WHEN TO PASS moved above it; header now "read last, it
governs; in conflict it wins"); items 5/6 split with a precedence paragraph
(contract > persona > SoP > Live); item 7 demoted to a one-liner pointing at
the tool description; `[#12]`/budget/"don't yap" wording fixed with a
tiebreak sentence; user Rules collapsed to § pointers; SoP bullet harmonized
(provisional → canonical); `[#id]` demand conditional on non-empty live;
steering hint moved inside the builder before the final patch line
(`options.steeringHint`, `prompt-session.js` no longer appends);
`buildRoundContext` wired into primary turns via `options.maxRounds`
(guidance tier); bracket-tag exception sentence; summon guests get tier lens
+ bias + craft; `windowNote` falls back to "large", verbosity licence
removed; truncation-ceiling warnings (`lintTruncation`); BUILD sourced from
`buildMode` (legacy write/edit inference only when unset); explicit web
tool alias map; `## Mode` rendered unconditionally. Pinned by lint tests
1, 11, 12, 16 and the golden fixture.

### P2 — done, with one deliberate deviation
Scripted migration over 89 files: tradeoff-number tic removed from agendas
(30 files, 0 leftovers), doctrine prefixes stripped (87 files, 0 leftovers),
civilian expert-check demand removed (40 files, 0 leftovers), contribution
types lowercased (8 values), biases lowercased, 4 trait entries removed from
`expertise` (no array emptied). All files still validate; 0 style + 0
truncation warnings. **Deviation:** senior/principal persona *expansion*
(<200 chars in all 20 files) was NOT done — fabricating 20 domain voices is
authorship, not cleanup. Instead `lintDepth` warns at load (visible in test
output: 20 `persona_thin` warnings). **P2-G decision: wired, not deleted** —
`reflection_guidance` now reaches perspective-mode task + system prompts
(`query-modes.js`, `interaction-prompts.js`, `query-evidence.js`), which also
makes the `README.md:181` claim true.

### P3 — done
- **P3-A** `test/prompt-lint.test.js`: 19 checks (contract-last, no hard cap,
  described==offered ×3 configs, forum gate, bias grammar, bracket policy,
  field coverage incl. guest lens + reflection guidance, corpus lint,
  cache-bust, first-speaker, roster id, round phase, steering order,
  N0 source guard, exclusivity, mandatory parity, tools-off mode).
- **P3-B** `scripts/turn-outcome-report.js`: aggregates patch outcomes,
  citation density, tool error rate, prose band, passes, tool-only turns from
  meeting DBs; `--check` exits 1 on floor violation (verified against a
  synthetic DB: report exit 0, check exit 1).
- **P3-C** `test/prompt-golden.test.js`: per-section SHA hashes for a fixed
  golden turn + contract-last ordering assertion.

### Honest deltas vs the proposal
- System prompt grew 9,597 → ~10,000 chars (Mode section + precedence +
  exclusivity lines outweigh the trims); user prompt shrank 4,449 → ~3,150
  (−30%). Combined −6%, not the −15–20% projected — correctness was bought
  with bytes. Further compression is available (Quality block, tool-list
  prose) but was judged lower-value than the shipped fixes.
- `test/forum.test.js` required one update (it had pinned the old
  mandatory-absent default).
- No live-LLM validation was run; behavioural claims (patch rate, citation
  density) remain to be confirmed via `scripts/turn-outcome-report.js --check`
  on real meetings — that is the defined next step, not a gap in this work.

# Loom — Deliberation Quality in Totality (2026-10-21, **revision 2** — implemented)

> **Implementation status: every finding below is implemented**, with the
> architecture doc (`ORCHESTRATION_ARCHITECTURE.md`) updated in the same pass and
> new `docs:verify` pins so the contracts cannot drift again. See
> [§0 Implementation log](#0-implementation-log--what-landed) for the
> file-level map, the measured before/after, and the two places where the
> implementation had to go further than the plan.
>
> *Restored 2026-10-22 after an external process emptied `analysis/`; the code
> changes it describes were never lost.*

## 0. Implementation log — what landed

| # | Change | Files |
|---|--------|-------|
| **A** | The shared consensus section is the **orchestrator's** settled registry (the clerk's semantic judgement); the agents' exact-match ≥2-holder aggregate is the fallback. The settled merge now happens *before* the State of Play is built, and the room sees the orchestrator's items in **every** round (the early-phase pointer named an empty section). | `src/state-patch.js`, `src/orchestrator/round.js`, `src/prompts/blocks.js` |
| **B** | The transcript budget is the **model's window** (`budgetCharsFor`), not a constant. Two reserves: every round keeps a citable index (one line per contribution), and whatever is left goes to the newest rounds' full text — so the final round is the last thing sacrificed. | `src/state-of-play.js`, `src/synthesis-coordinator.js`, `src/orchestrator/synthesis.js` |
| **C** | The room receives the clerk's account as its **bullets** (`Settled` / `Contested` / `Next`) under a new heading, and the synthesis digests carry the same bullets. New `src/lib/clerk-summary.js` parses the clerk's fixed output format. | `src/lib/clerk-summary.js`, `src/prompts/agent.js`, `src/state-of-play.js` |
| **D** | The orchestrator's order is its call: the override block, the tool description and the doc no longer bias it against acting; the roster shows who spoke this round and who spoke **first**; the order it set stands until it changes it. | `src/round-summarizer.js`, `src/plugin/tools/turn-order.js`, `src/services/round-service.js`, doc §6 |
| **E** | `## Dissenting Views` is a **slot, not a detector**: the artifact's dissent is the clerk's `Contested` bullet, carried (with a doctrine rule and a critique-checklist line), never re-derived. | `src/prompts/synthesis.js`, `src/synthesis/sections.js`, `src/synthesis/finalize.js`, `src/synthesis-coordinator.js` |
| **F** | The action-item template can no longer offer `handoff to @role`, and `finalizeSynthesis` repairs any surviving invented handle deterministically. | `src/prompts/synthesis.js`, `src/synthesis/finalize.js` |
| **G** | The forum's **discussion** (not its titles) travels into the synthesis context, fenced as data. | `src/orchestrator/synthesis.js`, `src/orchestrator.js`, `src/prompts/synthesis.js` |
| **H** | Every artifact ends with a factual provenance footer: rounds · contributions · participants · ballots held (or "no ballot held") · the share of contributions it cites. | `src/synthesis-coordinator.js` |
| **I** | The engagement ledger is labelled an internal check and told not to be cited. | `src/prompts/synthesis.js` |
| **J** | Owner distribution moved into the template; the critique checklist checks it. | `src/prompts/synthesis.js`, `src/synthesis-coordinator.js` |
| **K** | Code-analysis artifacts must carry `## Files Involved`. | `src/prompts/synthesis.js` |

### Measured, before → after

| | before | after |
|---|---|---|
| ids visible to the synthesizer (10-round meeting, 200k-token model) | 18 / 241 (7%) | **241 / 241 (100%)** |
| ids visible (10-round meeting, 32k-token model) | 18 / 241 | **141 / 241, final round 33/33** |
| the final round's contributions visible | 0 / 33 | **33 / 33** |
| plain contributions visible (10-round, 200k model) | 6 / 100 (6%) | **100 / 100** |
| the shared consensus section in the recorded F1 meeting | **empty (0 rows)** | the orchestrator's 2 real consensus items, with their `[#id]`s |
| rounds whose room-view contained the clerk's `Settled`/`Contested` bullets | 0 / 10 | **10 / 10** |
| the artifact's dissent (10-round, 22 critiques) | 0 chars | a required slot, sourced from the clerk |
| invented handoff targets in real artifacts | 3 | 0 (template + deterministic repair) |

### Two places the implementation went further than the plan

1. **The transcript needed a guarantee, not a heuristic.** The first cut of the new builder reserved a share of the budget for the citable index and let the full text compete with it — and in the tightest budgets the final round ended up *neither* full *nor* indexed. The assembly now reserves the index first (every round keeps its ids) and spends what is left on the newest rounds' full text, so the final round is only ever demoted to an index, never dropped.
2. **The ledger's framing had to move with the dissent slot.** Both were "the synthesizer should know something it cannot see" — the ledger's uncited ids and the clerk's contested bullet. The ledger is now explicitly non-citable, and the dissent slot explicitly carries the clerk's verdict.

**Test surface:** 419 → 425 tests, all green, plus 11 new `docs:verify` pins (the consensus ownership, the settled block in every phase, the clerk's account bullets, the dissent slot, the band contract, the resolved window, the ratchet steer).

---

## 1. The instrument

| | `5817825a` (F1) | `7811b8db` (10-round) | `3113ed87` (6-round) |
|---|---|---|---|
| rounds | 4/4 | 10/10 | 6/5 |
| contributions | 23 | **241** | 38 |
| primary / interactive | 12 / 11 | 100 / 141 | 25 / 13 |
| ballots held | 0 | **79** | 0 |
| cross-citations | 3.83/contrib | 4.65/contrib | 6.29/contrib |
| agent errors | 0 | 0 | 0 |
| participation spread (min/max) | 0.88 | **0.37** | 0.67 |
| **contributions cited in the artifact** | 100% | **10%** | 88% |
| **orchestrator's dissent in the artifact** | 989 chars | **0 chars** | 1475 chars |
| **orchestrator's "Settled"/"Contested" bullets reaching the room** | 2/4 rounds | **0/10 rounds** | — |
| **…reaching the synthesizer (earlier rounds)** | 0/4 | **0/10** | — |

The artifact quality is genuinely high — spectrum table, a real Decision Rule (trigger/order/owner/date/default/re-pricing), `(n, window, source)` on every figure, named dissent, owners on every action item, split confidence ("Name: Medium; Number: Low"). **The writing is not the problem. The pipeline is: the orchestrator's judgement is cut away before either the room or the synthesizer can use it.**

---

## 2. The findings

### A. The room has no shared memory of what it has settled (P0)

**Who owns this.** The orchestrator already *is* the consensus authority: its `**Settled:**` bullet is a **semantic** judgement ("items the room converged on this round that now have multi-holder agreement"), and the meeting-level registry built from it is exactly that — 2 items in the F1 meeting ("The room converged that 'races' means FIA Sunday Grands Prix in 2027 excluding Sprints…"), 8 in the 10-round one ("Governance before slim — version-pin plus risk tier precedes any compile/slim…"). The design note in `src/lib/settled-registry.js` says it outright: the clerk "detects paraphrased consensus semantically, which exact-match state aggregation cannot (deliberation 2 replay: five agents, five phrasings, zero exact matches)".

**Measured.** The exact-match path indeed never fires: **0 multi-holder `established` items** in both meetings, so the shared State's "Agreements & Proposals" section has **0 rows** (the F1 meeting's stored SoP has no consensus section at all). Two consumers of "what is settled" therefore disagree:

| consumer | source | what it actually saw |
|---|---|---|
| the room's prompt — `## Settled Watch` pointer | the **orchestrator's** registry (2-8 items) | a count, and a pointer to *"Agreements & Proposals"* — a section that is **empty** |
| the synthesis prompt — "State of Play (**PRIMARY source**)" | the **agents'** exact-match | nothing (0 rows in every meeting) |

So the consensus record exists, is good, is owned by the right party — and is delivered to neither.

**Fix (orchestrator-owned, one source of truth).**
1. The State's consensus section is populated from the **orchestrator's settled registry** (items carry their `[#id]`s — the clerk writes them with refs), not from the agents' holder counts. The exact-match aggregation remains what it already is elsewhere: the **fallback** for meetings with no designation yet (round 1, a degraded clerk, flag-off).
2. The room's prompt renders the orchestrator's settled items in **every** round (they are 2-8 items, capped at 10 — measured), with the late phase keeping the stricter "signed, do not re-argue" wording.
3. The pointer text stops naming a section that can be empty; it points at the registry.

This also *strengthens* the existing A4 invariant (a single agent's self-assertion must not render as consensus): enforcement moves from a holder count to the **orchestrator's judgement**, which is strictly better evidence.

### B. The synthesis transcript is the deliverable's ceiling (P0)

**Measured.** `formatFinalRoundTranscript` builds the synthesizer's view of the deliberation under a hard-coded **24,000 characters** (~6k tokens) — in a prompt that announces the model's real window (200k+, and 1M models exist). For a long deliberation the loss is severe and lands in the worst place:

| Meeting | ids visible to the synthesizer | plain contributions visible | round 1 | **final round** |
|---|---|---|---|---|
| `5817825a` (4 rounds) | all | all | ✓ | ✓ |
| `3113ed87` (5 rounds) | 15/38 | 10/25 (40%) | 0/5 | **0/8** |
| `7811b8db` (10 rounds) | **18/241 (7%)** | **6/100 (6%)** | 0/21 | **0/33** |

Two structural faults, both in `src/state-of-play.js`:

1. **The final round is the first thing cut.** For >4 rounds the builder takes the last 2 rounds "in full", then — if *that tail* exceeds 24k — hard-cuts the tail and gives the earlier rounds nothing. The most decision-relevant round disappears first, and the truncation marker ("earliest rounds summarized, latest rounds fuller") describes the opposite of what happened.
2. **Earlier rounds are a 400-char prefix of the summary** — and see finding C: that prefix does not contain the orchestrator's `Settled`/`Contested` bullets at all (0/10 rounds). So for earlier rounds the synthesizer receives the room's *establishments* and none of its *disagreements*.

**Fix.**
- **Derive the budget from the model, not from a constant.** The synthesis model's window is already resolved and threaded into the coordinator — reuse `budgetCharsFor(model, availableModels)`, the same helper the agent path uses. With a 1M-token model the whole deliberation fits and the cap effectively disappears; with a 32k model it shrinks honestly.
- **Never drop the final round.** When the window genuinely cannot hold it, degrade by *whole-unit per-contribution cuts with a marker*, never by dropping a round.
- **Keep every contribution citable.** If a contribution's prose is cut, its index line (`- [#id] holder (type): …`) stays, so "cite by [#id]" keeps working and the artifact can still represent what the room did.
- **Carry the orchestrator's bullets in the digests** (Settled / Contested / Next), not a prefix of prose — the digest should carry the *judgement*, not the first paragraph.

**One honest caveat (latency, not cost).** The 24k constant was a *latency* guard, not a cost guard — the code says so ("truncations are anti-timeout only"), and the synthesis call has a fixed 15-minute timeout (`synthesisTimeoutMs: 900000`). So the implementation should scale the budget with the window **and** keep the timeout honest: either keep a latency ceiling well above the realistic deliberation size, or let the synthesis timeout scale with the payload it was given. The cap should come from the window and the timeout, never from a constant nobody re-checks.

### C. The clerk's round account is written — and delivered to the dashboard, not to the room (P0/P1)

**Measured.** The clerk writes 4,000-6,500 characters per round; the room sees the first **600** (`src/prompts/agent.js:389-390`, unmarked). What survives is not "a bit less" — it is *the wrong part*:

| Meeting | rounds whose 600-char prefix still contains the clerk's `Settled` bullet | …the `Contested` bullet |
|---|---|---|
| `7811b8db` | **0/10** | **0/10** |
| `5817825a` | 2/4 | 1/4 |

In the 10-round meeting the room received **only the `Established` bullet** in every single round — the three bullets that actually change behaviour (`Settled`: what is agreed, `Contested`: what is disputed, `Next`: what this round must produce) never reached the participants who could act on them. The same holds for the synthesizer's 400-char earlier-round digests (0/10).

**Fix (a bug, not a budget).**
- Deliver the clerk's account at a **window-scaled budget** (the agent's fit ladder already sacrifices this block when a prompt is too large — `prompt-session.js:243-244`, fit step 3 — so a bigger cap is safe).
- **Deliver it as its bullets, not as a prose prefix.** The clerk's output format is fixed (`**Established:** …`, `**Settled:** …`, `**Contested:** …`, `**Evidence:** …`, `**Open:** …`, `**Next:** …`), so a deterministic parse can give the room the three lines it can act on (`Settled`, `Contested`, `Next`) inside a few hundred characters — the right content instead of the first 600 characters of the wrong content.
- The same bullet-level carry belongs in the synthesis transcript's digests (finding B).

The clerk is the room's memory. Today it writes for the audience that cannot act.

### D. The orchestrator owns the next round's order — and it is not acting (P1)

**The mechanism is right.** The clerk's `loom_set_turn_order` call is the orchestrator-only override; the order it sets **persists** into the next round (`setPlannedTurnOrder` survives until `filterActiveParticipants` applies and clears it), and it also sets the next speaker. The F1 meeting shows it working: round 1 opened by `revenue_ops`, rounds 2-4 by `startup_veteran` (a clerk override). The 10-round meeting shows it unused: **the same participant opened all 10 rounds** (and all 5 in `3113ed87`).

**Why it doesn't fire — three reasons, all fixable:**
1. **The wording biases against it, in three places.** The tool description: *"only when this round's evidence warrants a different order; **omit to keep the default rotation**"*. The clerk's override block: *"**Default rotation stands.** If this round's evidence warrants a different speaking order next round, call loom_set_turn_order once… **Omit it to keep the default.**"* And the architecture doc: *"Default order: Agents speak in composition order… There is no randomization."* — there is no "rotation" anywhere: the default is the static composition order. A model told three times that the default stands, and that changing it is exceptional, does not change it.
2. **The clerk cannot see the pattern it would fix.** Its roster is `id — N contributions` (cumulative) — enough to know who is quiet, but not who spoke in which order, so it cannot see "this person opened every round".
3. **The first speaker is structurally privileged** (it takes the steering hint, the first-speaker opening duties, and frames the round), so leaving the order alone compounds one voice's influence over the whole deliberation.

**Fix (the orchestrator decides; the machinery must make deciding easy and default-on).**
- **Reword, in all three places**, so the orchestrator's order is the mechanism and its previous decision persists: *"Next round's order is yours: the order you set last round stands until this round's evidence warrants a change — call loom_set_turn_order with the full id list when it does. Set one when the roster shows a voice that has spoken least, a claim that needs a defender next, or a position that must be tested before the room converges."*
- **Show the clerk the speaking order** (who spoke this round, in order) alongside the roster, so "this person opened every round" is visible to the only agent that can act on it.
- **Make the policy line actionable** — it already carries the operator's `anti_starvation` / `evidence_first` preference; with the order visible, the clerk can apply it.
- **Fallbacks stay the orchestrator's to override:** when the clerk does not call, the composition order stands. (Optional, flagged as a judgement call: a fairness fallback — advance to the least-recently-spoken participant — would stop a *passive* clerk from freezing one voice at the front, and the orchestrator's explicit order overrides it the moment it is given. This is a decision for the maintainers, not a silent default.)

### E. Dissent is the orchestrator's judgement — so the artifact must source it there, never re-derive it (P1)

**Measured.** The most contested meeting recorded — `7811b8db`: 22 critique responses, 19 perspective responses, 1.78 contest-hits per contribution, 79 ballots — produced an artifact with **`dissent_chars=0`**. Its dissent *is* in the artifact, but buried inside a Reasoning bullet ("Risk Officer held the lone dissent for fail-closed on unpriceable tail risk"). The other two meetings happened to carry a `## Dissenting Views` section.

**Why.** Nothing in the output contract asks for that section: the draft prompt's required sections are Executive Summary / Decision / Decision Rule / Reasoning / Action Items / Open Questions / Confidence. The section appears in artifacts only when the model chooses to write it. (The previous audit removed `## Dissenting Views` from the *critique template* because the draft prompt never defined it — correct about the template, but it left the section undefined everywhere. It must be **defined**, not left undefined.)

**The fix must not reintroduce detection.** The codebase deliberately removed dissent detection (no keyword heuristics over responses, no objection collector, no per-type dissent inventory) and the synthesis doctrine says so explicitly: *"Dissent tracking is the orchestrator's job, not a regex's. It reads the full transcript and decides for itself what is live dissent."* So:

- **The orchestrator's `**Contested:**` bullet is the dissent judgement** — it names the live disagreement, the holders, and their positions with `[#id]`s. That is the source.
- **The synthesis prompt is told to carry it forward**: *"the round clerk named the live disagreement in its Contested bullet — reproduce it in `## Dissenting Views` with the holders and their `[#id]`s; do not go hunting for new dissent in the prose, and do not soften it."*
- **The section is a slot, not a detector**: always present, "None — the room converged" when the clerk named none. No keyword pass, no heuristic, no new vocabulary.
- **Make sure the clerk's Contested bullet actually reaches the synthesizer** (finding B/C: today 0/10 earlier rounds carry it) — otherwise the instruction points at nothing.

A reader must be able to see what the room did *not* settle. That is the orchestrator's verdict to render, not the synthesizer's to discover.

### F. The action-item template teaches the artifact to invent handoff targets (P1)

**Measured.** Two of the three real artifacts contain invented `@handles` that the synthesis prompt explicitly forbids:

- `5817825a`: `— proposed: The Revenue Operations Director → handoff to @technical-analysis —` and `→ handoff to @trackside-ops`
- `7811b8db`: `— proposed: Product Engineer → handoff to @systems_engineer_6 —`

The prompt forbids exactly this — *"never invent @handle/@role placeholders (no '@technical-analysis'-style invented teams)"* — while the **template** for the section offers the forbidden form:

```
- {verb} {what} — owner: {name or "proposed: X → handoff to @role"} — block cite [#id]
```

A fill-in-the-blank template with a concrete example beats a rule in prose: the model copies the template. The rule's own alternative (`'proposed: X — needs a participant with domain Y'`) is never shown as a template, so it is never used.

**Fix.**
- Change the template to the rule's form: `- {verb} {what} — owner: {name} — block cite [#id]`, plus a clearly-offered second line for unattributed work: `— proposed: needs a participant with domain Y —`.
- Add a **deterministic guard** in `finalizeSynthesis`: an action item containing an `@handle` that is not a participant name is rewritten to `proposed: needs a participant with domain Y`. No LLM call, no false positives, and the artifact stops shipping targets that do not exist.

### G. The forum never reaches the deliverable (P1)

The forum digest rides in the State of Play so the clerk and the synthesizer read it — but the digest is **titles, comment counts and a 160-character preview** (`src/utils/forum-digest.js`). The thread discussion itself never reaches the synthesizer, while the agent-facing prompt tells participants *"writing here is writing to the room"*.

**Measured: all three recorded meetings created zero forum topics and zero forum comments** (the tables exist, nothing was ever written) — the forum is a write-only sink in practice, exactly the failure the post-mortem said it was fixed for. (The seed's foreign-key defect is documented in the primary/orchestrator audit, §2b.)

**Fix (bounded, no new tool):** include the threads' actual recent comments (up to 3 threads × the last 2 comments, ~300 chars each) in the synthesis context. The read path already exists (`loom_forum_read_topic`); the orchestrator now reads the forum and hands it to the synthesis, fenced as data. If the forum is unused, the cost is zero.

### H. The deliverable does not state its own provenance (P1)

A reader of the 10-round artifact learns it rests on 10 rounds, 241 contributions and 79 ballots only from the **report header** ("Rounds: 10"). The artifact itself never says how many contributions the deliberation produced, whether a **ballot** was held (two of the three meetings held none, and the reader cannot tell that its Decision Rule is prose rather than a tally), or what fraction of the room it actually represents (the number is already computed — `artifact.engagement.coverage` — and hidden in JSON where no reader will see it).

**Fix (deterministic, coordinator-side, no LLM):** append a short factual footer:

```
---
*Deliberation: 10 rounds · 241 contributions · 10 participants · 79 ballots held · 18% of contributions cited in this artifact.*
```

Honesty about coverage is a trust signal, and it is free: every number is already known to the coordinator.

### I. The engagement ledger leaks internal meta-stats as citable claims (P2)

**Measured.** The 10-round artifact contains, inside a Reasoning bullet:

> "Ledger hygiene: 1 of 100 plain contributions engaged no peer (n=100, window=full deliberation, Source: Engagement Ledger [#1])"

Two problems: the ledger's internal statistics are quoted as a finding, and the citation `[#1]` points at a contribution unrelated to them. The ledger is a **check**, not evidence, and it is currently citable-shaped.

**Fix:** mark it as non-citable context (`_Internal check — not a source; do not cite it._`) and remove the "Source:" affordance from the block.

### J. Action-item ownership concentrates on one holder (P2)

**Measured.** F1: 4 of 6 items owned by the Chief Revenue Officer. 10-round: 4 of 6 by the Systems Engineer. The prompt says *"distribute owners (max 2 per holder unless justified)"* — the artifacts neither distribute nor justify.

**Fix:** the template line becomes *"distribute owners — no more than 2 items per holder unless you say why in one clause"* (an instruction inside the template, where it is read), and the critique checklist gains one line: *"are the owners distributed, or is every item landing on one agent?"*

### K. Code-mode artifacts never report the files involved (P2)

`artifact.files_involved` is extracted from the artifact — but the code-analysis required-sections list is Executive Summary / Decision / Decision Rule / Reasoning / **Proposed Fix** / Action Items / Open Questions. Nothing asks for a file list, so the field is usually empty. For a programming deliverable, "which files changed, which are proposed" is a headline item, and the State of Play already carries a `## Files Involved` section the synthesizer can see.

**Fix:** require `## Files Involved` in code-analysis mode (the section has a renderer and a structured field), or fold the file list into `## Proposed Fix` so it cannot be omitted.

### L. Category labels in the artifact's Reasoning — closed, and the measurement vindicates it (P2, closed)

Every Reasoning bullet in the 10-round artifact carries a category: *"**Devil's Advocate (junior, [#188])**"*. The synthesis prompt forbids that ("no category anywhere in this prompt by design") and the previous audit's B2 fix (category-free, domain-free few-shot example + the rule moved into the prompt text) addresses it. The artifact is the proof that the *old* few-shot example was being imitated verbatim — few-shot examples, not rules, decide this. Closed; kept here as the evidence.

---

## 3. What the review changed

| Original proposal | Correction | New proposal |
|---|---|---|
| Render the **mechanical** settled registry every round; fold it into the SoP | The consensus record is the **orchestrator's** judgement — it should *be* the SoP's consensus section, and the agents' exact-match stays the fallback | A.1/A.2/A.3 |
| Scale the transcript budget with the model window (a "budget" proposal) | There should be **no fixed 24k budget at all** — the window *is* the budget, and 1M-token models exist | B (budget derived, not scaled), plus final-round protection and citable index lines |
| Rotate the default turn order mechanically | The **orchestrator** decides the order; the problem is that it is not acting (biased wording, it cannot see the pattern) | D (rewording, visibility, policy actionability; fallback flagged as a judgement call) |
| Require a `## Dissenting Views` section | No detection, ever — the **orchestrator's** `Contested` bullet is the source; the slot is a slot | E (carry the orchestrator's verdict; ensure it actually reaches the synthesizer) |
| (new) | The 600-char cut was called a "budget" | It is a **bug**: it removes exactly `Settled`/`Contested`/`Next` in 0/10 rounds | C |

**Guard rails for this whole plan — deliberately NOT done:** no keyword/text detection of dissent, roles, or agreement (that machinery was deleted on purpose); no persona permission tiers or role hierarchy (every persona stays equal, names only); no new features, tools, or LLM calls; no output/input budget cuts — every budget change here *removes* a self-imposed truncation.

---

## 4. What is already excellent — measured, and worth protecting

- **Numeric discipline holds.** 76 / 47 / 37 `[#id]` citations across the three artifacts, **0** dangling ids, every figure carrying `(n, window, source)`.
- **The citation-warning detector is precise enough to ship.** Run against the three real artifacts it flags **1, 1, 0** (≈1-2% false positives) — and it is currently `dryRun` and off, so a useful trust signal is computed and discarded. *Decision point (not a change):* ship it softly — fold "2 citations could not be verified against the transcript" into the Confidence justification rather than adding a warnings section.
- **Ballots reach the artifact verbatim** — *"count-and-mark won 8 to 1 (n=9 responders, window=round 9, Source: [#201])"*. The ratchet doctrine works end to end.
- **The Decision Rule is a real instrument** — trigger, order, owner, date, default, re-pricing — present in all three artifacts, including what would reopen it.
- **The room really engages.** 3.83-6.29 peer citations per contribution; the engagement ledger found only **1** peer-uncited plain contribution in 100. The agents cite each other — *visibility* is the problem, not willingness.
- **Zero agent errors** across 302 contributions; the degraded paths were never needed.
- **Participation can be perfectly balanced** (F1: Gini 0.029) — the 10-round imbalance is a *turn-order* artefact, not a capability limit.
- **The synthesis prompt's grounding and versioned-base-table doctrines visibly work** — the F1 artifact names the superseded gates.

---

## 5. The plan

| # | Change | Owner of the decision | Effort | Risk |
|---|--------|----------------------|--------|------|
| 1 | **The State's consensus section = the orchestrator's settled registry**; the room sees the orchestrator's settled items every round; the pointer stops pointing at an empty section | orchestrator | 1.5 h | low (2-8 items) |
| 2 | **Transcript budget = the model's window**; the final round is never dropped; every contribution keeps a citable index line; the digests carry the orchestrator's bullets | orchestrator | 3 h | medium (prompt size) |
| 3 | **The clerk's account reaches the room** (window-scaled) and arrives as its bullets — `Settled` / `Contested` / `Next` — not a prose prefix | orchestrator | 1 h | low (fit ladder protects) |
| 4 | **The orchestrator acts on the order**: reword the override block + tool description + doc so its decision persists and is the default path; show it who spoke in which order; make the policy line actionable | orchestrator | 1 h | medium (turn order changes) |
| 5 | **Dissent reaches the artifact from the orchestrator's `Contested` bullet**; the slot is always present; no detection | orchestrator | 1 h | low |
| 6 | **Action items cannot invent handoffs** (template + deterministic guard) | synthesizer | 45 min | low |
| 7 | **Provenance footer** on the artifact | coordinator | 45 min | low |
| 8 | **Owner distribution + files in code mode** | synthesizer | 45 min | low |
| 9 | **Forum content into the synthesis context** | coordinator | 1.5 h | low |
| 10 | **The ledger is not citable** | coordinator | 15 min | none |

**Order:** 1 → 3 → 2 → 5 → 6 → 4 → 7 → 9 → 8 → 10. Items 1, 3 and 2 are the ones that make a *long* deliberation worth running; 5 and 6 are the ones that make every artifact trustworthy; 4 is the one that makes a ten-person room feel like ten people.

**Status: all 10 implemented** — see [§0](#0-implementation-log--what-landed).

### Keep it measurable

Every number in this document comes from ~40-line read-only scripts over the meeting DBs (transcript visibility, state-bucket holder counts, clerk-bullet survival under the cut, artifact coverage, detector precision, first-speaker per round). **Proposed: land them as `npm run quality:meetings`** so a future change to the prompt, the transcript builder or the turn order cannot silently cost the room 90% of its work again. A plugin that measures its own deliberation quality is also the plugin that can claim it.

---

## 6. Non-findings (checked, deliberately left alone)

- **The engagement ledger's strictness** — demanding coverage is right; the problem is visibility, not the demand. The ledger is tiny (1 of 100) because the agents really do cite each other.
- **The synthesis's second LLM call** — the critique pass is a quality feature and visibly fires.
- **`## Files Involved` in the State of Play** — fine; only the artifact side needs the file list.
- **Randomising turn order** — no: the orchestrator's decision should be auditable and reproducible.
- **A "what we did not consider" section** — `## Open Questions` already carries unresolved questions with probes; a second section would duplicate it.
- **The spectrum table format** — the best part of the F1 artifact (two positions, named holders, evidence and tradeoff per row). Leave it alone.

---

## 7. Verification snippets

```bash
# A — does the shared State of Play ever carry consensus, and where does it come from?
node -e "…parse participants.state_json, count holder sets per bucket…; SELECT state_of_play, settled_items FROM meetings"
# B — what fraction of the room's work can the synthesizer see?
node -e "…formatFinalRoundTranscript(transcriptData, participants); match /\[#(\d+)\]/g…"
# C — which clerk bullets survive the cut the room actually receives?
node -e "…SELECT summary FROM rounds; take summary.slice(0, 600); test /\*\*Contested:\*\*/"
# D — who opens each round?
node -e "…SELECT round, participant_id FROM contributions ORDER BY id…"
# E — does the artifact carry the orchestrator's dissent?
node -e "…SELECT content FROM artifacts…"
# F — do artifacts invent handoff targets?
grep -o "handoff to @[a-z_]*" .opencode/loom/meetings/*.md
# H — what does the artifact cover?
python3 .opencode/loom_quality.py .opencode/loom/meetings/<id>.db
```

---

## 8. The one-paragraph version

The deliberation machinery is good — 302 real contributions, zero agent errors, disciplined citations, working ballots, a Decision Rule that names its own re-opening conditions. What limits the deliverable is not the writing: it is that **the orchestrator's judgement is cut away before anyone can use it**. The room receives 600 of ~5,000 characters of the clerk's account, and that 600 happens to contain only the `Established` bullet — never `Settled`, never `Contested`, never `Next` (0/10 rounds). The synthesizer receives a fixed 24k slice of the deliberation that cuts the **final round first**, so a 10-round meeting arrives as 7% of itself and the artifact represents 10% of the room's work. The State's consensus section is computed by exact string match, so it is empty in every real meeting while the orchestrator's semantic consensus record (2-8 items, high quality) sits in a list nobody reads. And the orchestrator, which owns the next round's speaking order, is told in three places that the default stands — so one voice opened all ten rounds. None of this needs a new feature: the fixes are to stop cutting, to let the orchestrator's own products reach the room and the synthesizer, and to remove three sentences that tell the orchestrator not to act.

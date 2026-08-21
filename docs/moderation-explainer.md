# Moderation System — Purpose, Mechanics, and What-If Removal

> Prompt-engineering perspective. No code changes to moderator in this batch per your hold request — this doc is the talk-through you asked for.

## 1. Purpose — what the moderator is for

The Loom runs 2–7 agents across 2–4 rounds, each with escalating temperature and a private incentive to be heard. Without governance it drifts:

* **Circular stalemate** — two agents trade `challenge ↔ challenge` on the same premise with no new evidence (e.g., Security Engineer vs Architect on “stateless vs revocation” for 3+ exchanges).
* **Starvation** — a `principal` who proposes early never gets challenged because `junior` with a real edge case never gets a slot.
* **False convergence** — agents all `[PASS]` not because they agree but because they have no turn incentive, so synthesis invents consensus.
* **Runaway length** — without a converge signal the loop only stops on `max_rounds` or timeout, wasting tokens on repetition.

The moderator’s job is **process governance, not domain opinion**. It never says “JWT is better”. It says: “this thread is circular, redirect speaker X next round” or “coverage is broad and no new info — synthesize now”. It is a separate LLM call using the strongest model so its judgment outranks any participant’s tier.

The `civilian` and `junior` temperature (0.5–0.7) also amplifies the need: they are creative but noisy; moderator filters noise without silencing.

## 2. How it works today (prompt + deterministic gates)

### 2.1 When it is consulted

`moderation.js:checkModeratorIntervention` every round, but gated to save tokens:

```
if contributions.length < 3            → continue (no data)
if challenges/dissents in last 4 < 2   → continue
if hasConflict == false                → continue (consensus short-circuit)
```

Only when 2+ challenges in window does it build the **situation** string:

* default: `Circular argument: N challenges in last 4`
* refined if a single participant challenged 3+ in last 6: `Participant X has challenged 3+ times … possible deadlock`

That `situation` is the only heuristic input; the LLM judges whether it is real.

### 2.2 What the LLM prompt contains (`src/prompts.js:buildModeratorPrompt`)

* Authority list (5 bullets) + Rules (5) — tautological (“cut off circular arguments (3+ exchanges with no new information)” without defining new information).
* Previous 10 rulings (`Round 2: Direct X → id`) — for consistency, but only decision→next_speaker, no reason.
* Current State of Play (2k chars) with explicit “use this to distinguish circular vs legitimate dispute”.
* Situation + Deliberation State (round, total contributions, last 3 contributions truncated 100 chars).
* Required output: XML `<ruling>` with `decision / next_speaker / reason`. Parser at `src/moderation.js:7` falls back to keyword `converge/synthesize/wrap up` if XML missing — over-eager.

### 2.3 Ruling types (`src/moderation.js:43` and `src/services/moderator-service.js:36`)

* **continue** — `next_speaker: continue` or parse failure. No action; `planTurnOrder` runs normally.
* **break** — `next_speaker: <active_id>`. `RoundInitializer.filterActiveParticipants` moves that id to position 0 next round. Ignored if target is `passed/failed`.
* **converge** — `next_speaker: synthesize` (or decision contains converge). Deferred if `currentRound < minRounds` (default 2) with progress message “Moderator wants to end early, but minimum rounds not yet reached.”

Turn ordering itself (`buildTurnOrderPrompt`) is **separate** from moderation — it orders whoever requested `[REQUEST_NEXT]`. Moderator `break` overrides it for one round.

### 2.4 Token cost

Moderator is LLM-gated (often short-circuits) but when triggered costs ~1 call/round at principal model. Turn order planner can add another call when ≥2 requests. So worst 2 extra calls/round beyond agent turns.

## 3. What happens if we remove it entirely

**If deleted with no replacement:**

* **No forced convergence.** Meeting ends only on `max_rounds`, `all passed/failed`, or `timeout/stall`. For your “longer deliberation” preference this actually ***helps*** length — you get full 3–4 rounds every time — but you also get **tail spam**: last round becomes 4 `support`/`refine` loops with no new info because nothing stops it.
* **No deadlock break.** Circular pair loops until `max_rounds`. Example: 3 rounds of Security Engineer ↔ Architect on revocation, while Financial Analyst’s cost objection never gets floor. State of Play will show `Disagreements: token revocation remains unsolved` but no one is forced to hear the third voice.
* **Turn order reverts to composition order.** `planTurnOrder` without moderator still runs, but with no `break` override its bias is `priority + recency + tier`. If agents stop emitting `[REQUEST_NEXT]` (they often do when circling), order becomes static composition order — junior last every round, starved.
* **Termination becomes non-deterministic from prompt view.** Agents decide to `PASS` based only on their own “do I have something to add?” heuristic, not a global view. You lose the minority-report signal: moderator `reason` (“NEW_INFO 0, ENTRENCHMENT 2…”) is currently the only place dissent depth is explicitly logged.

**Net:** removal trades **short-circuit risk** (moderator can cut too early, which you dislike) for **long-tail waste and starvation**. For “longer is better” you actually want removal, but you need a cheap substitute for the anti-starvation and anti-loop parts.

## 4. Simpler-rule alternatives (prompt-only, no moderator LLM)

### Option A — No LLM moderator, keep deterministic turn planner only (simplest)

Keep `planTurnOrder` (1 LLM call when ≥2 requests, else deterministic) and drop `checkModeratorIntervention` entirely.

* Convergence = only `max_rounds / all passed / timeout`.
* Loop detection = `planTurnOrder` already has rule 4 “avoid circular re-litigation (same 2 speakers challenge↔challenge)” — keep that as sole loop brake.
* **Pros:** -1 LLM call/round, zero moderation prompt to maintain, guarantees longer deliberations (max_rounds always reached unless all pass). Matches your preference.
* **Cons:** No `break` to force under-heard voice when entrenchment is 2; turn order can only prioritize those who requested, not those who should be heard.

Prompt change: delete `buildModeratorPrompt` and its call; keep `buildTurnOrderPrompt` unchanged.

### Option B — Rule-based moderator (no LLM, fully deterministic)

Replace LLM with 3 heuristics already computed for prompt:

```
NEW_INFO = last round introduced tool output or SoP-new term ?
ENTRENCHMENT = same 2 ids in last 4 challenges ?
COVERAGE = active participants who contributed / active
```

* `if ENTRENCHMENT and !NEW_INFO → break` (pick least-recent under-heard id)
* `if !NEW_INFO and COVERAGE ≥ 0.7 and round ≥ minRounds → converge`
* else continue

All 3 signals exist without LLM (`challenge` counts, `tool_calls`, `contributions_count`). Just encode as `if` in `src/moderation.js` and skip LLM entirely. `reason` becomes deterministic string like “ENTRENCHMENT 2, NEW_INFO 0”.

* **Pros:** deterministic, free, explainable, no prompt to drift.
* **Cons:** brittle — misses nuanced “legitimate dispute vs circular” that SoP reading gives LLM. DISSENT_DEPTH judgment (is disagreement substantive?) is hard without LLM.

### Option C — Keep moderator, but make it “long-deliberation biased” and cheaper (recommended if you keep any)

You already asked to hold off changes, but when you revisit, don’t delete — **bias it**:

* Raise gate to `minContributions: 4, recentChallenges: 3` (config) so it triggers less early.
* Keep rubric but change converge threshold to `NEW_INFO=0 AND DISSENT_DEPTH=0` only (currently `ENTRENCHMENT≥1 OR DISSENT_DEPTH=0`) — so one real dispute prevents convergence.
* Make it `fastPathModel` not principal (already does) and keep `previousRulings` with **reason** included (already FIXED in v2 prompt).

This gives you longer deliberations **with** loop break, at same cost.

## 5. What we did this batch per your hold

* **No edits** to `buildModeratorPrompt`, `moderation.js`, or `moderator-service.js` thresholds. Moderator stays as shipped in v2 (biased to `KEEP DELIBERATING`).
* All other prompt surfaces (system/user, query/vote/summon, summarizer, synthesis, personas) were elevated per Phase 1–4.
* Next step when you want to revisit: pick Option A (simplest, aligns with longer preference) or Option C (keep with stricter converge). Option B is middle ground if you want deterministic without LLM cost.


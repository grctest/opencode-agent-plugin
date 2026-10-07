# The Loom Orchestration Architecture

**Schema version:** `PRAGMA user_version = 16` (`LATEST_SCHEMA_VERSION` in `src/database/schema.js`) — `meetings.status ∈ {initializing,weaving,converged,timeout,cancelled,aborted,max_rounds_reached}` — fresh DBs enforce `CHECK(status IN …)` + foreign keys. Persona categories carry no CHECK whitelist: any folder name is a valid category. v5→v6 adds the SKILL.state layer: `participants.state_json` (JSON `AgentState`) + append-only `state_patches` audit table (see §12). v6→v7 persists the complete persona behavior contract; v9→v10 stamps the effective orchestrator config; v11→v12 adds the meeting-level settled registry; **v12→v13 lands the confidence split and drops the orphaned `artifacts.dissent` column**; **v13→v14 widens `participants.tier` to admit the `nonhuman` tier**; **v15→v16 renames `participants.tier` → `category` and `participants.tier_guidance` → `category_guidance` and drops the seniority whitelist**. Rule: any change to the DDL ships with `LATEST_SCHEMA_VERSION += 1` *and* a matching `MIGRATIONS[]` entry in the same change, so two structurally different databases can never claim one version number (N2). Static schema and bundle checks cover the current version; live Bun/opencode integration remains environment-dependent.

A complete technical reference for how the Loom multi-agent deliberation system works, from user input to final output. Every LLM prompt, every data structure, every decision point. Written for someone who cannot read the source code.

### ID Glossary (naming debt §10)

| ID | Meaning | Source |
|---|---|---|
| `meetingId` / `loomId` | DB primary key for a deliberation (`meetings.id`, UUID) | `paths.js:getMeetingDbPath`, `src/dashboard/server/control.js` |
| `sessionID` / `parentSessionId` | opencode chat session that owns the meeting (parent of all ephemeral sessions) | `client.session.create({parentID})` |
| `opencodeSessionId` | Duplicate of parent session ID persisted in `meetings.opencode_session_id` for resume | `database/session-index.js` |
| `ephemeralSessionId` | Short-lived child session per agent per round (round-scoped) | `session-manager.js:createEphemeralSession` |
| `orchestratorSessionId` | One persistent session for summary/turn-order | `session-manager.js:promptOrchestrator` |
| `weave` | In-memory `StateManager.weave` == `contributions` table rows == `data.rounds[].contributions` | `services/state-manager.js` |
| `fabric` | Legacy name for `meetings.fabric` (initial user context); now superseded by `state_of_play` but retained in DB for compat | `fabric-manager.js` (alias: `state-of-play`) |

---

## Table of Contents

1. [End-to-End Flow Summary](#1-end-to-end-flow-summary)
2. [Meeting Creation](#2-meeting-creation)
3. [Agent Architecture](#3-agent-architecture)
4. [What Agents See and Produce](#4-what-agents-see-and-produce)
5. [Round Execution](#5-round-execution)
6. [Turn Ordering](#6-turn-ordering)
7. [LLM Session Architecture](#7-llm-session-architecture)
8. [Agent-Driven Termination](#8-agent-driven-termination)
9. [Turn Order System](#9-turn-order-system)
10. [Convergence Detection](#10-convergence-detection)
11. [State of Play](#11-state-of-play)
12. [Reflection System](#12-reflection-system)
13. [Round Summarization](#13-round-summarization)
14. [Synthesis](#14-synthesis)
15. [State Management](#15-state-management)
16. [Error Handling & Model Fallback](#16-error-handling--model-fallback)
17. [Stall Detection](#17-stall-detection)
18. [Extension, Resume, and Crash Recovery](#18-extension-resume-and-crash-recovery)
19. [Embedding PersonaIndex](#19-embedding-personaindex)
20. [Agent-Requested Tools](#20-agent-requested-tools)
21. [Fast-Path Model Routing](#21-fast-path-model-routing)
22. [Inline Peer Interactions: Query, Vote, Summon](#22-inline-peer-interactions-query-vote-summon)
23. [Dashboard System](#23-dashboard-system)
24. [Meeting Lifecycle: From Setup Tab to Report File](#24-meeting-lifecycle-from-setup-tab-to-report-file)
25. [Metrics and Observability](#25-metrics-and-observability)
26. [Model Configuration](#26-model-configuration)

---

## 1. End-to-End Flow Summary

When a user approves and starts a deliberation from the dashboard Setup tab, this is what happens:

0. **Setup approval (always required)** — The user enters a question, previews the suggested room, and must approve every persona seat (agreeing with the suggestion or replacing seats from the persona catalog) plus the per-seat model assignments before anything runs. Nothing starts without explicit `approved: true`.
0a. **Deliberation mode (Setup tab §5, defaults to Plan)** — Plan is read-only: agents propose diffs (``` file=src/... ```) but the `write`/`edit` tools are never offered. Build offers `write`/`edit` and renders BUILD prompt wording, so agents may apply live file edits after reading. The choice is stored in `features.buildMode` (strict `=== true`, persisted in `feature_toggles_json`) and flows into `agentTools.buildMode` for the meeting, its extensions, and resumes — pick Build before starting whenever the deliberation is expected to produce live changes.
1. **Room composition** — The question is analyzed for complexity, then a team of at least 2 agents is suggested without any LLM call (auto-composed rooms run 2–7 seats; manually-built rooms have no maximum): each seat is filled by the persona (from `personas/<category>/*.json`) whose embedded description is most semantically similar to the question (via `PersonaIndex`). Each agent gets a name, persona description, agenda, category, and topic tags.
2. **Model assignment** — Each agent is assigned an LLM model at random from the enabled pool; categories never influence the draw. Explicit per-seat `model` selections from Setup win over random assignment. The discovery pool can be narrowed with the dashboard model filter (Setup tab, Section 26).
3. **Rounds execute** — A round is a single sequential prompt phase:
   - Each agent speaks in turn via a **round-scoped ephemeral session** (one session per participant per round), seeing the state of play, its own bounded state, and current-round contributions.
   - Agents write **untyped prose** — there are no `[PROPOSE]`/`[CHALLENGE]` type tags anymore; following agents interpret content directly. Agents call `loom_pass` when they have nothing new to contribute.
   - During their turn agents can invoke **loom_\* interaction tools** (`loom_query`, `loom_vote`, `loom_summon`, `loom_pass`) alongside research tools. These are plugin-registered tools that execute server-side during `session.prompt`: peer answers, ballots, and tallies are returned **inline in the same turn** and folded back into the speaker's final contribution via an optional same-turn synthesis pass (Section 22).
4. **Round summarization** — After all agents speak, an LLM clerk summary is generated every round (Established / Contested / Evidence / Open bullets), degrading to a deterministic digest when the LLM returns empty (Section 13).
5. **State of play update** — The state of play is aggregated entirely from each agent's bounded `Σⁱ` state. If patch coverage is incomplete, a **type-driven** full-weave digest is merged in as a fallback; it files only peer responses and file references, and never guesses a primary turn's bucket from its prose.
6. **Turn order override (optional)** — the round summary is the orchestrator's single LLM call per round; it may set next round's order via the orchestrator-only `loom_set_turn_order` tool, else the default rotation stands (Section 9).
7. **Termination** — Deterministic: (a) all participants have called `loom_pass` or failed after the configured minimum rounds, (b) the round limit reached, or (c) stall detection fires. There is no meeting-level wall-clock timeout — per-agent provider timeouts (`agentTimeoutMs`) bound each LLM call, and the stall watchdog bounds inactivity.
8. **Synthesis** — One agent (typically the principal) synthesizes all contributions into a structured artifact with Decision, Reasoning, Action Items, Dissenting Views, Open Questions, and Confidence, then self-critiques it.
9. **Output** — The run executes as a detached background job (HTTP returns immediately); progress streams via the dashboard Timeline tab and the final synthesis lands in the Output tab plus a full markdown report saved to `.opencode/loom/meetings/<meetingId>.md`. Nothing is returned to chat — the dashboard is the sole control plane, started with `/loom_viz`.

---

## 2. Meeting Creation

### Step 1: Nothing

There is no complexity analysis, no role list, and no seniority boost. The seat
count is `composition.autoSelectSeats` (default 3) purely as a *pre-selection*
count for the dialog — it does not influence which personas rank highly. Once the
user confirms, the room is exactly what they chose.

### Step 2: Similarity-Based Persona Selection

There is **no LLM domain detection** — the now-removed `domain` pipeline was replaced by embedding-based selection.

1. All personas are loaded from JSON files (`personas/<category>/*.json`, or legacy `<category>.json` arrays) and embedded into a process-scoped in-memory store via `PersonaIndex.indexAll()` (no database tables; a store-level fingerprint skips re-indexing when the model and catalog are unchanged). Cache key is `model|quant|persona|category|dim|fingerprint` (model-aware, `TUNING.EMBEDDING_CACHE_MAX` LRU).
2. The question (plus any context) is embedded once with the query-side prefix.
3. `PersonaIndex.searchAll(queryEmbedding)` brute-forces cosine over the **entire** store and returns every persona sorted ascending by L2-equivalent distance (`sqrt(2 * cosineDistance)`), ties broken by name so the list is reproducible.
4. `buildRankingResult` slices the top `autoSelectSeats` as `selected`, keeping `selected` a strict prefix of `ranked` so the dialog can highlight a contiguous block.

**The catalog is one flat pool.** This is the whole rule, and it replaced a much larger one: no category quota, no per-category top-N cut, no cross-category promotion, and no separate non-human pool. Three of the nearest personas may all be `junior`; `nonhuman` is ranked alongside the rest with no special-casing and can occupy any position. Composition is deterministic content-similarity; no `seed` parameter exists — rooms are reproducible given the same question and persona index. `test/persona-ranking.test.js` pins each of these as an invariant, including that a distant persona is never promoted over a nearer one.

**There is no embedder → there is no auto-select.** Ranking is the one operation that cannot degrade: a keyword-overlap score is not a weaker version of a vector ranking, it is a different answer to a different question, and it fails worst exactly where it matters — a question whose vocabulary overlaps no persona's prose ranks everyone at zero and presents an arbitrary order as relevance. So `rankAllPersonas` throws with `code: "embedder_unavailable"`, `POST /api/room/preview` maps that to **503**, and the Setup tab omits the auto-select button entirely. Manual persona selection is unaffected. The keyword fallback path and all the seniority machinery it mirrored have been deleted, so there is no second selection path left to keep in sync.

**The dialog.** The endpoint returns `{ ranked: [{name, category, distance}], selected, auto_select_count }` — identity and distance only, since full persona text for 349 entries would be megabytes and the client already holds the catalog from `/api/personas`. `RoomSelectionDialog` renders all 349 in distance order with a similarity bar, pre-selects the top 3, and lets the user toggle any of the six categories off, select or deselect anyone, and confirm. Three invariants. First, filtering only ever *removes* rows — it never re-sorts, because the list *is* the similarity ordering and re-sorting by category would be making a different claim about relevance. Second, hiding a category does not evict already-selected seats from it; the footer says so explicitly when that happens. Third, and purely mechanical: **the list viewport has a height floor** (`min-h-[220px]` on the wrapper, and `MIN_LIST_HEIGHT` clamping the measured value).

That third one exists because the measurement and the rendered height are mutually
dependent — the `List`'s height is what gives the wrapper its height. With no floor
that is a feedback loop: hiding every category unmounts the `List`, leaving only a
one-line empty-state message, which collapses the wrapper, which makes
`ResizeObserver` record the collapsed height, which means re-showing categories mounts a
`List` one row tall — permanently, because the short `List` keeps the wrapper short.
The floor makes collapse unreachable rather than merely unlikely.

`RoomSelectionDialog` is also the dashboard's only react-window virtualisation, and
`react-window` is v2 (`rowComponent`/`rowCount`/`rowHeight`/`rowProps`); v2 ignores
the v1 names, so a v1 call renders with `rowCount === undefined` and throws
`Invalid index 0`. `PersonaPickerDialog` is the reference implementation for both
invariants, and `test/room-selection-dialog.test.js` asserts all of them against the
component source — the failures need a DOM, but the causes are statically checkable.

Seats are written only on confirm, so a cancelled dialog leaves the room untouched.

4. Meeting-level `tags` are derived from the selected participants' most common tags (top 3).

**Custom rooms:** Approving an edited participant list in the Setup tab skips composition entirely. Each participant requires `name`, `persona`, `agenda`, `category` (an `id` is derived; `tags`/`expertise` default to `["general"]`). Persona similarity needs no database access, so composition imposes no ordering constraint on the meeting-row insert.

### 3c. The `nonhuman` Category: Sentience as a Lens

Five categories describe persona flavor, and a sixth exists to hold personas
that are **not people**. `personas/nonhuman/*.json` ships 77 sentient non-humans —
animal minds with alien senses, the hadal deep, intelligence in another medium,
collective minds, folkloric beings, planetary-scale systems, and personified
abstractions. None of them is a human job role: a CISO here would duplicate a
principal persona, and `test/nonhuman-category.test.js` fails on any persona named
after an office.

Three properties make the category work, none of which come for free from "it's just
another category":

1. **It is a category, not a reserved seat** (Step 2). Because selection ranks one flat pool, a non-human persona is seated exactly when it is among the nearest to the question — never because a slot was held for it. Nothing guarantees the category appears; equally, nothing caps it or promotes it. A reef question legitimately seats three non-humans, and an API-design question legitimately seats none.
2. **A non-human seat is a peer, not a curiosity.** All seats hold identical
   rights (`BASE_RIGHTS`: contribute + call_vote). Granting a lesser right would
   make a whale's dissent procedurally weaker than a CFO's, which is precisely
   the failure the category exists to prevent.
3. **The authoring law inverts.** For a human persona the rule is *the lens is not
   a body*; for a non-human being whose senses are not ours it becomes positive:
   **a being's senses become the evidence it demands, not the actions it takes.**
   The bat does not echolocate (an agent has no ears) — it asks what would have to
   bounce back for the shape of the problem to be knowable, and rejects any answer
   that only reads fine. `lintEmbodiment` would reject "I echolocate" in an
   instruction field, and the rewrite is not a concession: a genuinely alien sense
   is an unimpeachable reason to distrust the room's default epistemics.

A question with no non-human neighbour simply ranks the category low. `test/nonhuman-category.test.js` asserts that the category remains a first-class category everywhere one is named (loader, dashboard, DB, packaging) and that no quota has crept back in.

### Persona Loading

Personas live under `<plugin>/personas/<category>/*.json` (category directories — any folder name is a valid category), with fallback to legacy `<category>.json` arrays. User-authored personas in `~/.config/opencode/loom/personas/<category>/` are merged in (user personas take precedence, loaded after the bundled ones; duplicates by name are dropped). Persona files are cached for 60 seconds. Each persona is validated: `name` present, `persona` >50 chars, `agenda` >20 chars, and `tags` present (legacy `domain`/`domains` fields are normalized to `tags`; legacy `tier`/`tier_guidance` fields are normalized to `category`/`category_guidance`). Each persona has `name`, `persona` (description), `agenda`, `tags`, optional `expertise`, `known_biases`, `communication_style`, `preferred_contribution_types`, `anti_patterns`, `category_guidance`, and `reflection_guidance`.

The six bundled categories are `junior`, `mid`, `senior`, `principal`, `civilian` (all human) and `nonhuman` (see §3c) — 349 bundled personas in total. There is no whitelist anywhere: `isValidCategory` accepts any folder-name slug, Setup validation accepts any category slug, and `participants.category` carries no CHECK. `test/nonhuman-category.test.js` asserts the category survives the loader, dashboard, DB, and packaging with no quota.

### Step 3: Model Assignment

Models are discovered from the connected providers via `discoverModels()` (`provider.providers` API), with the user session's current model recorded as `sessionModel`. The discovery result may be narrowed by the dashboard model filter (Setup tab, Section 26). If a session model can't be discovered the discovery result is empty (agents just carry their session model).

`assignModelsToParticipants()` draws a random model per seat from the enabled pool (`assignModelsRandomly()`; an injectable RNG keeps tests deterministic):

- Categories never influence the draw — persona categories are organizational labels only.
- Per-participant overrides (`model` object or `model_override` string) always win.
- The Setup tab pre-fills each seat's model picker from the preview's flat `suggested_models` (parallel to the selected seats, likewise random); every picker remains changeable to any enabled model before start.

### Step 4: Session Creation

**No persistent agent sessions are created.** All agent and orchestrator LLM calls use fresh ephemeral sessions (Section 7). The synthesis phase is the sole exception — it uses one long-lived session for the draft + critique passes.

---

## 3. Agent Architecture

### The Category System

Categories (`junior`, `mid`, `senior`, `principal`, `civilian`, `nonhuman` folders) organize persona flavors for browsing; they grant nothing and drive no engine behavior:

- Every seat holds identical rights (`BASE_RIGHTS`: contribute + call_vote). Actual tool availability is governed by the `agentTools` config (Section 20), never by category.
- Categories play no part in turn-order decisions — the orchestrator orders participants by evidence, urgency, and recency — and no part in model assignment, which is random per seat.
- A sixth category, `nonhuman`, holds personas that are not people (§3c). It is never reserved and wins a seat only on distance, like any other category.

**Behavioral guidance is defined in each persona's `category_guidance` field** (legacy `tier_guidance` is accepted as an alias). Each persona file is self-contained and user-editable:

```json
{
  "name": "Security Engineer",
  "persona": "You assume breach...",
  "agenda": "Identify security implications...",
  "tags": ["engineering", "security"],
  "expertise": ["threat modeling", "authentication"],
  "category_guidance": "Prioritize accuracy and risk assessment. Cite patterns from experience. Be conservative with claims but commit fully when you do. Flag irreversible decisions.",
  "reflection_guidance": "When reflecting, walk through the exploit path of the proposed change. Ask: 'What new attack surface does this create?' or 'What existing defense does this weaken?'",
  "anti_patterns": ["Sweeping generalizations without evidence"]
}
```

### Persona Structure

Each agent is loaded from a JSON persona file that also describes how to behave in non-contributing phases:

```json
{
  "name": "Security Engineer",
  "persona": "A seasoned application security engineer with 12 years of experience in authentication, encryption, and threat modeling. Tends to think in attack vectors and worst-case scenarios.",
  "agenda": "Ensure all proposed solutions meet security baselines and don't introduce new attack surfaces.",
  "tags": ["engineering", "security"],
  "expertise": ["authentication", "encryption", "threat modeling"],
  "known_biases": ["Over-indexes on security at the expense of UX"],
  "communication_style": "Technical and precise, references OWASP and CVE patterns",
  "preferred_contribution_types": ["challenge", "refine"],
  "category_guidance": "Prioritize accuracy and risk assessment...",
  "reflection_guidance": "When reflecting, walk through the exploit path..."
}
```

(`tags` replaces the deprecated `domain`/`domains` fields. `domains.json` still exists as a reference vocabulary but is not part of the selection pipeline.)

### What a Participant Object Looks Like in State

```javascript
{
  config: {
    id: "senior_security_engineer",
    name: "Security Engineer",
    persona: "A seasoned application security engineer...",
    agenda: "Ensure all proposed solutions meet security baselines...",
    category: "senior",
    tags: ["engineering", "security"],
    expertise: ["authentication", "encryption", "threat modeling"],
    known_biases: ["Over-indexes on security at the expense of UX"],
    communication_style: "Technical and precise",
    preferred_contribution_types: ["challenge", "refine"],
    anti_patterns: [...],
    category_guidance: "...", reflection_guidance: "...",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" }
  },
  // (no tier_config: every seat holds identical rights; categories are labels only)
  embedding: Float32Array /* loaded at init from persona embeddings when the embedder is available */,
  status: "listening",      // listening | speaking | passed | failed | muted (muted only appears in restored data from older meetings)
  reflection: "The JWT migration makes sense, but token revocation is unsolved.",   // maintained via perspective-mode query answers
  contributions_count: 2
}
```

Note: `session_id` and persistent session tracking are gone — agents use ephemeral sessions with no stored session handle.

---

## 4. What Agents See and Produce

Every agent LLM call involves two prompts: a **system prompt** (identity + rules) and a **user prompt** (state of play + context + question).

### The System Prompt

Every agent receives this system prompt (built by `buildAgentSystemPrompt`). Condensed structure:

```
You are **Security Engineer** (senior) — a deliberator in "Loom." (the parenthetical is the organizational category label)

## Identity
A seasoned application security engineer with 12 years of experience in
authentication, encryption, and threat modeling...

## Agenda
Ensure all proposed solutions meet security baselines and don't introduce
new attack surfaces.

## Disposition
- Voice: Technical and precise, references OWASP and CVE patterns
- Natural modes: challenge, refine
- Bias check: you tend to Over-indexes on security at the expense of UX.
  Counter it in one sentence before returning to your lens.

## Craft (positive anti-patterns)
- Instead of: "Sweeping generalizations without evidence" → say what you observed, with [#id] or Source.

## Persona Lens
Persona lens (subordinate to contract):
<persona category_guidance>

  ## OUTPUT CONTRACT — read this last, it governs your response

  1. Length: 350-700 words for prose (`LENGTH_LIMITS.agentProseWords`); 300-700 for code diffs (``` file=src/... ``` blocks, not counted toward the prose cap).
     One claim per sentence; preserve code and numbers verbatim.
  2. Grounding: engage prior work via [#id]; external facts add Source: https://… ;
     code references use file=src/path.ts:18; otherwise qualify as "in my experience…".
  3. Boundaries: never emit <<< or >>> delimiters; never invent tool output or unread files.
  4. Interaction — peer actions happen only through the real loom_* tools in your tool list:
        - loom_query queries peers via queries:[{target, question, mode}] — modes 'clarify'
          (factual), 'perspective' (their stance on your statement), 'evidence' (researched
          Finding+Source+Strength); loom_vote polls all peers on lettered options;
          loom_summon brings in a guest expert.
        - Interaction tools fan out to peers in parallel and return their answers inline within
          this same turn — wait for the result, then cite [#id] from the returned responses
          or tally in your final contribution.
        - Make as many tool calls as you need — there is no per-turn tool-call limit.
        - CRITICAL: tool invocations are transmitted through the model's function-calling
          channel, never through response prose. Any function-call notation in text executes
          nothing. Bracket tags like [QUERY: @id], [EVIDENCE: @id], [CALL_VOTE] are obsolete.
        Reference others by participant_id from Recent Contributions, e.g. [#12].
  5. Stay in character — persona and agenda shape framing, not facts.

## Research Tools — Tool Ladder (use at most one research tool per turn unless an
   evidence request demands more)

Available: websearch, webfetch, read, glob, grep, bash, loom_query, loom_vote,
           loom_summon, loom_pass, loom_state_patch
           (only enabled ones are listed)

Ladder: read/glob/grep (verify local files) → websearch (verify a current fact) →
        webfetch (deep dive only after a search hit)

For code analysis in this folder: prioritize read/glob/grep first — file=src/... citations require a read.

Quality:
- One focused query beats three vague ones. Synthesize, don't dump.
- If a tool is rejected as invalid, retry with exact names above — don't silently fall back to memory.
- Cite as Source: https://… or file=src/... when it strengthens your point.
```

Notes:

- The tool list is assembled from `agentTools` config: built-ins plus the loom tools (`loom_query`, `loom_vote`, `loom_summon`, `loom_pass`, `loom_state_patch`). There is no auto-injected prior-transcript RAG block; recall is supplied by the bounded state-of-play and live current-round contributions. When agent tools are disabled, the entire tool section is omitted. System prompt cache `systemPromptCache` is `TUNING.SYSTEM_PROMPT_CACHE_MAX` 50 LRU via `getSystemPromptCacheMax()` and keyed by `hashConfig` which includes `agentTools` digest (`enabled|loom|builtIn|maxCalls|sameTurn`) — changing `agentTools` busts cache.
- `known_biases`: when a persona has more than two biases, they are deterministically rotated based on the participant name hash, so different agents surface different biases first.
- There is no type-tag rule anywhere in the contract — agents write prose; calling `loom_pass` means pass.
- Transcript `Live` block budgets ~800 chars prose / ~1200 chars code per contribution (≤12 contributions) via `truncateAtSentence` (sentence-boundary, not mid-word `slice`).

### The User Prompt (Weighted Golden Sandwich)

Each agent's user prompt is built by `buildAgentUserPrompt`. It follows a bounded, stateless pattern that carries all necessary context without accumulating history — with explicit epistemic weighting between sections. Concrete example for an agent in round 3:

```
## Question (canonical)
Should we migrate our authentication service to JWT tokens?

## Tags: engineering, security

## Round 3

<<<LOOM_USER_CONTEXT>>>_BEGIN_
We're a 50-person startup...            (only present when context was provided in Setup)
<<<LOOM_USER_CONTEXT>>>_END_

## State of Play — CANONICAL (treat as settled unless you challenge it with new evidence)

<<<LOOM_STATE_OF_PLAY>>>_BEGIN_
## Question
Should we migrate our authentication service to JWT tokens?

## Decisions & Proposals
- We should adopt a phased migration over Q1 and Q2, starting with the auth service

## Agreements
- Short-lived access tokens (5 min) are essential

## Disagreements & Concerns
- Token revocation remains unsolved — blocklists defeat statelessness

## Open Questions
- How will existing sessions be handled during the transition?

## Key Facts
- Refresh tokens on the client are recoverable by design
<<<LOOM_STATE_OF_PLAY>>>_END_

## Your State — CARRIED FORWARD (you wrote this via loom_state_patch; update it this turn)

<<<LOOM_MY_STATE>>>_BEGIN_
Stance: Short-lived JWTs with server-side refresh rotation.
Established:
- phased migration Q1-Q2 starting with auth service
Contested:
- client-side refresh storage theft risk
Open:
- session handover downtime budget?
<<<LOOM_MY_STATE>>>_END_

## Live — Recent Contributions

<<<LOOM_CONTRIBUTIONS>>>_BEGIN_
- [#4] [senior_architect]: Hybrid approach — short-lived JWTs plus server-side refresh rotation...
- [#5] [mid_security_engineer]: Server-side refresh tokens are just session tokens with extra steps...
<<<LOOM_CONTRIBUTIONS>>>_END_

## Your Turn — Weighted Guidance

- **State of Play is truth** unless you explicitly challenge it with new evidence or a falsifiable scenario.
- **Your State is yours to maintain** — call loom_state_patch once per turn, after your prose. This is the only memory you carry: anything you do not patch is discarded before your next turn, so a turn that reasons well but patches nothing has wasted the work. Stale bullets you don't remove stay. Evidence (with Source/[#id]) is protected from FIFO eviction longer than other bullets, but only your newest evidence is protected — re-assert anything still load-bearing each turn, and check the `evicted` echo to see what fell off.
- **Live is current round only** — anything older you still need must already be in Your State; if it isn't, re-establish it from the digest (don't quote full old prose).
- **Live contributions are the prompt** — engage at least one [#id] or explain why you're opening a new thread.
- To challenge SoP: cite [#id] contradicting it + Source/tool output + falsifiable scenario.

Rules:
- 350-700 words for prose welcome (code diffs excepted); never emit <<< >>> delimiters
- Cite [#id] when referencing prior work; introduce facts with Source/file= or qualify as experience
- Preserve code and numbers verbatim — do not round or invent

Make your contribution or pass.
Then call loom_state_patch once — project your stance and 1-3 bullets so they survive into your next turn. Nothing you write in prose carries forward on its own.
```

Note the structure:

- **Question (canonical)** + tags + round number lead the prompt.
- **State of Play**: structured summary of decisions, agreements, disagreements, open questions, key facts (and files involved) — explicitly labeled CANONICAL (Section 11). The state is what *you* declared via `loom_state_patch`; aggregation over those per-agent states is the only path, and the type-driven weave digest that backs it up never infers meaning from prose.
- **Your State**: the agent's own carried execution state Σⁱ (stance + established/contested/open/facts/files), rendered from runtime-validated `loom_state_patch` calls only — never model prose. Empty states render `(empty — patch it this turn)`. Shown only when `agentTools.loom.loom_state_patch` is on; flag-off prompts are byte-identical to legacy. Prompt invariant: `Aⁱ_r = (P, Σⁱ_r, Oⁱ_r)` — immutable spec, own state, latest observation. (SKILL.state complementary implementation; see `plans/skill-state-complementary-implementation.md`.)
- **Live contributions**: current-round contributions only (round == r, `vote_response` excluded, ≤12), each budgeted ~800 chars prose / ~1200 chars code, with stable IDs like `[#4]`. Prior rounds arrive via Σⁱ + SoP digest, never raw replay — per-turn prompt footprint is flat in T.
- **No reflection section**: the participant's stored reflection is *not* injected into primary turns. Σⁱ.stance is the single source of truth for position; legacy reflection is the fallback only when stance is empty. Peer-facing prompts (query/vote/summon targets) see one line: `Your position (from your state vN): "…"` plus top bullets — never both stance and reflection side by side.
- **Steering hint**: if the orchestrator queued a steering note (contribution-mix nudge), it is appended after the prompt body — consumed exactly once, by the round's first speaker only.
- **Delimiters**: every untrusted block is wrapped in `<<<LOOM_LABEL>>>_BEGIN_` / `<<<LOOM_LABEL>>>_END_` to prevent prompt injection and boundary confusion. An empty section is omitted.
- **Interaction-prompt deviation (deliberate):** the strict `O_t = current round only` rule above governs *primary* agent turns. Peer-facing sub-prompts built by `loom_query` / `loom_vote` / `loom_summon` (`src/plugin/tools/query-evidence.js`, `src/plugin/tools/vote-summon.js`) use a two-round window (`round >= currentRound - 1`, ≤12): the target's own last 2 contributions plus up to 6 recent room contributions (ballots and reflection rows excluded), so a peer answering an inline question sees the conversation, not just a mirror. Those are sub-turns with their own budget, not the primary reasoning context, and the retention is still bounded — the O(1) claim is unaffected.
- **Peer questions are self-contained:** the caller invokes `loom_query` mid-turn before writing prose, so there is no draft to show — the `question` field must carry the specific claim being asked about, and the rendered prompt says so explicitly rather than duplicating the question into the contribution block.
- **Salience: prompt emphasis is the only enforcement (SKILL.state is off/on, not optional/mandatory).** The paper makes it structurally impossible to omit (App. A.4 requires `state_patch` inside every response's JSON block), so our tool-channel split must recover that weight in prompt form. There is deliberately no follow-up LLM call on a miss — a miss is logged (`mandatory_capability_missed`, per-turn outcome `never_attempted`) and the turn stands, so deliberations stay fast:
  1. **OUTPUT CONTRACT item 8**, gated on `agentTools.loom.loom_state_patch` — states the ordering (prose first, then the call) and that the patch maintains the agent's private notes for its next turn; it never substitutes for prose, which is what the room and the end user read. Prose about patching ("Patched", "state", version numbers) is explicitly forbidden.
  2. **Final line of the user prompt** (gated on `showState` — the state block actually rendered): the patch note precedes the closer, and the closer ends on the contribution itself. Recency is the strongest available position, so it belongs to deliberation, not bookkeeping.
  3. **Guidance bullet**: the patch maintains private notes for the agent's own next turn; the room still read the contribution even when the patch is skipped.
  4. **Pass exemption in WHEN TO PASS**: passing needs no patch, which preserves `exempt_pass` semantics and avoids burning a call when the agent has nothing new.
  The tool is offered inline in the primary turn's map as the agent's absolutely-last tool use — there is no dedicated per-turn patch call and no enforcement retry. Measure the effect with the per-turn outcome enum (§12).

### What Agents Produce

An agent response is **untyped prose** (or a `loom_pass` tool call). `parseAgentResponseRaw` → Zod `AgentResponseSchema` no longer looks for type tags or directives:

- Any legacy bracket tag prefix (`[PROPOSE]`, `[CHALLENGE]`, …) is stripped from the content; the stored type is always `"contribution"`. Following agents interpret the full content directly.
- All structured directive fields (`query`, `evidence`, `summon`, `vote`) are schema-validated but always `null` — peer interactions happen exclusively through real loom tools.
- If parsing fails entirely, the raw sanitized text is stored as a generic contribution so nothing is silently dropped.

**Tool calls** are first-class: `extractAgentResponse()` returns all completed/error ToolParts, and they are mapped onto the response as `tool_calls` (tool name, callID, status, output) for audit and dashboard display. Two tool-derived behaviors:

1. **Same-turn synthesis** — when `agentTools.sameTurnSynthesis` is on and the turn contains successful `loom_query`/`loom_vote`/`loom_summon` calls, a second prompt on the same ephemeral session presents the tool outputs (each bounded to ~3.5k chars) with the instruction to synthesize the final contribution citing `[#id]` — and offers **no interaction tools** (`buildToolsMapWithoutLoom`) so results can't be re-fetched. The synthesized text replaces the first-pass text when substantive; otherwise the first pass stands.
2. **Final-action state patch (toggle on/off)** — when SKILL.state is on, every primary non-pass turn ends with one validated `loom_state_patch` call (per-agent execution state Σⁱ: stance + established/contested/open/facts/files). The tail is pipelined: it runs concurrently with the next turn's primary pass and merges before persist (`runPatchTailPhase` + executor merge + `_settlePendingTails` join before session cleanup/summary). Tails never touch the singleton `#activeTurn` — they register in a per-participant tail channel (`beginTailTurn`/`queueTailPatch`/`takeTailPatch`), so the next turn's ownership can't misattribute or refuse the patch, and outputs equal the sequential path (`test/tail-pipeline.test.js` pins commit equivalence). The tool is **not offered in the primary turn** (`buildToolsMap(..., { omitStatePatch: true })`), so the agent cannot patch before its queries. After the primary pass, same-turn synthesis, and any mandatory-capability retry, a single final pass on the same ephemeral session offers a patch-only tool map and requests the turn's one and only patch call as the agent's **last action** — peer answers are already in session history, so they can enter `stance`/`facts_add`. Misses never fail the turn — prose is preserved, state stays at its prior version, and there is no retry. Each turn records a per-turn outcome enum (§12) on `contributions.prompt_context.state_patch_outcome`; `loom_pass` turns are exempt (`exempt_pass`). Toggle: `agentTools.loom.loom_state_patch` (tool) / `features.skillState` on/off (dashboard). The server-side one-per-turn guard in `plugin/tools/state-patch.js` remains as a safety net for the single attempt.

Edge cases:

- **Tool-only turn** — no text but executed tools: a stub contribution ("[TOOL-ONLY TURN — no text produced; tool evidence preserved]") is stored carrying the `tool_calls`.
- **`loom_pass` tool call** — the pass is persisted as a contribution with the reason string, preserving any tool evidence.
- There is **no hard word-limit enforcement** on contributions (the old `maxContributionWords` setting was removed); length contracts are prompt-level only.

---

## 5. Round Execution

Each round is a single, strictly sequential **prompt phase**. Each agent speaks one at a time, seeing all prior same-round contributions (including inline query/vote/summon results) as they are produced.

### Prompt Phase

At phase start, **round-scoped sessions** are created — one ephemeral session per active participant (`this._roundSessionIds`), registered in the session→meeting map. Sessions are reused for every prompt of that participant within the round (including retries) and deleted when the round ends; this cuts session churn ~70% versus per-turn sessions.

For each agent (in turn order):

1. Sets status to "speaking" (visible in dashboard); a fresh `batchId` is stamped for grouping inline interaction rows.
2. Checks if the assigned model's circuit breaker is healthy. If open, a healthy fallback model is selected immediately and used from the first attempt (Section 16).
3. Uses a **sliding-deadline timeout**: base `agentTimeoutMs` (20min) — no reduction when agents fail. While the prompt pends, a 30s heartbeat touches the stall watchdog and weave growth (inline loom tools landing server-side) defers the deadline by one more budget, up to 3× the base. A dead call with no progress still times out; `0` disables the guard.
4. Builds a bounded context from the agent's own `Σⁱ`, the shared state of play, and the current-round live contributions. It does not auto-retrieve prior transcript chunks.
5. Collects current-round contributions: bounded live context with `vote_response` rows excluded.
6. If this agent is first in the planned order, consumes any queued **steering hint** (contribution-mix nudge; Section 11/post-phase) and appends it to the user prompt.
7. Sends system prompt + Weighted Golden Sandwich user prompt with a **boolean tool map** when agent tools are enabled (built-ins plus `loom_query`, `loom_vote`, `loom_summon`, `loom_pass`, `loom_state_patch`).
8. Extracts the response with `extractAgentResponse()` (last TextPart, all ToolParts, reasoning blocks). Inline loom tool calls have already executed server-side at this point — their contributions are already in the weave.
9. Sanitizes content, parses the untyped response, and stores the contribution (Section 4).
10. Runs the **same-turn synthesis pass** when loom interaction tools succeeded and text was produced (Section 4).

Failure handling: a failed turn goes through the retry → fallback-model ladder before the agent is marked `failed` (Section 16). Because inline tools execute during `session.prompt`, a retry after a timeout can mean peer contributions exist in the weave without appearing in that turn's `tool_calls` — logged explicitly (`attempt_failed_possible_tool_side_effects`). Agents calling `loom_pass` are set to `passed`.

**Example mid-round flow:**

Agent lineup: [Agent 1, Agent 2, Agent 3]

1. Agent 1 speaks → contribution added to weave
2. Agent 2 challenges and calls `loom_query({queries: [{target: "junior_0", question: "…"}]})` mid-turn → executes server-side inside Agent 2's `session.prompt`; junior_0 answers via an ephemeral prompt (its answer becomes a `query_response` row under Agent 2's batch); the answer returns inline to Agent 2, whose final contribution cites it (Section 22)
3. Agent 3 speaks → sees Agent 2's challenge *and* the query response row

### Post-Phase: Turn Order Planning + Round Summarization + Finalization

After the prompt phase:

1. **Round summarization** (`summarizeRound`, Section 13) — LLM clerk summary every round; deterministic digest on empty responses.
2. **State of play update** — `updateStateOfPlay(weave, question, tags)` regenerates the structured summary (Section 11).
3. **No prior-transcript vector indexing** — embeddings are used for persona selection only; round text remains auditable in SQLite and is projected into bounded state.
4. **Turn order override (optional)** — the summary call may set next round's order via `loom_set_turn_order`; otherwise the default rotation stands (Section 9).
5. **Termination checks** — all participants passed/failed, or `current_round >= max_rounds` (Section 10).
6. **Contribution-mix steering** — if the round contained ≥3 challenges/dissents and no synthesis-type consolidation, a steering hint is queued for the next round's first speaker ("consolidate positions before opening a new challenge"). Cheap and prompt-level; no LLM call.

The round summary and state of play are persisted to the database.

---

## 6. Turn Ordering

**Default order:** Agents speak in composition order (the order they appear in the participants array). There is no randomization.

**Orchestrator-decided order:** The round summary call is the orchestrator's single LLM call per round. Its prompt carries a Next-round turn order block (roster + operator `turnOrderPolicy` preference); when this round's evidence warrants a different order, the orchestrator calls the orchestrator-only `loom_set_turn_order` tool once with the full ordered id list (unknown ids dropped, missing seats appended). No call means the default rotation stands. The order is stored as `planned_turn_order` (head as `next_speaker_id`) and applied by `RoundInitializer.filterActiveParticipants()` at the start of the next round (cleared after applying). When no override exists, `fallbackTurnOrder()` supplies the current composition order minus failed seats.

**Skip-passed logic:** From round 3 onward, a participant who passed within the last 2 rounds (lookback window of 10 contributions) and carries no stored reflection is excluded from the active list for the next round — but only if at least one participant remains active. A progress message is emitted (e.g. *"⏭️ Skipped: Agent X (inactive, no new reflections)"*).

---

## 7. LLM Session Architecture

### Round-Scoped Ephemeral Sessions for Agents

Agent turns use **round-scoped ephemeral sessions**:

```
Parent Session (user's opencode chat)
  ├── Ephemeral Session: Architect Lead (round-scoped, created at phase start) → deleted after the round
  ├── Ephemeral Session: Security Engineer (round-scoped)                     → deleted after the round
  ├── Inline ephemeral prompts: query/vote/summon targets (created + deleted per call via runEphemeralPrompt)
   ├── Orchestrator Session: ONE persistent session for summary/turn-order calls → deleted at meeting close
  ├── Synth Session: Synthesizer (draft + critique)                           → deleted after use
  └── ...
```

**Why round-scoped?** Each round creates one session per active participant up front (`runPromptPhase`), reuses it for every prompt/attempt that participant makes during the round, and deletes all of them in a `finally` block. This keeps O(1) token growth per turn while cutting session create/delete API churn ~70% versus per-turn sessions. If creation fails for a participant, the executor falls back to per-turn sessions.

**Why ephemeral at all?** Every prompt is self-contained (all context passed explicitly), so:
- **O(1) token growth per turn** — no accumulated history from prior turns
- **No session state drift** — each turn starts clean
- **Lower memory footprint** — no persistent agent session history stored server-side

Session creation itself is wrapped in `withRetry` (`maxAttempts = maxRetryAttempts`, exponential backoff 1s → 2s → 4s → 8s with jitter) because session-creation API calls can transiently fail.

### Creating an Ephemeral Session

```javascript
const sessionId = await sessionManager.createEphemeralSession(participant);
// → withRetry(client.session.create({ body: { parentID, title: "Loom · Ephemeral · <name>" } }))
sessionManager.registerSessionMeeting(sessionId, meetingId);   // tool resolution
```

### Prompting an Agent

All agent prompts go through the shared `SessionContract` (`sessionManager.getContract().prompt()`), which unifies timeout/retry/error handling:

```javascript
const result = await sessionManager.getContract().prompt({
  sessionId,
  system: buildAgentSystemPrompt(participant),
  model,
  parts: [{ type: "text", text: buildAgentUserPrompt(...) }],
  tools: toolsMap,   // boolean filter map, e.g. { websearch: true, loom_query: true }
});
const { text, toolResults, reasoning } = extractAgentResponse(result.data);
// ... parse & store; same-turn synthesis pass when loom interaction tools succeeded,
// then any mandatory-capability retry, then the single final loom_state_patch
// pass (order: primary → synthesis → mandatory → patch, all on the same
// round-scoped session, so within-step reasoning stays in-session)
```

`extractAgentResponse()` handles all Part types:
- **TextPart**: returns only the **last** TextPart (pre-tool text is noise)
- **ToolPart**: results in "completed" or "error" state — never pending/running. Completed inline loom tool calls have already persisted their contributions server-side.
- **ReasoningPart**: thinking blocks (reasoning models), returned separately
- **FilePart, StepStart/FinishPart, SnapshotPart, etc.**: informational (ignored)

### Prompting the Orchestrator (Persistent)

Moderation rulings share **one persistent orchestrator session** per meeting (`promptOrchestrator`), with retries and empty-response treatment as transient failures (round summaries run on fresh ephemeral sessions — Section 13 — so long meetings don't accumulate O(R²) context):

```javascript
async promptOrchestrator(system, model, message) {
  let sessionId = this.#orchestratorSessionId;
  if (!sessionId) {
    try {
      sessionId = await this.#createSessionWithRetry("Loom · Orchestrator (persistent)");
      this.#orchestratorSessionId = sessionId;
    } catch {
      /* fallback: fresh ephemeral session per prompt */
    }
  }
  const result = await withRetry(() => contract.prompt({ sessionId, system, model, tools: {}, parts: [...] }),
    { retryable: (err) => isRetryableError(err) || isEmptyResponseError(err), ... });
  return { text: result.text, tokens: result.tokens };
}
```

The session is deleted at meeting close (`deleteOrchestratorSession`). Because every orchestrator prompt is self-contained (previous rulings are embedded in the prompt text), reuse adds no context pollution — it just avoids repeated create/delete API traffic.

Context that should be *visible* to the user is posted to the parent session via `session.promptAsync({ body: { noReply: true, parts: [text] } })` — `postProgress()`, with `[info]`/`[warn]`/`[error]` severity prefixes.

Inline peer interactions prompted from plugin tools use `runEphemeralPrompt(participant, opts, meetingId)` — a shared primitive that creates an ephemeral session, registers it, races the prompt against the caller's abort signal, then always unregisters and deletes the session.

### Circuit Breaker

Each model used by agents tracks consecutive failures via the circuit breaker (Section 16). An unhealthy model is not used for turns — a healthy fallback model takes its place — and after the reset timeout one test attempt is allowed.

---

## 8. Agent-Driven Termination

Termination is agent-driven: agents call the `loom_pass` tool when they have nothing new to contribute. The meeting ends when all active participants have passed after the configured minimum rounds.

### The `loom_pass` Tool

Defined in `src/plugin/tools/pass.js`, `loom_pass` is a structured tool call that replaces text-based `[PASS]` signals:

```
loom_pass({ reason: "covered by #3" })
```

**Args:**
- `reason` (optional string, max 200 chars) — why the agent is passing

**Returns:**
```json
{ "passed": true, "reason": "covered by #3" }
```

### How Pass Detection Works

1. Agent calls `loom_pass` during its turn
2. Tool returns `{ passed: true, reason: "..." }` with metadata
3. In `execute-turn.js`, detect `loom_pass` in tool results → skip same-turn synthesis
4. In `_handlePromptResult`, check `metadata.passed === true` → apply pass logic:
   - Set `p.status = "passed"`
   - Persist via `db.setParticipantStatus(id, "passed")`
   - Store pass contribution with reason string as content
5. All-passed check in `_finalizeRound` transitions to `"converged"`

### Termination Conditions

| Condition | What it does |
|-----------|--------------|
| All participants have called `loom_pass` or failed (`activeCount === 0`) | natural end — highest priority |
| `current_round >= max_rounds` | guaranteed termination |
| Stall detection / user cancellation | extrinsic stops |

There is no meeting-level wall-clock timeout: a deliberation runs until it converges, hits the round cap, or stalls. The stall watchdog and user cancellation are the extrinsic stops and proceed to synthesis.

Terminal statuses: `converged`, `cancelled`, `timeout`, `max_rounds_reached`, `aborted`.

---

## 9. Turn Order System

### How Turn Order Works

Turn order is orchestrator-decided without a second planning call: the
end-of-round summary (`summarizeRound`, Section 13) is the orchestrator's
single LLM call per round, and it carries a Next-round turn order block plus
the orchestrator-only `loom_set_turn_order` tool (`plugin/tools/turn-order.js`).
The tool is registered for host resolution but never appears in any
agent-facing tool map (`buildToolsMap`/`buildToolsMapWithoutLoom` — pinned by
test). It takes the full ordered id list plus an optional reason; the runtime
validates (unknown ids dropped, missing non-failed seats appended in rotation
order, failed seats excluded) and stores the result as `planned_turn_order`
(head as `next_speaker_id`). No tool call means the default rotation stands,
materialized by `fallbackTurnOrder()` (current composition order, failed seats
excluded). The operator's `turnOrderPolicy` steers the summary's override block
(`getTurnOrderGuidance`) instead of a separate prompt:

```
Default rotation stands. If this round's evidence warrants a different speaking
order next round, call loom_set_turn_order once with the full ordered
participant ids. Omit it to keep the default. Order preference: <policy line>.


The override block the clerk sees (roster ids + policy line) and the tool description are the whole mechanism — there is no planner prompt, no `buildTurnOrderPrompt`, and no `planTurnOrder()` (both deleted). Ordering inputs are evidence, urgency, and recency; category or seniority appears nowhere by design.

Per-meeting attribution: the summary call records `summary`/`summary_ms` and any override records `turn_order` via `recordMeetingCall`/`recordMeetingLatency` (Section 25).

The ordered list is stored as `planned_turn_order` (and its head as `next_speaker_id`) and applied by `RoundInitializer.filterActiveParticipants()` next round.

Note: config keys `maxTurnRequestsPerRound`, `turnRequestThresholds.autoGrant`, and `maxTurnRequestWords` were removed from the schema (never enforced — turn order is orchestrator-decided; see the deprecation table in `src/config/defaults.js`).

---

## 10. Convergence Detection

Convergence is deterministic and integrated into round finalization — there is no separate LLM "convergence check" anymore.

The meeting terminates when any of these hold after a round:

| Condition | What it does |
|-----------|--------------|
| All participants have called `loom_pass` or failed (`activeCount === 0`) | natural end — highest priority |
| `current_round >= max_rounds` | guaranteed termination |

The `meetings.convergence` column persists only as a display label (set to `"agent_driven"`). Termination is deterministic (see table above). There is no meeting-level wall-clock timeout; the stall watchdog and user cancellation are the extrinsic stops and proceed to synthesis.

Terminal statuses: `converged`, `cancelled`, `timeout`, `max_rounds_reached`, and `aborted`. The current round finalizer produces `max_rounds_reached` when the active round cap is exhausted and `aborted` for mixed pass/fail exhaustion or unrecoverable finalization errors.

---

## 11. State of Play

The state of play is the primary running context for agents. It replaces the old fabric-compaction system with a structured summary aggregated from each agent's bounded `Σⁱ` state; a type-driven weave digest is merged when patch coverage is incomplete. Nothing infers a bucket from an agent's prose — the state of play says what agents *declared*, not what a regex inferred.

### What It Contains

`aggregateStateOfPlay()` produces the markdown document with these sections; `updateStateOfPlay()` supplies the deterministic fallback when coverage is incomplete.

```markdown
## Question
Should we migrate our authentication service to JWT tokens?

## Tags
engineering, security

## Decisions & Proposals
- We should adopt a phased migration over Q1 and Q2, starting with the auth service
- Use short-lived JWTs (5 min expiry) with refresh tokens

## Agreements
- Short-lived access tokens are essential
- Stateless auth reduces session store overhead

## Disagreements & Concerns
- Token revocation remains unsolved — blocklists defeat statelessness
- Refresh tokens stored client-side are a high-value target

## Open Questions
- How will existing sessions be handled during the transition?
- What's the actual downtime budget?

## Key Facts
- Refresh tokens stored client-side are recoverable by design (query response)
- Industry benchmarks show 12-15% YoY growth for this sector (evidence response)
```

### How It's Derived

Primary path is **deterministic aggregation over per-agent states** (`aggregateStateOfPlay` in `src/state-patch.js`): each bucket collects bullets with holder attribution, dedupes case-insensitively, ranks by holder-count then recency (round, then contribution id — lexicographic text is only the final deterministic tiebreak), and selects the top 8 with a per-holder cap (3) plus a coverage pass guaranteeing every active voice ≥1 slot; `established` maps to `## Decisions & Proposals` while `## Agreements` holds the true-consensus subset (≥2 holders); stances are ranked into Key Facts alongside evidence with a floor of 3 evidence slots; files are unioned most-recent-first by (round, contribution id). Output markdown shape is identical to the legacy path, so every consumer works untouched. Aggregation itself is `O(P × buckets)`; the round finalizer runs the `updateStateOfPlay` fallback only when state coverage is incomplete or the aggregate is empty.

Fallback is `updateStateOfPlay(weave, question, tags)`, a **type-driven** scan used when all states are empty (meeting start, SKILL.state off, old DB). It categorizes contributions from **the stored contribution type** (`c.type`) and the interaction mode the calling tool recorded (`prompt_context.mode`) — nothing else:

| `c.type` | Category |
|-----------|----------|
| `contribution` (primary turns — untyped) | **not filed** — see below |
| `critique_response` | Disagreements & Concerns |
| `query_response` | Key Facts — except modes `risks`/`assumptions`/`alternatives` (Open Questions) and `critique` (Disagreements) |
| `perspective_response` | Key Facts (attributed context, not a finding) |
| `evidence_response` | Key Facts — only when tool-backed; un-backed answers route to Open Questions as claimed-but-ungrounded |
| `summoned_response` | Key Facts |
| `reflection` | Key Facts, wrapped as `[Reflected: …]` |
| `vote_response` | (excluded — individual ballots are noise; the invoker's interpretation carries the result) |
| `synthesize`, `refuse` | (excluded) |
| `pass` | (skipped before classification) |
| `propose`, `refine`, `support`, `question` (legacy, no longer emitted) | (not filed) |
| unknown/missing | (not filed) |

**Untyped primary turns are not filed, and there is no keyword fallback.** This is a deliberate deletion. The state of play is the room's primary shared context, and a word-boundary regex (`\bwe should\b` → Decisions, `\bagree\b` → Agreements, `\bdisagree\b` → Disagreements, trailing `?` → Open Questions) was deciding what the room believed it had established — from an agent's prose, with no way for anyone to see or override the guess. `loom_state_patch` is the declaration channel for a primary turn: its `established` / `contested` / `open` / `facts` buckets are what `aggregateStateOfPlay` reads. A turn that did not call it contributed nothing to the state of play, and its prose is still in that round's Live block and in the synthesis transcript, so it is in the record without being claimed as settled.

For the same reason the round finalizer no longer forces the `O(T)` scan for a turn whose patch missed (`hasUncapturedContribution` / `state_patch_outcome` are gone): the scan could not capture the content that condition named.

**Files Involved:** content mentioning file paths (`file=` markers, `src/…` references, or code-file extensions) additionally contributes a short snippet to a dedicated `## Files Involved` section (deduplicated, 5 most recent) so agents can target project files during code-analysis deliberations.

Content is cleaned of legacy bracket directives (`[REQUEST_NEXT]`, `[QUERY]`, `[EVIDENCE]`, `[SUMMON]`) before inclusion. Each section holds the **5 most recent** items, each truncated to **300 characters**.

### How It Appears in Agent Prompts

```
<<<LOOM_STATE_OF_PLAY>>>_BEGIN_
## Question
Should we migrate our authentication service to JWT tokens?

## Decisions & Proposals
- We should adopt a phased migration over Q1 and Q2
...
<<<LOOM_STATE_OF_PLAY>>>_END_
```

### Persistence

The state of play is stored in `meetings.state_of_play` and updated after each round; on resume it is restored from the database.

### Why This Replaces Fabric Compaction

The old system appended round summaries to a "fabric" string and compressed it past `maxFabricChars`. Problems: O(N²) token growth and information loss on compaction. The current state of play is derived from bounded per-agent state with a type-driven weave fallback when coverage is incomplete, and is bounded in size. Combined with ephemeral sessions, per-turn token growth is O(1). The legacy `fabric` column remains only for initial user context and compatibility.

---

## 12. Reflections

Reflections are per-participant belief states: a short statement of where that agent currently stands on the deliberation. They are **no longer produced automatically** — there is no mid-round reflection phase, and challenges/dissents do not trigger reflections.

**SKILL.state single source of truth:** `Σⁱ.stance` **is** the agent's authoritative position. Legacy `participants.reflection` / `reflectionHistory` is kept for backward compatibility but is no longer a second authority: `perspective`-mode answers still write `reflection` and additionally mark the responder `state_dirty`; while that flag is set and `stance` is still empty, `getParticipantState()` surfaces the fresh `reflection` as the stance in the own-state block, so the one-turn lag is never a blind spot. The responder's next mandatory `loom_state_patch` then makes it durable as `stance` (no extra LLM call). Peer prompts render one line only — `Your position (from your state vN): "…"` plus top bullets, falling back to `reflection` only when `stance` is empty. Skip-passed and synthesis read `stance` first, `reflection` only when `stance` is empty. Dashboard participant cards show `stance@vN`. See `plans/skill-state-complementary-implementation.md` §5.7.

### How Reflections Are Maintained Today

The only live write path is **`loom_query` with mode `perspective`**: when an agent solicits a peer's stance on a statement, the peer's answer replaces the peer's stored reflection and is pushed onto a bounded `reflectionHistory` (last 5 entries, in memory) plus persisted via `setParticipantReflection` on the `participants` row. This keeps each agent's "current position" fresh as a side effect of natural peer-to-peer interaction rather than extra LLM calls — the perspective answer *is* their position.

### Where Reflections Surface

- **Peer-facing prompts:** query/vote/summon targets see `Your current position: "<reflection>"` so they answer consistently with their latest stance (Section 22).
- **Synthesis:** participants with reflections get a `### Final Reflections` block appended to the transcript digest (`**Name (category) reflection**: …`).
- **Dashboard:** participant cards show a reflection indicator; legacy `reflection`-type contribution rows still render in the timeline.
- **Skip-passed logic:** a passed agent is kept active if they carry a reflection (Section 6).

### Storage

`participants.reflection` stores the raw text without any header; `reflectionHistory` is session-scoped only. Legacy `reflection`-type contributions (from earlier versions) remain readable in the weave, are folded into round summaries as inline `↳ Reflected:` lines when present, and classify into Key Facts as `[Reflected: …]` — but no current code path creates them.

---

## 13. Round Summarization

After each round, a summary is generated via LLM — every round, unconditionally (there is no conflict-gated mode anymore). If the LLM fails or returns empty, a deterministic digest keeps the round auditable.

### LLM Clerk Summary

`summarizeRound` picks the default model (first seat carrying a model, else first available — or fallback model), filters to substantive contributions (`contribution` + `query_response`/`evidence_response` etc., legacy `propose`/`challenge` included; `evidence_response` only when tool-backed; `[PASS]` excluded) via `SUBSTANTIVE_TYPES` (`src/utils/contribution-types.js`, `vote_tally` removed — outcome via invoker prose) and prompts:

```
You are a concise deliberation clerk. Summarize round 3 in 60-90 words —
no preamble, phrase-style bullets. Preserve numbers verbatim.

## Question
Should we migrate our authentication service to JWT tokens?

## Round 3 Contributions
- [#4] senior_architect [CONTRIBUTION]: We should adopt a phased migration...

## Evidence / Tool Signals (do not invent — use only if cited)
- [#7] data_scientist [evidence_response]: ... [tools: websearch]

## Output — exactly 4 bullets, each one line:
- **Established:** {decisions/proposals that gained support, with holder [#id]}
- **Contested:** {what remains disputed and who holds each side}
- **Evidence:** {tool/vec-grounded evidence introduced, with Source or [#id]; or "None"}
- **Open:** {unresolved questions or next decision needed}

Rules: cite [#id] when attributing. Keep Contested holders explicit.
Preserve numbers verbatim — do not round, estimate, or invent.
```

The **Evidence/Tool Signals** hint collects up to 4 evidence/query/tool-backed contributions sorted by strength ("Strength: strong" > tool-backed > plain, synthetic `write` excluded), so grounded claims are visible to the summarizer even when filtered out of the main list. When patches exist, a `## Agent States (carried)` line (`state: senior@v3, mid@v2`) is appended — no new LLM call.

Runs via the fast-path-routable `#promptOrchestrator` type `"summary"` (Section 21). Contributions are budgeted at 12k chars total (selected by evidence strength, emitted chronologically, each line capped at 1200 chars) with a `…[N further contribution(s) omitted]` marker when exceeded; the Agent States block is capped at 4k chars like the synthesis path's.

### Orchestrator `customInstructions` — Density Template

The orchestrator config's free-text `customInstructions` field (validated to 4000 chars, `src/orchestrator/models.js`) is the operator's lever for deliberation density. When it is **empty**, the clerk prompt automatically gains a default density tail (plan §4.8):

> `In late rounds (3+), note contributions that re-state State of Play without new evidence, and state whether a decision rule (trigger + date + owner) exists for the final artifact.`

When the operator supplies their own `customInstructions`, the default tail is replaced — operator text wins. Recommended template for density-sensitive meetings:

```
In rounds 3+, flag any contribution that restates settled points without new evidence.
Require at least one new source or new argument per round.
If the room has not committed to a decision rule (trigger + date + owner) by the final round, say so explicitly in the summary.
```

### Degraded Digest Fallback

If the LLM summary is empty after retries, the round gets a deterministic digest instead of failing the meeting: up to 8 substantive contribution lines, prefixed `(Degraded summary — LLM returned empty response)` and logged as `summary_degraded`.

### Storage

Round summaries are stored in the `rounds` table (per round) for dashboard display. They are **not** appended to running context — the state of play is regenerated from the full weave instead.

---

## 14. Synthesis

When the meeting ends (convergence, max rounds, timeout, cancellation, or abort), the system synthesizes all contributions into a final artifact.

### Synthesizer Selection

Synthesis runs on the orchestrator model (`_getOrchestratorModel()` — explicit orchestrator model, else default seat model, else healthy fallback), never on a seniority pick: categories play no role in who synthesizes.

### The Synthesis Session

Unlike agent turns, synthesis uses **one persistent session** (`createSynthesizerSession`) reused across the draft, section-repair retries, and the critique pass — the same session accumulates the draft so the critique can reference it.

### Post-Synthesis Persona Proposals

After the artifact saves, one bounded call (`generatePersonaProposals`, `persona-proposals.js`, model = orchestrator model, 120 s cap) drafts persona-file additions grounded in the deliberation: at most 2 `anti_patterns` + 1 `known_biases` per persona, only when the artifact shows a concrete failure, unknown personas and filler dropped by `parseProposalResponse`. Output is a human-review file (`persona-proposals/<meetingId>.md`, atomic write like reports) — never auto-applied. Degraded syntheses skip the pass; any failure is local (meeting outcome unaffected). Toggle: `personaProposals` (default true). The system prompt is `NEUTRAL_SYNTHESIZER_SYSTEM`:

```
You are a synthesis auditor, not a participant. You are neutral to all
agendas — including the synthesizer persona you may have borrowed.

Rules:
1. Prefer citing [#id] or State-of-Play for every Decision and Action Item.
   Novel synthesized fixes are marked "Proposed — synthesized from [#id]".
2. Every Dissenting View must name holder (name + category) and [#id].
   Unresolved Objections are mandatory dissent.
3. Do not invent numbers, dates, costs, tool results, or participant positions
   not in transcript/State-of-Play. If evidence conflicts, state both and set
   Confidence accordingly.
4. Resolved Concerns must NOT reappear as Dissenting Views.
5. Never emit <<< or >>> delimiters. Preserve code and numbers verbatim.
```

(Neutrality matters: the synthesizer is often a specific participant's model/persona, but must not editorialize toward their agenda.)

### The Synthesis Prompt

`buildSynthesisPrompt(question, transcript, participants, tags, stateOfPlay, objections, userContext, opts)` first runs **task-mode detection** (`detectTaskMode`, the single detector also used by the critique pass when deciding whether to request `## Proposed Fix`): questions/tags matching code signals (`react`, `src/`, `.tsx`, `bug`, `refactor`, …) switch to **code-analysis mode**, which adds a required `## Proposed Fix` section with diff blocks and relaxed grounding for clearly-marked synthesized fixes; otherwise it is conversational mode. Meeting tags are threaded through (the `## Tags (topic)` block renders), and build-vs-plan derives from the effective tools the meeting ran with (`opts.buildMode`), not from tags. Section budgets come from `LENGTH_LIMITS`, and the required-section contract is the single `SYNTHESIS_SECTION_CONTRACT` table shared by prompt, repair feedback, and validator.

Condensed structure:

```
You are the synthesis auditor. The deliberation is complete. Produce the final
artifact.

## Mode: Conversational | Code-Analysis (read-only)

## Original Question
Should we migrate our authentication service to JWT tokens?

## Tags (topic)
engineering, security

## State of Play (Final — PRIMARY source)
...

## Unresolved Dissent (must appear in Dissenting Views with holder + [#id])
- Security Engineer: Server-side refresh tokens are just session tokens... (holder: mid_security_engineer)

## Resolved Concerns (do NOT re-list as dissent)
- ...

## Deliberation Transcript (supporting detail — cite [#id] when using it)
<<<LOOM_TRANSCRIPT>>> digest of earlier rounds + full final round + Agent States (final) + Final Reflections <<<END>>>

## Participants (activity)
- Architect Lead (senior): 3 contributions
...

## Synthesis Doctrine
You are not a participant. You are an auditor. Every claim you make must be traceable.
(grounding / attribution / no-invention / resolved≠dissent / actionability rules;
the `### Agent States (final)` block is positions-only — every contested claim still
needs a weave [#id], and state bullets without a [#id] trail are unattributed positions)

## Length — per-section budget
Decision 80-120w · Reasoning 150-250w · Action Items 80-120w ·
Dissenting Views 80-120w · Open Questions 60-90w · Confidence 20-40w

## Required Sections — output these exact headings in this order, even if empty (write "None")
## Decision / ## Reasoning / ## Action Items (+ ## Proposed Fix in code mode)
/ ## Dissenting Views / ## Open Questions

## Confidence
One word: High | Medium | Low — justified against the rubric:
- High = ≥70% meaningful participation AND 0 unresolved objections AND ≥1 grounded claim
- Medium = broad participation with 1 dissent, or majority participation with passes
- Low = significant disagreement remains, or many failed/passed, or ungrounded key claims
```

Only a bounded transcript is included (`formatFinalRoundTranscript`): every contribution line carries its stable `- **[#id] Name** (category, type)` citation key (`pass` rows excluded); earlier rounds appear as ~2-line digests, the last 2 rounds in full (24k chars total, digests truncated first — the final round and state blocks are never cut for digests), plus each participant's stored reflection under `### Final Reflections`. Unresolved objections come from `collectObjections()` (untyped dissent found by keyword + `critique_response` type): an objection cited (`[#id]`) by the final round is resolved; one merely sharing vocabulary is `stale` (background, not live dissent); the rest stay unresolved and are mandatory dissent.

### Required-Section Repair

After the draft, `validateSynthesisSections` requires: always — `Decision`, `Reasoning`, `Confidence`, `Dissenting Views`, `Open Questions`; plus at least one of `Action Items` / `Proposed Fix` (code mode expects Proposed Fix). If anything is missing and retries remain (`synthesisMaxRetries`, default 1), the model is re-prompted on the SAME session: *"Your previous response was missing these required sections: … Please include ALL of the following sections…"*.

### Self-Critique Pass

The synthesizer then audits its own draft against the transcript (up to `MAX_CRITIQUE_RETRIES` = 3):

```
Review the draft below against the deliberation transcript for:
1. Misattributed views (a point credited to the wrong participant)
2. Invented points not present in the deliberation
3. Significant dissent that was omitted from "Dissenting Views"
4. Decisions or action items not supported by any contribution

If corrections are needed, output the FULL revised synthesis with ALL required
sections.

If the draft is accurate, grounded, and complete, respond with exactly: [NO_CHANGES]
```

- `[NO_CHANGES]` → the original draft stands.
- A complete revision replaces the draft.
- A revision that dropped sections is re-sent with feedback; the best revision seen is kept, and retries stop early when an attempt makes no progress (no more burning full-prompt calls on a non-converging model).
- On any error the best revision so far is kept (starting from the original draft).

### Finalization

`finalizeSynthesis` post-processes the text:
- Appends **## Unresolved Objections** and **## Resolved Concerns** (from `objection_collector`).
- Appends **## Refusals** (agents who refused to engage, as `Name: content`).
- Adds a note for any required section the model omitted (`> **Note:** The synthesizer did not generate…`).
- **Grounded-synthesis check:** every `## Decision` line citing no valid `[#id]` from the weave is collected for **## Needs Verification** — and, with the detectors off by default (N3), counted rather than written.
- **Detector precision gate (N3):** `## Needs Verification` and `## Citation Warnings` are both computed and both **counted** in `artifact.detector_report`; neither is written to the deliverable unless its flag is on *and* `detectors.dryRun` is false. Conflicts require a shared unit, a shared label and a time order, so a year is never banded against a percentage; citation targets under `minCitationTargetChars` and "synthesized from" attributions are exempt.
- Parses the Confidence section if present; otherwise derives it heuristically (`deriveConfidence`):
  ```javascript
  if (dissentCount === 0 && challengeRatio < 0.3 && participationRate >= 0.5) return "high";
  if (dissentCount <= 1 && challengeRatio < 0.5 && participationRate >= 0.33) return "medium";
  return "low";
  ```
- **Confidence roll-up (N2):** the stored `confidence` is `min(name, number)` — the weaker layer wins — so the column can never read `high` while the artifact's own prose says `Number: Low`. Both layers are persisted in `confidence_name` / `confidence_number`; the prose split, when the synthesizer wrote one, wins over the derived one.
- **Engagement ledger (N8):** `artifact.engagement` records how many plain contributions engage no peer, how many citations point at the author, and what fraction of the weave this very artifact cites. The same ledger is handed to the synthesis prompt so each uncited contribution must be cited, synthesized, or named as superseded.
- Extracts structured fields (`decisions`, `action_items`, `proposed_fix`, `files_involved`, `open_questions`, `refusals`, `confidence`, `confidence_name`, `confidence_number`, `reconciliation`, `detector_report`, `engagement`) and persists the artifact with `_saveArtifact`.
- **No retraction detection.** An earlier build inferred retractions from 11 English-phrase regexes (`i retract`, `scratch that`, `i no longer stand by`…), bound each to its original by `[#id]` citation or keyword overlap, propagated taint over the citation graph, and wrote `⚠ retracted claim [#n]` / `⚠ retracted figure 16.7pp` markers into the artifact. All of it is deleted. A house style that did not match the regex produced a retraction that silently was not one — the same failure as the deleted vote tally, one layer up: code guessing at meaning and then reporting the guess as a record. Retracting a figure is a thing an agent *does*, and when it wants to it says so in its own prose; the synthesizer sees the whole transcript and can weigh the correction itself. `test/no-prose-interpreters.test.js` pins the deletion.

### Fallback Synthesis

- If the coordinator's synthesis *session* fails, `fallbackSynthesis()` returns a State-of-Play-based artifact (or, absent state of play, categorized proposals/dissent/questions).
- If synthesis throws entirely, the orchestrator persists a **degraded artifact**: *"Synthesis could not be completed (message)"* with Confidence *Low (synthesis interrupted)*.
- If **no substantive contributions exist** (all passed or all failed with no prior output): *"No output could be generated — no substantive contributions were received."*
- If **some participants failed** but contributions exist from earlier rounds: synthesis proceeds normally with a footnote: *"Deliberation ended early — N of M participants failed (completed X of Y rounds). Synthesis is based on available contributions only."*

---

## 15. State Management

### State Shape

```javascript
{
  id: "meeting_abc123",
  parent_session_id: "session_xyz",
  question: "Should we migrate to JWT?",
  context: "We're a 50-person startup...",
  participants: [/* see Section 3 */],
  fabric: "We're a 50-person startup...",   // original user context (base of extension appends)
  state_of_play: "## Question\nShould we...", // structured summary, rebuilt each round
  weave: [/* all contributions across all rounds */],
  rounds: [
    { number: 1, contributions: [...], token_path: [...], summary: "..." }
  ],
  current_round: 3,
  max_rounds: 6,
  current_speaker_idx: 0,
  status: "weaving",   // initializing | weaving | converged | cancelled | timeout | max_rounds_reached | aborted
  artifact: null,      // set after synthesis
  objections: [],      // collected at synthesis time
  tags: ["engineering", "security"],
  next_contribution_id: 14,
  next_speaker_id: null,          // set by loom_set_turn_order, the default fallback, or loom_pass redirect
  planned_turn_order: [],         // planned for next round
  opencode_session_id: "...",     // for session-indexing
}
```

### Immutability

`getState()` returns deep-frozen copies (`structuredClone` + `deepFreeze`; `createMeetingConfig()` deep-freezes via `JSON.parse(JSON.stringify(TUNING))` per-meeting). All mutations go through targeted `StateManager` methods:

```javascript
stateManager.transitionTo("weaving")            // validated TRANSITIONS table
stateManager.addContribution(obj)               // atomic addition
stateManager.setStateOfPlay(summary)            // regenerated each round
stateManager.setPlannedTurnOrder(ids)           // for next round
stateManager.setNextSpeakerId(id)               // turn order planning
stateManager.reorderForNextSpeaker(id)          // established for next round
stateManager.addParticipantReflection(id, text)
stateManager.getParticipantState(id)            // Σⁱ clone (lazy Σ_0 seed)
stateManager.setParticipantState(id, next)      // Σⁱ store + stance mirror
stateManager.linkStateToContribution(id, cid)   // Σⁱ ↔ contribution link
stateManager.getAllParticipantStates()          // SoP aggregation + synthesis
```

`transitionTo` validates against `StateManager.TRANSITIONS` (`initializing → weaving/cancelled/aborted/timeout`; `weaving → converged/cancelled/timeout/max_rounds_reached/aborted`; terminals absorbing). `forceTransitionTo` now allows `initializing→weaving` for stuck-in-initializing extension plus all terminal→`weaving` (resume), else throws; `orchestrator.close()` is idempotent (`#closed` guard, nulls `_database/_sessionManager/_roundExecutor`).

### Persistence

State is persisted via the `PersistenceService` after each round finalization and after terminal events (`#persistState`), atomically updating `meetings` with round, status, fabric, state_of_play, next_speaker_id, stats, and degradation flags. Fresh DBs enforce participant status checks, foreign keys, and `UNIQUE(meeting_id,name)` (no category whitelist). On resume, `restoreStateFromDb()` reconstructs from SQLite (participants with behavioral persona fields, weave, rounds, `agent_errors` with `CHECK`, next speaker, call stats) and rehydrates `artifact`/`objections` if synthesized.

### Per-Agent Execution State (SKILL.state)

Each agent owns a bounded structured state `Σⁱ = { stance, established[], contested[], open[], facts[], files[], version, updated_round, updated_contribution_id }` (`src/state-patch.js`). In memory it lives in `StateManager.participantStates` (per-agent ownership — no two agents ever write the same slice); `buildSharedState` carries only a summary (counts + versions) to avoid inflating the per-round clone. Persisted in `participants.state_json` plus an append-only `state_patches` audit table (`UNIQUE(meeting_id, participant_id, version)`, `ON DELETE CASCADE`), schema `user_version 13`. During a primary turn the validated patch is held in `StateManager`; the contribution, participant state, and patch audit row commit in one SQLite transaction. `version++` happens only on successfully applied patches; failed validation, empty patches, and misses mutate nothing and write no row. Resume/extension carries all `Σⁱ` forward (`restoreParticipantStates`); missing/corrupt rows seed deterministically (reflection-seeded when available, else empty, `rebuilt: true`). Full spec: `plans/skill-state-complementary-implementation.md`.

**Bounded by construction (`STATE_PATCH_CAPS`).** Each bucket holds ≤ `buckets` (8) items — ≤ `buckets + reserve` (10) transiently, reported in `overCap`; `stance` ≤400ch, bullets ≤280ch, files ≤160ch; ≤3 adds and ≤5 removes per call. `renderMyStateMarkdown` slices to `buckets`, and `aggregateStateOfPlay` caps every shared bucket at `buckets`, so prompt footprint is flat in `T`.

**Evidence pin tier.** `facts` bullets carrying `Source:`/`[#id]` are evidence and survive FIFO eviction longer than ordinary bullets — but the exemption is **tiered, not absolute**. The newest `pinnedFacts` (8) pins are protected outright; older pins *degrade to evictable* and each demotion is echoed as `evicted[].demoted === true`. `pinnedFacts === buckets` establishes **stored ⊆ visible ⊆ removable** — every bullet the runtime holds is rendered in the own-state block, so the model can always explicitly `remove` it; no invisible state accumulates. Verified under stress: 500 consecutive cited adds settle at exactly 8, all buckets stay bounded under mixed load, and pinned evidence still survives 20 unrelated non-fact patches.

**Merge invariants (`applyStatePatch`, pure + deterministic).** Cross-bucket adds move rather than duplicate (a blocked move by pinned evidence skips the add entirely, recorded in `skipped`); ungrounded `facts_add` entries quarantine into `open` *through the same cap/FIFO path* as any other write; `remove[]` matches on trimmed + whitespace-collapsed + lowercased keys and may match across buckets; stance clearing is done by `remove`ing the current stance (the schema requires non-empty).

**Persistence ordering.** A primary-turn patch is queued in memory and committed with the contribution, `participants.state_json`, and `state_patches` in one transaction. The in-memory state is published only after that commit succeeds. A failed transaction leaves both the weave and participant state unchanged, so the executor can record persistence degradation without reporting a state-only success.

**Per-turn patch outcome enum (observability, never gating).** Because patching is non-fatal, "no patch" has several causes that a single counter collapses. Every primary turn records exactly one of `applied | exempt_pass | never_attempted | rejected | unverified | disabled` on `contributions.prompt_context.state_patch_outcome` (plus `state_patch_detail` for rejections), stored on the already-persisted blob so no schema migration is needed for observability. `never_attempted` is the behavioral signal (no patch call in the turn); `rejected` is validation/persistence. A patch that lands on a pass turn records `applied` (both calls honored). (`skipped_deadline` is no longer produced since the meeting deadline was removed; the dashboard label remains for historical contributions.)

**Coverage is computed from the enum, not tool-call status.** Counting `tool_calls` with `status === "completed"` *inflates* coverage, because a rejected patch returns a normal tool result carrying `metadata.error` and no throw. The dashboard Overview now reports applied-from-outcome cross-checked against durable `state_patches` audit rows and the count of participants whose `state_version > 0`; disagreement between those three is itself the diagnostic signal. Per-turn outcome also appears in the Timeline contribution dialog's Details tab. Operational logging only — no benchmark harness, no token accounting.

---

## 16. Error Handling & Model Fallback

### Retry-able Call Sites

Retries (`withRetry`, exponential backoff with jitter) wrap:
- **Session creation** (`client.session.create`) — `maxAttempts = maxRetryAttempts` (default 2).
- **Orchestrator prompts** (`SessionManager.promptOrchestrator`) — same retry policy.

Retryable errors (`isRetryableError`): `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, any message containing "timed out", HTTP 5xx, HTTP 429.

### Agent Prompt Failures (retry + model fallback)

Agent turns are now **retried** — the old "run once and fail" behavior is gone. `#promptChildSession` runs a staged recovery ladder before an agent is marked `failed`:

1. **Sliding-deadline timeout:** base `agentTimeoutMs` (20min) per agent call — deliberately NOT reduced when agents fail ("previously punished survivors"). Weave growth while pending defers the deadline (up to 3× base); no progress still times out.
2. **Retry on the assigned model** — up to `modelFallback.maxRetriesPerModel` (default 2) retries *after* the first attempt, with exponential backoff (1000ms · 2^attempt + jitter, capped at 8s). Each failure increments the model's circuit-breaker counter.
3. **Fallback model** — when the primary model's retries are exhausted (and `modelFallback.enabled`, default true), `selectFallbackModel()` picks a healthy model from the discovered pool that is *not* the failing model (random among the healthy candidates) and the turn is attempted on it (up to `modelFallback.maxFallbackAttempts` retries after the first fallback attempt), with the same backoff. A progress message announces the switch ("⚠️ Model X failed — retrying with Y").
4. **Failure** — only when the primary and fallback attempts are all exhausted does the agent's status become `failed`, an `agent_errors` row is written with type `model_fallback` (`Model: X, No fallback available` or `Original: X, Fallback: Y — <error>`), and the agent is skipped for the rest of the round.

Every failed/finished turn path is precomputed once: **bounded state context, system prompt, and user prompt are built model-independent and reused across retries/fallbacks** (no duplicate context-building calls). When the circuit breaker already marks the assigned model `open`, the turn starts directly on a fallback model without retrying the unhealthy one.

**Inline-tool side effects across retries:** loom interaction tools execute server-side *during* `session.prompt`. If an attempt fails after those side effects landed, the retried response will not re-contain those ToolParts — the peer contributions already live in the weave (deduplicated by batch+target+question idempotency keys, Section 22), and the gap is surfaced via an explicit `attempt_failed_possible_tool_side_effects` log instead of silently disappearing.

Successful fallback turns carry a `_fallback` metadata object on the parsed response (`{ from, to, error }`); having succeeded on the fallback model, the agent's status returns to `listening` as normal. Additionally, `#getParticipantModel` can itself substitute the highest-quality healthy model when a participant's own model is unhealthy (orchestrator-level fallback used by directives and synthesis).

### Circuit Breaker

Per-model failure tracking (`circuitBreaker.failureThreshold: 3`, `circuitBreaker.resetTimeoutMs: 300000`):
- After `failureThreshold` consecutive failures the model state is `open`. The *next* turn for an agent assigned that model does **not skip** — a healthy fallback model is selected and used instead (see above).
- After the reset timeout the breaker goes `half-open` (one test attempt allowed).
- On success, the breaker resets to `closed` (the failure record is cleared).
- `circuitBreaker.getHealthyModels(available)` excludes open models from the fallback pool, so an unhealthy model can never be chosen as a fallback while it is open.
- An open circuit breaker with **no healthy fallback available** still fails the turn: `#recordFallbackFailure` writes "circuit breaker open, no fallback" into `agent_errors`.

### Model Fallback Configuration

```json
{
  "modelFallback": {
    "enabled": true,
    "maxRetriesPerModel": 2,
    "maxFallbackAttempts": 1
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Master switch for the retry + fallback ladder. When `false`, a single prompt failure immediately fails the agent (legacy behavior). |
| `maxRetriesPerModel` | `2` | Extra attempts on the same model before falling back (0 = no retries on the primary). |
| `maxFallbackAttempts` | `1` | Extra attempts on the selected fallback model. |

### Database Errors

Database operations are wrapped in try-catch; best-effort operations log and continue. Schema changes run through the ordered migration list in `src/database/schema.js`; current schema is version 7. `MeetingDatabase.transaction()` uses savepoints, and meeting/report writes are file-permission restricted.

Indexing and other best-effort operations log and continue.

### All-Failed / All-Passed Handling

Degraded artifacts are produced when every participant fails or everyone passes (Section 14).

---

## 17. Stall Detection

A watchdog monitors activity. If no state update occurs for the configured interval, the meeting is cancelled and passes through to synthesis.

**Configuration:** `stallTimeoutMs` = 1,800,000ms (30 min), tick interval `WATCHDOG_TICK_MS` = 30,000ms (30s) via `TUNING.WATCHDOG_TICK_MS` (`getConfig().tuning`). Must exceed `agentTimeoutMs` (20min) so the watchdog never kills a legal long turn.

**Mechanism:** `StallWatchdog.start(getStatus, isCancelled)` is idempotent (`start()` touches if already running); `touch()` on `#notifyUpdate` + contributions + every pending-LLM heartbeat (`SessionContract` `onHeartbeat` every `PROMPT_LIVENESS_TICK_MS`) resets `lastActivityAt`.

**Mechanism:** `StallWatchdog.start(getStatus, isCancelled)` begins a 30s interval. On each tick:
1. If the process is cancelled or the meeting is in a terminal status, stop the watchdog.
2. If `Date.now() - lastActivityAt > stallTimeoutMs`, log `stall_detected`, set `stallCancelled = true`, and call `onStall()`.

**Activity touch:** `lastActivityAt` is updated on every state update (`#notifyUpdate()`) via `stallWatchdog.touch()`, on every contribution, and on every pending-prompt heartbeat tick (`onPromptActivity` → `stallWatchdog.touch()`).

**Stall response:** `onStall` sets `#cancelled = true` and posts "⏱️ No activity detected for a while — stopping the deliberation." The weave loop detects the flag and transitions to **"timeout"** (not "cancelled" — this distinguishes inactivity from user action), then proceeds to synthesis.

---

## 18. Extension, Resume, and Crash Recovery

### Meeting Extension (from the dashboard Setup tab)

When a user extends an existing meeting from the Setup tab (`POST /api/meetings/extend` with `meeting_id` + new `question`), `handleExtendMeeting` runs it as a detached background job:

1. The meeting database is resolved directly by ID (`getDbPathForMeeting`); existing participants are read from it.
2. A `MeetingOrchestrator` is constructed with `resume: true`; `restoreStateFromDb()` rebuilds state from the SQLite DB.
3. `extendMeeting(newPrompt, additionalRounds)` (via `MeetingExtender`) appends the new input to the fabric: `**User Input:** <new prompt>`.
4. Status is force-transitioned back to `"weaving"`.
5. `max_rounds` increases by the dashboard's "Additional rounds" input (1–10) when provided; otherwise a bounded amount derived from configuration (2–6 rounds; fallback 4).
6. All persisted participants, including behavioral persona fields and state, are restored and reset to `"listening"`.
7. The weaving loop runs again from the current round, then synthesis runs again.

Extension is rejected with HTTP 409 while another deliberation is running. Every start is a fresh meeting — there is no `fresh` flag anymore.

### What Survives a Resume

From the database: participants (with personas, categories, models, status, reflections), the full weave, rounds, the state of play, max rounds, next speaker, and call stats. Participant contribution counts are recomputed from the weave. Each finished agent turn commits atomically (contribution + optional state patch); the round summary and state of play commit only at round finalization. A kill mid-round therefore leaves the partial round's committed turns durable, its in-flight turn lost, and its summary unwritten.

### Resume after an Interruption (from the dashboard Setup tab)

When the server is force-closed mid-run, the meeting row stays at `weaving` with no running job after relaunch. Selecting that meeting in the Setup tab offers **Resume** (`POST /api/meetings/resume`), which restores state and then completes the interrupted round in place — re-driving only its missing speakers and finalizing it — before continuing to the next round. Committed turns are never replayed; `next_contribution_id` is re-derived from `MAX(id)`. Resume preserves the meeting's stored session attribution, feature toggles, orchestrator config, and `max_rounds`; it never appends fabric or requires new input (that is Extend's role). Extend is idempotent for a killed extension: retrying the same prompt skips the fabric append and round bump.

### Finishing a Synthesis Orphan

A kill between the terminal-status write and the artifact write leaves a terminal meeting with no output. The Setup tab offers **Finish** (`POST /api/meetings/finish`) for exactly that state: restore + synthesis only, no new rounds, with the original terminal status re-applied afterward. If only the Markdown report is missing, Finish regenerates it from the stored artifact without running anything.

### Crash Recovery Guarantees

- **Dirty close**: every readonly open (dashboard, session lookup, repair) recovers an uncheckpointed WAL through one ordered ladder — writable `wal_checkpoint(TRUNCATE)`, then readonly retry, then a degraded last resort (`immutable=1`, else a tmp copy of the main image). BUSY/LOCKED and corruption are never retried as recovery. `GET /api/repair?meeting=` forces the same checkpoint on demand, and the dashboard auto-repairs once before retrying a failed load.
- **Degraded guard**: if a non-empty WAL survives the checkpoint (read-only or locked volume), reads may reflect the last checkpointed image. The dashboard still renders everything recorded, but Resume/Finish are refused (`db_degraded_readonly`) rather than risking recovery decisions on a stale image.
- **Startup hygiene**: on boot the dashboard checkpoints every meeting DB and sweeps crash-orphaned temp files (preview databases, readonly copies, report/rename tmps) behind an age gate; live writers' fresh files are never touched.

---

## 19. Embedding PersonaIndex

Loom uses local embeddings for **persona selection only**. It does not auto-retrieve prior transcript chunks into agent prompts and does not maintain a fabric-RAG index. Prior contributions remain durable in SQLite, while each agent carries a bounded `Σⁱ` state and receives the shared state of play plus current-round live contributions.

### In-memory store

| Structure | Purpose |
|-------|---------|
| process-scoped `Map` in `PersonaIndex` | Persona vectors (`personaName`, category, tags, embedding text) keyed `category\|name`, ~280KB for the full catalog |

The store is filled lazily with a validated embedding dimension and a store-level fingerprint (model + catalog content), so repeat meetings skip inference entirely. If the model is unavailable, composition falls back to keyword/tag matching. (Historical note: these vectors used to live in `persona_embeddings` + sqlite-vec `vec_persona_embeddings_${dim}` tables per meeting DB; that backing was removed — old DBs may still contain the orphaned tables, which nothing reads.)

### Embedding Service

The local ONNX embedder uses `onnxruntime-node` and `@huggingface/tokenizers`. The default is `Snowflake/snowflake-arctic-embed-xs` (384 dimensions, 512 maximum tokens, INT8). Model files live under `<opencode-config-dir>/loom/models/`; runtime dependencies are resolved from the installed plugin dependencies or the project `node_modules` during development. Model metadata and tokenizer checksums are validated before loading.

### Composition Flow

1. `PersonaIndex.indexAll()` embeds each persona's description, agenda, tags, and expertise into the in-memory store, at `availableParallelism() - 1` concurrent (clamped to 2..16). ONNX threads internally, so this is not the bottleneck — the whole 349-persona catalog costs ~6s cold.
2. `PersonaIndex.searchAll(queryEmbedding)` performs one unpartitioned in-memory similarity lookup and returns the whole catalog ranked nearest-first. This is microseconds.
3. The top `autoSelectSeats` are pre-selected; the user confirms, edits, or filters before anything runs.
4. The dashboard requires explicit persona and model approval before any meeting starts.

### Background Index Warm

Step 1 is the only slow part of ranking, and it is paid once per process. So it is
paid in the background instead: `warmPersonaIndex()` runs when the embedder becomes
ready (`initEmbeddingModel` at dashboard start, and `POST /api/models/select` after
a model switch — the store fingerprint includes the model name, so a switch genuinely
requires a rebuild). Afterwards `indexAll` is a ~4ms fingerprint no-op.

The warm is fire-and-forget and cannot block readiness: it never rejects, concurrent
callers share one run, and it short-circuits before touching the catalog when no model
is loaded rather than failing 349 individual embeds. `getPersonaIndexStatus()` reports
`empty | indexing | ready | error` with a live count; `GET /api/models` serves it
inside `embeddingStatus.personaIndex`, which the Setup tab polls every 5s.

The auto-select button is **hidden until `ready`**, with a muted
`Preparing N personas…` line in its place while indexing and an explicit amber message
if the index errored. Hiding rather than disabling is deliberate: a disabled button
next to a working manual path explains nothing, and neither does a button that is
simply absent.

### Degraded Mode

Embedding initialization and indexing are best-effort. A missing native dependency, invalid model file, or provider failure must not prevent a meeting from starting. Auto-select is simply not offered in that state — `/api/room/preview` returns 503 `embedder_unavailable` and the Setup tab falls back to manual persona selection, which needs no embedder. A meeting started without auto-select runs exactly as it always did. Agent prompts never depend on a successful embedding call; `loom_summon` gates itself separately via `isSummonAvailable()`.

The eager warm is a latency optimisation, never a new dependency. If it fails, `rankAllPersonas` still calls `indexAll` itself and indexing is retried inline on the user's click; ranking never returns an empty `ranked` list to the dialog, which would be rendered as a room with no personas while being presented as the closest matches.

---

## 20. Agent Tooling — Built-ins + Plugin-Registered Loom Tools

Agent tooling is split between **built-in OpenCode tools** (webfetch, websearch, read, glob, grep, and optional bash) and **plugin-registered loom tools** (loom_query, loom_vote, loom_summon, loom_pass, loom_state_patch). Both sets flow into agent prompts through the same mechanism: `agentTools` config → `tools` body map → OpenCode server maps to provider tool definitions.

### Tool Sets by Phase

| Phase | Built-in | Loom Plugin | tool_choice |
|-------|----------|-------------|-------------|
| Primary agent turn | `webfetch`, `websearch`, `read`, `glob`, `grep` (bash only when explicitly enabled and allowlisted) | `loom_query`, `loom_vote`, `loom_summon`, `loom_pass`, `loom_state_patch` | `auto` |
| Query/Evidence response (peer) | `webfetch`, `websearch`, `read` | *(none)* | `auto` / `required` (evidence) |
| Vote response (peer) | *(none)* | *(none)* | `none` — bare `[Vote: X]` ballot |
| Summoned expert | `webfetch`, `websearch`, `read` | *(none)* | `auto` |

**Not granted to agents**: `write`, `edit`, `tui`, `todo`, `lsp`, `comment`, `snapshot`, `permissions`.

### Plugin-Registered Tools

| Tool | Source File | Purpose |
|------|-----------|---------|
| `loom_query` | `plugin/tools/query-evidence.js` | Query peers with 7 modes (clarify/perspective/evidence/critique/risks/assumptions/alternatives) — returns inline for same-turn synthesis |
| `loom_vote` | `plugin/tools/vote-summon.js` | Call a lettered poll — fan-out to all other active participants, inline tally |
| `loom_summon` | `plugin/tools/vote-summon.js` | Summon a guest expert persona for one additive contribution |
| `loom_pass` | `plugin/tools/pass.js` | Pass on current turn; deliberation ends when all participants pass |
| `loom_state_patch` | `plugin/tools/state-patch.js` | Maintain private notes for next round (when toggle on: offered inline, once as the absolutely-last tool use per non-pass turn; a miss is logged and the turn stands — no follow-up call) |
| `loom_set_turn_order` | `plugin/tools/turn-order.js` | **Orchestrator-only** — override next round's order from the summary call (Section 9). Registered for host resolution but never in any agent-facing tool map. |

All loom tools resolve the current meeting from `context.sessionID` via the session-index, then delegate to the in-memory `activeLooms` engine for state/session/database access. Shared helpers `src/plugin/tools/shared.js:1` centralize `resolveCaller` (session→speaking→weave→any), `resolveModel` (borrow any healthy participant model), `buildBatchId` (`inline-${meetingId}-${round}-${callerId}`), and `TERMINAL_STATUSES` (re-exported from `src/constants.js:3`).

### Tool Registration Chain

```
src/index.js (Loom factory)
  → tool("loom_query", createQueryEvidenceTools({ config, resolveMeeting, activeLooms }))
  → tool("loom_vote", createVoteSummonTools({ config, resolveMeeting, activeLooms }))
  → tool("loom_summon", ...)
  → tool("loom_pass", createPassTool({ config }))
  → tool("loom_state_patch", createStatePatchTool({ config, resolveMeeting, activeLooms }))

When an agent turn starts:
  MeetingOrchestrator → RoundExecutor
    → client.session.prompt({ body: { tools: toolsMap } })
```

The `tools` body field is a **boolean filter map** (e.g. `{ webfetch: true, loom_query: true }`); the opencode server maps enabled tools to provider-format tool definitions automatically. Built-in tools are gated by `agentTools.builtIn.*`; loom tools by `agentTools.loom.*`.

### Agent Guidance

When loom tools are enabled, the system prompt includes:
- **Research-first guidance** for configured research tools ("search before you claim").
- **Query-mode guidance** (`loom_query` modes table embedded in system prompt) — callers use modes to specify the kind of response they want.
- **Evidence requests** additionally require "You MUST use at least one research tool to find concrete evidence. Do NOT speculate or reason from memory alone."

### Configuration

```json
{
  "agentTools": {
    "enabled": true,
    "builtIn": {
      "webfetch": true, "websearch": true, "read": true,
      "bash": { "enabled": false, "allowlist": ["git", "ls", "wc", "head", "tail", "grep", "find"] },
      "glob": true, "grep": true, "lsp": false
    },
    "loom": {
      "loom_query": true,
      "loom_vote": true,
      "loom_summon": true,
      "loom_pass": true,
      "loom_state_patch": true
    },
    "maxToolOutputTokens": 12000
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Master switch for all agent tools |
| `builtIn.*` | (see above) | Enable built-in tools for agent turns |
| `builtIn.bash.allowlist` | `["git","ls","wc","head","tail","grep","find"]` | Only these commands via bash |
| `loom.*` | all `true` | Enable loom plugin tools (query/vote/summon/pass/state_patch). `loom_summon` is additionally **capability-gated** on a loaded embedding model — see §20 Embedding model unavailable |
| `maxToolOutputTokens` | `12000` | Warning threshold for stored tool-output volume; synthesis context remains bounded |

> Tool-call volume is unlimited by design: there is no per-turn tool-call cap,
> no per-call `loom_query` target cap, and no per-round/per-agent `loom_summon`
> cap. The legacy keys `agentTools.maxToolCallsPerTurn`,
> `agentTools.maxQueryTargetsPerTurn`, `maxSummonsPerRound`, and
> `maxSummonsPerAgent` are deprecated and ignored. Telemetry still records the
> per-turn high-water mark (`tool_calls.max_in_a_turn`) with `cap_per_turn: null`.

### MCP Servers (Spike Findings — Not Implemented)

The host (opencode) exposes configured MCP servers (local stdio + remote HTTP, `opencode.json` `mcp` section) as LLM tools alongside built-ins, named `<server>_<tool>`, manageable per-agent via `tools` globs. This repo's `session.prompt` takes a `tools: Record<string, boolean>` name map resolved host-side — the same mechanism built-ins already use — so requesting MCP names from plugin sessions is expected to work, but no live host was available to verify resolution, naming edge cases (e.g. hyphens), or enablement semantics for plugin-created sessions.

Integration plan (when a live host confirms): loom config allowlist (default-deny, mirroring the bash-allowlist philosophy — MCP servers inflate context fast, per host docs), matched names merged into `buildToolsMap`, one ladder rung teaching when to reach for them. Verification: enable a fixture MCP server, run a turn requesting it, confirm server-side execution. Until then: no code, no config keys.

### Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Prompt injection via tool outputs | Tool outputs feed the final text only; content is sanitized + `delimitContext` fenced `PEER_CONTRIBUTIONS`/`STATE_OF_PLAY` in `buildSummonPrompt` |
| Bash command execution | Disabled by default; when explicitly enabled, only allowlisted executables and conservative argument checks are accepted before execution. Shell composition, interpreters, `-exec`, and recursive flags are rejected. |
| Filesystem exposure | `read` via opencode SDK sandbox; meeting IDs and dashboard asset paths are validated; model names reject traversal segments; files use restrictive permissions where supported |
| Embedding model unavailable | Persona composition falls back to keyword/tag matching and records `semantic_degraded`; no prior-transcript retrieval is required. `loom_summon` is the exception — it picks the guest by semantic similarity over the persona index, so with no model there is nothing to rank the issue against and it would return an arbitrary guest. It hides instead of degrading: `src/services/embedding-gate.js` is consulted by all three enforcement layers (`buildToolsMap` drops it from the offer, `prompts/agent.js` drops it from the tool ladder / guidance / mandatory note / OUTPUT CONTRACT, `vote-summon.js` refuses a direct call with the fix), so config permission alone never surfaces a tool that cannot work. Meeting init already awaits embedder startup, so the gate reads a settled state rather than a race |
| Loom tool side effects on retry | Inline peer contributions persisted via normalized question/batch idempotency keys; retried prompts reuse existing responses; abort re-checks in `query-evidence.js:102`/`vote-summon.js:142` |

---

## 21. Fast-Path Model Routing

Orchestrator calls can use a cheaper/faster model instead of the default seat model.

### Configuration

```javascript
{
  fastPathModel: "anthropic/claude-haiku"  // empty string = disabled
}
```

### What Gets Routed

`#promptOrchestrator` routes to the fast-path model when `fastPathModel` is set:

```javascript
const useModel = (fastPathModel && (type === "moderation" || type === "summary"))
  ? fastPathModel
  : model;
```

| Call Type | Fast-Path? | Used By |
|-----------|-----------|---------|
| `moderation` | Yes | Moderator rulings (Section 8) |
| `summary` | Yes | LLM round summaries incl. the turn-order override block (Sections 9, 13) |

There is no `turn_order` call type anymore: ordering travels inside the summary call, which is fast-path eligible like any summary.

When `fastPathModel` is empty (default), all orchestrator calls use the default seat model.

---

## 22. Inline Peer Interactions: Query, Vote, Summon

Agents can direct the conversation at specific participants via **plugin-registered loom tools** (Section 20) without waiting for the round-robin order. When invoked, callee responses return **inline** so the caller can synthesize them within the same turn. All interactions run immediately after the source agent's contribution is stored, using fresh ephemeral sessions for each target (reused round-scoped sessions when available for the heaviest fan-out, vote). Targets are resolved from the current participant list, excluding the source and any passed/failed/muted participants.

### `loom_query` — Multi-Mode Peer Query

**Signature:** `loom_query({ queries: [{ target, question, mode }] })`

One call can query multiple peers (1 per item). Each item specifies a `target` (participant ID), `question` (1–500 chars), and `mode` (one of 7, default `clarify`):

| Mode | Response Kind | tool_choice | Purpose |
|------|--------------|-------------|---------|
| `clarify` | Factual answer | `auto` | Default — ask for information |
| `perspective` | Position-tagged opinion | `auto` | Solicit the target's stance on a statement; updates their stored reflection |
| `evidence` | Finding + Source + Strength | `required` | Target MUST use a research tool |
| `critique` | Most damaging objection | `auto` | Adversarially stress-test a statement |
| `risks` | Failure modes + severity + mitigation | `auto` | Surface risk angles |
| `assumptions` | Unstated premises + how to test them | `auto` | Expose hidden assumptions |
| `alternatives` | Genuinely different approaches | `auto` | Explore alternative framings |

**Execution flow:**
1. Resolve each target (must exist, not failed/passed/muted).
2. For each resolved target: build prompt via `buildQueryPrompt` (clarify/other modes) or `buildEvidencePrompt` (evidence mode) — the self-contained question (no draft exists mid-turn; the prompt states this explicitly), target's recent contributions plus recent room context, one-line position (`Your position (from your state vN)` + top bullets; the full Σⁱ block is the fallback only when no position exists), a settled-items digest (`buildPeerSettledDigest`: consensus text only, capped at 4, so the peer cannot unknowingly re-litigate signed points — absent when nothing is settled, in which case the prompt is byte-identical), plus round context.
3. Run `runEphemeralPrompt` for each target — **parallel by default** (`agentTools.parallelQueries`, Setup-tab toggle; off = serial loop). Parallel runs use batched fan-out (`src/utils/fanout.js`: default 5/batch, ~100/min budget from `TUNING.FANOUT`, order-preserving, all-settled — one slow/failed peer never blocks the others). Prompts run concurrently; persistence stays serial in request order (two-phase) so contribution IDs are monotonic.
4. Persist each response as a typed contribution (`query_response` or `evidence_response`) under the invoker's `batch_id`.
5. **Perspective mode side-effect:** the response replaces the target's stored `reflection` (pushed onto bounded `reflectionHistory`, max 5) and persists via `setParticipantReflection` — this is the primary write path for reflections (Section 12).

**Idempotency:** if `batch_id + target + question` already exists in the weave (retry after timeout), the existing contribution is reused instead of re-prompting.

**Dashboard:** targets marked `speaking` while responding; listed in `meetings.querying_participants`.

### `loom_vote` — Poll

**Signature:** `loom_vote({ question })`

Fan-out to **all other active participants** (the source does not ballot; failed/passed participants are excluded). Voters are prompted in **parallel batches** (`src/utils/fanout.js`: default 5/batch, ~100/min budget from `TUNING.FANOUT`) and **the source is the sole, declared interpreter** of the returned ballots. Partial failures are per-voter entries — one failed ballot never blocks the rest. Note: at very large room sizes (e.g. 300 participants ≈ 60 batches) full fan-out is complete but slow by design; the caller waits for all batches.

- **Prompt** (`buildVotePrompt`): poll question, source's contribution, voter's last 2 contributions and stored reflection, round context.
- **Ballot format:** `[Vote: <letter>]` first, then 1–2 sentences of reasoning. Nothing parses it: the ballot is stored and returned verbatim, and the invoker's model reads it. (N1 — the former `utils/vote-tally.js` regex interpreted ballots and silently dropped 44% of them while still reporting `Total voters: 0`; the module was deleted rather than hardened, because a lossy second source of truth beside the raw ballots is worse than no second source of truth.)
- **Tools:** none — `tool_choice: "none"` (fast, tool-free poll).
- **Output:** each ballot stored as `vote_response` (`[Vote from <Name>]`), **untruncated** — the reasoning is the evidence, and a 200-character prefix once cut the load-bearing sentence of a ballot mid-word. Ballots are returned **inline** to the caller as `{question, votes:[…], note}` for same-turn synthesis; there is no `tally` field and no `vote_tally` row. The note states the contract: *"Ballots are returned verbatim and you are the interpreter — no tally is computed and no ballot is dropped. State the outcome, the number of responders, and the margin, and record the ballots you are relying on in your contribution."* Because the interpretation lives in the invoker's contribution, downstream synthesis cites that contribution and an interpretation error is visible at its source.
- **Edge case:** source-only → empty `votes` with the same note.
- **Idempotency:** same `batch_id + question` reuses existing `vote_response` rows verbatim.

### `loom_summon` — Guest Expert

**Signature:** `loom_summon({ persona_name, issue })`

Brings in a **guest expert** from the persona pool (matched by name across all categories; unknown personas are rejected). The summoned agent is not a registered participant — it contributes once.

- **Rate limits:** none — agents may summon as many guests as they want.
- **Model:** the summoning agent's own model.
- **Tools:** `webfetch`, `websearch`, `read` (no bash/glob/grep — least privilege for guests).
- **Prompt** (`buildSummonPrompt`): persona expertise, communication style, requester's issue, recent context (last 4 contributions), round context.
- **Contribution:** type `summoned_response`, participant id `summoned_<slug>`, content prefixed `[Summoned: <Name> (<category>)]`.

### How Inline Responses Appear in the Caller's Context

Peer responses are returned as JSON payloads in the tool output. The caller's system prompt instructs it to **synthesize inline** — use the peer answers directly in its contribution rather than reporting them as raw tool output. Responses are also stored as indented contribution rows in the weave for later agents' context.

### Interaction Outcomes in State of Play

| Contribution Type | State of Play Section | Notes |
|-------------------|----------------------|-------|
| `query_response` (clarify) | Key Facts | Includes the target's answer |
| `query_response` (risks/assumptions/alternatives) | Open Questions | Unresolved angles, not findings |
| `query_response` (critique) | Disagreements & Concerns | Adversarial objection |
| `query_response` (perspective) | Open Questions | A position, not a finding; also updates target's stored reflection |
| `evidence_response` (tool-backed) | Key Facts | Includes source + strength metadata |
| `evidence_response` (no tool backing) | Open Questions | Claimed but ungrounded — needs verification |
| `vote_response` | (excluded) | Individual ballots — outcome via invoker prose |
| `summoned_response` | Key Facts | Guest expert perspective |

All response types flow into the weave and appear in later agents' recent contributions.

---

## 23. Dashboard System

`/loom_viz` starts a lightweight static web dashboard (default port 3210) that renders a live view of all meetings under `.opencode/loom/meetings/`.

### How It Works

- **Serving:** `startDashboard(directory, port)` serves an HTML shell (per-request `Content-Security-Policy: script-src 'nonce-<uuid>'`, inline theme script `nonce` via `getHtmlShell(nonce)`) + static assets (`/assets/*`, `isAssetPathSafe` fullwidth `%` NFC + `realpathSync` jail) and a JSON API (`SECURITY_HEADERS: nosniff/DENY`).
- **Data source:** `DashboardApi` opens each meeting SQLite DB **read-only**, with a `TUNING.MAX_DB_CACHE_SIZE` (10) LRU cache and TTL; connections are re-opened when the DB file's mtime changes (`DB_REFRESH_INTERVAL_MS` 500ms coalesced, `refreshIfStale()`), so it reads fresh state without live coupling.
- **Real-time updates:** the server holds SSE clients per meeting (`/api/stream`) and **polls** the DB every 1s (active) or `DASHBOARD_IDLE_TIMEOUT_MS/12` ≈5s idle (adaptive `ACTIVE_POLL_INTERVAL`/`IDLE_POLL_INTERVAL` + `maxClientsForAnyMeeting>3` throttle). Per-meeting `lastMtime` gate skips all 8 queries when `currentMtime===prevMtime`; `broadcast()` uses a 100-event `pendingQueues` backpressure buffer (drains on `desiredSize>0`, drops after 100; `SLOW_CONSUMER_TIMEOUT 30s`). `exportMarkdownStream` is `pull()`-based (not `start` drop). Events: `state`, `contributions` (`prompt_context:null` stripped in SSE, parity with REST `include_context=0`), `orchestrator_messages`, `participants`, `agent_error`, `artifact`. Terminal-state and artifact deduped via single `lastArtifactCreatedAt`/`stateStr` cache (not double-emit).
- **Meeting selection:** `/api/meetings` lists every `meetings/*.db` with question, status, round, convergence, created_at, participant count (sorted newest first). The UI auto-switches to the most recent.

### UI Tabs

- **Overview** — participants (cards with status/category/model/reflection, contribution counts), recent contributions, errors, an agent-perspective panel, and the final artifact when present.
- **Timeline** — per-round contribution timeline, orchestrator decision log (turn-order plans, summaries) interleaved per round, participation matrix, contribution-type chart, and inline reflection/query/evidence/summon/vote rows.
- **Output** — the final artifact with structured fields; export actions.

### Key API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/meetings` | List meetings |
| `GET /api/meeting?meeting=ID[&limit&offset]` | Full meeting payload (state, participants, contributions w/ pagination, orchestrator messages, errors, artifact, embedding model metadata) |
| `GET /api/stream?meeting=ID` | SSE live updates |
| `GET /api/state`, `/api/state_stats` | Meeting state (with live flags) |
| `GET /api/contributions?meeting=ID[&since&limit&offset]` | Contributions, optionally incremental |
| `GET /api/orchestrator_messages?meeting=ID` | Orchestrator log |
| `GET /api/agent_errors`, `/api/participants` | Per-meeting data |
| `GET /api/contribution_context?meeting=ID&contribution_id=N` | Full prompt context behind a contribution |
| `GET /api/agent_contexts`, `/api/agent_context?meeting=ID&participant=P` | Agent-level prompt context |
| `GET /api/artifact?meeting=ID` | Final artifact |
| `GET /api/export?meeting=ID[&format=markdown|json]`, `/api/export/stream` | Downloadable exports |
| `GET /api/models`, `POST /api/models/select` | Downloaded embedding models + embedder status; switch active embedding model |
| `GET /api/metrics` | Global metrics snapshot (Section 25) |
| `GET /api/health` | Liveness |

### Dashboard Security

All `/api/*` routes are gated by a capability check (`src/dashboard/security.js`): loopback host allow-list, same-origin/`sec-fetch-site` validation, and a token presented via the `x-loom-dashboard-token` header or the `loom_dashboard_<port>` cookie (`HttpOnly; SameSite=Strict; Path=/`, set on the HTML shell). The token is **deterministic**: `SHA-256(ownerSessionId)` (`@noble/hashes/sha256`), falling back to `SHA-256(<loomBaseDir>:<port>)` for standalone dashboards with no owning session. Deriving the token instead of generating a random one per process means a server restart (plugin reload, `/loom_stop` → `/loom_viz`) never invalidates the browser's cookie — previously every start rotated the token and all API calls 401'd ("dashboard authentication required") until a manual refresh. As a safety net, the client (`src/dashboard/auth.js`) reloads the page once per 30s when any API call returns 401, which re-fetches the current cookie; a timestamp guard in `sessionStorage` prevents reload loops when auth genuinely fails.

### Embedding Model Panel

On dashboard start, the embedding model is initialized eagerly (status tracked: idle → initializing → ready/error). `/api/models` lists downloaded models and the current status; `POST /api/models/select` hot-swaps the active embedder.

---

## 24. Meeting Lifecycle: From Setup Tab to Report File

### The Setup Tab (sole control plane)

Deliberations are created exclusively from the dashboard Setup tab. The plugin exposes only `/loom_viz` (start server) and `/loom_stop`. The Setup flow is:

1. **Question** — user enters `question` (required, ≥3 chars), optional `context`, `max_rounds` (default from config: 4).
2. **Models** — the user toggles the enable/disable filter (`POST /api/llm-models/filter`). At least one model must be enabled before personas can be added. No per-category pickers here — models are chosen per persona seat in step 3.
3. **Personas** — the user auto-selects or adds seats manually from the catalog (`GET /api/personas`). Adding a seat is the approval; at least 2 seats required. Auto-select calls `POST /api/room/preview`, which ranks the whole catalog via the same `rankAllPersonas` path as a real run — persona vectors are process-scoped, so no throwaway database is involved. It returns `{ ranked, selected, auto_select_count }` plus flat random `suggested_models` (parallel to the selected seats), which pre-fill each seat's model picker. The dialog opens on the returned ranking with the top 3 selected; seats are written only on confirm. With no embedder the endpoint returns **503 `embedder_unavailable`** and the Setup tab shows no auto-select button, leaving manual selection as the only route.
4. **Per-seat models** — every persona row carries its own model picker (defaults from the random suggestion, changeable to any enabled model). Disabling a model prunes it from seats holding it, blocking start until re-picked.
5. **Start** — `POST /api/meetings/start` with `{ question, context, max_rounds, participants: [{ …, model: { provider_id, model_id } }], approved: true }` (explicit `approved: true` enforced server-side, HTTP 400 otherwise). Per-seat `model` values validated against the filtered pool (disabled/unhealthy/unknown fall back to random assignment). Hard deadline disabled — stall watchdog and provider errors are the only extrinsic stops.

**Stored-run view:** when the selected meeting has persisted participants, the Setup form mirrors its stored configuration (question, context, rounds, seats with per-seat models, feature toggles, orchestrator config) and every input is disabled — the meeting already ran, so the form is a read-only record. The "Extend current deliberation" card below it remains the way to continue the meeting.

### Control-Plane Flow (`src/dashboard/server/control.js`)

1. Reject with 409 if a deliberation is already running (single-run lock); reject with 503 if the plugin runtime (opencode client) isn't injected.
2. Validate `question`/`participants` (at least 2 seats, no maximum; required `name`/`persona`/`agenda`/`category`, any category slug accepted) and clamp `max_rounds` to 1–999.
3. Discover models + session model; apply the dashboard model filter (Section 26) plus the global-unhealthy set to the pool.
4. Ignore legacy per-tier `models` selections (warn), then `assignModelsToParticipants()` fills seats without a valid per-seat model at random.
5. Create the meeting DB, `initializeMeeting()` (with the launcher session as `parentSessionId`/`opencodeSessionId`), `insertParticipants()`.
6. Construct `MeetingOrchestrator` (passing the filtered `availableModels` for fallback selection) with dashboard callbacks (no-ops — progress is SSE/DB only), register it in shared `activeLooms`, and run `initialize()` + `runMeeting()` on a **detached promise** — HTTP returns `{ meeting_id }` with 202 immediately.
7. On completion write the full report to `.opencode/loom/meetings/<meetingId>.md`. Nothing is ever returned to chat.

### Progress Callbacks

Dashboard-first, callbacks are intentionally silent toward chat:
- `onContribution` / `onRoundComplete` / `onSynthesisStart` / `onSynthesisComplete` — no-ops (progress is visible via SSE/poll + Timeline tab)
- `onUpdate` — debug state logging only

### Companion Tools & Endpoints

- `loom_status` — check a running Loom (status, round, contributions, meeting ID)
- `loom_cancel` — request cancellation (current round completes, then synthesis runs)
- `loom_debug` — dump internal state of a running Loom (optional `include` filter)
- `loom_viz` / `loom_stop` — start/stop the dashboard (the only user commands)
- `GET /api/llm-models` — discover available models with cost/context/reasoning, enabled/unhealthy status, and a random suggested model. `POST /api/llm-models/filter` (`enable`/`disable`/`reset`) — manage the **dashboard-global model filter** (persisted as `models-filter.json`). The filter restricts which discovered models Loom agents may use. (See Section 26.)
- `GET /api/personas`, `POST /api/room/preview`, `POST /api/meetings/start|-cancel|extend`, `GET /api/jobs` — the Setup control plane.

### Session Index & Cleanup

- `loadSessionIndex()` reads `session-index.json` under the loom base dir, mapping opencode session IDs → `{ meetingId, dbPath }` entries (used by `findMeetingBySessionId` and tool resolution).
- `indexMeeting()` registers a meeting for its session; `getDatabasesBySessionId()` lists them.
- On `session.deleted` events, the plugin deletes the meeting DB files for that session.
- On process exit / SIGINT / SIGTERM / uncaughtException / unhandledRejection, all active looms are marked `aborted`.

### Storage Layout

```
<directory>/.opencode/loom/            (or ~/.config/opencode/loom when no directory)
  ├── meetings/<meetingId>.db          // one SQLite DB per meeting
  ├── meetings/<meetingId>.md          // persisted full report
  ├── session-index.json               // opencode session → meeting mapping
  ├── models/<name>/model.json         // downloaded embedding models
  ├── deps/node_modules/               // onnxruntime / tokenizers externals
  └── personas/<category>/*.json      // user-authored personas (optional)
```

---

## 25. Metrics and Observability

### In-Memory Metrics (`metrics.js`)

A simple process-wide collector exposed via `/api/metrics` and `getMetricsSnapshot()` (circular `latencyBuffers` `TUNING.LATENCY_SAMPLE_LIMIT` 100, O(1) `recordLatency`):

- **Counter** — `llm_calls_by_type` (agent/agent_synthesis/patch_tail/turn_order/summary/synthesis), `retry_events` (`attempted`/`retry_success`/`exhausted` via `withRetry`), `breaker_events` (`open`/`half_open`/`closed`), `degradation_events`, `meeting_degraded_reasons`.
- **Latencies** — `llm_prompt_ms`, `llm_synthesis_ms`, `llm_patch_tail_ms`, `turn_order_ms`, `summary_ms`, `synthesis_ms`, `round_span_ms` (last `LATENCY_SAMPLE_LIMIT` samples; aggregated into count/avg/p50/p95/max via `latencyStats`).
- **Per-meeting breakdown** — `recordMeetingCall`/`recordMeetingLatency` attribute each LLM call to its meeting at the call site (`getMeetingBreakdown` → `{calls, latencies}` with count/avg/max); process-global buckets mix meetings and cannot answer per-meeting questions. `GET /api/metrics?meeting=<id>` serves the live breakdown; the finished row persists `call_breakdown`/`latency_breakdown` inside `meeting_metrics.counters` (no schema change). Breakdowns are latency telemetry (rate-limit signal), never cost/token reporting.

RoundExecution records per-call tokens and `llm_prompt_ms` per agent call; synthesis records its own bucket. `getMetricsSnapshot()` is polled by dashboard `GET /api/metrics` and persisted per-meeting via `meeting_metrics` at synthesis.

### Per-Meeting Metrics

On meeting end the orchestrator persists `meeting_metrics` via `saveMeetingMetrics`: counters (LLM calls by type, token counts), duration_ms, rounds, contributions. The dashboard can render these alongside the meeting.

`meeting_metrics.counters.quality` is the per-meeting health block, and the rule it follows is that **liveness is not health** (N6). A run in which a third of state writes were refused used to present as `agent_errors: 0` with 100% of `tool_audit` rows `completed`, because refusals existed only in an agent's prose. It now carries:

| Field | Meaning |
|---|---|
| `contributions_by_type` | raw mix |
| `unresolved_objections` / `total_objections` | the objection inventory |
| `input_tokens` / `output_tokens` / `total_tokens` / `latencies` | real cost accounting |
| `cost_unmeasurable` | every cost counter is zero — never grade on empty telemetry |
| `meeting_degraded_reasons` | **named** reasons this meeting ran degraded: `state_patch_rejected`, `final_round_below_floor`, `final_round_patch_grace_failed`, `cost_unmeasurable`. Recorded at the point of refusal via `recordMeetingDegradedReason` (`tool_call_limit_reached` is retained only as a legacy value — no tool-call cap is enforced) |
| `tool_calls.max_in_a_turn` / `tool_calls.cap_per_turn` | tool-call volume is unlimited; the per-turn high-water mark is reported with `cap_per_turn: null` |
| `round_budget` | `{ final_span_ms, median_span_ms, ratio, below_floor }` — the closing round measured against the median of the others (N9) |
| `final_patch_grace` | `{ attempted, patched, failed }` — the closing round's guaranteed patch opportunity |
| `mechanism_mix` | argument-shaped vs decision-shaped contributions per round, plus the objection inventory for each round (N12). **Visibility, not a rule**: ballots rose 2 → 16 while unresolved objections fell 15 → 3 in one meeting, and whether that is a good trade is not decidable from a single meeting. The earlier proposal to cap ballot share was withdrawn — it would have punished a legitimate mechanism choice and suppressed the definition-freeze and denominator decisions that meeting's reasoning rests on |

Refusals are also written to `tool_audit` with a status that is not `completed` (`loomToolRefusal`), so the audit table stops reading 100% success.

### Logging

Structured JSON logs via `Logger` (circular `ringBuffer` `TUNING.RING_BUFFER_SIZE` 500 O(1) `ringBuffer[head]` + `orderedRing()`, `getRecentLogs` via `orderedRing()`; `getRingSize()` reads `TUNING` live) with recursive `SECRET_KEY_RE` redaction (`authorization|api_key|bearer|token|password|secret|privateKey|credentials` deep walk, `Bearer [REDACTED]`). Contexts: `meeting_id` (short form + `fullMeetingId`), `correlationId`, event name, and fields. Error paths are captured per participant in `agent_errors` and globally in `error_log`. Model-fallback events are observable as `model_fallback`/`model_fallback_failed` log events, an `agent_errors` row with type `model_fallback`, and a `⚠️ … falling back …` progress message.

---

## 26. Model Configuration

A recap of every knob that controls which LLM runs an agent or the orchestrator. Model configuration spans four layers:

### 1. Model Discovery & the Model Filter

`discoverModels()` (`src/services/model-service.js`) reads the connected providers via `client.provider.providers` and records the user session's current model as `sessionModel`. Deprecated models are excluded.

A **dashboard-global deny-list model filter** (persisted as `models-filter.json` under `resolveLoomBaseDir(directory)`) is maintained from the Setup tab:
- `GET /api/llm-models` — lists all discovered models with `provider/model` identifiers, cost, context window, reasoning capability, enabled/unhealthy status, plus a random suggested model (filtered preview — disabled models never proposed).
- `POST /api/llm-models/filter` with `action: enable|disable` + `models: [<id>…]` — restrict which discovered models Loom agents may use (`applyModelFilter` deny-list). Default (no filter) = all models; new models are enabled by default; disabling the last model leaves one enabled and reports it as `guard_kept`. Enabling a model also clears its global-unhealthy mark.
- `action: reset` — clears the filter back to "all models" and clears all global-unhealthy marks.

The filter is applied to the discovery result before assignment and to the `availableModels` list passed to the orchestrator for fallback selection. Legacy per-tier `models=[…]` selections from Setup are ignored with a warning — only per-seat `model` values apply.

### 2. Tier-Based Assignment

`assignModelsToParticipants()` → `assignModelsByTier()` is the single deterministic assignment engine (shared with the Setup tab suggestion preview so both always agree):

- Models are sorted by a capability score (`scoreModel`: active status + context window + reasoning capability; cost is display-only).
- Principal/senior roles receive the session model (or the best available); mid/junior get the next-best unused models.
- **No model diversity flag**: random per-seat assignment already spreads seats across the pool; categories never influence the draw.
- The pool itself can be pre-narrowed by the model filter (layer 1).

### 3. Per-Participant Overrides

Explicit configuration always wins over automatic assignment:

- **Setup `models=[…]`** — legacy per-tier selection, ignored with a warning (per-seat `model` is the only selection).
- **Custom rooms** — participants may carry a `model` object `{ providerID, modelID }` or a `model_override` string `"provider/model"` (`buildOverrideMap`). Overridden models are also excluded from the diversity pool so they aren't double-assigned.

### 4. Orchestrator & Fallback Model Safeguards

- **Fast-path routing** (`fastPathModel`): cheap models for moderation/summary orchestrator calls, including the summary call that carries the turn-order override (Section 21).
- **Model fallback** (`modelFallback.*`): a failed agent turn is retried on its model, then on a healthy fallback selected by `selectFallbackModel()` (Section 16).
- `getDefaultModel()` acts as a safety net: `#getParticipantModel(participant, fallbackOnError)` substitutes the highest-quality healthy model whenever a participant's own model is missing or unhealthy (used by directives, votes, and synthesis).

The appendix table lists every model-related configuration key (`fastPathModel`, `circuitBreaker.*`, `modelFallback.*`).

---

## Appendix: Key Configuration Values

Loaded from `.loomrc.json` (project or `<opencode-config-dir>/.loomrc.json`), or the legacy `opencode.json` `"loom"` key. Validated and merged over defaults; unknown keys warn and are ignored. `OPENCODE_CONFIG_DIR` selects the shared Loom data root when no workspace is supplied. `DEFAULT_CONFIG.tuning` is `JSON.parse(JSON.stringify(TUNING))` deep-clone (not ref) — per-meeting `createMeetingConfig()` deep-freezes.

`TUNING` (current constants, `src/config/defaults.js:1`): `MAX_ITERATIONS 100` (weaving loop guard), `WATCHDOG_TICK_MS 30000`, `RING_BUFFER_SIZE 500`, `SKIP_PASSED_*` (3,10,2), `EXTENSION_EXTRA_ROUNDS_FALLBACK 4`, `MAX_CRITIQUE_RETRIES 3`, `SYSTEM_PROMPT_CACHE_MAX 50`, `EMBEDDING_CACHE_MAX 512`, `LATENCY_SAMPLE_LIMIT 100`, `DASHBOARD_IDLE_TIMEOUT_MS 60000`, `MAX_DB_CACHE_SIZE 10`, `VOTE_TIMEOUT_MS 180000`/`SUMMON_TIMEOUT_MS 300000`/`FINAL_ROUND_PATCH_GRACE_MS 180000` (N9 — one bounded, patch-only turn for each participant that did not patch in the closing round; `0` disables), `PATCH_TAIL_TIMEOUT_MS 180000`, `PROMPT_LIVENESS_TICK_MS 30000`/`PROMPT_LIVENESS_MAX_MULTIPLE 3` (sliding-deadline liveness: heartbeat touch + deadline deferral on visible progress), and bounded state/transcript budgets. There is no fabric-RAG tuning or vector search tool in the current agent context path.

DB fresh `meetings`/`participants` enforce `CHECK` + `UNIQUE` + `FK` at `initSchema()`; ordered migrations bring existing databases to the current schema version (13). (Pre-existing DBs may still contain the removed `persona_embeddings`/vec tables; nothing reads them.)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `agentTimeoutMs` | 1,200,000 | Per-agent LLM call budget (20min; sliding deadline defers on visible progress up to 3× — no failure-based reduction) |
| `synthesisTimeoutMs` | 900,000 | Synthesis draft/critique call timeout (15min, heartbeat-kept) |
| `defaultMaxRounds` | 4 | Default meeting rounds |
| `minRounds` | 2 | Minimum rounds before the meeting can end (agents may still pass earlier — the tool accepts; all-passed before this re-opens deliberation instead of terminating) |
| `fastPathModel` | `""` | Model for cheap orchestrator calls (empty = disabled) |
| `maxRetryAttempts` | 2 | Retries for session creation / orchestrator prompts |
| `retryBaseDelayMs` | 1,000 | Base retry delay |
| `retryMaxDelayMs` | 8,000 | Max retry delay |
| `synthesisMaxRetries` | 1 | Draft section-repair retries |
| `stallTimeoutMs` | 1,800,000 | Inactivity stall timeout — must exceed agentTimeoutMs; pending-LLM heartbeats touch every 30s (watchdog ticks every 30s) |
| `modelDiversity` | `true` | Give each agent a distinct model when enough are available |
| `agentTools.maxToolOutputTokens` | `12,000` | Warning threshold for stored tool-output volume; synthesis context remains bounded |
| per-model input ceiling | model's `limit.context` | No meeting-wide token budget exists. Each call is sized against the window of the model it uses (32k–1M) via `utils/context-budget.js`; over-budget prompts are trimmed by block priority, then by a funnel backstop |
| `circuitBreaker.failureThreshold` | `3` | Consecutive failures before a model is marked unhealthy |
| `circuitBreaker.resetTimeoutMs` | 300,000 | Half-open test window for an unhealthy model |
| `modelFallback.enabled` | `true` | Master switch for agent-turn retries + fallback model selection (Section 16) |
| `modelFallback.maxRetriesPerModel` | `2` | Retries on the same model before falling back |
| `modelFallback.maxFallbackAttempts` | `1` | Retries on the selected fallback model |
| `agentTools.sameTurnSynthesis` | `true` | Peer responses returned inline for same-turn synthesis (Section 22) |
| `agentTools.*` | (see Section 20) | Tool enablement — built-in tools + loom plugin tools (query/vote/summon/pass/state_patch) |
| `agentTools.builtIn.bash.enabled` | `false` | Bash is disabled unless explicitly enabled with a safe allowlist |
| `detectors.needsVerification` | `false` | Ship the `## Needs Verification` section in the artifact. Off by default (N3): a detector that cannot state its precision is advisory, and this one was ~40% precise |
| `detectors.citationWarnings` | `false` | Ship the `## Citation Warnings` section. Same gate |
| `detectors.dryRun` | `true` | Count candidates without writing them. Candidate counts always travel in `artifact.detector_report`, so a hand audit can measure precision before either flag is enabled |
| `detectors.dryRunMeetings` | `2` | Meetings to dry-run before enabling a flag |
| `detectors.precisionFloor` | `0.9` | Measured precision a detector must clear on a hand-audited sample before it graduates from advisory to authoritative |
| `detectors.minCitationTargetChars` | `400` | Citation targets shorter than this are exempt — keyword overlap cannot check a 57-character ballot |
| `composition.autoSelectSeats` | `3` | How many of the ranked personas are pre-selected when the auto-select dialog opens. Presentation only — it does not influence which personas rank highly, and the user can change the selection freely |
| `DEFAULT_EMBEDDING_MODEL` | `"Snowflake/snowflake-arctic-embed-xs"` | Default embedder for persona selection (warmed up on dashboard start) |
| `DEFAULT_EMBEDDING_QUANT` | `"onnx/model_int8.onnx"` | ONNX quantization variant used by the embedder |
---

## 27. What Code May and May Not Interpret

Every subsystem here parses text the models wrote. That is unavoidable — but it is
not all the same activity, and conflating the kinds is how a machine-made guess
ends up presented as a record.

### Three kinds, only one of which is a defect

| Kind | What it is | Examples | Verdict |
|------|------------|----------|---------|
| **Rendering** | The artifact is a markdown document for humans; its headings *are* its structure. Reading them back is formatting, not interpretation. | `extractSection(text, "Decision")` → the `decisions` column; `normalizePipeTables` | **Keep.** Deleting these would be the vote-tally lesson misapplied — the fix there was a *lossy second source of truth*, not a contract. |
| **Integrity** | Facts about stored data, not about meaning. | does `[#12]` resolve to a real row; is a state patch schema-valid; is a turn under the length cap | **Keep.** Correct in code, and cheap to verify. |
| **Semantic judgement** | Code deciding what an agent *meant*. | "this is a retraction"; "this turn established a decision"; "this objection is answered"; "this fact is grounded" | **This is the vote-tally class.** |

### The rule

> Code may not make a semantic claim about an agent's prose that a human cannot
> see, audit, and override.

Concretely: if a regex or a heuristic would decide *what the room believes*, or
*what an agent claimed*, and the answer reaches an agent prompt, a DB column, or
the deliverable, it is doing the model's job. The agent's own words are the
source of truth. If a structured channel already exists for the declaration
(`loom_state_patch` buckets, tool calls, contribution types), code reads that
channel and nothing else.

### Deleted under this rule

- **Vote tallying** — a regex counted ballots and dropped 44% of them, reporting
  `Total voters: 0` while presenting the count as fact. `utils/vote-tally.js`
  removed; the invoker's model is the declared interpreter and ballots are stored
  and returned verbatim.
- **`classifyByKeywords`** — decided which state-of-play bucket a turn's prose
  belonged in from `we should` / `agree` / `disagree` / a trailing `?`, and its
  output was the room's primary shared context. Removed. Untyped primary turns
  file nothing; `loom_state_patch` is the declaration channel.
- **Retraction detection** — 11 English-phrase regexes decided that a claim was
  withdrawn, then value+unit string matching tainted every downstream number,
  and the artifact was mutated with `⚠ retracted …` markers. Removed entirely,
  including the `retractions` / `retracted_figures` artifact fields and the
  retraction-lookup falsifier in the reconciliation pass.

`test/no-prose-interpreters.test.js` greps `src/` for the deleted symbols and for
the detector's own phrase vocabulary, so none of it can come back unnoticed.

### Still on the list, deliberately not yet removed

These remain load-bearing and are tracked rather than silently tolerated:

| Site | What it guesses |
|---|---|
| `state-patch.js` `isPinned` | that a `facts_add` bullet is grounded because its text contains `Source:` or `[#id]` — and, when it is not, it **silently** re-routes the fact to `open (unverified)` |
| `utils/text.js` `extractFileBlockTools` | that a ```` ```file=…``` ```` fence in prose was a real file write, fabricating a `write` tool call that then satisfies `deriveConfidence`'s grounding test and `hasToolBacking` — code inventing evidence and then rewarding it |
| `round-summarizer.js` `strength:` | that a contribution's evidence is strong/weak/inconclusive from a prose keyword — and orders the clerk's input budget by it |
| `objection-collector.js` | that an objection is stale from keyword overlap; the verdict feeds `deriveConfidence`'s `dissentCount` gate |
| `execute-turn.js` | that a second-pass synthesis is substantive from a 200-character count, overriding the first pass |
| `state-of-play.js` `hasFileMention` | that a bare `layout.tsx` mention in prose is a file the room touched |
| `persona-proposals.js` `extractBalancedJsonArray` | a structural scrape, but of the proposal call's own JSON array — never of deliberation prose |

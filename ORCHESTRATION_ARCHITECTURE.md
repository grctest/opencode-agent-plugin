# The Loom Orchestration Architecture

**Schema version:** `PRAGMA user_version = 2` (`LATEST_SCHEMA_VERSION` in `src/database/schema.js:10`) — `meetings.status ∈ {initializing,weaving,converged,timeout,cancelled,aborted,max_rounds_reached}` — fresh DBs enforce `CHECK(status IN …)` + `CHECK(tier IN …)` + `UNIQUE(meeting_id,chunk_index)` + FKs; no migration path (fresh-slate install, session wipe on delete). Last verified against `package@0.1.0` + DB `user_version 2`.

A complete technical reference for how the Loom multi-agent deliberation system works, from user input to final output. Every LLM prompt, every data structure, every decision point. Written for someone who cannot read the source code.

### ID Glossary (naming debt §10)

| ID | Meaning | Source |
|---|---|---|
| `meetingId` / `loomId` | DB primary key for a deliberation (`meetings.id`, UUID) | `paths.js:getMeetingDbPath`, `src/handlers/knit-handler.js` |
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
18. [Extension and Resume](#18-extension-and-resume)
19. [Vector Index, RAG, and PersonaIndex](#19-vector-index-rag-and-personaindex)
20. [Agent-Requested Tools](#20-agent-requested-tools)
21. [Fast-Path Model Routing](#21-fast-path-model-routing)
22. [Inline Peer Interactions: Query, Vote, Summon, Turn Requests](#22-inline-peer-interactions-query-vote-summon-turn-requests)
23. [Dashboard System](#23-dashboard-system)
24. [Meeting Lifecycle: From /knit to Report File](#24-meeting-lifecycle-from-knit-to-report-file)
25. [Metrics and Observability](#25-metrics-and-observability)
26. [Model Configuration](#26-model-configuration)

---

## 1. End-to-End Flow Summary

When a user types `/knit` with a question, this is what happens:

1. **Room composition** — The question is analyzed for complexity, then a team of 2–7 agents is assembled without any LLM call: each per-tier role is filled by the persona (from `personas/<tier>/*.json`) whose embedded description is most semantically similar to the question (via `PersonaIndex`). Each agent gets a name, persona description, agenda, tier, and topic tags.
2. **Model assignment** — Each agent is assigned an LLM model. Principal/senior tiers get the top available model (the session's model when present); remaining tiers get the next-best unused models. Explicit per-participant `model`/`model_override` fields win over automatic assignment. The discovery pool can be narrowed with a per-session model filter (`/enable_knit_models` / `/disable_knit_models`, Section 26).
3. **Rounds execute** — A round is a single sequential prompt phase:
   - Each agent speaks in turn via a **round-scoped ephemeral session** (one session per participant per round), seeing the state of play, vector-RAG context, and recent contributions.
   - Agents write **untyped prose** — there are no `[PROPOSE]`/`[CHALLENGE]` type tags anymore; following agents interpret content directly. Agents call `loom_pass` when they have nothing new to contribute.
   - During their turn agents can invoke **loom_\* interaction tools** (`loom_query`, `loom_vote`, `loom_summon`, `loom_request_next`, `loom_pass`) alongside research tools. These are plugin-registered tools that execute server-side during `session.prompt`: peer answers, ballots, and tallies are returned **inline in the same turn** and folded back into the speaker's final contribution via an optional same-turn synthesis pass (Section 22).
4. **Round summarization** — After all agents speak, an LLM clerk summary is generated every round (Established / Contested / Evidence / Open bullets), degrading to a deterministic digest when the LLM returns empty (Section 13).
5. **State of play update** — The state of play (decisions, agreements, disagreements, open questions, key facts, files involved) is regenerated from the full weave.
6. **Turn order planning** — `planTurnOrder()` produces the next round's ordered participant list from `loom_request_next` requests (Section 9).
7. **Termination** — Deterministic: (a) all participants have called `loom_pass` or failed, (b) the round limit reached, or (c) hard timeout/stall/token budget fires. The wall-clock hard timeout is disabled by default (`defaultMeetingTimeoutMs: 0` = no limit); stall watchdog (inactivity), token budget exhaustion, and user cancellation still terminate the meeting.
8. **Synthesis** — One agent (typically the principal) synthesizes all contributions into a structured artifact with Decision, Reasoning, Action Items, Dissenting Views, Open Questions, and Confidence, then self-critiques it.
9. **Output** — A concise chat summary plus a full markdown report saved to `.opencode/loom/meetings/<meetingId>.md`. The live dashboard can be started with `/loom_viz`.

---

## 2. Meeting Creation

### Step 1: Complexity Analysis

`composeRoomWithSimilarity(question, db)` scores the question:

- **Word count:** >30 words → +2, >15 words → +1
- **Question marks:** more than one `?` → +1
- **Multiple dimensions:** presence of and/or/vs/compare/tradeoff/pros-cons → +2
- **Conditionals:** if/when/assuming/given that/depending on/considering → +1
- **Stakeholders:** team/customer/user/client/stakeholder/executive/leadership → +1

Score → complexity: **high** (≥5), **medium** (≥3), **low** (<3).

The team size is derived from complexity (high=5, medium=4, low=3), clamped to 2–7. Role lists are generated by size:

```
count ≤ 3:  [mid, civilian, junior]
count ≤ 5:  [senior, mid, civilian, junior, junior]
else:       [senior, mid, mid, civilian, junior, junior, junior]
```

Then a seniority boost is applied: `high` shifts every tier up one level, `low` shifts everyone down one level (e.g. high → `[principal, senior, mid, civilian, junior, junior, junior]` (civilian immune to boost)).

Composition is deterministic content-similarity; no `seed` parameter exists — rooms are reproducible given the same question and persona index.

### Step 2: Similarity-Based Persona Selection

There is **no LLM domain detection** — the now-removed `domain` pipeline was replaced by embedding-based selection.

1. All personas are loaded from JSON files (`personas/<tier>/*.json`, or legacy `<tier>.json` arrays) and embedded into the meeting database via `PersonaIndex.indexAll()` (tables `persona_embeddings` + `vec_persona_embeddings_${dim}`, FK to `meetings(id)`, `CHECK(tier IN …)` + `UNIQUE(meeting_id,name)`).
2. For each role tier in the role list, `PersonaIndex.search(question, tier, 5)` returns the 5 most similar personas for that tier (vector `vec_persona_embeddings_${dim} MATCH` filtered by tier, with fallback keyword scoring when vector unavailable); the first persona not already used is selected. Cache key is `model|quant|persona|tier|dim|fingerprint` (model-aware, `TUNING.EMBEDDING_CACHE_MAX` LRU).
3. Selection is deterministic given the same question and persona index.
4. Meeting-level `tags` are derived from the selected participants' most common tags (top 3).
5. Estimated rounds: `base` high=4/medium=3/low=2 clamped to `±1` around `getConfig().defaultMaxRounds` (default 3) — `estimated = clamp(base, cfg-1, cfg+1)` (fresh DB: `participants.tags`/`expertise` persisted).

If the embedding service is unavailable, composition falls back to keyword-based `composeRoomByKeyword` (token overlap + `maxCosineDistance` relevance floor `minScore = max(1, floor(2*(1-maxDistance+0.15)))`), not an empty room; civilian generalist fills gaps.

**Custom rooms:** Passing `participants` to `/knit` skips composition entirely. Each participant requires `name`, `persona`, `agenda`, `tier` (an `id` is derived; `tags`/`expertise` default to `["general"]`).

**Prioritization for a meeting row:** the meeting row is inserted into the database *before* composition so the FK constraint on `persona_embeddings(meeting_id)` is satisfied.

### Persona Loading

Personas live under `<plugin>/personas/<tier>/*.json` (tier directories), with fallback to legacy `<tier>.json` arrays. User-authored personas in `~/.config/opencode/loom/personas/<tier>/` are merged in (user personas take precedence, loaded after the bundled ones; duplicates by name are dropped). Persona files are cached for 60 seconds. Each persona is validated: `name` present, `persona` >50 chars, `agenda` >20 chars, and `tags` present (legacy `domain`/`domains` fields are normalized to `tags`). Each persona has `name`, `persona` (description), `agenda`, `tags`, optional `expertise`, `known_biases`, `communication_style`, `preferred_contribution_types`, `anti_patterns`, `tier_guidance`, and `reflection_guidance`.

### Step 3: Model Assignment

Models are discovered from the connected providers via `discoverModels()` (`provider.providers` API), with the user session's current model recorded as `sessionModel`. The discovery result may be narrowed by the model filter (`/enable_knit_models` / `/disable_knit_models`, Section 26). If a session model can't be discovered the discovery result is empty (agents just carry their session model).

`assignModelsToParticipants()` uses `assignModelsByTier()` (a single deterministic engine shared with the `list_knit_models` preview so the two always agree):

- Models are sorted by capability score (active + context window + reasoning capability; cost is display-only).
- **Principal and senior** roles get the top model — the session model if present, else the best available.
- **Mid and junior** roles get the next-best unused models.
- Per-participant overrides (`model` object or `model_override` string) always win.
- **Model diversity** (`modelDiversity`, default true): when more distinct models are available than tiers, each *individual* agent gets a unique model (best models to the highest tiers), so participants don't all use the same LLM.

### Step 4: Session Creation

**No persistent agent sessions are created.** All agent and orchestrator LLM calls use fresh ephemeral sessions (Section 7). The synthesis phase is the sole exception — it uses one long-lived session for the draft + critique passes.

---

## 3. Agent Architecture

### The Tier System

Four tiers determine agent behavior, authority, and LLM parameters:

| Tier | Temperature | `loom_request_next` Priority Cap | Rights |
|------|------------|-------------------------------|--------|
| junior | 0.7 | 5 | contribute, request_turn |
| mid | 0.5 | 7 | contribute, request_turn, call_vote |
| senior | 0.3 | 9 | contribute, request_turn, call_vote |
| principal | 0.2 | 10 | contribute, request_turn, call_vote |

`civilian` shares mid temperature/cap/rights via `utils/tier.js`. The rights flags are vestigial metadata — actual tool availability is governed by the `agentTools` config (Section 20), not tier rights.

**Behavioral guidance is defined in each persona's `tier_guidance` field** (the old static `getPromptForTier` tier strings still exist but are deprecated fallbacks). Each persona file is self-contained and user-editable:

```json
{
  "name": "Security Engineer",
  "persona": "You assume breach...",
  "agenda": "Identify security implications...",
  "tags": ["engineering", "security"],
  "expertise": ["threat modeling", "authentication"],
  "tier_guidance": "Prioritize accuracy and risk assessment. Cite patterns from experience. Be conservative with claims but commit fully when you do. Flag irreversible decisions.",
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
  "tier_guidance": "Prioritize accuracy and risk assessment...",
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
    tier: "senior",
    tags: ["engineering", "security"],
    expertise: ["authentication", "encryption", "threat modeling"],
    known_biases: ["Over-indexes on security at the expense of UX"],
    communication_style: "Technical and precise",
    preferred_contribution_types: ["challenge", "refine"],
    anti_patterns: [...],
    tier_guidance: "...", reflection_guidance: "...",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" }
  },
  tier_config: { temperature: 0.3, rights: { contribute: true, request_turn: true, call_vote: true } },
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
You are **Security Engineer** (senior) — a deliberator in "Loom."

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

## Tier Doctrine
Senior doctrine: name the irreversible commitment and its mitigation/rollback...
<persona tier_guidance>

  ## OUTPUT CONTRACT — read this last, it governs your response

  1. Length: 120-180 words for prose; 150-350 for code diffs (``` file=src/... ``` blocks).
     One claim per sentence; preserve code and numbers verbatim.
  2. Grounding: engage prior work via [#id]; external facts add Source: https://… ;
     code references use file=src/path.ts:18; otherwise qualify as "in my experience…".
  3. Boundaries: never emit <<< or >>> delimiters; never invent tool output or unread files.
  4. Interaction — peer actions happen only through the real loom_* tools in your tool list:
        - loom_query queries peers via queries:[{target, question, mode}] — modes 'clarify'
          (factual), 'perspective' (their stance on your statement), 'evidence' (researched
          Finding+Source+Strength); loom_vote polls all peers on lettered options;
          loom_summon brings in a guest expert; loom_request_next requests speaking priority
          next round (priority capped at <tier cap>).
        - Interaction tools fan out to peers in parallel and return their answers inline within
          this same turn — wait for the result, then cite [#id] from the returned responses
          or tally in your final contribution.
        - Up to <maxToolCallsPerTurn> loom calls per turn; prefer one focused interaction call.
        - CRITICAL: tool invocations are transmitted through the model's function-calling
          channel, never through response prose. Any function-call notation in text executes
          nothing. Bracket tags like [QUERY: @id], [EVIDENCE: @id], [CALL_VOTE] are obsolete.
        Reference others by participant_id from Recent Contributions, e.g. [#12].
  5. Stay in character — persona and agenda shape framing, not facts.

## Research Tools — Tool Ladder (use at most one research tool per turn unless an
   evidence request demands more)

Available: websearch, webfetch, read, glob, grep, bash, loom_vector_search,
           loom_query, loom_vote, loom_summon, loom_request_next, loom_pass    (only enabled ones listed)

Ladder: loom_vector_search (recall what was said → cheapest) → websearch (verify current
        fact) → read/grep/glob (verify local file) → webfetch (deep dive ONLY after a search hit)

For code analysis in this folder: prioritize read/glob/grep first — file=src/... citations require a read.

Quality:
- One focused query beats three vague ones. Synthesize, don't dump.
- If a tool is rejected as invalid, retry with exact names above — don't silently fall back to memory.
- Cite as Source: https://… or vec: round#id or file=src/... when it strengthens your point.
```

Notes:

- The tool list is assembled from `agentTools` config: built-ins plus the loom tools (`loom_vector_search`, `loom_query`, `loom_vote`, `loom_summon`, `loom_request_next`, `loom_pass`). When agent tools are disabled, the entire tool section is omitted. System prompt cache `systemPromptCache` is `TUNING.SYSTEM_PROMPT_CACHE_MAX` 50 LRU via `getSystemPromptCacheMax()` and keyed by `hashConfig` which now includes `agentTools` digest (`enabled|loom|builtIn|maxCalls|sameTurn`) — changing `agentTools` busts cache.
- `known_biases`: when a persona has more than two biases, they are deterministically rotated based on the participant name hash, so different agents surface different biases first.
- There is no type-tag rule anywhere in the contract — agents write prose; calling `loom_pass` means pass.
- Transcript `Live` block budgets `code 320 / prose 220` via `truncateAtSentence` (sentence-boundary, not mid-word `slice`).

### The User Prompt (Weighted Golden Sandwich)

Each agent's user prompt is built by `buildAgentUserPrompt`. It follows a bounded, stateless pattern that carries all necessary context without accumulating history — with explicit epistemic weighting between sections. Concrete example for an agent in round 3:

```
## Question (canonical)
Should we migrate our authentication service to JWT tokens?

## Tags: engineering, security

## Round 3

<<<LOOM_USER_CONTEXT>>>_BEGIN_
We're a 50-person startup...            (only present when /knit context was provided)
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

## Recall — Vector-Retrieved Prior Context (may be stale — verify before citing)

<<<LOOM_RELEVANT_PRIOR_CONTEXT>>>_BEGIN_
[Round 1] The team agreed on phased migration but split on refresh token storage
<<<LOOM_RELEVANT_PRIOR_CONTEXT>>>_END_

## Live — Recent Contributions

<<<LOOM_CONTRIBUTIONS>>>_BEGIN_
- [#4] [senior_architect]: Hybrid approach — short-lived JWTs plus server-side refresh rotation...
- [#5] [mid_security_engineer]: Server-side refresh tokens are just session tokens with extra steps...
<<<LOOM_CONTRIBUTIONS>>>_END_

## Your Turn — Weighted Guidance

- **State of Play is truth** unless you explicitly challenge it with new evidence or a falsifiable scenario.
- **Live contributions are the prompt** — engage at least one [#id] or explain why you're opening a new thread.
- **Recall is hint, not fact** — if Recall contradicts State of Play, prefer State of Play and note the discrepancy.
- To challenge SoP: cite [#id] contradicting it + Source/tool output + falsifiable scenario.

Rules:
- 120-180 words for prose (code diffs excepted); never emit <<< >>> delimiters
- Cite [#id] when referencing prior work; introduce facts with Source/file= or qualify as experience
- Preserve code and numbers verbatim — do not round or invent

Make your contribution or pass.
```

Note the structure:

- **Question (canonical)** + tags + round number lead the prompt.
- **State of Play**: structured summary of decisions, agreements, disagreements, open questions, key facts (and files involved), derived from ALL prior contributions — explicitly labeled CANONICAL (Section 11).
- **Recall**: semantically retrieved prior context via the vector index — explicitly labeled as a hint, excluding the current round.
- **Live contributions**: the last ~12 contributions across the current and previous rounds (`vote_response` rows excluded), each budgeted to ~220 characters (more when carrying code blocks/fences), with stable IDs like `[#4]`.
- **No reflection section**: the participant's stored reflection is *not* injected into primary turns. It surfaces in peer-facing prompts (query/vote/summon targets see "Your current position: …") and in the synthesis transcript.
- **Steering hint**: if the orchestrator queued a steering note (contribution-mix nudge), it is appended after the prompt body — consumed exactly once, by the round's first speaker only.
- **Delimiters**: every untrusted block is wrapped in `<<<LOOM_LABEL>>>_BEGIN_` / `<<<LOOM_LABEL>>>_END_` to prevent prompt injection and boundary confusion. An empty section is omitted.

### What Agents Produce

An agent response is **untyped prose** (or a `loom_pass` tool call). `parseAgentResponseRaw` → Zod `AgentResponseSchema` no longer looks for type tags or directives:

- Any legacy bracket tag prefix (`[PROPOSE]`, `[CHALLENGE]`, …) is stripped from the content; the stored type is always `"contribution"`. Following agents interpret the full content directly.
- All structured directive fields (`request_next`, `query`, `evidence`, `summon`, `vote`) are schema-validated but always `null` — peer interactions happen exclusively through real loom tools.
- If parsing fails entirely, the raw sanitized text is stored as a generic contribution so nothing is silently dropped.

**Tool calls** are first-class: `extractAgentResponse()` returns all completed/error ToolParts, and they are mapped onto the response as `tool_calls` (tool name, callID, status, output) for audit and dashboard display. Two tool-derived behaviors:

1. **Turn requests** — if the agent called `loom_request_next`, its `{priority, reason}` is extracted from the tool results and attached as `response.request_next`, capped by tier (`getPriorityCap`: junior 5, mid/civilian 7, senior 9, principal 10).
2. **Same-turn synthesis** — when `agentTools.sameTurnSynthesis` is on and the turn contains successful `loom_query`/`loom_vote`/`loom_summon` calls, a second prompt on the same ephemeral session presents the tool outputs (each bounded to ~3.5k chars) with the instruction to synthesize the final contribution citing `[#id]` — and offers **no interaction tools** (`buildToolsMapWithoutLoom`) so results can't be re-fetched. The synthesized text replaces the first-pass text when substantive; otherwise the first pass stands.

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
3. Uses a **fixed timeout**: base `agentTimeoutMs` (240s), clamped down only near the meeting deadline — no reduction when agents fail.
4. Builds vector-RAG context: the query text is the last 2 rounds' contributions (or the question if none yet); `retrieveRelevant(query, 10, currentRound)` returns up to 10 chunks, excluding the current round.
5. Collects recent contributions: last 12 across current + previous rounds, `vote_response` rows excluded.
6. If this agent is first in the planned order, consumes any queued **steering hint** (contribution-mix nudge; Section 11/post-phase) and appends it to the user prompt.
7. Sends system prompt + Weighted Golden Sandwich user prompt with a **boolean tool map** when agent tools are enabled (built-ins plus `loom_vector_search`, `loom_query`, `loom_vote`, `loom_summon`, `loom_request_next`).
8. Extracts the response with `extractAgentResponse()` (last TextPart, all ToolParts, reasoning blocks). Inline loom tool calls have already executed server-side at this point — their contributions are already in the weave.
9. Sanitizes content, parses the untyped response, stores the contribution plus any tool-derived turn request (Section 4).
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
3. **Vector indexing** — `VectorIndex.indexRound()` embeds the round summary and contributions asynchronously, raced against a 5s guard timer (best-effort; timeout logs and continues).
4. **Turn order planning** — `planTurnOrder()` produces the next round's ordered participant list (Section 9).
5. **Termination checks** — all participants passed/failed, or `current_round >= max_rounds` (Section 10).
6. **Contribution-mix steering** — if the round contained ≥3 challenges/dissents and no synthesis-type consolidation, a steering hint is queued for the next round's first speaker ("consolidate positions before opening a new challenge"). Cheap and prompt-level; no LLM call.

The round summary and state of play are persisted to the database.

---

## 6. Turn Ordering

**Default order:** Agents speak in composition order (the order they appear in the participants array). There is no randomization.

**Turn request override:** At the end of each round, `planTurnOrder()` is invoked with the round's `loom_request_next` tool requests (Section 9). The resulting JSON array of participant IDs is stored as the `planned_turn_order` and applied by `RoundInitializer.filterActiveParticipants()` at the start of the next round (the plan is cleared after being applied).

**Skip-passed logic:** From round 3 onward, a participant who passed within the last 2 rounds (lookback window of 10 contributions) and carries no stored reflection is excluded from the active list for the next round — but only if at least one participant remains active. A progress message is emitted (e.g. *"⏭️ Skipped: Agent X (inactive, no new reflections)"*).

**When no turn requests exist:** No LLM call is made. `planTurnOrder` returns the default composition order of non-failed participants.

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
  temperature: participant.tier_config.temperature,
  parts: [{ type: "text", text: buildAgentUserPrompt(...) }],
  tools: toolsMap,   // boolean filter map, e.g. { websearch: true, loom_query: true }
});
const { text, toolResults, reasoning } = extractAgentResponse(result.data);
// ... parse & store; same-turn synthesis pass when loom interaction tools succeeded
```

`extractAgentResponse()` handles all Part types:
- **TextPart**: returns only the **last** TextPart (pre-tool text is noise)
- **ToolPart**: results in "completed" or "error" state — never pending/running. Completed inline loom tool calls have already persisted their contributions server-side.
- **ReasoningPart**: thinking blocks (reasoning models), returned separately
- **FilePart, StepStart/FinishPart, SnapshotPart, etc.**: informational (ignored)

### Prompting the Orchestrator (Persistent)

Moderation rulings, LLM round summaries, and turn-order planning share **one persistent orchestrator session** per meeting (`promptOrchestrator`), with retries and empty-response treatment as transient failures:

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

Termination is agent-driven: agents call the `loom_pass` tool when they have nothing new to contribute. The meeting ends when all active participants have passed.

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
| Hard timeout / stall / token budget / user cancellation | extrinsic stops |

The absolute wall-clock timeout is disabled by default (`defaultMeetingTimeoutMs: 0` = no limit); stall watchdog, token budget, and user cancellation remain as extrinsic stops and proceed to synthesis.

Terminal statuses: `converged`, `cancelled`, `timeout`, `max_rounds_reached`, `aborted`.

---

## 9. Turn Order System

### How Turn Requests Work

During the prompt phase, an agent can call the `loom_request_next` tool (fire-and-forget; the tool result is just an acknowledgment) to request speaking priority for the **next round**:

```
The refresh-token approach underestimates token theft risk from client-side
storage. I need time to lay out the mitigations.
— plus tool call: loom_request_next({priority: 8, reason: "I have concrete
mitigations for the token theft concern and need to present them before the
round closes"})
```

After the turn completes, the executor scans the stored `tool_calls` for `loom_request_next` results and attaches `{priority, reason}` as `response.request_next`, capped at the requesting agent's tier cap (junior 5, mid/civilian 7, senior 9, principal 10) via `getPriorityCap`. Requests carry only `priority` and `reason`.

### Turn Request Resolution (`planTurnOrder`)

Running at the end of each round:

1. **No requests** → return the default composition order of all non-failed participants (no LLM call).
2. **Single valid request** → programmatically move the requesting agent to position 0 (no LLM call).
3. **Multiple requests** → filter to valid requesters (participant exists and isn't failed), then prompt the planner via `buildTurnOrderPrompt`, which returns a JSON array of participant IDs:

```
You are the turn order planner for a multi-agent deliberation. Favor longer,
richer deliberation — give diverse voices room. Avoid starvation.

## Current State of Play
...

## Last Round Summary
...

## Agent Turn Requests (priority already capped by tier)
  - mid_security_engineer (Security Engineer, mid): Priority 8 — "..."

## Active Participants
  - senior_architect (Architect Lead, senior, 3 contribs [has reflection])
  - ...

## Task
Return a JSON array of participant IDs ordered by who should speak first
to push deliberation forward thoroughly.

Ranking doctrine (in order):
1. Strong evidence-backed challenges/requests first — tool output with
   Strength: strong or [#id] citation signals substance
2. Higher priority requests next (intrinsic urgency)
3. Proposals introducing a new distinct option before refinements/supports
4. Anti-starvation: anyone who spoke last without new reflection/evidence
   is demoted one rank
5. Tie-break: (a) who spoke least recently, then (b) seniority

Constraints:
- Include every active participant exactly once
- Consider State of Play to avoid immediate circular re-litigation

Respond with ONLY a JSON array: ["id1", "id2", "id3"]
```

The planner runs on the **fast-path model** when configured (otherwise the highest-tier model). The response is parsed with a balanced-bracket JSON-array scan (`extractBalancedJsonArray`) so a `]` inside a quoted ID can't truncate it, and validated against the participant list (unknown IDs dropped, missing participants appended). On LLM failure a deterministic fallback sorts by priority descending, then tier (principal > senior > mid/civilian > junior).

4. The ordered list is stored as `planned_turn_order` (and its head as `next_speaker_id`) and applied by `RoundInitializer.filterActiveParticipants()` next round.

Note: config keys `maxTurnRequestsPerRound`, `turnRequestThresholds.autoGrant`, and `maxTurnRequestWords` were removed from the schema (never enforced — ordering is `planTurnOrder`; see the deprecation table in `src/config/defaults.js`).

---

## 10. Convergence Detection

Convergence is deterministic and integrated into round finalization — there is no separate LLM "convergence check" anymore.

The meeting terminates when any of these hold after a round:

| Condition | What it does |
|-----------|--------------|
| All participants have called `loom_pass` or failed (`activeCount === 0`) | natural end — highest priority |
| `current_round >= max_rounds` | guaranteed termination |

The `meetings.convergence` column persists only as a display label (set to `"agent_driven"`). Termination is deterministic (see table above). The absolute wall-clock timeout is disabled by default (stall watchdog, token budget, and user cancellation remain as extrinsic stops) and proceeds to synthesis.

Terminal statuses: `converged`, `cancelled`, `timeout`, `max_rounds_reached`, `aborted` (the last two surface via the state machine but are not produced by the current orchestration paths; `max_rounds_reached` is reserved).

---

## 11. State of Play

The state of play is the primary running context for agents. It replaces the old fabric-compaction system with a structured, always-accurate summary derived from the full weave.

### What It Contains

`updateStateOfPlay(weave, question, tags)` produces a markdown document with these sections:

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

The orchestrator calls `updateStateOfPlay(weave, question, tags)` which categorizes contributions using **the stored contribution type** (`c.type`) as the primary signal:

| `c.type` | Category |
|-----------|----------|
| `contribution` (primary turns — untyped) | Fallback keyword matching |
| `propose`, `refine` | Decisions & Proposals |
| `support` | Agreements |
| `challenge`, `dissent`, `critique_response` | Disagreements & Concerns |
| `question` | Open Questions |
| `query_response` | Key Facts — except modes `risks`/`assumptions`, which feed Open Questions |
| `evidence_response`, `summoned_response` | Key Facts |
| `reflection` | Key Facts, wrapped as `[Reflected: …]` |
| `vote_response` | (excluded — individual ballots are noise; the tally carries the result) |
| `synthesize`, `refuse` | (excluded) |
| `pass` | (skipped before classification) |
| unknown/missing | Fallback keyword matching |

**Fallback keyword matching** (for untyped contributions and missing/unknown types) uses word-boundary-aware regex: `\bwe should\b`/`\bdecision\b` → Decisions, `\bagree\b`/`\bconsensus\b` → Agreements, `\bdisagree\b`/`\bconcern\b` → Disagreements, `?` → Open Questions, otherwise Key Facts.

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

The old system appended round summaries to a "fabric" string and compressed it past `maxFabricChars`. Problems: O(N²) token growth and information loss on compaction. The state of play is derived from the full weave (no loss) and bounded in size (no growth). Combined with ephemeral sessions, per-turn token growth is O(1). (The `fabric-*` naming remains in the DB only for the initial user context and the vector chunk tables.)

---

## 12. Reflections

Reflections are per-participant belief states: a short statement of where that agent currently stands on the deliberation. They are **no longer produced automatically** — there is no mid-round reflection phase, and challenges/dissents do not trigger reflections.

### How Reflections Are Maintained Today

The only live write path is **`loom_query` with mode `perspective`**: when an agent solicits a peer's stance on a statement, the peer's answer replaces the peer's stored reflection and is pushed onto a bounded `reflectionHistory` (last 5 entries, in memory) plus persisted via `setParticipantReflection` on the `participants` row. This keeps each agent's "current position" fresh as a side effect of natural peer-to-peer interaction rather than extra LLM calls — the perspective answer *is* their position.

### Where Reflections Surface

- **Peer-facing prompts:** query/vote/summon targets see `Your current position: "<reflection>"` so they answer consistently with their latest stance (Section 22).
- **Synthesis:** participants with reflections get a `### Final Reflections` block appended to the transcript digest (`**Name (tier) reflection**: …`).
- **Dashboard:** participant cards show a reflection indicator; legacy `reflection`-type contribution rows still render in the timeline.
- **Skip-passed logic:** a passed agent is kept active if they carry a reflection (Section 6).

### Storage

`participants.reflection` stores the raw text without any header; `reflectionHistory` is session-scoped only. Legacy `reflection`-type contributions (from earlier versions) remain readable in the weave, are folded into round summaries as inline `↳ Reflected:` lines when present, and classify into Key Facts as `[Reflected: …]` — but no current code path creates them.

---

## 13. Round Summarization

After each round, a summary is generated via LLM — every round, unconditionally (there is no conflict-gated mode anymore). If the LLM fails or returns empty, a deterministic digest keeps the round auditable.

### LLM Clerk Summary

`summarizeRound` picks the highest-tier model (or fallback model), filters to substantive contributions (`contribution` + `query_response`/`evidence_response` etc., legacy `propose`/`challenge` included; `evidence_response` only when tool-backed; `[PASS]` excluded) via `SUBSTANTIVE_TYPES` (`src/utils/contribution-types.js`, `vote_tally` removed — outcome via invoker prose) and prompts:

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

The **Evidence/Tool Signals** hint collects up to 4 evidence/query/tool-backed contributions sorted by strength ("Strength: strong" > tool-backed > plain, synthetic `write` excluded), so grounded claims are visible to the summarizer even when filtered out of the main list.

Runs via the fast-path-routable `#promptOrchestrator` type `"summary"` (Section 21). Transcript is budget-capped at 8k chars with `…[truncated]` marker when exceeded.

### Degraded Digest Fallback

If the LLM summary is empty after retries, the round gets a deterministic digest instead of failing the meeting: up to 8 substantive contribution lines plus a turn-request count, prefixed `(Degraded summary — LLM returned empty response)` and logged as `summary_degraded`.

### Storage

Round summaries are stored in the `rounds` table (per round) for dashboard display. They are **not** appended to running context — the state of play is regenerated from the full weave instead.

---

## 14. Synthesis

When the meeting ends (convergence, max rounds, timeout, cancellation, or abort), the system synthesizes all contributions into a final artifact.

### Synthesizer Selection

Priority: principal (non-failed) > senior (non-failed) > any non-failed > last participant.

### The Synthesis Session

Unlike agent turns, synthesis uses **one persistent session** (`createSynthesizerSession`) reused across the draft, section-repair retries, and the critique pass — the same session accumulates the draft so the critique can reference it. The system prompt is `NEUTRAL_SYNTHESIZER_SYSTEM`:

```
You are a synthesis auditor, not a participant. You are neutral to all
agendas — including the synthesizer persona you may have borrowed.

Rules:
1. Prefer citing [#id] or State-of-Play for every Decision and Action Item.
   Novel synthesized fixes are marked "Proposed — synthesized from [#id]".
2. Every Dissenting View must name holder (name + tier) and [#id].
   Unresolved Objections are mandatory dissent.
3. Do not invent numbers, dates, costs, tool results, or participant positions
   not in transcript/State-of-Play. If evidence conflicts, state both and set
   Confidence accordingly.
4. Resolved Concerns must NOT reappear as Dissenting Views.
5. Never emit <<< or >>> delimiters. Preserve code and numbers verbatim.
```

(Neutrality matters: the synthesizer is often a specific participant's model/persona, but must not editorialize toward their agenda.)

### The Synthesis Prompt

`buildSynthesisPrompt(question, transcript, participants, tags, stateOfPlay, objections, userContext)` first runs **task-mode detection** (`detectTaskMode`): questions/tags matching code signals (`react`, `src/`, `.tsx`, `bug`, `refactor`, …) switch to **code-analysis mode**, which adds a required `## Proposed Fix` section with diff blocks and relaxed grounding for clearly-marked synthesized fixes; otherwise it is conversational mode.

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
<<<LOOM_TRANSCRIPT>>> digest of earlier rounds + full final round + Final Reflections <<<END>>>

## Participants (activity)
- Architect Lead (senior): 3 contributions
...

## Synthesis Doctrine
You are not a participant. You are an auditor. Every claim you make must be traceable.
(grounding / attribution / no-invention / resolved≠dissent / actionability rules)

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

Only a bounded transcript is included (`formatFinalRoundTranscript`): earlier rounds appear as ~2-line digests, the final round in full (capped ~8k chars), plus each participant's stored reflection under `### Final Reflections`. Unresolved objections come from `collectObjections()` (challenges/dissent-type contributions across rounds; an objection is legacy once the final round shows activity).

### Required-Section Repair

After the draft, `validateSynthesisSections` requires: always — `Decision`, `Reasoning`, `Confidence`, `Dissenting Views`, `Open Questions`; plus at least one of `Action Items` / `Proposed Fix` (code mode expects Proposed Fix). If anything is missing and retries remain (`synthesisMaxRetries`, default 1), the model is re-prompted on the SAME session: *"Your previous response was missing these required sections: … Please include ALL of the following sections…"*.

### Self-Critique Pass

The synthesizer then audits its own draft against the transcript (up to `MAX_CRITIQUE_RETRIES` = 2):

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
- A revision that dropped sections is re-sent with feedback.
- On any error the original draft is kept.

### Finalization

`finalizeSynthesis` post-processes the text:
- Appends **## Unresolved Objections** and **## Resolved Concerns** (from `objection_collector`).
- Appends **## Refusals** (agents who refused to engage, as `Name: content`).
- Adds a note for any required section the model omitted (`> **Note:** The synthesizer did not generate…`).
- **Grounded-synthesis check:** every `## Decision` line citing no valid `[#id]` from the weave is listed under **## Needs Verification** rather than silently kept.
- Parses the Confidence section if present; otherwise derives it heuristically (`deriveConfidence`):
  ```javascript
  if (dissentCount === 0 && challengeRatio < 0.3 && participationRate >= 0.5) return "high";
  if (dissentCount <= 1 && challengeRatio < 0.5 && participationRate >= 0.33) return "medium";
  return "low";
  ```
- Extracts structured fields (`decisions`, `action_items`, `proposed_fix`, `files_involved`, `open_questions`, `dissent`, `refusals`, `confidence`) and persists the artifact with `_saveArtifact`.

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
    { number: 1, contributions: [...], turn_requests: [...], token_path: [...], summary: "..." }
  ],
  current_round: 3,
  max_rounds: 6,
  current_speaker_idx: 0,
  status: "weaving",   // initializing | weaving | converged | cancelled | timeout | max_rounds_reached | aborted
  artifact: null,      // set after synthesis
  objections: [],      // collected at synthesis time
  tags: ["engineering", "security"],
  next_contribution_id: 14,
  next_speaker_id: null,          // set by planTurnOrder or loom_pass redirect
  planned_turn_order: [],         // planned for next round
  opencode_session_id: "...",     // for session-indexing
}
```

### Immutability

`getState()` returns deep-frozen copies (`structuredClone` + `deepFreeze` + `freezeTierConfig`; `createMeetingConfig()` deep-freezes via `JSON.parse(JSON.stringify(TUNING))` per-meeting). All mutations go through targeted `StateManager` methods:

```javascript
stateManager.transitionTo("weaving")            // validated TRANSITIONS table
stateManager.addContribution(obj)               // atomic addition
stateManager.setStateOfPlay(summary)            // regenerated each round
stateManager.setPlannedTurnOrder(ids)           // for next round
stateManager.setNextSpeakerId(id)               // turn order planning
stateManager.reorderForNextSpeaker(id)          // established for next round
stateManager.addParticipantReflection(id, text)
```

`transitionTo` validates against `StateManager.TRANSITIONS` (`initializing → weaving/cancelled/aborted/timeout`; `weaving → converged/cancelled/timeout/max_rounds_reached/aborted`; terminals absorbing). `forceTransitionTo` now allows `initializing→weaving` for stuck-in-initializing extension plus all terminal→`weaving` (resume), else throws; `orchestrator.close()` is idempotent (`#closed` guard, nulls `_database/_sessionManager/_roundExecutor`).

### Persistence

State is persisted via the `PersistenceService` after each round finalization and after terminal events (`#persistState`), atomically updating `meetings` with round, status, fabric, state_of_play, next_speaker_id, stats, `semantic_degraded`. Fresh DBs enforce `participants.tags`/`expertise` (FK `meetings(id)`), `UNIQUE(meeting_id,name)` + `UNIQUE(meeting_id,chunk_index)`. On resume, `restoreStateFromDb()` reconstructs from SQLite (participants with `tags/expertise` + `known_biases`/`communication_style`/`preferred_contribution_types`, weave, rounds, `turn_requests` with `FK` + `CHECK(priority 1..10, DEFAULT 1)`, `agent_errors` with `CHECK`, next speaker, call stats) and rehydrates `artifact`/`objections` if synthesized.

---

## 16. Error Handling & Model Fallback

### Retry-able Call Sites

Retries (`withRetry`, exponential backoff with jitter) wrap:
- **Session creation** (`client.session.create`) — `maxAttempts = maxRetryAttempts` (default 2).
- **Orchestrator prompts** (`SessionManager.promptOrchestrator`) — same retry policy.

Retryable errors (`isRetryableError`): `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, any message containing "timed out", HTTP 5xx, HTTP 429.

### Agent Prompt Failures (retry + model fallback)

Agent turns are now **retried** — the old "run once and fail" behavior is gone. `#promptChildSession` runs a staged recovery ladder before an agent is marked `failed`:

1. **Fixed timeout:** base `agentTimeoutMs` (240s) per agent call — deliberately NOT reduced when agents fail ("previously punished survivors").
2. **Retry on the assigned model** — up to `modelFallback.maxRetriesPerModel` (default 2) retries *after* the first attempt, with exponential backoff (1000ms · 2^attempt + jitter, capped at 8s). Each failure increments the model's circuit-breaker counter.
3. **Fallback model** — when the primary model's retries are exhausted (and `modelFallback.enabled`, default true), `selectFallbackModel()` picks a healthy model from the discovered pool that is *not* the failing model (random among the healthy candidates) and the turn is attempted on it (up to `modelFallback.maxFallbackAttempts` retries after the first fallback attempt), with the same backoff. A progress message announces the switch ("⚠️ Model X failed — retrying with Y").
4. **Failure** — only when the primary and fallback attempts are all exhausted does the agent's status become `failed`, an `agent_errors` row is written with type `model_fallback` (`Model: X, No fallback available` or `Original: X, Fallback: Y — <error>`), and the agent is skipped for the rest of the round.

Every failed/finished turn path is precomputed once: **RAG context, system prompt, and user prompt are built model-independent and reused across retries/fallbacks** (no duplicate RAG calls). When the circuit breaker already marks the assigned model `open`, the turn starts directly on a fallback model without retrying the unhealthy one.

**Inline-tool side effects across retries:** loom interaction tools execute server-side *during* `session.prompt`. If an attempt fails after those side effects landed, the retried response will not re-contain those ToolParts — the peer contributions already live in the weave (deduplicated by batch+target+question idempotency keys, Section 22), and the gap is surfaced via an explicit `attempt_failed_possible_tool_side_effects` log instead of silently disappearing.

Successful fallback turns carry a `_fallback` metadata object on the parsed response (`{ from, to, error }`); having succeeded on the fallback model, the agent's status returns to `listening` as normal. Additionally, `#getParticipantModel` can itself substitute the highest-tier healthy model when a participant's own model is unhealthy (orchestrator-level fallback used by directives and synthesis).

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

Database operations are wrapped in try-catch; best-effort operations log and continue. Fresh DBs enforce `CHECK(status/tier/round/type/priority)` + `UNIQUE(meeting_id,chunk_index)` + `FK(meetings→participants→contributions)` at `initSchema()` (`user_version 2`); there is no migration machinery — `schema.js` ships `initSchema()` with the final schema (alpha: DBs are wiped whenever a session is deleted, `MIGRATIONS[1]` is no-op). `storeFabricChunk` is always `BEGIN IMMEDIATE` around `MAX+1`+`INSERT` (vector + non-vector), `SAVEPOINT loom_txn_*` for nested `MeetingDatabase.transaction()`. `isSafeBashCommand` post-hoc sandbox in `execute-turn.js:132` blocks `--upload-pack`/`-exec`/`-R`/`--exec` (permissive, allows `git ls-files --cached`).

Indexing and other best-effort operations log and continue.

### All-Failed / All-Passed Handling

Degraded artifacts are produced when every participant fails or everyone passes (Section 14).

---

## 17. Stall Detection

A watchdog monitors activity. If no state update occurs for the configured interval, the meeting is cancelled and passes through to synthesis.

**Configuration:** `stallTimeoutMs` = 600,000ms (10 min), tick interval `WATCHDOG_TICK_MS` = 30,000ms (30s) via `TUNING.WATCHDOG_TICK_MS` (`getConfig().tuning`).

**Mechanism:** `StallWatchdog.start(getStatus, isCancelled)` is idempotent (`start()` touches if already running); `touch()` on `#notifyUpdate` + contributions resets `lastActivityAt`.

**Mechanism:** `StallWatchdog.start(getStatus, isCancelled)` begins a 30s interval. On each tick:
1. If the process is cancelled or the meeting is in a terminal status, stop the watchdog.
2. If `Date.now() - lastActivityAt > stallTimeoutMs`, log `stall_detected`, set `stallCancelled = true`, and call `onStall()`.

**Activity touch:** `lastActivityAt` is updated on every state update (`#notifyUpdate()`) via `stallWatchdog.touch()` and on every contribution.

**Stall response:** `onStall` sets `#cancelled = true` and posts "⏱️ No activity detected for a while — stopping the deliberation." The weave loop detects the flag and transitions to **"timeout"** (not "cancelled" — this distinguishes inactivity from user action), then proceeds to synthesis.

---

## 18. Extension and Resume

### Meeting Extension (continuing in the same chat)

When a user runs `/knit` again in a session that already has a meeting (and hasn't passed `fresh`), `handleKnit` routes to `handleExtend` instead of creating a new meeting:

1. The meeting is looked up via the session index (`findMeetingBySessionId`).
2. A `MeetingOrchestrator` is constructed with `resume: true`; `restoreStateFromDb()` rebuilds state from the SQLite DB.
3. `extendMeeting(newPrompt)` (via `MeetingExtender`) appends the new input to the fabric: `**User Input:** <new prompt>`.
4. Status is force-transitioned back to `"weaving"`.
5. `max_rounds` increases by 4 (`EXTENSION_EXTRA_ROUNDS`).
6. All participants are reset to `"listening"`.
7. The weaving loop runs again from the current round, then synthesis runs again.

`/knit fresh: true` deletes the existing meeting DB first if one exists.

### What Survives a Resume

From the database: participants (with personas, tiers, models, status, reflections), the full weave, rounds and turn requests, the state of play, max rounds, next speaker, and call stats. Participant contribution counts are recomputed from the weave.

---

## 19. Vector Index, RAG, and PersonaIndex

### The Vector Tables

`VectorIndex` provides semantic retrieval over prior deliberation context, backed by sqlite-vec virtual tables (dim-parameterized `vec_*_${dim}` via `vecTableName(prefix,dim)` / `sanitizeDim` helper, `CHECK` + `UNIQUE` on `fabric_chunks`):

| Table | Purpose |
|-------|---------|
| `fabric_chunks` | Regular table: chunked content (`CHECK(source IN ('round_summary','contribution','context'))`, `UNIQUE(meeting_id,chunk_index)`) |
| `vec_fabric_chunks_${dim}` | sqlite-vec virtual table: `embedding float[${dim}]` — used for agent RAG (dim from `getEmbeddingDim()`, `TUNING.VEC_SEARCH_TOPK`/`FABRIC_CHUNK_MAX_TOKENS`/`CONTEXT_CHAR_PER_TOKEN`) |
| `persona_embeddings` | Regular table: embedded persona text (`persona_name`, `tier CHECK`, `tags`, `embedding_text`) |
| `vec_persona_embeddings_${dim}` | sqlite-vec virtual table: `embedding float[${dim}]` — used for room composition (meeting-scoped, tier-filtered) |

### Embedding Service

The embedding service (`embedding-service.js`) provides a pluggable embedding interface backed by a local ONNX model:

- **ONNX Runtime model:** `onnxruntime-node` for inference, `@huggingface/tokenizers` for tokenization. Default model **Snowflake/snowflake-arctic-embed-xs** (~22 MB, 384 dims, BERT architecture, int8 quantized, `maxTokens` 512). Runs entirely locally.
- **Model resolution:** onnxruntime-node and the tokenizers are marked as esbuild externals; at runtime they're resolved from a dedicated deps directory at `~/.config/opencode/loom/deps/node_modules/` via `createRequire`, with a fallback to the project's `node_modules` for local development.
- **Model download:** the default model is installed by `npm run install:plugin` via `scripts/model.mjs` into `~/.config/opencode/loom/models/<name>/model.json` (specifies dims, maxTokens, modelType, quant path).
- **Initialization:** `initEmbeddingModel()` runs eagerly when the dashboard starts, lazily on first use by composition/RAG/vector indexing, and on plugin startup via `ensureEmbedderInitialized()`. The dashboard shows embedder status (loading/ready/failed).

The `embed()` path tokenizes text, builds `input_ids`/`attention_mask`/`token_type_ids` tensors, runs the session, extracts `last_hidden_state`, mean-pools over non-padding tokens, and L2-normalizes to a `Float32Array` of length `dims`.

### Chunking Strategy

`#chunkText` splits on paragraphs (`\n\n`), merging paragraphs up to `maxTokens × charsPerToken` characters (`charsPerToken` 2 for CJK/code-heavy else `TUNING.CONTEXT_CHAR_PER_TOKEN` 4, `maxTokens` from `getEmbeddingMaxTokens()` or `TUNING.FABRIC_CHUNK_MAX_TOKENS` fallback; dense detection `[\u3040-\u9FFF]`). Oversized paragraphs hard-split by sentence/word boundaries. Each chunk is stored with a source tag: `round_summary`, `contribution`, or `context`.

### Indexing Flow

- **At meeting start** (non-resume): the user context is indexed via `indexContext()` — fire-and-forget (shared `#indexChunks(pending,label)` helper deduplicates `indexRound`/`indexContext`).
- **After each round**: `indexRound(roundNumber, summary, contributions)` chunks and embeds the summary (source `round_summary`) and each contribution (source `contribution`, prefixed `[participant_id] (type):`). Batch embed concurrency 4, `storeFabricChunk` `BEGIN IMMEDIATE` around `MAX+1`+`INSERT` for both vector/non-vector, `storeFabricEmbedding` via `vecTableName`. Best-effort (`.catch(logger.warn)`); `semantic_degraded` set only when all embeds fail, cleared only on tier-matched `vec` hit (tier-filtered `searchPersonaEmbeddings`).
- **Personas**: `PersonaIndex.indexAll(personas)` embeds `persona + agenda + tags + expertise` text per persona at composition time (meeting-scoped, cache `model|quant|dim|fingerprint` `TUNING.EMBEDDING_CACHE_MAX` LRU, concurrency 4).

### Retrieval Flow

```javascript
const recentContribs = weave.filter((c) => c.round >= currentRound - 1);
const queryText = recentContribs.length > 0
  ? recentContribs.map((c) => c.content).join("\n")
  : stateManager.getQuestion();
const ragChunks = await vectorIndex.retrieveRelevant(queryText, 10, currentRound);
```

`retrieveRelevant(queryText, topK, excludeRound)`:
1. Embeds the query.
2. Runs cosine similarity search (`vec_fabric_chunks MATCH`, fetching topK+5).
3. Excludes chunks from the current round (avoids self-referencing).
4. Returns topK results.

**RAG query:** the query text is the last two rounds' contributions (filtered by round and not excluded), joined into a single string. If no contributions exist yet, the meeting question is used instead. Different agents can still retrieve different "relevant" context because each agent's own contributions may differ from the group's.

### How RAG Context Appears in Agent Prompts

```
<<<LOOM_RELEVANT_PRIOR_CONTEXT>>>_BEGIN_
[Round 1] The JWT migration makes sense, but token revocation is unsolved...
[Round 2] Refresh tokens with server-side storage defeats statelessness...
<<<LOOM_RELEVANT_PRIOR_CONTEXT>>>_END_
```

When no RAG context is available (early rounds, empty index), this section is omitted.

---

## 20. Agent Tooling — Built-ins + Plugin-Registered Loom Tools

Agent tooling is split between **built-in OpenCode tools** (web_fetch, read, bash, etc.) and **plugin-registered loom tools** (loom_query, loom_vote, loom_summon, loom_request_next, loom_vector_search). Both sets flow into agent prompts through the same mechanism: `agentTools` config → `tools` body map → OpenCode server maps to provider tool definitions.

### Tool Sets by Phase

| Phase | Built-in | Loom Plugin | tool_choice |
|-------|----------|-------------|-------------|
| Primary agent turn | `web_fetch`, `web_search`, `read`, `glob`, `grep`, `bash` (allowlisted) | `loom_query`, `loom_vote`, `loom_summon`, `loom_request_next`, `loom_pass`, `loom_vector_search` | `auto` |
| Query/Evidence response (peer) | `web_fetch`, `web_search`, `read`, `loom_vector_search` | *(none)* | `auto` / `required` (evidence) |
| Vote response (peer) | *(none)* | *(none)* | `none` — bare `[Vote: X]` ballot |
| Summoned expert | `web_fetch`, `web_search`, `read`, `loom_vector_search` | *(none)* | `auto` |

**Not granted to agents**: `write`, `edit`, `tui`, `todo`, `lsp`, `comment`, `snapshot`, `permissions`.

### Plugin-Registered Tools

| Tool | Source File | Purpose |
|------|-----------|---------|
| `loom_query` | `plugin/tools/query-evidence.js` | Query peers with 7 modes (clarify/perspective/evidence/critique/risks/assumptions/alternatives) — returns inline for same-turn synthesis |
| `loom_vote` | `plugin/tools/vote-summon.js` | Call a lettered poll — fan-out to all active participants, inline tally |
| `loom_summon` | `plugin/tools/vote-summon.js` | Summon a guest expert persona for one additive contribution |
| `loom_request_next` | `plugin/tools/meta.js` | Request priority speaking slot in next round |
| `loom_pass` | `plugin/tools/pass.js` | Pass on current turn; deliberation ends when all participants pass |
| `loom_vector_search` | `plugin/tools/vector-search.js` | Semantic similarity search against prior deliberation chunks |

All loom tools resolve the current meeting from `context.sessionID` via the session-index, then delegate to the in-memory `activeLooms` engine for state/session/database access. Shared helpers `src/plugin/tools/shared.js:1` centralize `resolveCaller` (session→speaking→weave→any), `resolveModel` (borrow any healthy participant model), `buildBatchId` (`inline-${meetingId}-${round}-${callerId}`), and `TERMINAL_STATUSES` (re-exported from `src/constants.js:3`).

### Tool Registration Chain

```
src/index.js (Loom factory)
  → tool("loom_query", createQueryEvidenceTools({ config, resolveMeeting, activeLooms }))
  → tool("loom_vote", createVoteSummonTools({ config, resolveMeeting, activeLooms }))
  → tool("loom_summon", ...)
  → tool("loom_request_next", createMetaTools({ config }))
  → tool("loom_pass", createPassTool({ config }))
  → tool("loom_vector_search", createVectorSearchTool({ config, resolveMeeting }))

When an agent turn starts:
  MeetingOrchestrator → RoundExecutor
    → client.session.prompt({ body: { tools: toolsMap } })
```

The `tools` body field is a **boolean filter map** (e.g. `{ web_fetch: true, loom_query: true }`); the opencode server maps enabled tools to provider-format tool definitions automatically. Built-in tools are gated by `agentTools.builtIn.*`; loom tools by `agentTools.loom.*`.

### Agent Guidance

When loom tools are enabled, the system prompt includes:
- **Research-first guidance** for `loom_vector_search` ("search before you claim").
- **Query-mode guidance** (`loom_query` modes table embedded in system prompt) — callers use modes to specify the kind of response they want.
- **Evidence requests** additionally require "You MUST use at least one research tool to find concrete evidence. Do NOT speculate or reason from memory alone."

### Configuration

```json
{
  "agentTools": {
    "enabled": true,
    "builtIn": {
      "web_fetch": true, "web_search": true, "read": true,
      "bash": { "enabled": true, "allowlist": ["git", "ls", "wc", "head", "tail", "grep", "find"] },
      "glob": true, "grep": true, "lsp": false
    },
    "loom": {
      "loom_query": true,
      "loom_vote": true,
      "loom_summon": true,
      "loom_request_next": true,
      "loom_pass": true,
      "loom_vector_search": true
    },
    "maxToolCallsPerTurn": 5,
    "maxToolOutputTokens": 4000
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Master switch for all agent tools |
| `builtIn.*` | (see above) | Enable built-in tools for agent turns |
| `builtIn.bash.allowlist` | `["git","ls","wc","head","tail","grep","find"]` | Only these commands via bash |
| `loom.*` | all `true` | Enable loom plugin tools (query/vote/summon/request_next/pass/vector_search) |
| `maxToolCallsPerTurn` | `5` | Soft limit — exceeding logs a warning (not truncated) |
| `maxToolOutputTokens` | `4000` | Contract limit on tool output volume (drives server-side truncation) |

### Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Prompt injection via tool outputs | Tool outputs feed the final text only; content is sanitized + `delimitContext` fenced `PEER_CONTRIBUTIONS`/`STATE_OF_PLAY` in `buildSummonPrompt` |
| Bash command execution | Allowlisted commands only; post-hoc `isSafeBashCommand` (`--upload-pack`/`-exec`/`-R`/`--exec`, `find -execdir`) in `execute-turn.js:132` (permissive, allows `git ls-files --cached`) |
| Filesystem exposure | `read` via opencode SDK sandbox; `paths.js:getMeetingDbPath` `realpathSync` jail + `isAssetPathSafe` fullwidth `%` NFC |
| Embedding model unavailable | `embedText` throws; `retrieveRelevant` catches and returns `[]`, composition falls back to keyword `maxCosineDistance` floor |
| Loom tool side effects on retry | Inline peer contributions persisted via idempotency keys (`batchId+target+question`, `vote` batch); retried prompts do not duplicate; abort re-checks in `query-evidence.js:102`/`vote-summon.js:142` |

---

## 21. Fast-Path Model Routing

Orchestrator calls can use a cheaper/faster model instead of the highest-tier agent model.

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
| `summary` | Yes | LLM round summaries (Section 13) |
| `turn_order` | No (via planner) | `planTurnOrder` selects `fastPathModel` itself (Section 9) |

Note: turn-order planning is special — `#promptOrchestrator` doesn't fast-path `turn_order`, but `planTurnOrder` picks `fastPathModel || getHighestTierModel()` as its model before calling the orchestrator, so it still benefits when configured.

When `fastPathModel` is empty (default), all orchestrator calls use the highest-tier model.

---

## 22. Inline Peer Interactions: Query, Vote, Summon, Turn Requests

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
2. For each resolved target: build prompt via `buildQueryPrompt` (clarify/other modes) or `buildEvidencePrompt` (evidence mode) — source's contribution + question, target's recent contributions and stored reflection, seniority + round context.
3. Run `runEphemeralPrompt` for each target (parallel where possible).
4. Persist each response as a typed contribution (`query_response` or `evidence_response`) under the invoker's `batch_id`.
5. **Perspective mode side-effect:** the response replaces the target's stored `reflection` (pushed onto bounded `reflectionHistory`, max 5) and persists via `setParticipantReflection` — this is the primary write path for reflections (Section 12).

**Idempotency:** if `batch_id + target + question` already exists in the weave (retry after timeout), the existing contribution is reused instead of re-prompting.

**Dashboard:** targets marked `speaking` while responding; listed in `meetings.querying_participants`.

### `loom_vote` — Poll

**Signature:** `loom_vote({ question })`

Fan-out to **all active participants** (source + every non-failed/passed/muted participant). The source's ballot is parsed from its own contribution content; all others are prompted in parallel.

- **Prompt** (`buildVotePrompt`): poll question, source's contribution, voter's last 2 contributions and stored reflection, round context.
- **Ballot format:** `[Vote: <letter>]` + 1–2 sentences reasoning. `extractVoteLetter()` accepts the tag or a standalone capital letter.
- **Tools:** none — `tool_choice: "none"` (fast, tool-free poll).
- **Output:** each ballot stored as `vote_response` (`[Vote from <Name>]`); tally is returned **inline** to the caller (`{tally:"[Vote Tally] …", votes:[…]}`) for same-turn synthesis — no `vote_tally` row is persisted (invoker interprets in prose).
- **Edge case:** source-only → tally inline with 1 voter.
- **Idempotency:** same `batch_id + question` reuses existing `vote_response` rows and rebuilds tally inline.

### `loom_summon` — Guest Expert

**Signature:** `loom_summon({ persona_name, issue })`

Brings in a **guest expert** from the persona pool (matched by name across all tiers; unknown personas are rejected). The summoned agent is not a registered participant — it contributes once.

- **Rate limits:** `maxSummonsPerRound` (2), `maxSummonsPerAgent` (1) — tracked per round.
- **Model:** the summoning agent's own model; temperature 0.7.
- **Tools:** `web_fetch`, `web_search`, `read`, `loom_vector_search` (no bash/glob/grep — least privilege for guests).
- **Prompt** (`buildSummonPrompt`): persona expertise, communication style, requester's issue, recent context (last 4 contributions), round context.
- **Contribution:** type `summoned_response`, participant id `summoned_<slug>`, content prefixed `[Summoned: <Name> (<tier>)]`.

### `loom_request_next` — Turn Request

**Signature:** `loom_request_next({ priority, reason })`

A meta-level request (not a peer interaction) — queues a turn request for the next round's ordering algorithm. Priority capped by tier. The request is returned as `{ queued: true }` and processed during the post-phase turn-ordering step (Section 9).

### How Inline Responses Appear in the Caller's Context

Peer responses are returned as JSON payloads in the tool output. The caller's system prompt instructs it to **synthesize inline** — use the peer answers directly in its contribution rather than reporting them as raw tool output. Responses are also stored as indented contribution rows in the weave for later agents' context.

### Interaction Outcomes in State of Play

| Contribution Type | State of Play Section | Notes |
|-------------------|----------------------|-------|
| `query_response` (clarify/critique/risks/assumptions/alternatives) | Key Facts | Includes the target's answer |
| `query_response` (perspective) | Key Facts | Also updates target's stored reflection |
| `evidence_response` | Key Facts | Includes source + strength metadata |
| `vote_response` | (excluded) | Individual ballots — outcome via invoker prose |
| `summoned_response` | Key Facts | Guest expert perspective |

All response types flow into the weave and appear in later agents' recent contributions.

---

## 23. Dashboard System

`/loom_viz` starts a lightweight static web dashboard (default port 3210) that renders a live view of all meetings under `.opencode/loom/meetings/`.

### How It Works

- **Serving:** `startDashboard(directory, port)` serves an HTML shell (per-request `Content-Security-Policy: script-src 'nonce-<uuid>'`, inline theme script `nonce` via `getHtmlShell(nonce)`) + static assets (`/assets/*`, `isAssetPathSafe` fullwidth `%` NFC + `realpathSync` jail) and a JSON API (`SECURITY_HEADERS: nosniff/DENY`).
- **Data source:** `DashboardApi` opens each meeting SQLite DB **read-only**, with a `TUNING.MAX_DB_CACHE_SIZE` (10) LRU cache and TTL; connections are re-opened when the DB file's mtime changes (`DB_REFRESH_INTERVAL_MS` 500ms coalesced, `refreshIfStale()`), so it reads fresh state without live coupling.
- **Real-time updates:** the server holds SSE clients per meeting (`/api/stream`) and **polls** the DB every 1s (active) or `DASHBOARD_IDLE_TIMEOUT_MS/12` ≈5s idle (adaptive `ACTIVE_POLL_INTERVAL`/`IDLE_POLL_INTERVAL` + `maxClientsForAnyMeeting>3` throttle). Per-meeting `lastMtime` gate skips all 8 queries when `currentMtime===prevMtime`; `broadcast()` uses a 100-event `pendingQueues` backpressure buffer (drains on `desiredSize>0`, drops after 100; `SLOW_CONSUMER_TIMEOUT 30s`). `exportMarkdownStream` is `pull()`-based (not `start` drop). Events: `state`, `contributions` (`prompt_context:null` stripped in SSE, parity with REST `include_context=0`), `orchestrator_messages`, `turn_requests`, `participants`, `agent_error`, `artifact`. Terminal-state and artifact deduped via single `lastArtifactCreatedAt`/`stateStr` cache (not double-emit).
- **Meeting selection:** `/api/meetings` lists every `meetings/*.db` with question, status, round, convergence, created_at, participant count (sorted newest first). The UI auto-switches to the most recent.

### UI Tabs

- **Overview** — participants (cards with status/tier/model/reflection, contribution counts), recent contributions, turn requests, errors, an agent-perspective panel, and the final artifact when present.
- **Timeline** — per-round contribution timeline, orchestrator decision log (turn-order plans, summaries) interleaved per round, participation matrix, contribution-type chart, and inline reflection/query/evidence/summon/vote rows.
- **Output** — the final artifact with structured fields; export actions.

### Key API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/meetings` | List meetings |
| `GET /api/meeting?meeting=ID[&limit&offset]` | Full meeting payload (state, participants, contributions w/ pagination, turn requests, orchestrator messages, errors, artifact, embedding model metadata) |
| `GET /api/stream?meeting=ID` | SSE live updates |
| `GET /api/state`, `/api/state_stats` | Meeting state (with live flags) |
| `GET /api/contributions?meeting=ID[&since&limit&offset]` | Contributions, optionally incremental |
| `GET /api/orchestrator_messages?meeting=ID` | Orchestrator log |
| `GET /api/turn_requests`, `/api/agent_errors`, `/api/participants` | Per-meeting data |
| `GET /api/contribution_context?meeting=ID&contribution_id=N` | Full prompt context behind a contribution |
| `GET /api/agent_contexts`, `/api/agent_context?meeting=ID&participant=P` | Agent-level prompt context |
| `GET /api/artifact?meeting=ID` | Final artifact |
| `GET /api/export?meeting=ID[&format=markdown|json]`, `/api/export/stream` | Downloadable exports |
| `GET /api/models`, `POST /api/models/select` | Downloaded embedding models + embedder status; switch active embedding model |
| `GET /api/metrics` | Global metrics snapshot (Section 25) |
| `GET /api/health` | Liveness |

### Embedding Model Panel

On dashboard start, the embedding model is initialized eagerly (status tracked: idle → initializing → ready/error). `/api/models` lists downloaded models and the current status; `POST /api/models/select` hot-swaps the active embedder.

---

## 24. Meeting Lifecycle: From /knit to Report File

### The /knit Command

Exposed as a plugin tool (`knit`) — invoked when the user types `/knit <question>`.

**Args:** `question`, `context`, `participants` (custom room), `max_rounds` (default from config: 3), `models` (explicit per-tier assignment, e.g. `[{ tier: "senior", provider_id: "anthropic", model_id: "claude-sonnet-4-..." }]`), `meeting_timeout` (ms, `0` = no limit, max 3600000, default `0`), `dry_run` (preview room without deliberating), `fresh` (replace an existing meeting for the session).

### Handler Flow (`createKnitHandler`)

1. Discover models + session model; apply the optional model filter (`list_knit_models` / `enable_knit_models` / `disable_knit_models`, Section 26) to the pool.
2. If `fresh: true`, delete any existing meeting DB for the session.
3. If an existing meeting exists (and not `fresh`/`dry_run`) → **extend** (Section 18).
4. Otherwise compose a room (or use custom participants), assign models (honoring `models` per-tier overrides and per-participant `model`/`model_override`), and (optionally) preview with `dry_run`.
5. Insert the meeting row (before composition, satisfying the FK for persona embeddings), run composition, insert participants.
6. Construct `MeetingOrchestrator` (passing the filtered `availableModels` for fallback selection), run `initialize()` + `runMeeting()`.
7. Write the full report to `.opencode/loom/meetings/<meetingId>.md` and return a concise chat summary (decision line extracted from the artifact's `## Decision` section; suggestions to run `/loom_viz`).

### Progress Callbacks

The handler wires metadata callbacks to the chat context for live UX:
- `onContribution` — title `Loom R<n>: <name> (<type>)` + metadata (`loom_last_contributor`, `loom_last_type`, `loom_round`)
- `onRoundComplete` — round summary preview
- `onSynthesisStart` / `onSynthesisComplete` — synthesis status + output preview
- `onUpdate` — state logging

### Companion Tools

- `loom_status` — check a running Loom (status, round, contributions, meeting ID)
- `loom_cancel` — request cancellation (current round completes, then synthesis runs)
- `loom_debug` — dump internal state of a running Loom (optional `include` filter)
- `loom_viz` / `loom_stop` — start/stop the dashboard
- `list_knit_models` — discover available models, preview tier assignments (`createModelPlan`), showing cost/context/reasoning and current enabled/disabled status. `enable_knit_models` / `disable_knit_models` / `reset_knit_models` — manage a **session-scoped model filter**. The filter restricts which discovered models Loom agents may use; the preview also stages the plan for the next `/knit`. (See Section 26.)

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
  └── personas/<tier>/*.json           // user-authored personas (optional)
```

---

## 25. Metrics and Observability

### In-Memory Metrics (`metrics.js`)

A simple process-wide collector exposed via `/api/metrics` and `getMetricsSnapshot()` (circular `latencyBuffers` `TUNING.LATENCY_SAMPLE_LIMIT` 100, O(1) `recordLatency`):

- **Counter** — `llm_calls_by_type` (agent/synthesis), `retry_events` (`attempted`/`retry_success`/`exhausted` via `withRetry`), `breaker_events` (`open`/`half_open`/`closed`), `degradation_events`.
- **Latencies** — `llm_prompt_ms`, `synthesis_ms` (last `LATENCY_SAMPLE_LIMIT` samples; aggregated into count/avg/p50/p95/max via `latencyStats`).

RoundExecution records per-call tokens and `llm_prompt_ms` per agent call; synthesis records its own bucket. `getMetricsSnapshot()` is polled by dashboard `GET /api/metrics` and persisted per-meeting via `meeting_metrics` at synthesis.

### Per-Meeting Metrics

On meeting end the orchestrator persists `meeting_metrics` via `saveMeetingMetrics`: counters (LLM calls by type, token counts), duration_ms, rounds, contributions, turn request count. The dashboard can render these alongside the meeting.

### Logging

Structured JSON logs via `Logger` (circular `ringBuffer` `TUNING.RING_BUFFER_SIZE` 500 O(1) `ringBuffer[head]` + `orderedRing()`, `getRecentLogs` via `orderedRing()`; `getRingSize()` reads `TUNING` live) with recursive `SECRET_KEY_RE` redaction (`authorization|api_key|bearer|token|password|secret|privateKey|credentials` deep walk, `Bearer [REDACTED]`). Contexts: `meeting_id` (short form + `fullMeetingId`), `correlationId`, event name, and fields. Error paths are captured per participant in `agent_errors` and globally in `error_log`. Model-fallback events are observable as `model_fallback`/`model_fallback_failed` log events, an `agent_errors` row with type `model_fallback`, and a `⚠️ … falling back …` progress message.

---

## 26. Model Configuration

A recap of every knob that controls which LLM runs an agent or the orchestrator. Model configuration spans four layers:

### 1. Model Discovery & the Model Filter

`discoverModels()` (`src/services/model-service.js`) reads the connected providers via `client.provider.providers` and records the user session's current model as `sessionModel`. Deprecated models are excluded.

A **per-session deny-list model filter** (`disabledModelsBySession` in the knit handler, persisted per-session as `models-filter-<sessionId>.json` under `resolveLoomBaseDir(directory)`) is maintained with four tools:
- `/list_knit_models` — lists all discovered models with `provider/model` identifiers, cost, context window, reasoning capability, current enabled/disabled status, plus the proposed tier assignment plan (filtered preview — disabled models never proposed).
- `/enable_knit_models <id>…` / `/disable_knit_models <id>…` — restrict which discovered models Loom agents may use (`applyModelFilter` deny-list). Default (no filter) = all models; new models are enabled by default; disabling the last model leaves one enabled and warns.
- `/reset_knit_models` — clears the filter back to "all models" for that session.

The filter is per-opencode-session (stored via `sessionID`, also persisted per-session file for restart) and is applied to the discovery result before composition, assignment, and the `availableModels` list passed to the orchestrator for fallback selection. Explicit `knit models=[…]` overrides are validated against the filtered available set — disabled models injected via override or stale `pendingModels` are ignored.

### 2. Tier-Based Assignment

`assignModelsToParticipants()` → `assignModelsByTier()` is the single deterministic assignment engine (shared with the `list_knit_models` preview so both always agree):

- Models are sorted by a capability score (`scoreModel`: active status + context window + reasoning capability; cost is display-only).
- Principal/senior roles receive the session model (or the best available); mid/junior get the next-best unused models.
- **Model diversity** (`modelDiversity`, default true): when more distinct models are available than tiers, every individual agent gets a unique model (best models to the highest tiers) instead of sharing per tier.
- The pool itself can be pre-narrowed by the model filter (layer 1).

### 3. Per-Participant Overrides

Explicit configuration always wins over automatic assignment:

- **`/knit models=[{ tier, provider_id, model_id }]`** — per-tier override applied at composition (mapped into each participant's `model`).
- **Custom rooms** — participants may carry a `model` object `{ providerID, modelID }` or a `model_override` string `"provider/model"` (`buildOverrideMap`). Overridden models are also excluded from the diversity pool so they aren't double-assigned.

### 4. Orchestrator & Fallback Model Safeguards

- **Fast-path routing** (`fastPathModel`): cheap models for moderation/summary orchestrator calls; turn-order planning selects it itself (Section 21).
- **Model fallback** (`modelFallback.*`): a failed agent turn is retried on its model, then on a healthy fallback selected by `selectFallbackModel()` (Section 16).
- `getHighestTierModel()` acts as a safety net: `#getParticipantModel(participant, fallbackOnError)` substitutes the highest-tier healthy model whenever a participant's own model is missing or unhealthy (used by directives, votes, and synthesis).

The appendix table lists every model-related configuration key (`fastPathModel`, `circuitBreaker.*`, `modelFallback.*`).

---

## Appendix: Key Configuration Values

Loaded from `.loomrc.json` (project or `~/.config/opencode/.loomrc.json`), or the legacy `opencode.json` `"loom"` key. Validated and merged over defaults; unknown keys warn and are ignored. `DEFAULT_CONFIG.tuning` is `JSON.parse(JSON.stringify(TUNING))` deep-clone (not ref) — per-meeting `createMeetingConfig()` deep-freezes.

`TUNING` (23 keys, `src/config/defaults.js:1`): `MAX_ITERATIONS 100` (weaving loop guard `weaving.js:71`), `WATCHDOG_TICK_MS 30000` (`stall-watchdog.js:47`), `RING_BUFFER_SIZE 500` (`logger.js:9`), `SKIP_PASSED_*` (3,10,2), `EXTENSION_EXTRA_ROUNDS_FALLBACK 4`, `MAX_CRITIQUE_RETRIES 2` (`synthesis-coordinator.js:10`), `SYSTEM_PROMPT_CACHE_MAX 50` (`prompts/agent.js:10`), `EMBEDDING_CACHE_MAX 512` (`persona-index.js:15`), `LATENCY_SAMPLE_LIMIT 100` (`metrics.js:19`), `DASHBOARD_IDLE_TIMEOUT_MS 60000` (`poll.js:60`), `MAX_DB_CACHE_SIZE 10` (`dashboard/api.js:11`), `VOTE_TIMEOUT_MS 60000`/`SUMMON_TIMEOUT_MS 90000` (`vote-summon.js:175,317`), `FABRIC_CHUNK_MAX_TOKENS 512`/`VEC_SEARCH_TOPK 10`/`CONTEXT_CHAR_PER_TOKEN 4` (`vector-index.js:101`), `CONTENT_TRUNCATION`/`TRANSCRIPT_BUDGET`/`STATE_OF_PLAY` budgets, `TERMINAL_STATUSES` (`constants.js:3`) central.

DB fresh `meetings`/`participants`/`fabric_chunks` enforce `CHECK` + `UNIQUE` + `FK` at `initSchema()`; `storeFabricChunk` always `BEGIN IMMEDIATE`.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `agentTimeoutMs` | 240,000 | Per-agent LLM call timeout (fixed — no failure-based reduction) |
| `synthesisTimeoutMs` | 180,000 | Synthesis draft/critique call timeout |
| `maxTurnRequestWords` | 200 | (Reserved — not enforced by current planner) |
| `defaultMaxRounds` | 3 | Default meeting rounds |
| `minRounds` | 2 | Minimum rounds before the meeting can end (agents cannot pass before this) |
| `fastPathModel` | `""` | Model for cheap orchestrator calls (empty = disabled) |
| `maxRetryAttempts` | 2 | Retries for session creation / orchestrator prompts |
| `retryBaseDelayMs` | 1,000 | Base retry delay |
| `retryMaxDelayMs` | 8,000 | Max retry delay |
| `synthesisMaxRetries` | 1 | Draft section-repair retries |
| `defaultMeetingTimeoutMs` | 0 | Absolute meeting deadline disabled (no limit; stall/token/user cancel only) |
| `stallTimeoutMs` | 600,000 | Inactivity stall timeout (watchdog ticks every 30s) |
| `modelDiversity` | `true` | Give each agent a distinct model when enough are available |
| `turnRequestThresholds.autoGrant` | `9` | (Reserved — not exercised) |
| `maxTurnRequestsPerRound` | `3` | (Reserved — not exercised) |
| `maxSummonsPerRound` | `2` | Summoned experts per round |
| `maxSummonsPerAgent` | `1` | Summons per agent per round |
| `circuitBreaker.failureThreshold` | `3` | Consecutive failures before a model is marked unhealthy |
| `circuitBreaker.resetTimeoutMs` | 300,000 | Half-open test window for an unhealthy model |
| `modelFallback.enabled` | `true` | Master switch for agent-turn retries + fallback model selection (Section 16) |
| `modelFallback.maxRetriesPerModel` | `2` | Retries on the same model before falling back |
| `modelFallback.maxFallbackAttempts` | `1` | Retries on the selected fallback model |
| `sameTurnSynthesis` | `true` | Peer responses returned inline for same-turn synthesis (Section 22) |
| `agentTools.*` | (see Section 20) | Tool enablement — built-in tools + loom plugin tools (query/vote/summon/request_next/pass/vector_search) |
| `DEFAULT_EMBEDDING_MODEL` | `"Snowflake/snowflake-arctic-embed-xs"` | Default embedder for PersonaIndex and vector search (warmed up on dashboard start) |
| `DEFAULT_EMBEDDING_QUANT` | `"onnx/model_int8.onnx"` | ONNX quantization variant used by the embedder |
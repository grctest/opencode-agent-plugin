# The Loom Orchestration Architecture

A complete technical reference for how the Loom multi-agent deliberation system works, from user input to final output. Every LLM prompt, every data structure, every decision point. Written for someone who cannot read the source code.

---

## Table of Contents

1. [End-to-End Flow Summary](#1-end-to-end-flow-summary)
2. [Meeting Creation](#2-meeting-creation)
3. [Agent Architecture](#3-agent-architecture)
4. [What Agents See and Produce](#4-what-agents-see-and-produce)
5. [Round Execution](#5-round-execution)
6. [Turn Ordering](#6-turn-ordering)
7. [LLM Session Architecture](#7-llm-session-architecture)
8. [Moderator System](#8-moderator-system)
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
22. [Directed Interactions: Query, Evidence, Summon, Vote](#22-directed-interactions-query-evidence-summon-vote)
23. [Dashboard System](#23-dashboard-system)
24. [Meeting Lifecycle: From /knit to Report File](#24-meeting-lifecycle-from-knit-to-report-file)
25. [Metrics and Observability](#25-metrics-and-observability)
26. [Model Configuration](#26-model-configuration)

---

## 1. End-to-End Flow Summary

When a user types `/knit` with a question, this is what happens:

1. **Room composition** — The question is analyzed for complexity, then a team of 2–7 agents is assembled without any LLM call: each per-tier role is filled by the persona (from `personas/<tier>/*.json`) whose embedded description is most semantically similar to the question (via `PersonaIndex`). Each agent gets a name, persona description, agenda, tier, and topic tags.
2. **Model assignment** — Each agent is assigned an LLM model. Principal/senior tiers get the top available model (the session's model when present); remaining tiers get the next-best unused models. Explicit per-participant `model`/`model_override` fields win over automatic assignment. The discovery pool can be narrowed with a per-session model filter (`/knit_models enable/disable`, Section 26).
3. **Rounds execute** — A round is a single sequential prompt phase:
   - Each agent speaks in turn via a fresh **ephemeral** LLM session, seeing the state of play, vector-RAG context, recent contributions, and their own prior reflection.
   - After a challenge or dissent, the single **most persona-similar** active participant (excluding the challenger) is selected via embeddings to reflect on it immediately (mid-round reflection).
   - Agents may also issue `[QUERY]`, `[EVIDENCE]`, `[SUMMON]`, and `[CALL_VOTE]` directives, which are executed immediately after their turn (Section 22).
4. **Round summarization** — After all agents speak, the round is summarized (heuristically always; semantically when conflict exists in `moderator_forces` mode).
5. **State of play update** — The state of play (decisions, agreements, disagreements, open questions, key facts) is regenerated from the full weave.
6. **Moderator check + turn order planning** — The moderator may rule `converge`, `break`, or `continue`; the moderator then plans the next round's turn order based on `[REQUEST_NEXT]` tags.
7. **Termination** — The meeting ends when (a) the moderator rules `converge` after the minimum round count, (b) all participants have passed or failed, or (c) the round limit is reached. Hard timeouts (absolute deadline, stall watchdog) and user cancellation also terminate the meeting.
8. **Synthesis** — One agent (typically the principal) synthesizes all contributions into a structured artifact with Decision, Reasoning, Action Items, Dissenting Views, Open Questions, and Confidence, then self-critiques it.
9. **Output** — A concise chat summary plus a full markdown report saved to `.opencode/loom/meetings/<meetingId>.md`. The live dashboard can be started with `/loom_viz`.

---

## 2. Meeting Creation

### Step 1: Complexity Analysis

`composeRoomWithSimilarity(question, seed, db)` scores the question:

- **Word count:** >30 words → +2, >15 words → +1
- **Question marks:** more than one `?` → +1
- **Multiple dimensions:** presence of and/or/vs/compare/tradeoff/pros-cons → +2
- **Conditionals:** if/when/assuming/given that/depending on/considering → +1
- **Stakeholders:** team/customer/user/client/stakeholder/executive/leadership → +1

Score → complexity: **high** (≥5), **medium** (≥3), **low** (<3).

The team size is derived from complexity (high=5, medium=4, low=3), clamped to 2–7. Role lists are generated by size:

```
count ≤ 3:  [mid, junior, junior]
count ≤ 5:  [senior, mid, junior, junior, junior]
else:       [senior, mid, mid, junior, junior, junior, junior]
```

Then a seniority boost is applied: `high` shifts every tier up one level, `low` shifts everyone down one level (e.g. high → `[principal, senior, mid, mid, junior, junior, junior]`).

> **Note:** `composeRoomWithSimilarity(question, seed, db)` accepts a `seed` argument but
> the composition is actually driven purely by the question's similarity search — the seed
> is ignored. The `seed` argument and its `/knit` surface are candidates for removal
> (see `docs/dead-code-review.md` §7).

### Step 2: Similarity-Based Persona Selection

There is **no LLM domain detection** — the now-removed `domain` pipeline was replaced by embedding-based selection.

1. All personas are loaded from JSON files (`personas/<tier>/*.json`, or legacy `<tier>.json` arrays) and embedded into the meeting database via `PersonaIndex.indexAll()` (tables `persona_embeddings` + `vec_persona_embeddings`, FK to `meetings(id)`).
2. For each role tier in the role list, `PersonaIndex.search(question, tier, 5)` returns the 5 most similar personas for that tier; the first persona not already used is selected.
3. ~(Seeded PRNG note removed — the seed arg is not used, see note above. Selection is deterministic given the same question and persona index.)
4. Meeting-level `tags` are derived from the selected participants' most common tags (top 3).
5. Estimated rounds: high=4, medium=3, low=2.

If the embedding service is unavailable, composition falls back to an empty room and the handler falls back gracefully.

**Custom rooms:** Passing `participants` to `/knit` skips composition entirely. Each participant requires `name`, `persona`, `agenda`, `tier` (an `id` is derived; `tags`/`expertise` default to `["general"]`).

**Prioritization for a meeting row:** the meeting row is inserted into the database *before* composition so the FK constraint on `persona_embeddings(meeting_id)` is satisfied.

### Persona Loading

Personas live under `<plugin>/personas/<tier>/*.json` (tier directories), with fallback to legacy `<tier>.json` arrays. User-authored personas in `~/.config/opencode/loom/personas/<tier>/` are merged in (user personas take precedence, loaded after the bundled ones; duplicates by name are dropped). Persona files are cached for 60 seconds. Each persona is validated: `name` present, `persona` >50 chars, `agenda` >20 chars, and `tags` present (legacy `domain`/`domains` fields are normalized to `tags`). Each persona has `name`, `persona` (description), `agenda`, `tags`, optional `expertise`, `known_biases`, `communication_style`, `preferred_contribution_types`, `anti_patterns`, `tier_guidance`, and `reflection_guidance`.

### Step 3: Model Assignment

Models are discovered from the connected providers via `discoverModels()` (`provider.providers` API), with the user session's current model recorded as `sessionModel`. The discovery result may be narrowed by the `/knit_models` model filter (Section 26). If a session model can't be discovered the discovery result is empty (agents just carry their session model).

`assignModelsToParticipants()` uses `assignModelsByTier()` (a single deterministic engine shared with the `/knit_models` preview so the two always agree):

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

| Tier | Temperature | `[REQUEST_NEXT]` Priority Cap | Rights |
|------|------------|-------------------------------|--------|
| junior | 0.7 | 5 | contribute, request_turn |
| mid | 0.5 | 7 | contribute, request_turn, call_vote |
| senior | 0.3 | 9 | contribute, request_turn, call_vote, veto |
| principal | 0.2 | 10 | contribute, request_turn, call_vote, veto, force_end |

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
  tier_config: { temperature: 0.3, rights: { contribute: true, request_turn: true, call_vote: true, veto: true, force_end: false } },
  embedding: Float32Array /* loaded at init when embedder is available — used for reflection targeting */,
  status: "listening",      // listening | speaking | passed | failed
  reflection: "The JWT migration makes sense, but token revocation is unsolved.",
  contributions_count: 2
}
```

Note: `session_id` and persistent session tracking are gone — agents use ephemeral sessions with no stored session handle.

---

## 4. What Agents See and Produce

Every agent LLM call involves two prompts: a **system prompt** (identity + rules) and a **user prompt** (state of play + context + question).

### The System Prompt

Every agent receives this system prompt (built by `buildAgentSystemPrompt`):

```
You are **Security Engineer** (senior) in a structured multi-agent deliberation called "Loom."

## Your Identity
A seasoned application security engineer with 12 years of experience in
authentication, encryption, and threat modeling. Tends to think in attack
vectors and worst-case scenarios.

## Your Agenda
Ensure all proposed solutions meet security baselines and don't introduce
new attack surfaces.

## Your Disposition
You are prone to these known tendencies — name them when they might be
coloring your view, and actively check them:
- Over-indexes on security at the expense of UX
Communicate in this register: Technical and precise, references OWASP and CVE patterns
You naturally contribute via: challenge, refine. Lean into these, but stay
open to others when the moment calls for it.

## What NOT to Do
- Sweeping generalizations without evidence

## Your Tier Guidance
Prioritize accuracy and risk assessment. Cite patterns from experience.
Be conservative with claims but commit fully when you do. Flag irreversible
decisions.

## Rules
1. Read the shared context and recent contributions carefully
2. If you have something meaningful to add, state your position clearly with supporting reasoning
3. If you have nothing to add, respond with exactly: [PASS]
4. Tag your type: [PROPOSE], [CHALLENGE], [REFINE], [SUPPORT], [DISSENT],
   [SYNTHESIZE], [QUESTION], or [REFUSE]
5. To request priority for the next round, add:
   [REQUEST_NEXT: Priority: <1-9>, Reason: "why you must speak next round"]
   — place this at the end of your response
6. Stay in character — your persona and agenda shape your contributions
7. Reference prior contributions using their stable ID from the Recent
   Contributions list, e.g. [#12]
8. To query a specific participant directly:
   [QUERY: @participant_id] your question — their response appears as a
   contribution. Max 2 targets.
9. To request evidence from a participant:
   [EVIDENCE: @participant_id] your evidence question — they must use tools
   to find concrete evidence. Max 2 targets.
10. To summon an external expert persona:
    [SUMMON: Persona Name] the issue you want addressed — they contribute a
    single response using your model. Use sparingly (max 1 per turn).

## Research Tools (when agent tools are enabled)
... (see Section 20)

## Example Response
[CHALLENGE] The proposed approach doesn't account for backward compatibility. ...

## Example With Turn Request
[PROPOSE] We should adopt a phased migration over Q1 and Q2. ...

[REQUEST_NEXT: Priority: 8, Reason: "Need to directly counter the Architect's
claim about stateful overhead before we move to action items"]

## Example With Query
[CHALLENGE] The migration timeline assumes no integration conflicts...

[QUERY: @staff-architect] Based on the service dependency graph, which
migrations are most likely to collide?

## Example With Evidence Request
[CHALLENGE] The budget projections assume 30% YoY growth but industry
benchmarks show 12-15% for this sector.

[EVIDENCE: @data-scientist] Find current industry growth benchmarks for SaaS
companies in this vertical.

## Example With Summons
[PROPOSE] We need to evaluate the security implications of this change...

[SUMMON: Security Engineer] What are the attack surfaces introduced by the
new authentication flow?
```

### The User Prompt (Golden Sandwich)

Each agent's user prompt is built by `buildAgentUserPrompt`. The prompt follows the **Golden Sandwich** pattern — a bounded, stateless prompt that carries all necessary context without accumulating history. Concrete example for a mid-tier agent in round 3:

```
## Question
Should we migrate our authentication service to JWT tokens?

## Tags: engineering, security

## Round 3

<<<LOOM_STATE_OF_PLAY>>>_BEGIN_
## Question
Should we migrate our authentication service to JWT tokens?

## Tags
engineering, security

## Decisions & Proposals
- We should adopt a phased migration over Q1 and Q2, starting with the auth service

## Agreements
- Short-lived access tokens (5 min) are essential

## Disagreements & Concerns
- Token revocation remains unsolved — blocklists defeat statelessness

## Open Questions
- How will existing sessions be handled during the transition?

## Key Facts
- [Query response] Refresh tokens on the client are recoverable by design
<<<LOOM_STATE_OF_PLAY>>>_END_

<<<LOOM_RELEVANT_PRIOR_CONTEXT>>>_BEGIN_
[Round 1] The team agreed on phased migration but split on refresh token storage
<<<LOOM_RELEVANT_PRIOR_CONTEXT>>>_END_

<<<LOOM_CONTRIBUTIONS>>>_BEGIN_
- [#4] [senior_architect] (propose): [PROPOSE] We should use a hybrid approach...
- [#5] [mid_security_engineer] (challenge): [CHALLENGE] Server-side refresh tokens...
- [#6] [junior_backend_dev] (challenge): [CHALLENGE] We're going in circles...
<<<LOOM_CONTRIBUTIONS>>>_END_

## Your Reflection
The JWT migration makes sense, but token revocation is unsolved.

## Your Turn
Read the state of play, relevant context, and recent contributions. Then
make your contribution or pass.
```

Note the structure:
- **State of Play**: structured summary of decisions, agreements, disagreements, open questions, and key facts derived from ALL prior contributions. The primary running context. (Section 11.)
- **Relevant Prior Context**: semantically retrieved prior contributions via the vector index. Bounded to 5 results, excluding the current round.
- **Recent Contributions**: the last 3–4 contributions from the current and previous rounds, with stable IDs like `[#4]`.
- **Reflection**: the agent's own latest reflection raw text (no header).
- **Delimiters**: every untrusted block is wrapped in `<<<LOOM_LABEL>>>_BEGIN_` / `<<<LOOM_LABEL>>>_END_` to prevent prompt injection and boundary confusion. An empty section is omitted.

### What Agents Produce

An agent response is a text string. The system parses it for structured directives (`parseAgentResponseRaw` → Zod `AgentResponseSchema`):

**Type tags** (exactly one required, at the start):
- `[PROPOSE]` — a new idea or suggestion
- `[CHALLENGE]` — questioning an existing idea
- `[REFINE]` — improving on someone else's proposal
- `[SUPPORT]` — agreeing with and reinforcing a point
- `[DISSENT]` — disagreeing with the majority
- `[SYNTHESIZE]` — combining multiple ideas
- `[QUESTION]` — asking for clarification
- `[REFUSE]` / `[REFUSE: reason]` — declining to engage, with optional reason
- `[PASS]` (alone) — nothing to add

**Optional directives:**
- `[REQUEST_NEXT: Priority: N, Reason: "..."]` — request priority for the *next round* (priority capped by tier)
- `[QUERY: @id1, @id2] question` — direct a question at 1–2 participants
- `[EVIDENCE: @id1, @id2] question` — demand tool-backed evidence from 1–2 participants
- `[SUMMON: Persona Name] issue` — bring in an external expert persona
- `[CALL_VOTE] question` — call a poll; every other active participant casts a `[Vote: X]` vote and a tally is produced (Section 22)

**Content** follows the tag. Example full response:

```
[CHALLENGE] The short-expiry-with-refresh approach assumes refresh tokens
can't be stolen. In practice, refresh tokens are long-lived and stored
client-side, making them a high-value target. [#2] raises a valid point.

[EVIDENCE: @data-scientist] Find current industry benchmarks for long-lived
session tokens in SaaS products.
```

The system parses this into:

```javascript
{
  type: "challenge",
  content: "The short-expiry-with-refresh approach assumes...",
  request_next: null,
  query: null,
  evidence: { targets: ["data-scientist"], question: "Find current industry benchmarks..." },
  summon: null,
  vote: null
}
```

If the parsed response fails schema validation, the system falls back to type `challenge` so the contribution is still visible. Directive tags (`[REQUEST_NEXT]`, `[QUERY]`, `[EVIDENCE]`, `[SUMMON]`, `[CALL_VOTE]`) and type tags are stripped from the stored content. There is **no hard word-limit enforcement** on contributions (the old `maxContributionWords` setting was removed).

Note: `[CALL_VOTE]` is recognized and executed by the parser/handler, but it is not advertised in the built-in agent system prompt's rules (Section 4, The System Prompt) — the vote flow is fully wired on the parsing and execution side.

---

## 5. Round Execution

Each round is a single, strictly sequential **prompt phase**. Each agent speaks one at a time via a fresh ephemeral session, seeing all prior same-round contributions (plus query/evidence/summon responses and reflections) as they are produced.

### Prompt Phase (with Directed Interactions + Mid-Round Reflections)

For each agent, the system:

1. Sets status to "speaking" (visible in dashboard).
2. Checks if the assigned model's circuit breaker is healthy (`isModelHealthy`). If the model is unhealthy, a healthy fallback model is selected immediately and used for the turn (Section 16).
3. Calculates an **adaptive timeout**: base `agentTimeoutMs` (120s), reduced by up to 50% as more agents fail in this round.
4. Builds vector-RAG context: the query text is the last 2 rounds' contributions (or the question if none yet); `retrieveRelevant(query, 5, currentRound)` returns up to 5 chunks, excluding the current round.
5. Creates a fresh ephemeral LLM session for this single turn.
6. Registers the ephemeral session → meeting mapping (for tool resolution).
7. Sends the system prompt + Golden Sandwich user prompt, with a **boolean tool map** when agent tools are enabled (e.g. `{ web_fetch: true, loom_vector_search: true }`).
8. Extracts the response with `extractAgentResponse()` (returns the **last** TextPart, all completed/error ToolParts, and any reasoning blocks).
9. Sanitizes the content to prevent prompt injection.
10. Parses type tags and directives with `parseAgentResponse()`; Zod-validates; falls back to type `challenge` on failure.
11. Stores the contribution plus any `[REQUEST_NEXT]` turn request.
12. **Executes directives immediately after the contribution is stored:**
    - `[QUERY]` → `executeQueries()` — target replies (Section 22)
    - `[EVIDENCE]` → `executeEvidenceRequests()` — target researches (Section 22)
    - `[SUMMON]` → `executeSummons()` — expert persona joins briefly (Section 22)
    - `[CALL_VOTE]` → `executeVote()` — all other active participants cast a vote and a tally is produced (Section 22)
13. **Mid-round reflection:** if the contribution is a `challenge` or `dissent`, the system selects the single **most persona-similar active participant** (embedding cosine similarity of the challenge text against participant embeddings, excluding the challenger) and triggers an immediate reflection (Section 12).
14. Restores status, cleans up the session→meeting mapping, and deletes the ephemeral session.

Note: on a failed prompt (`#promptChildSession` returns `null` after retries and model fallback are exhausted), the agent's status is set to `failed`, an error record is written, and the agent is skipped for the rest of the round. Agents that respond `[PASS]` are set to `passed`.

**Example mid-round flow:**

Agent lineup: [Agent 1, Agent 2, Agent 3, Agent 4]

1. Agent 1 speaks → contribution added to weave
2. Agent 2 speaks with `[CHALLENGE]` → contribution added to weave; **Agent 2 also emits `[QUERY: @Agent1]`** → Agent 1 is prompted to respond, producing a `query_response` contribution
3. **Reflection phase:** the most persona-similar active participant (say Agent 3) reflects on Agent 2's challenge → `reflection` contribution added to weave
4. Agent 4 speaks → sees Agent 2's challenge, Agent 1's query response, and Agent 3's reflection in its "recent contributions"

### Post-Phase: Turn Order Planning + Round Summarization + Finalization

After the prompt phase:

1. **Round summarization** (`summarizeRound`, Section 13) — heuristic always; LLM semantic summary when conflict exists in `moderator_forces` mode.
2. **State of play update** — `updateStateOfPlay(weave, question, tags)` regenerates the structured summary (Section 11).
3. **Vector indexing** — `VectorIndex.indexRound()` embeds the round summary and contributions asynchronously (best-effort).
4. **Moderator check** — `checkAndProcess()` may rule `converge`, `break`, or `continue` (Section 8).
5. **Turn order planning** — unless the moderator forced a `break`, `planTurnOrder()` produces the next round's ordered participant list (Section 9).
6. **Termination checks** — moderator `converge`, all participants passed/failed, or `current_round >= max_rounds` (Section 10).

The round summary and state of play are persisted to the database.

---

## 6. Turn Ordering

**Default order:** Agents speak in composition order (the order they appear in the participants array). There is no randomization.

**Turn request override:** At the end of each round, `planTurnOrder()` is invoked with the round's `[REQUEST_NEXT]` requests (Section 9). The resulting JSON array of participant IDs is stored as the `planned_turn_order` and applied by `RoundInitializer.filterActiveParticipants()` at the start of the next round.

**Moderator break ruling:** If the moderator rules `break`, the directed participant (by ID) is set as `next_speaker_id`; `reorderForNextSpeaker()` moves them to position 0 for the next round, and no LLM turn-order planning runs.

**Skip-passed logic:** From round 3 onward, if a participant passed within the last 2 rounds (lookback window of 10 contributions) and has no reflection since their last pass, they are excluded from the active list for the next round. A progress message is emitted (e.g. *"⏭️ Skipped: Agent X (inactive, no new reflections)"*).

**When no turn requests exist:** No LLM call is made. `planTurnOrder` returns the default composition order of non-failed participants. (Previously this claim was accompanied by a now-removed intra-round "queue jump" mechanism — that behavior no longer exists.)

---

## 7. LLM Session Architecture

### Stateless Ephemeral Sessions

The system uses **ephemeral sessions** for all agent turns and orchestrator system calls:

```
Parent Session (user's opencode chat)
  ├── Ephemeral Session: Architect Lead (round 1, turn 1) → deleted after use
  ├── Ephemeral Session: Security Engineer (round 1, turn 2) → deleted after use
  ├── Ephemeral Session: query response (Security Engineer) → deleted after use
  ├── Ephemeral Session: reflection (Architect Lead) → deleted after use
  ├── Ephemeral Session: Orchestrator (moderation) → deleted after use
  ├── Ephemeral Session: Orchestrator (turn order) → deleted after use
  ├── Ephemeral Session: Architect Lead (round 2, turn 1) → deleted after use
  ├── Synth Session: Synthesizer (draft + critique) → deleted after use
  └── ...
```

**Why ephemeral?** Each call creates a fresh session (with `parentID` pointing at the user's main session), sends a self-contained prompt (all context passed explicitly), receives a response, and deletes the session. This means:
- **O(1) token growth per turn** — no accumulated history from prior turns
- **No session state drift** — each turn starts clean
- **No session recreation needed** — if a turn fails, the next turn just creates a new ephemeral session
- **Lower memory footprint** — no persistent session history stored server-side

Session creation itself is wrapped in `withRetry` (`maxAttempts = maxRetryAttempts`, exponential backoff 1s → 2s → 4s → 8s with jitter) because session-creation API calls can transiently fail.

### Creating an Ephemeral Session

```javascript
const ephemeralSessionId = await sessionManager.createEphemeralSession(participant);
// → withRetry(client.session.create({ body: { parentID, title: `Loom · Ephemeral · <name>` } }))
```

### Prompting an Agent (Ephemeral)

```javascript
const sessionId = await createEphemeralSession(participant);
sessionManager.registerSessionMeeting(sessionId, meetingId);   // tool resolution
try {
  const result = await client.session.prompt({
    path: { id: sessionId },
    body: {
      system: buildAgentSystemPrompt(participant),
      model: participant.tier_config.model,
      temperature: participant.tier_config.temperature,
      parts: [{ type: "text", text: buildAgentUserPrompt(...) }],
      tools: toolsMap,   // boolean filter map, e.g. { web_fetch: true }
    },
    query: { directory },
  });
  const { text, toolResults, reasoning } = extractAgentResponse(result.data);
  // ... parse & store
} finally {
  sessionManager.unregisterSession(sessionId);
  await deleteEphemeralSession(sessionId);
}
```

`extractAgentResponse()` handles all Part types:
- **TextPart**: returns only the **last** TextPart (pre-tool text is noise)
- **ToolPart**: results in "completed" or "error" state — never pending/running
- **ReasoningPart**: thinking blocks (Claude 3.7, o1-style reasoning), returned separately
- **FilePart, StepStart/FinishPart, SnapshotPart, etc.**: informational (ignored)

### Prompting the Orchestrator (Ephemeral)

All orchestrator calls (moderation, turn order, semantic summary) use fresh ephemeral sessions via `SessionManager.promptOrchestrator()`, which also retries on transient failures:

```javascript
async promptOrchestrator(system, model, message) {
  const sessionId = await this.#createSessionWithRetry("Loom · Orchestrator (ephemeral)");
  try {
    const result = await withRetry(client.session.prompt({ path: { id: sessionId }, body: { system, model, tools: {}, parts: [...] } }));
    return { text: extractText(result.data), tokens: result.data?.tokens };
  } finally {
    this.deleteEphemeralSession(sessionId);
  }
}
```

**Why ephemeral here too?** The old design used a persistent orchestrator session, which caused context pollution between unrelated calls and unbounded token growth. Ephemeral calls are stateless; anything that must persist (like the moderator's previous rulings) is passed explicitly in the prompt text.

Context that should be *visible* to the user is posted to the parent session via `session.promptAsync({ body: { noReply: true, parts: [text] } })` — `postProgress()`.

### Circuit Breaker

Each model used by agents tracks consecutive failures via the circuit breaker (Section 16). An unhealthy model is not used for turns — a healthy fallback model takes its place — and after the reset timeout one test attempt is allowed.

---

## 8. Moderator System

### When the Moderator Is Consulted

`checkAndProcess()` runs every round, but the LLM ruling is **gated by thresholds** (`moderatorTrigger`, defaults `{ minContributions: 3, recentChallenges: 2, lookbackWindow: 4 }`) — it short-circuits without spending tokens when conditions aren't met:

1. Fewer than 3 contributions in the current round → `{ action: "continue" }` immediately.
2. Fewer than 2 challenges/dissents in the last 4 contributions → `{ action: "continue" }` immediately.
3. **Consensus short-circuit:** if none of the recent contributions are challenges or dissents → `{ action: "continue" }` immediately (the moderator exists to resolve deadlocks; if everyone agrees there's nothing to resolve).

When thresholds are exceeded, the situation is refined (a "circular argument" situation or a "repeated challenger: X has challenged 3+ times in the last 6 contributions" situation), and the moderator LLM evaluates whether to:
- **continue** — the deliberation is still productive
- **break** — force a specific participant to speak next (circular argument/deadlock)
- **converge** — the deliberation has reached its natural end

### The Moderator Prompt

```
You are the MODERATOR of a structured multi-agent deliberation. You do NOT
contribute opinions or domain knowledge. Your ONLY job is process governance.

## Your Authority
- Resolve deadlocks when two participants claim equal priority
- Cut off circular arguments (3+ exchanges with no new information)
- Declare convergence when all participants have passed
- Force synthesis when maximum rounds are reached
- Ensure all voices are heard fairly

## Rules
- Favor the participant who has spoken less recently
- Favor the participant whose point is more on-topic
- When in doubt, let the original speaker continue
- Your rulings are final
- Be consistent with your previous rulings unless circumstances have changed
  materially

## Your Previous Rulings (for consistency)
  1. Round 2: Direct Junior Dev to speak → junior_backend_dev
  2. Round 4: Continue → continue

## Current State of Play
## Question
Should we migrate our authentication service to JWT tokens?
... (full state of play included) ...

## Situation Requiring Your Ruling
Participant mid_security_engineer has challenged/dissented 3+ times in the
last 6 contributions across rounds. Possible circular argument or deadlock.

## Deliberation State
Round: 4/6
Contributions so far: 14
Last 3 contributions:
  - [CHALLENGE] JWT revocation is a solved problem with blocklists...
  - [CHALLENGE] Blocklists defeat the purpose of stateless auth...
  - [CHALLENGE] We're going in circles on statelessness vs revocation...

## Respond With Your Ruling
<ruling>
decision: <one sentence ruling>
next_speaker: <participant_id or "synthesize" or "continue">
reason: <brief justification>
</ruling>

IMPORTANT: Respond ONLY with the <ruling> block above. Do not include any other text.
```

### Ruling Types

1. **converge** — `next_speaker: "synthesize"` (or the decision mentions converge/wrap up). The deliberation ends — but only if `current_round >= minRounds` (default 2); otherwise convergence is deferred with a progress message.
2. **break** — `next_speaker: "<participant_id or name>"`. A specific agent is ordered to speak first next round. The target must be an active (non-passed, non-failed) participant.
3. **continue** — `next_speaker: "continue"` (or parse failure). No intervention needed.

### Ruling Processing

- **Deferred convergence** below `minRounds` — the moderator can't end the meeting too early.
- **Rulings are tracked** (up to 50) and included in subsequent moderator prompts for consistency.
- **Break targets only active participants** — a `break` for a passed/failed agent is ignored.
- **Fallback parsing:** if the response contains no `<ruling>` block, the parser looks for keywords like "converge"/"synthesize"/"wrap up" and defaults to convergence; otherwise it treats the raw text as the decision and continues.
- The moderator only ever runs via `#promptOrchestrator` with type `"moderation"` (fast-path-routable, Section 21).

---

## 9. Turn Order System

### How Turn Requests Work

During the prompt phase, an agent can embed a `[REQUEST_NEXT]` tag to request speaking priority for the **next round**:

```
[CHALLENGE] The refresh-token approach underestimates token theft risk from
client-side storage. I need time to lay out the mitigations.

[REQUEST_NEXT: Priority: 8, Reason: "I have concrete mitigations for the
token theft concern and need to present them before the round closes"]
```

The parser caps the priority at the requesting agent's tier cap (junior 5, mid 7, senior 9, principal 10) via `getPriorityCap`. `[REQUEST_NEXT]` carries only `priority` and `reason` — the "Target" field and intra-round queue-jumping from earlier designs were removed.

### Turn Request Resolution (`planTurnOrder`)

Running at the end of each round (unless the moderator forced a `break`):

1. **No requests** → return the default composition order of all non-failed participants (no LLM call).
2. **Single valid request** → programmatically move the requesting agent to position 0 (no LLM call).
3. **Multiple requests** → filter to valid requesters (participant exists and isn't failed), then prompt the planner via `buildTurnOrderPrompt`, which returns a JSON array of participant IDs:

```
You are the turn order planner for a multi-agent deliberation.

## Current State of Play
...

## Last Round Summary
...

## Agent Turn Requests
  - mid_security_engineer (Security Engineer, mid): Priority 8 — "..."

## Active Participants
  - senior_architect (Architect Lead, senior)
  - ...

## Task
Return a JSON array of participant IDs ordered by who should speak first
to push the deliberation forward efficiently.

Rules:
1. Higher priority requests should generally speak first
2. Tie-break by: (1) who spoke least recently, (2) seniority tier
   (principal > senior > mid > junior)
3. Ensure all active participants get a turn
4. Consider the State of Play to avoid circular arguments
5. If no requests, return participants in their current order

Respond with ONLY a JSON array of participant IDs: ["id1", "id2", "id3"]
```

The planner runs on the **fast-path model** when configured (otherwise the highest-tier model) and the resulting array is validated against the participant list (unknown IDs dropped, missing participants appended). On LLM failure a deterministic fallback sorts by priority descending, then tier.

4. The ordered list is stored as `planned_turn_order` (and its head as `next_speaker_id`) and applied by `RoundInitializer.filterActiveParticipants()` next round.

Note: config keys `maxTurnRequestsPerRound`, `turnRequestThresholds.autoGrant`, and `maxTurnRequestWords` exist in the config schema but are **not exercised** by the current planner (they are reserved/dormant).

---

## 10. Convergence Detection

Convergence is deterministic and integrated into round finalization — there is no separate LLM "convergence check" anymore (the old weighted 9-check and 2-check protocols were removed).

The meeting terminates when any of these hold after a round:

| Condition | What it does |
|-----------|--------------|
| Moderator rules `converge` (after `minRounds`, default 2) | natural end — highest priority |
| All participants have passed or failed (`activeCount === 0`) | early termination |
| `current_round >= max_rounds` | guaranteed termination |

The old `convergence` argument (`consensus` / `majority` / `moderator_forces`) was removed from the `/knit` contract entirely; the `meetings.convergence` column persists only as a display label (see `docs/removing-convergence-system.md`). Termination is deterministic (see table above). Hard timeouts (absolute meeting timeout, stall watchdog) and user cancellation also stop the weave loop and proceed to synthesis.

Terminal statuses: `converged`, `cancelled`, `timeout`, `max_rounds_reached`, `aborted`, `deadlocked` (the last two surface via the state machine but are not produced by the current orchestration paths; `max_rounds_reached` and `deadlocked` are reserved).

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

The orchestrator calls `updateStateOfPlay(weave, question, tags)` which categorizes contributions using **the parsed type tag** (`c.type`) as the primary signal:

| `c.type` | Category |
|-----------|----------|
| `propose`, `refine` | Decisions & Proposals |
| `vote_tally` | Decisions & Proposals (a resolved poll is a decided point) |
| `support` | Agreements |
| `challenge`, `dissent` | Disagreements & Concerns |
| `question` | Open Questions |
| `query_response`, `evidence_response`, `summoned_response` | Key Facts |
| `vote_response` | (excluded — individual ballots are noise; the tally carries the result) |
| `synthesize`, `refuse`, `reflection`, `pass` | (excluded) |
| unknown/missing | Fallback keyword matching |

**Fallback keyword matching** (for missing/unknown types) uses word-boundary-aware regex: `\bwe should\b`/`\bdecision\b` → Decisions, `\bagree\b`/`\bconsensus\b` → Agreements, `\bdisagree\b`/`\bconcern\b` → Disagreements, `?` → Open Questions, otherwise Key Facts.

Content is cleaned of type tags and `[REQUEST_NEXT]`/`[QUERY]`/`[EVIDENCE]`/`[SUMMON]` directives before inclusion. Each section holds the **5 most recent** items, each truncated to **300 characters**.

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

## 12. Reflection System

Reflections are public, evolving belief states that agents maintain across rounds. Each reflection is a contribution in the weave with a visible header identifying the trigger contribution. The agent's latest reflection is also stored on the participant object for next-round context.

### When Reflections Trigger

After each `challenge` or `dissent` in the prompt phase, the system triggers a reflection **for exactly one agent: the most persona-similar active participant** (excluding the challenger). Selection is embedding-based:

1. The challenge/dissent text is embedded (`embedText`).
2. Each active participant carries a `Float32Array` embedding (loaded at init from `persona_embeddings`).
3. `findMostSimilar()` returns the candidate with the highest cosine similarity (`similarity` logged).

This replaces the earlier "all agents that spoke before the challenger reflect" design — a single, deliberately-chosen reflector keeps reflection cost low and focuses it on the participant most likely to have a substantive response. If the embedder is unavailable, reflection is skipped.

**Key design decisions:**

- **Mid-round timing:** reflections happen immediately after a challenge/dissent so later agents see the response before taking their own turns.
- **Ephemeral sessions:** each reflection uses a fresh ephemeral session with the reflecting agent's own model and temperature.
- **Public contributions:** stored as type `reflection`, visible to all agents.
- **Reduced tool set:** reflections use `web_fetch`, `web_search`, `read`, and `loom_vector_search` only (Section 20).
- **No cascading reflections:** a reflection cannot trigger another reflection; the trigger condition only applies to regular agent turns.

### How Reflections Evolve

Each agent keeps a single `reflection` string. The reflection prompt gives the agent:
1. Its previous reflection ("Your previous reflection on this deliberation…")
2. The triggering challenge/dissent and its author
3. Its own last 2 contributions (avoids repetition)
4. **Seniority context** between the agent and the challenger:
   - A senior challenger: "…If their challenge has merit, update your position seriously. If it doesn't, hold your ground with evidence."
   - A junior challenger: "…Evaluate their challenge on its merits, not seniority. Junior agents sometimes see what seniors miss."
   - A peer: "…Engage directly and challenge back if you disagree."
5. **Round context** — early (be exploratory), mid (start converging), late (focus on unresolved issues).
6. **The persona's `reflection_guidance`** — persona-specific instructions ("When reflecting, walk through the exploit path…").

The result **updates** the prior reflection — keep what holds, revise what changed, add what's new.

### Reflection Contribution Structure

```javascript
{
  id: 14,
  round: 3,
  participant_id: "senior_architect",
  content: "[Reflection on #12 [CHALLENGE] by Security Engineer (Round 3)]\n\nInitially concerned about token theft, but the phased migration mitigates risk because...",
  type: "reflection",
  targets_which: 12,
  tool_calls: [...],           // when tools were used
  prompt_context: {...},       // full prompt + context for debugging
  created_at: "2026-08-15T..."
}
```

**Header format:** `[Reflection on #<id> [<TYPE>] by <agent_name> (Round <n>)]`

### How Reflections Appear in Agent Prompts

Later agents see reflection contributions in their "recent contributions":

```
- [#12] [mid_security_engineer] (challenge): [CHALLENGE] Server-side refresh tokens...
- [#14] [senior_architect] (reflection): [Reflection on #12 [CHALLENGE] by Security Engineer (Round 3)]
  Initially concerned about token theft, but the phased migration mitigates risk because...
```

### Storage

The `participant.reflection` field stores the raw reflection text **without** the header (used for next-round context in the agent's own prompt). The header-carrying reflection contribution is stored in the `contributions` table. Reflections are excluded from the state of play and from the LLM round-summary (though the round summary shows their *outcome* as an inline `↳ Reflected:` line, Section 13).

---

## 13. Round Summarization

After each round, a summary is generated for display and persistence.

### Heuristic Summary (always generated)

Counts contribution types: "Round contributions (4): 1 propose, 2 challenge, 1 support. 1 turn request(s)."

### LLM Semantic Summary (conditional)

Only generated when all of these hold:
- Convergence mode is `moderator_forces`
- There are more than 2 contributions
- There are conflict signals (challenges/dissents or turn requests)

Only substantive types (`propose`, `challenge`, `refine`, `support`, `dissent`, `synthesize`, `question`, `vote_tally`) are included; reflections are folded in as outcomes (`↳ Reflected: <outcome>`). The prompt:

```
Summarize this deliberation round. What was established? What remains contested?

## Question
Should we migrate our authentication service to JWT tokens?

## Round 3 Contributions
- [#4] senior_architect [PROPOSE]: We should adopt a phased migration...
- [#5] mid_security_engineer [CHALLENGE]: Server-side refresh tokens are just
  session tokens with extra steps...
  ↳ Reflected: Initially concerned about token theft, but the phased migration
    mitigates risk because...

## Instructions
Focus on:
1. What decisions or positions were established
2. What specific points remain contested and who holds each side
3. Any new information or evidence introduced

Provide your summary in this format:
- **Established:** {what was decided or agreed}
- **Contested:** {what remains disputed and by whom}
- **Open:** {unresolved questions or next decisions needed}
```

Runs via the fast-path-routable `#promptOrchestrator` type `"summary"` (Section 21). If the LLM summary fails, the heuristic summary stands.

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
You are a neutral deliberation analyst. Your only job is to fairly represent
all perspectives from the deliberation, without favoring any participant's
agenda. You synthesize diverse viewpoints into a clear, balanced, actionable
output.
```

(Neutrality matters: the synthesizer is often a specific participant, but must not editorialize toward their agenda.)

### The Synthesis Prompt

`buildSynthesisPrompt(question, transcript, participants, tags, stateOfPlay, objections)`:

```
You are the synthesizer. The deliberation is complete. Produce the final artifact.

## Original Question
Should we migrate our authentication service to JWT tokens?

## Tags
engineering, security

## State of Play (Final)
## Question
...

## Unresolved Objections
- Security Engineer: Server-side refresh tokens are just session tokens with extra steps

## Deliberation Transcript
### Round 3 (Final)
**[Architect Lead]** (senior, propose): [PROPOSE] We should migrate to JWT...
**[Security Engineer]** (senior, challenge): [CHALLENGE] JWTs can't be revoked...
...

## Participants
- Architect Lead (senior): 3 contributions
- Security Engineer (senior): 4 contributions
...

## Instructions
Produce a comprehensive, well-structured response that:
1. Directly answers the original question
2. Captures the strongest points from all perspectives
3. Notes any unresolved disagreements
4. Provides clear, actionable conclusions
5. Identifies remaining risks or open questions

Use the State of Play as your primary reference for what was decided, agreed
upon, and left unresolved. The transcript provides supporting detail and
attribution.

Format as markdown with these exact sections:
## Decision
## Reasoning
## Action Items
## Dissenting Views
## Open Questions
## Confidence

For Confidence:
- High = all active participants contributed meaningfully and there are no unresolved disagreements
- Medium = general agreement with minor dissent, or some participants did not contribute
- Low = significant disagreement remains, or many participants failed to contribute

## Example Output Structure
...
```

Only the **final round's** transcript is included (`formatFinalRoundTranscript`), since it shows how the conversation concluded while the State of Play captures all prior history. Unresolved objections come from `collectObjections()` (challenges/dissents across rounds; an objection is legacy once the final round shows activity).

### Required-Section Repair

After the first draft, `validateSynthesisSections` checks for the 6 required sections; if any are missing and retries remain (`synthesisMaxRetries`, default 1), the model is re-prompted on the SAME session with: *"Your previous response was missing these required sections: … Please include ALL of the following sections…"*.

### Self-Critique Pass

The synthesizer then audits its own draft against the transcript (up to `MAX_CRITIQUE_RETRIES` = 2):

```
You are a neutral deliberation analyst reviewing your own synthesis.

Review the draft below against the deliberation transcript for:
1. Misattributed views (a point credited to the wrong participant)
2. Invented points not present in the deliberation
3. Significant dissent that was omitted from "Dissenting Views"
4. Decisions or action items not supported by any contribution

If corrections are needed, output the FULL revised synthesis with ALL required
sections: ## Decision ## Reasoning ## Action Items ## Dissenting Views
## Open Questions ## Confidence

If the draft is accurate and complete, respond with exactly: [NO_CHANGES]

Draft synthesis:
{text.slice(0, 6000)}
```

- If the model answers `[NO_CHANGES]`, the original draft stands.
- If the revision is complete, it replaces the draft.
- If the revision dropped sections, the draft is re-sent with feedback.
- On any error the original draft is kept.

### Finalization

`finalizeSynthesis` post-processes the text:
- Appends **## Unresolved Objections** (from `objection_collector`).
- Appends **## Refusals** (agents who refused to engage, as `Name: content`).
- Adds a note for any required section the model omitted.
- Parses the Confidence section if present; otherwise derives it heuristically (`deriveConfidence`):
  ```javascript
  if (dissentCount === 0 && challengeRatio < 0.3 && participationRate >= 0.5) return "high";
  if (dissentCount <= 1 && challengeRatio < 0.5 && participationRate >= 0.33) return "medium";
  return "low";
  ```
- Still extracts structured fields (`decisions`, `action_items`, `open_questions`, `dissent`, `refusals`, `confidence`) and persists the artifact with `#saveArtifact`.

### Fallback Synthesis

- If the coordinator's synthesis *session* fails, `fallbackSynthesis()` returns a State-of-Play-based artifact (or, absent state of play, categorized proposals/dissent/questions).
- If synthesis throws entirely, the orchestrator persists a **degraded artifact**: *"Synthesis could not be completed (message)"* with Confidence *Low (synthesis interrupted)*.
- If **all participants failed** to contribute: *"No output could be generated — all participants failed to respond."*
- If **all participants passed**: *"No output could be generated — all participants passed without contributing."*

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
  status: "weaving",   // initializing | weaving | converged | cancelled | timeout | max_rounds_reached | aborted | deadlocked
  artifact: null,      // set after synthesis
  objections: [],      // collected at synthesis time
  tags: ["engineering", "security"],
  next_contribution_id: 14,
  next_speaker_id: null,          // set by moderator "break" ruling
  planned_turn_order: [],         // planned for next round
  opencode_session_id: "...",     // for session-indexing
}
```

### Immutability

`getState()` returns deep-frozen copies. All mutations go through targeted `StateManager` methods:

```javascript
stateManager.transitionTo("weaving")            // validated state machine
stateManager.addContribution(obj)               // atomic addition
stateManager.setStateOfPlay(summary)            // regenerated each round
stateManager.setPlannedTurnOrder(ids)           // for next round
stateManager.setNextSpeakerId(id)               // moderator break
stateManager.reorderForNextSpeaker(id)          // established for next round
stateManager.addParticipantReflection(id, text)
```

`transitionTo` validates against the state machine (`initializing → weaving; weaving → converged/cancelled/timeout/max_rounds_reached/aborted/deadlocked`; terminal states are absorbing). `forceTransitionTo` bypasses validation and is reserved for the extension escape hatch.

### Persistence

State is persisted via the `PersistenceService` after each round finalization and after terminal events (`#persistState`), atomically updating `meetings` with round, status, fabric, state_of_play, next_speaker_id, stats. On resume, `restoreStateFromDb()` reconstructs the in-memory state from the database (participants, weave, rounds, turn requests, next speaker, call stats).

---

## 16. Error Handling & Model Fallback

### Retry-able Call Sites

Retries (`withRetry`, exponential backoff with jitter) wrap:
- **Session creation** (`client.session.create`) — `maxAttempts = maxRetryAttempts` (default 2).
- **Orchestrator prompts** (`SessionManager.promptOrchestrator`) — same retry policy.

Retryable errors (`isRetryableError`): `ECONNREFUSED`, `ETIMEDOUT`, `ENOTFOUND`, any message containing "timed out", HTTP 5xx, HTTP 429.

### Agent Prompt Failures (retry + model fallback)

Agent turns are now **retried** — the old "run once and fail" behavior is gone. `#promptChildSession` runs a staged recovery ladder before an agent is marked `failed`:

1. **Adaptive timeout:** base `agentTimeoutMs` (120s), reduced by up to 50% as more agents fail in the current round.
2. **Retry on the assigned model** — up to `modelFallback.maxRetriesPerModel` (default 2) retries *after* the first attempt, with exponential backoff (1000ms · 2^attempt + jitter, capped at 8s). Each failure increments the model's circuit-breaker counter.
3. **Fallback model** — when the primary model's retries are exhausted (and `modelFallback.enabled`, default true), `selectFallbackModel()` picks a healthy model from the discovered pool that is *not* the failing model (random among the healthy candidates) and the turn is attempted on it (up to `modelFallback.maxFallbackAttempts` retries after the first fallback attempt), with the same backoff. A progress message announces the switch ("⚠️ Model X failed — retrying with Y").
4. **Failure** — only when the primary and fallback attempts are all exhausted does the agent's status become `failed`, an `agent_errors` row is written with type `model_fallback` (`Model: X, No fallback available` or `Original: X, Fallback: Y — <error>`), and the agent is skipped for the rest of the round.

Every failed/finished turn path is precomputed once: **RAG context, system prompt, and user prompt are built model-independent and reused across retries/fallbacks** (no duplicate RAG calls). When the circuit breaker already marks the assigned model `open`, the turn starts directly on a fallback model without retrying the unhealthy one.

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

Database operations are wrapped in try-catch; best-effort operations log and continue. There is no
migration machinery — `schema.js` ships exactly one `initSchema()` with the final schema (alpha:
DBs are wiped whenever a session is deleted). Indexing and other best-effort operations log and
continue.

### All-Failed / All-Passed Handling

Degraded artifacts are produced when every participant fails or everyone passes (Section 14).

---

## 17. Stall Detection

A watchdog monitors activity. If no state update occurs for the configured interval, the meeting is cancelled and passes through to synthesis.

**Configuration:** `stallTimeoutMs` = 300,000ms (5 min), tick interval `WATCHDOG_TICK_MS` = 30,000ms (30s).

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

`VectorIndex` provides semantic retrieval over prior deliberation context, backed by sqlite-vec virtual tables:

| Table | Purpose |
|-------|---------|
| `fabric_chunks` | Regular table: chunked content (round summaries, contributions, initial context) |
| `vec_fabric_chunks` | sqlite-vec virtual table: `embedding float[384]` — used for agent RAG |
| `persona_embeddings` | Regular table: embedded persona text (`persona_name`, `tier`, `tags`, `embedding_text`) |
| `vec_persona_embeddings` | sqlite-vec virtual table: `embedding float[384]` — used for composition & reflection targeting |

### Embedding Service

The embedding service (`embedding-service.js`) provides a pluggable embedding interface backed by a local ONNX model:

- **ONNX Runtime model:** `onnxruntime-node` for inference, `@huggingface/tokenizers` for tokenization. Default model **Snowflake/snowflake-arctic-embed-xs** (~22 MB, 384 dims, BERT architecture, int8 quantized, `maxTokens` 512). Runs entirely locally.
- **Model resolution:** onnxruntime-node and the tokenizers are marked as esbuild externals; at runtime they're resolved from a dedicated deps directory at `~/.config/opencode/loom/deps/node_modules/` via `createRequire`, with a fallback to the project's `node_modules` for local development.
- **Model download:** the default model is installed by `npm run install:plugin` via `scripts/model.mjs` into `~/.config/opencode/loom/models/<name>/model.json` (specifies dims, maxTokens, modelType, quant path).
- **Initialization:** `initEmbeddingModel()` runs eagerly when the dashboard starts and lazily on first use by composition/reflection/vector indexing. The dashboard shows embedder status (loading/ready/failed).

The `embed()` path tokenizes text, builds `input_ids`/`attention_mask`/`token_type_ids` tensors, runs the session, extracts `last_hidden_state`, mean-pools over non-padding tokens, and L2-normalizes to a `Float32Array` of length `dims`.

### Chunking Strategy

`#chunkText` splits on paragraphs (`\n\n`), merging paragraphs up to ~`maxTokens × 4` characters (1 token ≈ 4 chars). Each chunk is stored with a source tag: `round_summary`, `contribution`, or `context`.

### Indexing Flow

- **At meeting start** (non-resume): the user context is indexed via `indexContext()` — fire-and-forget.
- **After each round**: `indexRound(roundNumber, summary, contributions)` chunks and embeds the summary (source `round_summary`) and each contribution (source `contribution`, prefixed `[participant_id] (type):`). Best-effort (`.catch(logger.warn)`).
- **Personas**: `PersonaIndex.indexAll(personas)` embeds `persona + agenda + tags + expertise` text per persona at composition time (meeting-scoped).

### Retrieval Flow

```javascript
const recentContribs = weave.filter((c) => c.round >= currentRound - 1);
const queryText = recentContribs.length > 0
  ? recentContribs.map((c) => c.content).join("\n")
  : stateManager.getQuestion();
const ragChunks = await vectorIndex.retrieveRelevant(queryText, 5, currentRound);
```

`retrieveRelevant(queryText, topK, excludeRound)`:
1. Embeds the query.
2. Runs cosine similarity search (`vec_fabric_chunks MATCH`, fetching topK+5).
3. Excludes chunks from the current round (avoids self-referencing).
4. Returns topK results.

**Persona-aware RAG queries:** the query text includes the agent's own recent contributions with the group's recent contributions, so different agents can retrieve different "relevant" context reflecting their focus.

### How RAG Context Appears in Agent Prompts

```
<<<LOOM_RELEVANT_PRIOR_CONTEXT>>>_BEGIN_
[Round 1] The JWT migration makes sense, but token revocation is unsolved...
[Round 2] Refresh tokens with server-side storage defeats statelessness...
<<<LOOM_RELEVANT_PRIOR_CONTEXT>>>_END_
```

When no RAG context is available (early rounds, empty index), this section is omitted.

### Semantic Drift Detection (Removed)

`computeSemanticDrift(roundA, roundB)` computed centroid cosine distance between two
rounds, but it was never wired into any check — it was a legacy utility and is being
removed (see `docs/dead-code-review.md`). If revived, it should feed the dashboard drift
visualization (`docs/drift-visualization.md`), which requires the embedder fix in
`docs/embedder-init-issue.md`.

---

## 20. Agent-Requested Tools

The agent-tools system allows deliberation agents to call tools during their turns, complementing the server-side RAG with agent-directed retrieval and research.

### Motivation

The server-side RAG uses a fixed query (last 2 rounds' contributions) with top-5 results. Agents cannot: search sub-topics that don't match recent content, verify factual claims, research external topics, or explore the filesystem on demand. Tools fix this.

**Example:** The Security Engineer raised a concern in round 1; by round 3 the server RAG query may not match it. `loom_vector_search` lets the agent query directly.

### Available Tools (Primary Turns)

| Tool | Category | Purpose in Deliberation |
|------|----------|------------------------|
| `web_fetch` | Web | Fetch articles, documentation, CVE entries for fact-checking |
| `web_search` | Web | Search for current statistics, news, or background |
| `read` | Filesystem | Read project files (workspace-restricted) |
| `glob` | Filesystem | Find files by pattern |
| `grep` | Filesystem | Search file contents |
| `bash` | Shell | **Allowlisted commands only**: `git`, `ls`, `wc`, `head`, `tail`, `grep`, `find` — no write ops |
| `loom_vector_search` | Vector DB | Semantic search against prior deliberation context |

### Tool Sets by Phase

| Phase | Authorized Tools | tool_choice |
|-------|------------------|-------------|
| Primary agent turn | `web_fetch`, `web_search`, `read`, `glob`, `grep`, `bash` (allowlisted), `loom_vector_search` | `auto` |
| Reflection | `web_fetch`, `web_search`, `read`, `loom_vector_search` | `auto` |
| Query response | `web_fetch`, `web_search`, `read`, `loom_vector_search` | `auto` |
| Evidence response | `web_fetch`, `web_search`, `read`, `loom_vector_search` | `required` (MUST research) |
| Vote response | *(none)* | `none` — a bare `[Vote: X]` ballot, no tools |
| Summoned expert | `web_fetch`, `web_search`, `read`, `glob`, `grep`, `bash` (allowlisted), `loom_vector_search` | `auto` |

**Not granted to agents**: `write`, `edit`, `tui`, `todo`, `lsp`, `comment`, `snapshot`, `permissions`.

### Tool Details

#### `loom_vector_search` — Semantic Similarity Search (plugin-registered)

**Backing:** `VectorIndex.retrieveRelevant(query, topK, excludeRound)` → `MeetingDatabase.searchFabricVectors()`.

**Args:** `query` (required), `top_k` (optional, default 5, max 20 — capped at 10 in execution), `exclude_round` (optional).

**Returns:**
```json
{
  "results": [
    { "round": 2, "source": "round_summary|contribution|context",
      "distance": 0.23, "content": "..." , "participation_tags": [] }
  ],
  "truncated": false
}
```

**Distance range:** `[0, 2]` (0 = identical, 2 = opposite).

#### `read` — File Reading

Workspace-restricted; cannot read outside the project.

#### `bash` — Shell Commands

**Allowlisted commands only**: `git`, `ls`, `wc`, `head`, `tail`, `grep`, `find`. Write operations are never allowed.

### Session-to-Meeting Resolution

Each tool call must resolve which Loom meeting the ephemeral session belongs to:

```
1. Tool receives context.sessionID
2. Direct lookup: findMeetingBySessionId(directory, sessionID) via session-index.json
3. Fallback: client.session.get({ id } ) → session.info.parentID → user's main session → findMeetingBySessionId(directory, parentID)
4. MeetingDatabase.create(dbPath, meetingId) → SQLite connection
5. VectorIndex(db) → vector search wrapper
6. Execute VectorIndex.retrieveRelevant()
```

The in-memory `sessionManager.registerSessionMeeting()` map is also populated on session creation for fast resolution during a turn.

### Tool Registration

Tools are registered in `src/index.js` via the `tool()` hook and passed through the chain:

```
src/index.js (Loom factory)
  → createKnitHandler(client, directory, activeLooms, agentTools)
    → new MeetingOrchestrator({ ..., agentTools })
      → new RoundExecutor({ ..., tools: agentTools })
        → client.session.prompt({ body: { tools: toolsMap } })
```

The `tools` body field is a **boolean filter map** (e.g. `{ web_fetch: true, loom_vector_search: true }`); the opencode server maps enabled tools to provider-format tool definitions automatically. Built-in tools are gated by `agentTools.builtIn.*`; `loom_vector_search` by `agentTools.loom.loom_vector_search`; phase-level restrictions by overrides (`agentTools.reflection`, query/evidence/summon sets built in code).

### Agent Guidance

When tools are enabled, the system prompt includes research-first guidance (primary-turn and reflection variants). Evidence requests additionally require "You MUST use at least one research tool to find concrete evidence. Do NOT speculate or reason from memory alone."

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
    "loom": { "loom_vector_search": true },
    "reflection": { "bash": false, "glob": false, "grep": false },
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
| `loom.loom_vector_search` | `true` | Enable the plugin-registered vector search tool |
| `reflection.*` | bash/glob/grep `false` | Reduced set for reflections/queries/evidence |
| `maxToolCallsPerTurn` | `5` | Soft limit — exceeding logs a warning (not truncated) |
| `maxToolOutputTokens` | `4000` | Contract limit on tool output volume (drives server-side truncation) |

### Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Prompt injection via tool outputs | Tool outputs feed the final text only; `[QUERY]`/`[EVIDENCE]`/`[SUMMON]` tags are stripped; content is sanitized |
| Bash command execution | Allowlisted commands only; write operations never allowed |
| Filesystem exposure | `read` restricted to workspace |
| Reflection safety | Reduced tool set for reflections |
| Embedding model unavailable | `embedText` returns `null`; composition/reflection/vector-RAG degrade gracefully |

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
const useModel = (fastPathModel && (type === "moderation" || type === "compaction" || type === "summary"))
  ? fastPathModel
  : model;
```

| Call Type | Fast-Path? | Used By |
|-----------|-----------|---------|
| `moderation` | Yes | Moderator rulings (Section 8) |
| `summary` | Yes | LLM round summaries (Section 13) |
| `compaction` | Yes (legacy) | Reserved — compaction removed |
| `turn_order` | No (via planner) | `planTurnOrder` selects `fastPathModel` itself (Section 9) |

Note: turn-order planning is special — `#promptOrchestrator` doesn't fast-path `turn_order`, but `planTurnOrder` picks `fastPathModel || getHighestTierModel()` as its model before calling the orchestrator, so it still benefits when configured.

When `fastPathModel` is empty (default), all orchestrator calls use the highest-tier model.

---

## 22. Directed Interactions: Query, Evidence, Summon, Vote

Agents can direct the conversation at specific participants without waiting for the round-robin order. All four run immediately after the source agent's contribution is stored, using fresh ephemeral sessions for each target. Targets are resolved from the current participant list, excluding the source and any passed/failed participants.

### Query (`[QUERY: @target1, @target2] question`)

- Targets: 1–2 participant IDs (parsed from `@mention`s; extra targets dropped).
- **Prompt** (`buildQueryPrompt`): source's contribution and their question, the target's recent contributions and prior reflection, seniority + round context. System prompt: *"A fellow participant has directed a question to you. Respond directly and stay in character."* No contribution-type tags allowed — just answer.
- **Tools:** reduced set (`web_fetch`, `web_search`, `read`, `loom_vector_search`), `tool_choice: auto`.
- **Contribution:** type `query_response`, content prefixed `[Response to query from <Source Name>]`, `targets_which` set to the source contribution's ID, tool calls and prompt context recorded.
- While a target is responding, its status is `speaking` and it is listed in `meetings.querying_participants` (dashboard-visible).
- Failures are logged (`query_failed`) and the target's status is restored.

### Evidence (`[EVIDENCE: @target] question`)

- Identical mechanics to Query, except the target **must** research: `tool_choice: "required"` and the prompt demands "You MUST use at least one research tool… do not speculate". System prompt: *"A fellow participant has requested evidence from you. You MUST use research tools to find concrete evidence."*
- **Contribution:** type `evidence_response`, content prefixed `[Evidence from <Target> on <Source>'s <type>]`.
- Dashboard flag: `meetings.evidence_participants`.

### Summon (`[SUMMON: Persona Name] issue`)

- Brings in a **guest expert** persona from the persona pool (matched by name across all tiers; unknown personas are ignored). The summoned agent is not part of the registered participant list — it contributes once.
- **Rate limits:** `maxSummonsPerRound` (2) and `maxSummonsPerAgent` (1) — tracked per round in `round.summons`.
- **Model:** the summoning agent's own model; temperature 0.7.
- **Tools:** full primary-tool set (`web_fetch`, `web_search`, `read`, `glob`, `grep`, `bash` allowlisted, `loom_vector_search`), `tool_choice: auto`.
- **Prompt** (`buildSummonPrompt`): persona, expertise, communication style, the requester's issue, recent deliberation context (last 4 contributions), round context. System prompt: *"You are <Name> (<tier>), a guest expert summoned into this deliberation. Respond in character."*
- **Contribution:** type `summoned_response`, participant id `summoned_<name slug>`, content prefixed `[Summoned: <Name> (<tier>)]`.
- Dashboard flag: `meetings.summoning_participants`.

### Vote (`[CALL_VOTE] question`)

A polling mechanism residents can invoke to resolve a contested point quickly. Unlike Query/Evidence/Summon it is **fan-out to everyone**: the source agent plus every other active participant cast a ballot, then a deterministic tally is produced.

- **Trigger:** the parser recognizes `[CALL_VOTE]` followed by the poll question (Section 4). The rights field `call_vote` is granted to mid, senior, and principal in the tier model (Section 3), though the execution path does not programmatically gate on it.
- **Voters:** the source agent (its ballot is parsed from its own contribution content) plus every participant that is not passed or failed.
- **Prompt** (`buildVotePrompt`): the poll question, the source's contribution, the voter's last 2 contributions and prior reflection, and round context. System prompt: *"A fellow participant has called a vote. Cast your vote and provide brief reasoning."* No type tags allowed.
- **Ballot format:** the response must be `[Vote: <letter>]` followed by 1–2 sentences of reasoning. `extractVoteLetter()` accepts the `[Vote: X]` tag or a lone standalone capital letter on its own line.
- **Tools:** none — `tool_choice: "none"` (voting is a fast, tool-free poll).
- **Contributions:** each ballot is stored as type `vote_response` with content prefixed `[Vote from <Name>]` and `targets_which` pointing at the source contribution. After all ballots are collected (or fail, individually logged as `vote_failed`), a single type `vote_tally` contribution is produced by the source participant: it lists the counts per letter, the percentage of the winner, and `Total voters`.
- **Dashboard integration:** voters marked "speaking" while balloting; the dashboard renders `vote_response` and `vote_tally` rows inline in the Timeline, with a per-poll grouping.
- **Edge case:** if the source is the only active participant, a source-only tally is recorded immediately.

### Directed-Interaction Outcomes

Query, evidence, and summoned responses are classified into the State of Play's **Key Facts** section; a vote tally is classified as a **Decision** while individual ballots are excluded (Section 11). All four response types flow into the weave and appear in later agents' recent contributions.

---

## 23. Dashboard System

`/loom_viz` starts a lightweight static web dashboard (default port 3210) that renders a live view of all meetings under `.opencode/loom/meetings/`.

### How It Works

- **Serving:** `startDashboard(directory, port)` serves an HTML shell + static assets (`/assets/*`) and a JSON API.
- **Data source:** `DashboardApi` opens each meeting SQLite DB **read-only**, with a 10-DB LRU cache and TTL; connections are re-opened when the DB file's mtime changes (every ≤2s checks), so it reads fresh state without any live coupling to the orchestrator.
- **Real-time updates:** the server holds SSE clients per meeting (`/api/stream`) and **polls** the DB every 1s (active) or 5s (idle). On changes it broadcasts events: `state`, `contributions`, `orchestrator_messages`, `turn_requests`, `participants`, `agent_error`, `artifact`. Terminal-state and artifact events are broadcast once (dedup via cache).
- **Meeting selection:** `/api/meetings` lists every `meetings/*.db` with question, status, round, convergence, created_at, participant count (sorted newest first). The UI auto-switches to the most recent.

### UI Tabs

- **Overview** — participants (cards with status/tier/model/reflection, contribution counts), recent contributions, turn requests, errors, an agent-perspective panel, and the final artifact when present.
- **Timeline** — per-round contribution timeline, orchestrator decision log (moderator rulings, turn-order plans, summaries) interleaved per round, participation matrix, contribution-type chart, and inline reflection/query/evidence/summon/vote rows.
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

**Args:** `question`, `context`, `participants` (custom room), `max_rounds` (default from config: 3), `models` (explicit per-tier assignment, e.g. `[{ tier: "senior", provider_id: "anthropic", model_id: "claude-sonnet-4-..." }]`), `meeting_timeout` (ms, default 900000), `dry_run` (preview room without deliberating), `fresh` (replace an existing meeting for the session).

### Handler Flow (`createKnitHandler`)

1. Discover models + session model; apply the optional `/knit_models` model filter to the pool (Section 26).
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
- `knit_models` — discover available models, preview tier assignments (`createModelPlan` + `formatModelPlan`), and manage a **session-scoped model filter**. Actions: `list` (default), `enable <provider/model>…`, `disable <provider/model>…`, `reset`. The filter restricts which discovered models Loom agents may use; the preview also stages the plan for the next `/knit`. (See Section 26.)

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

A simple process-wide collector exposed via `/api/metrics` and `getMetricsSnapshot()`:

- **Counter** — `llm_calls_by_type` (agent/synthesis).
- **Latencies** — `llm_prompt_ms`, `synthesis_ms` (last 100 samples; aggregated into count/avg/p50/p95/max).

RoundExecution records per-call tokens and `llm_prompt_ms` per agent call; synthesis records its own bucket. Previously defined but never-written counters (turn request grants/denials, reflections, syntheses, meetings, tokens, gauges) were removed — see `docs/metrics-and-observability.md`.

### Per-Meeting Metrics

On meeting end the orchestrator persists `meeting_metrics` via `saveMeetingMetrics`: counters (LLM calls by type, token counts), duration_ms, rounds, contributions, turn request count. The dashboard can render these alongside the meeting.

### Logging

Structured JSON logs via `Logger` with contexts: `meeting_id` (short form), event name, and fields. Error paths are captured per participant in `agent_errors` and globally in `error_log`. Model-fallback events are observable as `model_fallback`/`model_fallback_failed` log events, an `agent_errors` row with type `model_fallback`, and a `⚠️ … falling back …` progress message.

---

## 26. Model Configuration

A recap of every knob that controls which LLM runs an agent or the orchestrator. Model configuration spans four layers:

### 1. Model Discovery & the Model Filter

`discoverModels()` (`src/services/model-service.js`) reads the connected providers via `client.provider.providers` and records the user session's current model as `sessionModel`. Deprecated models are excluded.

A **session-scoped model filter** (`enabledModels` in the knit handler) is maintained with `/knit_models`:
- `/knit_models` — lists all discovered models with `provider/model` identifiers, cost, context window, and reasoning capability, plus the proposed tier assignment plan.
- `/knit_models enable <id>…` / `/knit_models disable <id>…` — restrict which discovered models Loom agents may use (`applyModelFilter`). Default (no filter) = all models.
- `/knit_models reset` — clears the filter back to "all models".

The filter is mutable state on the knit handler (per opencode session, not persisted) and is applied to the discovery result before composition, assignment, and the `availableModels` list passed to the orchestrator for fallback selection.

### 2. Tier-Based Assignment

`assignModelsToParticipants()` → `assignModelsByTier()` is the single deterministic assignment engine (shared with the `/knit_models` preview so both always agree):

- Models are sorted by a capability score (`scoreModel`: active status + context window + reasoning capability; cost is display-only).
- Principal/senior roles receive the session model (or the best available); mid/junior get the next-best unused models.
- **Model diversity** (`modelDiversity`, default true): when more distinct models are available than tiers, every individual agent gets a unique model (best models to the highest tiers) instead of sharing per tier.
- The pool itself can be pre-narrowed by the model filter (layer 1).

### 3. Per-Participant Overrides

Explicit configuration always wins over automatic assignment:

- **`/knit models=[{ tier, provider_id, model_id }]`** — per-tier override applied at composition (mapped into each participant's `model`).
- **Custom rooms** — participants may carry a `model` object `{ providerID, modelID }` or a `model_override` string `"provider/model"` (`buildOverrideMap`). Overridden models are also excluded from the diversity pool so they aren't double-assigned.

### 4. Orchestrator & Fallback Model Safeguards

- **Fast-path routing** (`fastPathModel`): cheap models for moderation/summary/compaction orchestrator calls; turn-order planning selects it itself (Section 21).
- **Model fallback** (`modelFallback.*`): a failed agent turn is retried on its model, then on a healthy fallback selected by `selectFallbackModel()` (Section 16).
- `getHighestTierModel()` acts as a safety net: `#getParticipantModel(participant, fallbackOnError)` substitutes the highest-tier healthy model whenever a participant's own model is missing or unhealthy (used by directives, votes, and synthesis).

The appendix table lists every model-related configuration key (`modelDiversity`, `fastPathModel`, `circuitBreaker.*`, `modelFallback.*`).

---

## Appendix: Key Configuration Values

Loaded from `.loomrc.json` (project or `~/.config/opencode/.loomrc.json`), or the legacy `opencode.json` `"loom"` key. Validated and merged over defaults; unknown keys warn and are ignored.

| Parameter | Default | Description |
|-----------|---------|-------------|
| `agentTimeoutMs` | 120,000 | Per-agent LLM call timeout (reduced up to 50% as failures accumulate within a round) |
| `synthesisTimeoutMs` | 180,000 | Synthesis draft/critique call timeout |
| `maxTurnRequestWords` | 200 | (Reserved — not enforced by current planner) |
| `defaultMaxRounds` | 3 | Default meeting rounds |
| `minRounds` | 2 | Minimum rounds before the moderator can end the deliberation |
| `fastPathModel` | `""` | Model for cheap orchestrator calls (empty = disabled) |
| `maxRetryAttempts` | 2 | Retries for session creation / orchestrator prompts |
| `retryBaseDelayMs` | 1,000 | Base retry delay |
| `retryMaxDelayMs` | 8,000 | Max retry delay |
| `synthesisMaxRetries` | 1 | Draft section-repair retries |
| `defaultMeetingTimeoutMs` | 900,000 | Absolute meeting deadline (overridable via `/knit meeting_timeout`) |
| `stallTimeoutMs` | 300,000 | Inactivity stall timeout (watchdog ticks every 30s) |
| `modelDiversity` | `true` | Give each agent a distinct model when enough are available |
| `turnRequestThresholds.autoGrant` | `9` | (Reserved — not exercised) |
| `maxTurnRequestsPerRound` | `3` | (Reserved — not exercised) |
| `maxSummonsPerRound` | `2` | Summoned experts per round |
| `maxSummonsPerAgent` | `1` | Summons per agent per round |
| `moderatorTrigger.minContributions` | `3` | Round size gate for moderator consultation |
| `moderatorTrigger.recentChallenges` | `2` | Challenge/dissent count gate |
| `moderatorTrigger.lookbackWindow` | `4` | Lookback window for the gate |
| `circuitBreaker.failureThreshold` | `3` | Consecutive failures before a model is marked unhealthy |
| `circuitBreaker.resetTimeoutMs` | 300,000 | Half-open test window for an unhealthy model |
| `modelFallback.enabled` | `true` | Master switch for agent-turn retries + fallback model selection (Section 16) |
| `modelFallback.maxRetriesPerModel` | `2` | Retries on the same model before falling back |
| `modelFallback.maxFallbackAttempts` | `1` | Retries on the selected fallback model |
| `agentTools.*` | (see Section 20) | Tool enablement and phase overrides |
| `DEFAULT_EMBEDDING_MODEL` | `"Snowflake/snowflake-arctic-embed-xs"` | Default embedder for PersonaIndex and vector search (warmed up on dashboard start) |
| `DEFAULT_EMBEDDING_QUANT` | `"onnx/model_int8.onnx"` | ONNX quantization variant used by the embedder |
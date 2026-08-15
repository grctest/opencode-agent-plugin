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
16. [Error Handling](#16-error-handling)
17. [Stall Detection](#17-stall-detection)
18. [Extension Logic](#18-extension-logic)
19. [VectorIndex + RAG Context Retrieval](#19-vectorindex--rag-context-retrieval)
20. [Fast-Path Model Routing](#20-fast-path-model-routing)

---

## 1. End-to-End Flow Summary

When a user types `/knit` with a question, this is what happens:

1. **Domain detection** — The question is sent to an LLM to identify which domains it touches (engineering, finance, business, creative, etc.).
2. **Room composition** — Based on detected domains and question complexity, a team of 2–7 agents is assembled from persona files. Each agent gets a name, persona description, agenda, tier, and domain expertise.
3. **Model assignment** — Each agent is assigned an LLM model, with higher-tier agents getting the best available models.
4. **Orchestrator session created** — A single orchestrator session is created for system-level calls (moderation, summarization, convergence, domain detection). No persistent per-agent sessions are created.
5. **Rounds execute** — Each round has three phases:
   - **Prompt phase**: Agents speak sequentially, each via a fresh ephemeral session. Each sees the state of play, vector-RAG context, recent contributions, and their own reflection.
   - **Reflection phase**: After a challenge or dissent, agents privately reflect on what they heard.
   - **Turn order planning**: At end of round, moderator plans next round's turn order based on `[REQUEST_NEXT]` tags.
6. **State of play update** — After each round, a structured summary of decisions, agreements, disagreements, and open questions is derived from all contributions.
7. **Moderator checks** — After each round, if there are signs of deadlock or circular argument, the moderator intervenes.
8. **Convergence check** — After each round, 9 statistical and LLM-based checks (including a vector novelty check) determine whether to stop.
9. **Synthesis** — When the meeting ends, one agent (typically the principal) synthesizes all contributions into a structured artifact with Decision, Reasoning, Action Items, Dissenting Views, Open Questions, and Confidence.

---

## 2. Meeting Creation

### Step 1: Domain Detection

The question is sent to an LLM with this prompt:

```
Analyze the following question and determine which domains it touches on.

Question: "Should we migrate our authentication service to JWT tokens?"

Available domains with example keywords:
- engineering: api, code, database, deploy, infrastructure...
- finance: budget, cost, revenue, roi, investment...
- business: strategy, market, customer, growth, product...
- creative: design, brand, content, user experience...

Respond with ONLY a JSON array of domain names that apply.
```

The LLM responds with something like `["engineering", "security"]`. If it fails or returns invalid JSON, the system falls back to an empty domain list.

### Step 2: Room Composition

Based on the detected domains and question complexity, the system builds a team. The process:

**Complexity analysis** — The question is scored on: word count, question marks, dimensionality ("and/or/vs"), conditionals ("if/when"), stakeholders ("team/customer/user"), and domain keyword density. Scores: low (0–2), medium (3–4), high (5+).

**Role distribution** — For a 4-person team on a technical question:
```
senior, mid, mid, junior
```
For a 5-person financial question with high complexity:
```
principal, senior, mid, mid, junior
```
Complex questions get a seniority boost (each tier shifts up one level).

**Persona selection** — For each role, a persona is picked from JSON files (`personas/loom/senior.json`, etc.). Selection is:
- Weighted random, preferring personas whose domains match the question (+10 weight)
- Seeded PRNG (seed derived from question text) for reproducibility
- Similarity guard: if cosine similarity between persona texts exceeds 0.5, reselect to avoid duplicates

Each persona has: `name`, `persona` (description), `agenda`, `domains`, optional `known_biases`, `communication_style`, `preferred_contribution_types`.

### Step 3: Model Assignment

Each agent is assigned a model. Higher tiers get better models. If more models exist than agents, each agent gets a unique model. The system uses the opencode provider API to discover available models and sorts by quality score (active status + context window + reasoning capability).

### Step 4: Session Creation

Only one session is created at meeting start: the **orchestrator session** for system-level LLM calls (moderation, summarization, convergence, domain detection).

**No persistent per-agent sessions are created.** Each agent turn uses a fresh ephemeral session (see Section 7).

---

## 3. Agent Architecture

### The Tier System

Four tiers determine agent behavior, authority, and LLM parameters:

| Tier | Temperature | Turn Request Cap | Rights |
|------|------------|-----------------|--------|
| junior | 0.7 | Priority 5 | contribute, request_turn |
| mid | 0.5 | Priority 7 | contribute, request_turn, call_vote |
| senior | 0.3 | Priority 9 | contribute, request_turn, call_vote, veto |
| principal | 0.2 | Priority 10 | contribute, request_turn, call_vote, veto, force_end |

**Behavioral guidance injected into system prompts:**

- **junior**: "Think creatively and bring fresh perspectives. Wild ideas are welcome — you won't be penalized for being wrong. Challenge senior thinking with naive questions that expose hidden assumptions."
- **mid**: "Balance creativity with evidence. When you disagree, explain why with specific reasoning. Synthesize others' points before adding your own."
- **senior**: "Prioritize accuracy and risk assessment. Cite patterns from experience. Be conservative with claims but commit fully when you do. Flag irreversible decisions."
- **principal**: "See the whole system. Cut through noise and circular argument. When consensus is impossible, decide. Your primary role is to ensure this deliberation produces a clear, actionable answer."

### Persona Structure

Each agent is loaded from a JSON persona file. Example structure:

```json
{
  "name": "Security Engineer",
  "persona": "A seasoned application security engineer with 12 years of experience in authentication, encryption, and threat modeling. Tends to think in attack vectors and worst-case scenarios.",
  "agenda": "Ensure all proposed solutions meet security baselines and don't introduce new attack surfaces.",
  "domains": ["engineering", "security"],
  "known_biases": ["Over-indexes on security at the expense of UX"],
  "communication_style": "Technical and precise, references OWASP and CVE patterns",
  "preferred_contribution_types": ["challenge", "refine"]
}
```

### What a Participant Object Looks Like in State

```javascript
{
  config: {
    id: "senior_security_engineer",
    name: "Security Engineer",
    persona: "A seasoned application security engineer...",
    agenda: "Ensure all proposed solutions meet security baselines...",
    tier: "senior",
    domain: "engineering, security",
    domains: ["engineering", "security"],
    known_biases: ["Over-indexes on security at the expense of UX"],
    communication_style: "Technical and precise",
    preferred_contribution_types: ["challenge", "refine"]
  },
  tier_config: {
    model: "anthropic/claude-sonnet-4-20250514",
    temperature: 0.3,
    reasoning_effort: null,
    system_prompt_addendum: "Prioritize accuracy and risk assessment...",
    rights: { contribute: true, request_turn: true, call_vote: true, veto: true, force_end: false }
  },
  session_id: "",           // unused in ephemeral mode — reserved for future use
  status: "listening",      // listening | speaking | passed | failed | timed_out
  session_version: 0,       // unused in ephemeral mode
  reflection: "The JWT migration makes sense, but token revocation is unsolved.",
  contributions_count: 2
}
```

---

## 4. What Agents See and Produce

This is the most critical section. Every agent LLM call involves two prompts: a **system prompt** (identity + rules) and a **user prompt** (state of play + context + question).

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

## Your Tier Guidance
Prioritize accuracy and risk assessment. Cite patterns from experience.
Be conservative with claims but commit fully when you do. Flag irreversible
decisions.

## Rules
1. Read the shared context and recent contributions carefully
2. If you have something meaningful to add, state it concisely (aim for under 200 words)
3. If you have nothing to add, respond with exactly: [PASS]
4. Tag your type: [PROPOSE], [CHALLENGE], [REFINE], [SUPPORT], [DISSENT],
   [SYNTHESIZE], [QUESTION], or [REFUSE]
5. To request the next turn, add: [REQUEST_NEXT: Target: <participant|Self>,
   Priority: <1-9>, Reason: "why you (or they) must speak next"]
6. Stay in character — your persona and agenda shape your contributions
7. Reference prior contributions using their stable ID from the Recent
   Contributions list, e.g. [#12]
8. Only with a governance-level concern, add: [GOVERNANCE: <directive>: <value>]
   where directive is one of extend_rounds, force_converge, raise_objection,
   request_topic, nominate_synthesizer, or escalate.

## Example Response
[CHALLENGE] The proposed approach doesn't account for backward compatibility.
In my experience, breaking changes typically require a migration period. Have
we validated this with stakeholders?

## Example With Turn Request
[PROPOSE] We should adopt a phased migration over Q1 and Q2.

[REQUEST_NEXT: Target: Self, Priority: 8, Reason: "I have data showing the
auth service migration alone will take 6 weeks, making Q1 unrealistic"] The
auth service migration alone will take 6 weeks based on our last project
timeline — Q1 is unrealistic without additional resources.

## Example With Refusal
[REFUSE: I cannot engage with this premise because it assumes we have budget
approval, which we do not] This discussion presupposes resources that haven't
been allocated.
```

### The User Prompt (Golden Sandwich)

Each agent's user prompt is built by `buildAgentUserPrompt`. The prompt follows the **Golden Sandwich** pattern — a bounded, stateless prompt that carries all necessary context without accumulating history. Here is a concrete example for a mid-tier agent in round 3:

```
## Question
Should we migrate our authentication service to JWT tokens?

## Domain: engineering

## Round 3

<<<LOOM_STATE_OF_PLAY_BEGIN_
## Question
Should we migrate our authentication service to JWT tokens?

## Domain
engineering

## Decisions & Proposals
- We should adopt a phased migration over Q1 and Q2, starting with the auth service

## Agreements
- Short-lived access tokens (5 min) are essential
- Stateless auth reduces session store overhead

## Disagreements & Concerns
- Token revocation remains unsolved — blocklists defeat statelessness
- Refresh tokens stored client-side are a high-value target

## Open Questions
- How will existing sessions be handled during the transition?
- What's the actual downtime budget?
<<<LOOM_STATE_OF_PLAY_END_>>>

<<<LOOM_RELEVANT_PRIOR_CONTEXT_BEGIN_
[Round 1] The team agreed on phased migration but split on refresh token storage
[Round 2] Security Engineer challenged that refresh tokens are just session tokens with extra steps
<<<LOOM_RELEVANT_PRIOR_CONTEXT_END_>>>

<<<LOOM_CONTRIBUTIONS_BEGIN_
- [#4] [senior_architect] (propose): [PROPOSE] We should use a hybrid approach —
  short-lived JWTs for API auth, refresh tokens stored server-side...
- [#5] [mid_security_engineer] (challenge): [CHALLENGE] Server-side refresh tokens
  are just session tokens with extra steps. We've reinvented stateful auth...
- [#6] [junior_backend_dev] (challenge): [CHALLENGE] This feels like we're going
  in circles. The real question is: what's the actual downtime budget?
<<<LOOM_CONTRIBUTIONS_END_>>>

## Your Reflection
The JWT migration makes sense, but token revocation is unsolved.

## Your Turn

Read the state of play, relevant context, and recent contributions. Then make your contribution or pass.
```

Note the structure:
- **State of Play**: A structured summary of decisions, agreements, disagreements, and open questions derived from ALL prior contributions. This is the primary running context.
- **Relevant Prior Context**: Semantically retrieved prior contributions via vector RAG (sqlite-vec). Bounded to 5 results.
- **Recent Contributions**: The last 3–4 contributions from the current and previous rounds, with stable IDs like `[#4]`.
- **Reflection**: The agent's own private reflection from prior rounds.
- **Delimiters**: `<<<LOOM_*_BEGIN_>>>` / `<<<LOOM_*_END_>>>` blocks prevent prompt injection.

### What Agents Produce

An agent response is a text string. The system parses it for structured directives:

**Type tags** (exactly one required):
- `[PROPOSE]` — a new idea or suggestion
- `[CHALLENGE]` — questioning an existing idea
- `[REFINE]` — improving on someone else's proposal
- `[SUPPORT]` — agreeing with and reinforcing a point
- `[DISSENT]` — disagreeing with the majority
- `[SYNTHESIZE]` — combining multiple ideas
- `[QUESTION]` — asking for clarification
- `[REFUSE]` — declining to engage (with reason)
- `[PASS]` — nothing to add

**Optional directives:**
- `[REQUEST_NEXT: Target: <participant|Self>, Priority: N, Reason: "..."]` — request next turn
- `[GOVERNANCE: extend_rounds: 2]` — system-level escalation

**Content** follows the tag. Example full response:

```
[CHALLENGE] The short-expiry-with-refresh approach assumes refresh tokens
can't be stolen. In practice, refresh tokens are long-lived and stored
client-side, making them a high-value target. We need a token revocation
list regardless — at which point we're back to stateful auth with extra
complexity. [#2] raises a valid point that we're solving the wrong problem.
```

The system parses this into:
```javascript
{
  type: "challenge",
  content: "The short-expiry-with-refresh approach assumes...",
  request_next: null,
  governance: null,
  word_count: 52
}
```

---

## 5. Round Execution

Each round proceeds through two sequential phases:

### Phase 1: Prompt Phase

Agents generate contributions sequentially. Each agent speaks one at a time via a fresh ephemeral session, seeing all prior same-round contributions as they are produced.

For each agent, the system:

1. Sets status to "speaking" (visible in dashboard).
2. Checks if the assigned model's circuit breaker is healthy.
3. Calculates adaptive timeout: base 120s, reduced by up to 50% as more agents fail in this round.
4. Creates a fresh ephemeral LLM session for this single turn.
5. Sends system prompt + Golden Sandwich user prompt.
6. Wraps with retry logic (2 attempts, exponential backoff: 1s → 2s → 4s → 8s, 500ms jitter).
7. Extracts text from the LLM response.
8. Sanitizes content to prevent prompt injection (preserves known directives, strips other brackets/HTML).
9. Parses the response for type tags, `[REQUEST_NEXT]` turn order requests, and governance directives.
10. Enforces word limit (default 250 words).
11. Validates against a Zod schema; falls back to type "challenge" on validation failure.
12. Stores the contribution in state and database.
13. Deletes the ephemeral session (cleanup).

**Intra-round queue jumping:** If an agent tags `[REQUEST_NEXT: Priority: 9+]` during their turn, the system immediately moves that agent to position 0 of the *remaining* speakers in the current round. No LLM calls — pure programmatic array reorder.

### Phase 2: Reflection Phase

If any contribution in the round was a "challenge" or "dissent", the reflection phase runs.

Each listener generates a reflection in **parallel** via `Promise.allSettled()`. Each reflection supersedes any prior one — the agent produces a single evolved belief state, not an accumulated list.

**Reflection prompt includes:**
1. The agent's previous reflection (if any)
2. The triggering challenge/dissent
3. The agent's own last 2 contributions (avoids repetition)

```
## Private Reflection

You are **Architect Lead** (senior). Your agenda: Drive long-term technical vision

Your recent contributions:
- "We should adopt a phased migration starting with the auth service"

Your previous reflection:
"Token revocation is a concern, but the phased approach mitigates risk."

Now **Security Engineer** said:
"The short-expiry-with-refresh approach assumes refresh tokens can't be stolen..."

Assess risk and feasibility. What has worked before in similar situations?
What assumptions are most dangerous to leave unchallenged?

Write 2-3 sentences that UPDATE your previous reflection.
Keep what still holds, revise what has changed, add what's new.
Output a single coherent paragraph — this replaces your prior reflection.
```

Each agent maintains a single `reflection` string. The prompt instructs the LLM to produce a coherent paragraph that evolves the prior belief state.

### Post-Phase: Turn Order Planning + Round Summarization

After the prompt and reflection phases, two things happen:

1. **Turn Order Planning:** The moderator plans turn order for the next round based on `[REQUEST_NEXT]` tags. (See Section 9 for full details.)
2. **Round Summarization:** A round summary is generated.

**Heuristic first:** "Round contributions (4): 1 propose, 2 challenge, 1 support. 1 turn request(s)."

**LLM semantic summary (if conflict exists in moderator_forces mode):**

```
Summarize this deliberation round in 2-3 sentences. What was established?
What remains contested?

Contributions:
- [PROPOSE] We should adopt a phased migration over Q1 and Q2...
- [CHALLENGE] The short-expiry approach assumes refresh tokens can't be stolen...
- [SUPPORT] The stateless benefit is real, we could use short expiry...
- [DISSENT] We're solving the wrong problem — revocation lists are inevitable...

Summary:
```

The summary is stored in the database but is NOT appended to any running context. Instead, the state of play (Section 11) is regenerated from the full weave after each round.

---

## 6. Turn Ordering

**Default order:** Agents speak in composition order (the order they appear in the state's participants array). There is no randomization.

**Turn request override:** At the end of each round, if any agent emitted `[REQUEST_NEXT]` tags, the moderator plans turn order for the next round via `planTurnOrder()` (see Section 9). The planned order is stored in state and applied by `RoundInitializer.filterActiveParticipants()` at the start of the next round.

**Intra-round queue jumps:** If an agent tags `[REQUEST_NEXT: Priority: 9+]` during their turn, the system immediately moves them to position 0 of the remaining speakers in the current round (pure array swap, no LLM call).

**Moderator break ruling:** If the moderator detects circular arguments, it can force a specific participant to speak next via `setNextSpeakerId()`. This overrides any planned turn order.

**Skip-passed logic:** Starting from round 3, if a participant passed within the last 2 rounds and has no reflection since their last pass, they are excluded from the active participant list for the next round. A progress message is emitted (e.g., *"⏭️ Skipped: Agent X (inactive, no new reflections)"*) so users can see why an agent was excluded.

**When no turn requests exist:** No LLM call is made. The default composition order is preserved (or the moderator's break ruling applies).

---

## 7. LLM Session Architecture

### Stateless Ephemeral Sessions

The system uses **ephemeral sessions**, not persistent sessions:

```
Parent Session (user's opencode chat)
  └── Orchestrator Session (persistent, for system calls)
       ├── Ephemeral Session: Architect Lead (round 1, turn 1) → deleted after use
       ├── Ephemeral Session: Security Engineer (round 1, turn 2) → deleted after use
       ├── Ephemeral Session: Junior Developer (round 1, turn 3) → deleted after use
       ├── Ephemeral Session: Architect Lead (round 2, turn 1) → deleted after use
       └── ...
```

**Why ephemeral?** Each agent turn creates a fresh session, sends the Golden Sandwich prompt (state of play + RAG + recent contributions), receives a response, and deletes the session. This means:
- **O(1) token growth per turn** — no accumulated history from prior turns
- **No session state drift** — each turn starts clean
- **No session recreation needed** — if a turn fails, the next turn just creates a new ephemeral session
- **Lower memory footprint** — no persistent session history stored server-side

### Creating an Ephemeral Session

```javascript
async createEphemeralSession(participant) {
  return this.#createSessionWithRetry(
    `Loom · Ephemeral · ${participant.config.name}`,
    // ... retry logic
  );
}
```

### Prompting an Agent (Ephemeral)

```javascript
const ephemeralSessionId = await createEphemeralSession(participant);
try {
  const result = await client.session.prompt({
    path: { id: ephemeralSessionId },
    body: {
      system: buildAgentSystemPrompt(participant),
      model: participant.tier_config.model,
      temperature: participant.tier_config.temperature,
      parts: [{ type: "text", text: buildAgentUserPrompt(...) }],
    },
    query: { directory: workingDirectory },
  });
  // ... parse response
} finally {
  await deleteEphemeralSession(ephemeralSessionId);
}
```

### Prompting the Orchestrator (Persistent)

The orchestrator session is the only persistent session — it's reused across all system calls:

```javascript
client.session.prompt({
    path: { id: orchestratorSessionId },
    body: {
      system: "You are a neutral summarizer.",
      model: highestTierModel,
      tools: {},
      parts: [{ type: "text", text: prompt }],
    },
    query: { directory: workingDirectory },
  })
```

**Circuit breaker:** Each model tracks consecutive failures. After 3 failures, the model is skipped for 5 minutes. After the timeout, one test attempt is allowed. On success, the breaker resets.

---

## 8. Moderator System

### When the Moderator Is Consulted

The `checkAndProcess()` function is called every round, but the LLM-based ruling is **gated by thresholds** — it short-circuits without spending tokens when conditions aren't met:

1. Fewer than 3 contributions in the current round → returns `{ action: "continue" }` immediately.
2. Fewer than 2 challenges/dissents in the last 4 contributions → returns `{ action: "continue" }` immediately.
3. Consensus check: if none of the recent contributions are challenges or dissents → returns `{ action: "continue" }` immediately (the moderator is designed to resolve deadlocks; if everyone agrees, there's nothing to resolve).

When thresholds are exceeded, the moderator LLM evaluates whether to:
- **continue** — the deliberation is still productive
- **break** — force a specific participant to speak next (circular argument detected)
- **converge** — the deliberation has reached a natural conclusion

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
  1. Round 2: break → junior_backend_dev
  2. Round 4: continue → continue

## Current State of Play
## Question
Should we migrate our authentication service to JWT tokens?

## Decisions & Proposals
- We should adopt a phased migration over Q1 and Q2, starting with the auth service

## Agreements
- Short-lived access tokens (5 min) are essential
- Stateless auth reduces session store overhead

## Disagreements & Concerns
- Token revocation remains unsolved — blocklists defeat statelessness
- Refresh tokens stored client-side are a high-value target

## Open Questions
- How will existing sessions be handled during the transition?
- What's the actual downtime budget?

Use this to distinguish between:
- Circular arguments (revisiting settled points with no new evidence)
- Legitimate disputes (unresolved disagreements that need more discussion)

## Situation Requiring Your Ruling
Circular argument detected: Security Engineer has challenged 3 times in the
last 6 contributions without new evidence.

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

IMPORTANT: Respond ONLY with the <ruling> block above.
```

### Ruling Types

The moderator can rule:

1. **converge** — `next_speaker: "synthesize"`. The deliberation has reached its natural end.
2. **break** — `next_speaker: "<participant_id>"`. A specific agent is ordered to speak next, breaking a deadlock.
3. **continue** — `next_speaker: "continue"`. No intervention needed, proceed normally.

### Ruling Processing

- **Convergence is deferred** if the current round is less than `minRounds` (default 2). The moderator can't end the meeting too early.
- **Break rulings target only active participants** — not those who have passed or failed.
- **Rulings are tracked** (up to 50) and included in subsequent moderator prompts for consistency.
- **Fallback parsing:** If the moderator response doesn't parse cleanly, the system checks for keywords like "converge", "synthesize", "wrap up" and defaults to convergence.

---

## 9. Turn Order System

### How Turn Requests Work

During the prompt phase, an agent can embed a `[REQUEST_NEXT]` tag to request the next speaking turn for themselves or another participant:

```
[PROPOSE] We should use short-lived JWTs with refresh tokens.

[REQUEST_NEXT: Target: Senior Architect, Priority: 9, Reason: "They have
domain expertise on auth migrations and need to validate this approach"]
```

Or a self-request:

```
[REQUEST_NEXT: Target: Self, Priority: 8, Reason: "I need to respond to
the security concerns raised — I have concrete mitigations"]
```

### Turn Request Resolution

At the end of each round (after prompt + reflection phases), the moderator plans turn order for the next round:

1. **Collect all turn requests** from the round's contributions.
2. **Filter valid requests** — participant must exist and not be failed.
3. **Single-request fast path:** If only one valid request exists, programmatically move that agent to position 0 — no LLM call needed.
4. **Resolve priorities** using the requesting agent's tier:
   - Principal = 10
   - Senior = 9
   - Mid = 7
   - Junior = 5
5. **Sort by priority** descending.
6. **Tie-breaking:** When priorities are equal, the moderator considers:
   - Persona seniority (tier)
   - Who spoke least recently (to balance participation)
7. **Max per round:** 3 turn requests per round. Excess are denied.
8. **Cooldown:** An agent cannot request in consecutive rounds (they must wait their turn).
9. **Auto-grant threshold:** Priority ≥ 9 is automatically granted (intra-round queue jump if during round, or first in next round if at end of round).

### Intra-Round Queue Jumping

If an agent tags `[REQUEST_NEXT: Priority: 9+]` **during their turn** in the prompt phase, the system immediately moves that agent to position 0 of the *remaining* speakers in the current round. This is a pure array swap — no LLM calls.

Example:
- Original queue: `[A, B, C, D]` — A is currently speaking
- A tags `[REQUEST_NEXT: Priority: 9]`
- New queue: `[A, B, D, C]` — C moved to end, B stays at position 1

### Inter-Agent Reordering (Planned for Future)

For Priority < 9, if Agent B requests Agent A and the LLM agrees A should go next, the system can reorder within the current round's remaining speakers. This requires an LLM evaluation but uses the same fast-path model.

### Turn Order Planning

After the round completes, the moderator plans turn order for the next round:

```
You are planning turn order for the next round of a multi-agent deliberation.

## Current State of Play
{state_of_play}

## Turn Requests (Round {n})
- {agent_a} requested {target} (Priority: {p}, Reason: "{reason}")
- {agent_b} requested {target} (Priority: {p}, Reason: "{reason}")

## Available Participants
- {participant_1} ({tier}): {last_contribution_summary}
- {participant_2} ({tier}): {last_contribution_summary}

## Task
Plan the turn order for the next round. Consider:
- Priority scores (higher = go first)
- Who has spoken less recently (balance participation)
- Persona seniority for tie-breaking
- Reasonableness of the requested order

Respond with:
1. Ordered list of participant IDs
2. Brief reasoning for the ordering
```

The planning runs via `fastPathModel` (e.g., Claude Haiku) — a single LLM call per round end.

### Turn Order Notes

After turn order planning, the planned order and any denied requests are formatted as notes and appended to the fabric context:

```
**Turn Order (Round 3 → 4):**
- Planned order: Security Engineer → Architect Lead → Junior Developer
- DENIED: Junior Developer (P5): Priority too low
- DENIED: Architect Lead (P7): Cooldown (requested last round)
```

All agents see these notes in subsequent rounds via the state of play.

---

## 10. Convergence Detection

After each round, 9 checks run to determine if the meeting should end. Each produces a confidence score (0–100). The system uses a weighted scoring model.

### The 9 Checks

| Check | Weight | Min Round | What It Does |
|-------|--------|-----------|--------------|
| all_passed | 1.0 | any | All participants have passed or failed |
| max_rounds | 1.0 | any | Current round ≥ max rounds |
| early_convergence | 0.8 | 2 | All remaining participants passed (others failed) |
| low_novelty | 0.8 | 3 | Last 2 rounds' final contributions are highly similar to earlier context (TF-IDF cosine ≥ 0.45) |
| diminishing_returns | 0.6 | 3 | Recent content cosine similarity to older content ≥ 0.85 |
| stale_participants | 0.5 | 3 | Unique contributors in last 3 rounds ≤ 34% of total |
| diminishing_contributions | 0.55 | 3 | Recent 2 rounds' avg contribution count ≤ 50% of earlier avg |
| semantic | 0.9 | 3 | LLM says "converge" |
| vector_novelty | 0.85 | 3 | Semantic drift between last two rounds is below threshold (cosine distance < 0.15 via sqlite-vec embeddings) |

### The Semantic Check (LLM-Based)

This is the most sophisticated check. The prompt sent to the orchestrator LLM:

```
You are evaluating whether a multi-agent deliberation has reached a natural
conclusion.

## Original Question
Should we migrate our authentication service to JWT tokens?

## Deliberation State
Round: 4/6
Total contributions: 14

## Recent Round Summaries
Round 2: 3 proposals, 2 challenges. Turn requests granted on timeline concerns.
Round 3: 2 supports, 1 challenge. Junior developer raised refresh token security.
Round 4: 1 propose, 2 challenges. Circular argument on revocation vs statelessness.

## Most Recent Contributions
- [senior_architect] (propose): We should use a hybrid approach — short-lived
  JWTs for API auth, refresh tokens stored server-side...
- [mid_security_engineer] (challenge): Server-side refresh tokens are just
  session tokens with extra steps. We've reinvented stateful auth...
- [junior_backend_dev] (challenge): This feels like we're going in circles.
  The real question is: what's the actual downtime budget?

## Task
Decide whether this deliberation should continue or converge. Consider:
- Are participants repeating positions from earlier rounds without new reasoning?
- Is new information or meaningful reasoning still being introduced?
- Has the discussion naturally exhausted its productive potential?

Respond with EXACTLY this format:
decision: <converge | continue | extend>
reason: <one sentence explanation>
key_disagreements: <comma-separated list of unresolved disagreements, or "none">
```

### Scoring Logic

```
maxConfidence = max(check.confidence × check.weight) for all triggered checks
normalizedScore = maxConfidence / 100

thresholds:
  consensus mode: 0.9
  majority mode: 0.7
  moderator_forces mode: 0.6 (default)

shouldStop = normalizedScore >= threshold
```

The "extend" action from the semantic check adds 1 round to max_rounds (capped at 10).

---

## 11. State of Play

The state of play is the primary running context for agents. It replaces the old fabric compaction system with a structured, always-accurate summary derived from the full weave.

### What It Contains

The state of play is a markdown document with these sections:

```markdown
## Question
Should we migrate our authentication service to JWT tokens?

## Domain
engineering

## Decisions & Proposals
- We should adopt a phased migration over Q1 and Q2, starting with the auth service
- Use short-lived JWTs (5 min expiry) with refresh tokens

## Agreements
- Short-lived access tokens are essential
- Stateless auth reduces session store overhead
- Phased approach reduces risk

## Disagreements & Concerns
- Token revocation remains unsolved — blocklists defeat statelessness
- Refresh tokens stored client-side are a high-value target
- Server-side refresh tokens reinvent stateful auth

## Open Questions
- How will existing sessions be handled during the transition?
- What's the actual downtime budget?
- Is the revocation problem solvable without returning to stateful auth?
```

### How It's Derived

After each round finalization, the orchestrator calls `updateStateOfPlay(weave, question, domain)` which categorizes contributions using **the parsed type tag** (`c.type`) as the primary signal:

| `c.type` | Category |
|-----------|----------|
| `propose`, `refine` | Decisions & Proposals |
| `support` | Agreements |
| `challenge`, `dissent` | Disagreements & Concerns |
| `question` | Open Questions |
| `synthesize`, `refuse`, `pass` | (excluded) |
| unknown/missing | Fallback keyword matching |

**Fallback keyword matching** (for contributions with missing/unknown type tags) uses word-boundary-aware regex to avoid substring false positives (e.g., `\bwe should\b` instead of `.includes("we should")`).

Each section is capped at the 5 most recent items. Each item is truncated to 300 characters. The content is cleaned of `[REQUEST_NEXT]`, `[GOVERNANCE]`, and type tags before inclusion.

### How It Appears in Agent Prompts

```
<<<LOOM_STATE_OF_PLAY_BEGIN_
## Question
Should we migrate our authentication service to JWT tokens?

## Decisions & Proposals
- We should adopt a phased migration over Q1 and Q2

## Agreements
- Short-lived access tokens are essential

## Disagreements & Concerns
- Token revocation remains unsolved

## Open Questions
- How will existing sessions be handled during transition?
<<<LOOM_STATE_OF_PLAY_END_>>>
```

### Persistence

The state of play is stored in `meetings.state_of_play` in the database and updated after each round. On resume, it is restored from the database.

### Why This Replaces Fabric Compaction

The old system appended round summaries to a "fabric" string and compressed it when it exceeded `maxFabricChars`. This had two problems:
1. **O(N²) token growth** — persistent sessions accumulated history, and the injected fabric grew each round
2. **Information loss** — compaction (rule-based or LLM) lost nuance from earlier rounds

The state of play solves both: it's derived from the full weave (no information loss) and bounded in size (no growth). Combined with ephemeral sessions, token growth is O(1) per turn.

---

## 12. Reflection System

Reflections are private, evolving belief states that agents maintain across rounds. Each reflection supersedes any prior one — the agent produces a single coherent paragraph that captures its current thinking, not a list of disconnected notes.

### When Reflections Trigger

After the prompt phase, if any contribution was a "challenge" or "dissent", every other active participant generates a reflection. Reflections run in parallel via `Promise.allSettled()`.

### How Reflections Evolve

Each agent maintains a single `reflection` string (not an array). When generating a new reflection, the agent sees:
1. Its previous reflection (if any)
2. The triggering challenge/dissent
3. The agent's own recent contributions

The agent produces a 2–3 sentence paragraph that **updates** its prior reflection:
- Keep what still holds
- Revise what has changed
- Add what's new

This creates a narrative of evolving thought: *"Initially concerned about token theft, but after seeing the phased migration proposal, the bigger concern is..."*

### Context-Aware Prompts

Reflection prompts are composed from three axes:
- **Tier** — analytical lens (junior: instinctive, mid: structural, senior: risk/feasibility, principal: actionability)
- **Persona** — the agent's role and agenda
- **Recency** — the agent's own last 2 contributions (avoids repetition)

### Storage

Each participant has a single `reflection` field (string). The reflection is persisted to the database and appears in subsequent agent prompts as:

```
## Your Reflection
Initially concerned about token theft, but after seeing the phased
migration proposal, the bigger concern is refresh token rotation...
```

When the agent has no prior reflection, the prompt notes: *(No prior reflection — this is your first)*.

---

## 13. Round Summarization

After each round, a summary is generated for display and persistence purposes.

### Heuristic Summary (always generated)

Counts contribution types: "Round contributions (4): 1 propose, 2 challenge, 1 support. 1 turn request(s)."

### LLM Semantic Summary (conditional)

Only generated when:
- Convergence mode is `moderator_forces`
- There are >2 contributions
- There are conflict signals (challenges, dissents, or turn requests)

The prompt:

```
Summarize this deliberation round in 2-3 sentences. What was established?
What remains contested?

Contributions:
- [PROPOSE] We should adopt a phased migration over Q1 and Q2...
- [CHALLENGE] The short-expiry approach assumes refresh tokens can't be stolen...
- [SUPPORT] The stateless benefit is real, we could use short expiry...
- [DISSENT] We're solving the wrong problem — revocation lists are inevitable...

Summary:
```

### Storage

Round summaries are stored in the `rounds` table for display in the dashboard. They are NOT appended to any running context — the state of play is regenerated from the full weave instead.

---

## 14. Synthesis

When the meeting ends (convergence, max rounds, timeout, or cancellation), the system synthesizes all contributions into a final artifact.

### Synthesizer Selection

Priority: principal > senior > any non-failed > last participant.

### The Synthesis Prompt

The synthesis prompt uses the **State of Play** as its primary context, with the **final round transcript** as supporting detail. The full transcript is omitted — the State of Play already captures all historical decisions and agreements. Only the final round is included to show how the conversation concluded.

```
You are the synthesizer. The deliberation is complete. Produce the final artifact.

## Original Question
Should we migrate our authentication service to JWT tokens?

## Domain Context
This is an engineering question. Focus on technical tradeoffs, implementation
feasibility, and risk mitigation. Prioritize solutions that balance correctness
with pragmatism.

## State of Play (Final)
## Question
Should we migrate our authentication service to JWT tokens?

## Decisions & Proposals
- We should adopt a phased migration over Q1 and Q2, starting with the auth service
- Use short-lived JWTs (5 min expiry) with refresh tokens

## Agreements
- Short-lived access tokens are essential
- Stateless auth reduces session store overhead
- Phased approach reduces risk

## Disagreements & Concerns
- Token revocation remains unsolved — blocklists defeat statelessness
- Refresh tokens stored client-side are a high-value target
- Server-side refresh tokens reinvent stateful auth

## Open Questions
- How will existing sessions be handled during the transition?
- What's the actual downtime budget?
- Is the revocation problem solvable without returning to stateful auth?

## Unresolved Objections
- Security Engineer: Server-side refresh tokens are just session tokens with extra steps (Round 2)
- Junior Developer: What's the actual downtime budget? (Round 3)

## Deliberation Transcript (Final Round Only)
### Round 3
**[Architect Lead]** (senior, propose): [PROPOSE] We should migrate to JWT for
stateless auth...
**[Security Engineer]** (senior, challenge): [CHALLENGE] JWTs can't be revoked
easily...
**[Junior Developer]** (junior, support): [SUPPORT] The stateless benefit is
real...
**[Backend Engineer]** (mid, propose): [PROPOSE] We could use a hybrid approach...

## Participants
- Architect Lead (senior): 3 contributions
- Security Engineer (senior): 4 contributions
- Junior Developer (junior): 2 contributions
- Backend Engineer (mid): 3 contributions

## Instructions
Produce a comprehensive, well-structured response that:
1. Directly answers the original question
2. Captures the strongest points from all perspectives
3. Notes any unresolved disagreements
4. Provides clear, actionable conclusions
5. Identifies remaining risks or open questions

Use the State of Play as your primary reference for what was decided, agreed
upon, and left unresolved. The final round transcript provides supporting detail
and shows how the conversation concluded.

Format as markdown with these exact sections:
## Decision
## Reasoning
## Action Items
## Dissenting Views
## Open Questions
## Confidence

For Confidence:
- High = all active participants contributed meaningfully and there are no
  unresolved disagreements
- Medium = general agreement with minor dissent, or some participants did not
  contribute
- Low = significant disagreement remains, or many participants failed to
  contribute
```

### Self-Critique Pass

After the first synthesis draft, the synthesizer reviews its own output against the transcript:

```
Review this synthesis against the deliberation transcript. Check for:
1. Misattributed views — are views correctly attributed to the right participants?
2. Invented points — are any points in the synthesis that were never raised?
3. Omitted dissent — were any significant disagreements left out?
4. Unsupported decisions — is the decision supported by the actual discussion?

If corrections are needed, output the revised synthesis.
If accurate, respond: [NO_CHANGES]
```

This runs up to 2 times.

### Finalization

After the LLM synthesis, the system:
- Appends unresolved objections (from `objection_collector`)
- Adds refusal notes (agents who refused to engage)
- Adds missing-section notes if the LLM skipped required sections
- Derives confidence heuristically if the LLM didn't provide it:

```javascript
if (dissentCount === 0 && challengeRatio < 0.3 && participationRate >= 0.5) return "high";
if (dissentCount <= 1 && challengeRatio < 0.5 && participationRate >= 0.33) return "medium";
return "low";
```

### Fallback Synthesis

If synthesis entirely fails, a degraded artifact is constructed by categorizing contributions:

```
# Deliberation Output

## Decision
Synthesis could not be completed (error message).

## Reasoning
The meeting reached its end state but the synthesis step failed.
The full transcript is preserved for review.

## Action Items
- Retry synthesis with the meeting data
- Review the transcript tab for the full deliberation

## Confidence
Low (synthesis interrupted)
```

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
  fabric: "We're a 50-person startup...",   // original context (immutable after init)
  state_of_play: "## Question\nShould we...", // structured summary, rebuilt each round
  weave: [/* all contributions across all rounds */],
  rounds: [
    {
      number: 1,
      contributions: [/* contribution objects */],
      turn_requests: [/* turn request objects */],
      token_path: [/* token usage */],
      summary: "Round contributions (4): 2 propose, 1 challenge, 1 support."
    }
  ],
  current_round: 3,
  max_rounds: 6,
  current_speaker_idx: 0,
  status: "weaving",  // initializing | weaving | converged | cancelled | timeout | max_rounds_reached | aborted | deadlocked
  artifact: null,     // set after synthesis
  objections: [],
  convergence_mode: "moderator_forces",
  domain: "engineering",
  next_contribution_id: 14,
  next_speaker_id: null,  // set by moderator "break" ruling
}
```

### Immutability

Reads return deep-frozen copies. All mutations go through targeted methods on StateManager:

```javascript
stateManager.transitionTo("weaving")           // validated state machine
stateManager.addContribution(obj)              // atomic addition
stateManager.setFabric(newFabric)              // original context (rarely changed)
stateManager.setStateOfPlay(newSummary)        // structured summary, updated each round
stateManager.reorderForNextSpeaker(id)         // splice + unshift
stateManager.addParticipantReflection(id, text)
```

### Persistence

State is persisted to SQLite after each round finalization and after terminal events. The persistence is atomic (single transaction):

```sql
UPDATE meetings SET fabric = ?, state_of_play = ?, round = ?, status = ?,
  next_speaker_id = ?, stats = ? WHERE id = ?;
```

---

## 16. Error Handling

### Agent Prompt Failures

Each agent prompt is wrapped with retry logic:

- **Adaptive retry count:** `max(1, 2 - failedInCurrentRound)`. As more agents fail, remaining agents get fewer retries.
- **Exponential backoff:** 1s → 2s → 4s → 8s, with 500ms jitter.
- **Retryable errors:** ECONNREFUSED, ETIMEDOUT, ENOTFOUND, HTTP 5xx, HTTP 429 (rate limit).
- **Final failure:** The agent's status is set to "failed", an error record is stored in the database, and the agent is skipped for the rest of the round. The ephemeral session is cleaned up.

### Circuit Breaker

Per-model failure tracking. After 3 consecutive failures:
- Model is marked "open" and skipped.
- After 5 minutes, enters "half-open" (one test attempt allowed).
- On success, state resets to "closed".

### Database Errors

All database operations are wrapped in try-catch. Transactions use explicit BEGIN/COMMIT/ROLLBACK.

### All-Failed Handling

If all participants fail or all pass, a degraded artifact is generated:

```
# Deliberation Output

## Decision
No output could be generated — all participants passed without contributing.

## Reasoning
All 4 participants chose to pass. This may indicate the question was unclear
or participants had nothing to add.

## Action Items
- Rephrase the question with more specific context
- Add participants with more targeted expertise

## Confidence
Low (no contributions received)
```

---

## 17. Stall Detection

A watchdog monitors activity. If no state update occurs for 5 minutes (default), the meeting is cancelled.

**Configuration:** `stallTimeoutMs` = 300,000ms (5 min), tick interval = 30,000ms (30s).

**Mechanism:** The watchdog's `start()` method begins a timer. On each tick:
1. Check if the meeting is still in "weaving" or "initializing" status.
2. Check if `Date.now() - lastActivityAt > stallTimeoutMs`.
3. If stalled, set `stallCancelled = true` and call `onStall()`.

**Activity touch:** The `lastActivityAt` timestamp is updated on every state update (`#notifyUpdate()`) and on every contribution stored.

**Stall response:** When stall is detected, `#cancelled` is set to `true`. The weaving loop detects this and transitions to "timeout" status (not "cancelled" — the distinction indicates the meeting was terminated by inactivity, not user action).

---

## 18. Extension Logic

### User-Triggered Extension

When a user runs `/knit` again in a session that already has a meeting, the system extends instead of creating a new meeting:

1. The new user input is appended to the fabric: `**User Input:** <new prompt>`.
2. Status is force-transitioned back to "weaving".
3. `max_rounds` is increased by 4 (configurable `EXTENSION_EXTRA_ROUNDS`).
4. All participants are reset to "listening" status.
5. The weaving loop restarts from the current round.

### Automatic Extension via Convergence

The semantic convergence check can return "extend" instead of "converge" or "continue". When this happens:
- `max_rounds` is incremented by 1 (capped at 10).
- The meeting continues for one more round.

This handles the case where the LLM detects the discussion is close to conclusion but needs one more round to resolve key disagreements.

---

## 19. VectorIndex + RAG Context Retrieval

The VectorIndex system provides semantic retrieval over prior deliberation context using sqlite-vec. It chunks round summaries and contributions, embeds them, and stores them in a vector database for similarity search.

### Architecture

```
User context (initial)
  ↓ indexContext()
  ↓
fabric_chunks table ← vec_fabric_chunks virtual table (N-dim float vectors from ONNX model)
  ↑
Round summaries + contributions
  ↓ indexRound()
  ↓
embedText() → loadModel() → ONNX session + tokenizer → embed() → Float32Array
  ↓
Agent prompt (RAG retrieval)
  ↓ retrieveRelevant()
  ↓
"Relevant Prior Context" section in user prompt
```

### Embedding Service

The embedding service (`embedding-service.js`) provides a pluggable embedding interface backed by a local ONNX model:

- **ONNX Runtime model** (current): Uses `onnxruntime-node` for inference and `@huggingface/tokenizers` for tokenization. The default model is **Snowflake/snowflake-arctic-embed-xs** (~22 MB, 384 dims, BERT architecture, int8 quantized). The model runs entirely locally — no API calls, no network dependency for embeddings.

- **Model resolution**: `onnxruntime-node` and `@huggingface/tokenizers` are marked as esbuild externals (not bundled into `dist/loom.js`). At runtime, they are resolved from a dedicated deps directory at `~/.config/opencode/loom/deps/node_modules/` via `createRequire`, with a fallback to the project's `node_modules` for local development. This solves the module-resolution problem where the deployed plugin (`~/.config/opencode/plugins/loom.js`) cannot resolve bare specifiers from the project root.

- **Model download**: The default model is downloaded during `npm run install:plugin` via `scripts/model.mjs` into `~/.config/opencode/loom/models/<name>/model.json`. The `model.json` specifies dims (384), maxTokens (512), modelType (bert), quant path, and download metadata.

- **Initialization**: `initEmbeddingModel()` is called eagerly when `startDashboard()` runs (i.e., on any `/loom_viz` invocation). The dashboard shows the embedder status (loading/ready/failed) in the sidebar. Agents also trigger initialization on the first `initializeEmbedder()` call if the dashboard hasn't started yet.

```javascript
// src/services/model-manager.js
async loadModel(name, quant) {
  const ort = await resolveOnnx();           // from ~/.config/opencode/loom/deps/
  const Tokenizer = await resolveTokenizer();
  const session = await ort.InferenceSession.create(modelPath);
  const tokenizer = await Tokenizer.fromFile(tokenizerPath);
  return { session, tokenizer, dims: modelJson.dims, maxTokens: modelJson.maxTokens };
}
```

The `embed()` method tokenizes text, creates input tensors (`int64` for input_ids, attention_mask, token_type_ids), runs `session.run()`, extracts the `last_hidden_state` tensor, pools via mean-normalization over non-padding tokens, and L2-normalizes the result to a `Float32Array` of length `dims`.

### Chunking Strategy

Text is split into chunks suitable for embedding:
- Split on paragraph boundaries (`\n\n`)
- Max ~500 characters per chunk
- Short paragraphs are merged until the limit is reached
- Each chunk is tagged with its source type: `round_summary`, `contribution`, or `context`

### Indexing Flow

**At meeting start** (non-resume): The user-provided context is indexed via `vectorIndex.indexContext(context)`. This is fire-and-forget — it doesn't block meeting initialization.

**After each round finalization**: `vectorIndex.indexRound(roundNumber, summary, contributions)` is called. This:
1. Chunks the round summary → stores each chunk in `fabric_chunks` → embeds each chunk → stores vector in `vec_fabric_chunks`
2. For each contribution: prefixes with `[participant_id] (type)`, chunks, stores, and embeds

Both operations run asynchronously (`.catch((err) => logger.warn(...))`) — vector indexing is best-effort and doesn't block the weaving loop.

### Retrieval Flow

When prompting an agent, the system retrieves relevant prior context:

```javascript
const queryText = currentContribs.map((c) => c.content).join("\n");
const ragChunks = await vectorIndex.retrieveRelevant(queryText, 5, currentRound);
const ragContext = ragChunks
  .map((c) => `[Round ${c.round}] ${c.content}`)
  .join("\n\n");
```

The retrieval:
1. Embeds the query text (current round's contributions so far, or the question if no contributions yet)
2. Performs cosine similarity search via `vec_fabric_chunks MATCH`
3. Excludes chunks from the current round (avoids self-referencing)
4. Returns top 5 results with distance scores

### How RAG Context Appears in Agent Prompts

When RAG context is available, it appears in the user prompt as:

```
<<<LOOM_RELEVANT_PRIOR_CONTEXT_BEGIN_
[Round 1] The JWT migration makes sense, but token revocation is unsolved...
[Round 2] Refresh tokens with server-side storage defeats statelessness...
[Round 3] We agreed on short expiry times, but the revocation list remains...
<<<LOOM_RELEVANT_PRIOR_CONTEXT_END_>>>
```

When no RAG context is available (early rounds, empty index), this section is omitted.

### Persona-Aware RAG Queries

The RAG query is persona-aware: it combines the agent's recent contributions with the question to produce a query that's relevant to the agent's perspective. This means different agents may retrieve different "relevant" context, reflecting their individual focus areas.

### Semantic Drift Detection

The VectorIndex also supports computing semantic drift between two rounds via `computeSemanticDrift(roundA, roundB)`:

1. Retrieves all chunks for each round
2. Computes the centroid embedding for each round (average of all chunk embeddings, normalized)
3. Returns cosine distance: 0 = identical, 1 = orthogonal, 2 = opposite

This is used by the `vector_novelty` convergence check (Section 10). If the drift between the last two rounds is below 0.15, it signals the discussion has stagnated semantically — agents are rehashing the same ideas even if the exact words differ.

### Database Schema

**fabric_chunks** (regular table):
```sql
CREATE TABLE fabric_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'round_summary',
  created_at TEXT NOT NULL
);
```

**vec_fabric_chunks** (sqlite-vec virtual table):
```sql
CREATE VIRTUAL TABLE vec_fabric_chunks USING vec0(
  id INTEGER PRIMARY KEY,
  embedding float[384]
);
```

**Dimension note**: The vector dimension is determined by the embedding model at runtime. If the model's dims change (e.g., switching from `snowflake-arctic-embed-xs` at 384 dims to a larger model), the vec table is created with the matching dimension at database initialization time. The `vec_fabric_chunks_{dim}` naming convention is not used — a single table stores all embeddings, and the dimension is set from `model.json` on first load.

---

## 20. Fast-Path Model Routing

The fast-path model routing system allows certain orchestrator calls to use a cheaper, faster model instead of the highest-tier agent model.

### Motivation

The orchestrator session is shared for multiple system-level calls: moderation, summarization, convergence checks, and domain detection. Not all of these require the most powerful model. The fast-path routing lets you assign a lightweight model to routine calls while reserving the best model for agent prompts.

### Configuration

```javascript
{
  fastPathModel: "anthropic/claude-haiku"  // empty string = disabled
}
```

### What Gets Routed

The `#promptOrchestrator` method checks the call type and routes accordingly:

| Call Type | Fast-Path? | Description |
|-----------|-----------|-------------|
| `moderation` | Yes | Moderator rulings |
| `summary` | Yes | Round summary generation |
| `compaction` | Yes | Context compaction |
| `domain` | Yes | Domain detection (simple keyword classification) |
| `orchestrator` | No | Default — uses highest-tier model |
| `convergence` | No | Convergence verdict (semantic check) |

When `fastPathModel` is set and the call type matches, the fast-path model is used instead of the highest-tier agent model. When `fastPathModel` is empty (default), all orchestrator calls use the highest-tier model.

### Implementation

```javascript
async #promptOrchestrator(system, model, message, type = "orchestrator") {
  const fastPathModel = getConfig().fastPathModel;
  const useModel = (fastPathModel && (type === "moderation" || type === "compaction" || type === "summary" || type === "domain"))
    ? fastPathModel
    : model;
  // ... prompt with useModel
}
```

---

## Appendix: Key Configuration Values

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxContributionWords` | 250 | Max words per agent contribution |
| `maxTurnRequestWords` | 200 | Max words per turn request reason |
| `defaultMaxRounds` | 3 | Default meeting length |
| `maxTurnRequestsPerRound` | 3 | Cap on turn requests per round |
| `agentTimeoutMs` | 120,000 | Per-agent LLM call timeout |
| `maxRetryAttempts` | 2 | Retries per agent call |
| `retryBaseDelayMs` | 1,000 | Base retry delay |
| `retryMaxDelayMs` | 8,000 | Max retry delay |
| `stallTimeoutMs` | 300,000 | Inactivity timeout |
| `meetingTimeoutMs` | 600,000 | Absolute meeting timeout |
| `convergence.lowNoveltyCosineThreshold` | 0.45 | TF-IDF similarity threshold |
| `convergence.llmVerdictConfidence` | 90 | LLM convergence confidence |
| `convergence.staleParticipantRatio` | 0.34 | Stale participant threshold |
| `convergence.diminishingReturnsWindow` | 3 | Rounds to compare |
| `synthesisMaxRetries` | 1 | Synthesis retry count |
| `critiqueMaxRetries` | 2 | Self-critique retry count |
| `fastPathModel` | `""` | Model for cheap orchestrator calls (empty = disabled) |
| `DEFAULT_EMBEDDING_MODEL` | `"Snowflake/snowflake-arctic-embed-xs"` | Default embedding model name (model-manager.js export) |
| `DEFAULT_EMBEDDING_QUANT` | `"onnx/model_int8.onnx"` | Default quantization file (model-manager.js export) |
| `EMBEDDING_DIM` | 384 | Default embedding dimensionality (set from model.json at runtime) |

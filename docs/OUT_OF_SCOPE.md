# Out of Scope — The Loom

Features and approaches that have been evaluated and explicitly excluded from the current design, with rationale and feasibility assessment.

---

## Real-Time Streaming Interruption

**Status:** Not feasible with current opencode SDK

### What It Would Do

Allow an agent to interrupt another agent *while they are actively generating a response* — mid-sentence, mid-token. The interjector would inject their point immediately, and the original speaker would see the interjection before continuing.

### Why It's Not Feasible

The opencode SDK's `session.prompt()` is a single request-response call. It returns a complete response object when the LLM finishes generating. There is no mechanism to:

1. **Stream tokens client-side** — The SDK does not expose a streaming interface for partial response consumption.
2. **Abort an in-flight prompt** — Once a `session.prompt()` call is in progress, there is no API to cancel or pause it.
3. **Inject context mid-generation** — Even if we could stream, LLMs generate tokens autoregressively. You cannot insert new input into an ongoing generation without restarting from the prompt.

### Theoretical Requirements

To implement this, we would need:

| Requirement | Status |
|-------------|--------|
| Streaming token API from opencode SDK | Not available |
| LLM API support for prompt abortion | Partial (OpenAI/Anthropic support this) |
| Context window management for partial responses | Complex (would need to reconstruct prompt state) |
| Timeout/continuation logic for resumed speakers | Would need custom implementation |

### Alternative: Sequential Post-Contribution Interjection

What IS feasible (and now implemented): **sequential interjection**. After a participant finishes their full response, the system evaluates whether any other participant wants to respond immediately. If so, the interjector speaks before the round continues to the next scheduled participant.

This achieves 90% of the value at 10% of the complexity:

- Agents can react to specific points while they're fresh
- The deliberation still feels dynamic and responsive
- No SDK changes required
- Deterministic and testable

---

## Full Parallel Deliberation (All Agents Simultaneously)

**Status:** Partial — parallel prompting implemented, but not full parallel deliberation

### What "Full Parallel" Would Mean

Every agent in every round is prompted simultaneously. No agent ever sees another agent's contribution in the same round. Each round is a single parallel burst, and the warp (shared context) is the only cross-agent communication.

### The Tradeoff

| | Sequential (Old) | Parallel (Current Default) | Full Parallel |
|---|---|---|---|
| **Speed** | Slow (n× latency) | Fast (1× latency) | Fastest (1× latency) |
| **Cross-referencing** | High (see all same-round contributions) | Medium (see warp + previous rounds) | Low (see only warp) |
| **Interjection** | Natural (between turns) | Post-round phase | Not possible |
| **Reflection** | After each contribution | After round completes | After round completes |

### Current Implementation

The Loom uses **parallel prompting** (all participants prompted concurrently) combined with **post-round reflection and interjection phases**. This gives us:

- **Speed**: All participants in a round are prompted simultaneously
- **Responsiveness**: Reflection and interjection phases after the parallel burst allow agents to react to what others said
- **Quality**: The warp context preserves key information from previous rounds

### Why Not Full Parallel

Full parallel (no reflection/interjection phases) would be faster but would lose the responsive dynamic that makes deliberation valuable. The reflection and interjection phases add 2-4 additional LLM calls per round but produce significantly richer output.

---

## Enforced Seniority-Based Rights (Governance Directives)

**Status:** Deferred — prerequisite features not yet mature

### What It Would Do

Programmatically enforce that only agents with the right tier can use certain directives:

| Directive | Required Tier | Enforcement |
|-----------|--------------|-------------|
| `[INTERJECT]` | Any | Currently prompt-guided |
| `[CALL_VOTE]` | Mid+ | Not implemented |
| `[VETO]` | Senior+ | Not implemented |
| `[FORCE_END]` | Principal | Not implemented |
| `[REFUSE]` | Any | Not implemented |

### Why Deferred

1. **Interjection must work first** — You can't enforce rights on a directive that doesn't function. Sequential interjection is now implemented; enforcement can follow.
2. **Prompt guidance is "good enough"** — LLMs generally respect behavioral instructions in system prompts. Enforcement is a robustness improvement, not a critical gap.
3. **Adds agent prompt overhead** — Every new directive adds text to the system prompt, competing with persona and agenda for attention.

### Path Forward

Once interjection is stable, add governance directives incrementally:
1. Add `[REFUSE: reason]` (small, low-risk)
2. Add `[CALL_VOTE]` (requires vote tallying logic)
3. Add `[VETO]` and `[FORCE_END]` (requires synthesis override logic)
4. Add programmatic enforcement (check `can(participant, action)` before processing)

---

## Token-Passing / Talking Stick (`[NEXT: name]`)

**Status:** Deferred — high LLM reliability risk

### What It Would Do

After contributing, an agent chooses who speaks next. This breaks rigid round-robin ordering and makes deliberation feel more organic.

### Why Deferred

**LLM reliability is the core risk.** Agents might:
- Pick the same speaker repeatedly (deadlock)
- Pick passed participants
- Pick themselves (infinite loop)
- Fail to follow the `[NEXT: name]` format
- Make suboptimal choices (always deferring to seniors, ignoring juniors)

Each failure mode requires fallback logic, timeout handling, and recovery — adding significant complexity.

### Path Forward

Consider as an experimental opt-in feature (`token_passing: true`) once:
- Core deliberation flow is stable
- Interjection is working (simpler form of reordering)
- We have data on LLM reliability with structured directives

---

## Cross-Round Persistent Memory

**Status:** Partial — reflections provide limited form

### What Full Memory Would Do

Agents would maintain a structured memory of their own prior contributions, explicitly referenced in future prompts:

```
## Your Previous Contributions
- Round 1: "We should use PostgreSQL for reliability" (type: propose)
- Round 2: "Actually, let me reconsider given the scale requirements" (type: refine)

## Your Private Reflections
- On Security Engineer's threat model: "I agree we need encryption at rest"
```

### Why Not Fully Implemented

1. **Context window cost** — Each agent's prompt is already ~500-800 tokens. Adding full history would double it.
2. **Diminishing returns** — The warp already contains round summaries. Explicit memory is most valuable for agents who passed early rounds and are returning later.
3. **Complexity** — Requires tracking per-agent contribution history, formatting it, and deciding what to include.

### Current Implementation

Reflections provide a lightweight form of cross-round memory: agents store a private thought after challenging contributions, which is included in their next speaking turn. This captures the highest-value memory (reactions to disagreement) without the overhead of full history.

---

## Agent-Initiated Round Extension

**Status:** Deferred — requires agent-to-orchestrator signaling

### What It Would Do

An agent could request "one more round" before convergence, signaling that the deliberation hasn't reached a satisfactory conclusion.

### Why Deferred

Requires a signaling mechanism from agents back to the orchestrator beyond the current contribution types. Could be implemented as a special directive like `[EXTEND: reason]`, but adds convergence complexity.

---

## Real-Time Human Interjection

**Status:** Out of scope by design

### What It Would Do

Allow the human user to inject comments or guidance while agents are actively deliberating, not just between rounds.

### Why Out of Scope

The orchestration loop is synchronous — it runs to completion without yielding control to the user mid-round. Human input is already supported between rounds via the `waitForUserInput` callback, which is the appropriate granularity for human participation.

Injecting human input mid-round would require:
- Async interruption of the orchestration loop
- Race condition handling (what if human and agent write simultaneously?)
- Confusion in the transcript (whose contribution is whose?)

The current model — human input between rounds — is cleaner and more comprehensible.

---

## Semantic Convergence Detection

**Status:** Partial — rule-based detection only

### What Full Semantic Detection Would Do

Instead of counting challenge/dissent types, analyze the actual content of contributions to detect:
- "Agents are repeating the same points"
- "No new information since round 2"
- "Consensus is emerging but not yet declared"

### Why Not Fully Implemented

1. **Requires an additional LLM call per round** — Adds latency and cost
2. **Hard to evaluate** — How do you measure "semantic convergence" objectively?
3. **Existing heuristic is reasonable** — Challenge/dissent counting is a decent proxy

### Current Implementation

The moderator intervention check (`moderation.js`) uses a simple heuristic: if 3 of the last 4 contributions are challenges/dissents within a single round, trigger moderator review. Combined with the new interjection system, this provides adequate convergence management.

---

## Model Fallback on Provider Failure

**Status:** Not implemented

### What It Would Do

If a participant's assigned model fails repeatedly, automatically fall back to a different model from the same or different provider.

### Why Not Implemented

1. **Model capabilities vary** — A fallback model might have different context windows, reasoning capabilities, or behavior.
2. **Inconsistent persona** — If an agent switches models mid-deliberation, their "voice" changes.
3. **Complexity** — Requires tracking model health, maintaining fallback chains, and handling partial-failure states.

### Current Behavior

If a participant's model fails, they are marked as "passed" and the deliberation continues without them. This is simpler and more predictable than silent model switching.

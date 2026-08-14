# Out of Scope — The Loom

Features and approaches that have been evaluated and explicitly excluded from the current design, with rationale and feasibility assessment.

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

## Agent-Initiated Round Extension

**Status:** Deferred — requires agent-to-orchestrator signaling

### What It Would Do

An agent could request "one more round" before convergence, signaling that the deliberation hasn't reached a satisfactory conclusion.

### Why Deferred

Requires a signaling mechanism from agents back to the orchestrator beyond the current contribution types. Could be implemented as a special directive like `[EXTEND: reason]`, but adds convergence complexity.

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

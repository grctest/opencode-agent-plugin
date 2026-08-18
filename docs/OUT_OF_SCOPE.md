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


# Loom Improvement Roadmap

Features that are currently partial or need work to fully deliver on their promise.

Each item includes: current state, value assessment, feasibility, production risk, and recommendation.

---

## 1. Push-Back / Refusal (Beyond [PASS])

**Status:** Recommended — do first

**Current state:** Agents can contribute `challenge` or `dissent` types, but there's no explicit refusal mechanism beyond `[PASS]`. An agent that fundamentally disagrees with the question's premise can only contribute a challenge or pass.

**What's needed:**
- `[REFUSE: reason]` directive — agent refuses to engage with the current line of discussion
- Agent provides a reason (stored in `reason` field)
- Refusal is recorded in transcript and visible in final output
- Distinguishes "I pass" (no opinion) from "I refuse" (active objection to the premise)

**Value:** Medium. Preserves a stronger dissent signal. For high-stakes deliberations, agents should be able to say "this question is based on a flawed premise."

**Feasibility:**
- Implementation: Small. Add `[REFUSE: reason]` parsing to `validation.ts`, add `"refuse"` to `ContributionType`, handle in `orchestrator.ts`, include in `artifact.ts` output
- Production risk: Low — it's a superset of existing `[PASS]` parsing. No circular logic or inter-agent coordination needed

**Files to modify:**
- `src/validation.js` — parse `[REFUSE: reason]` from agent response
- `src/types.js` — add `"refuse"` to `ContributionType`
- `src/orchestrator.js` — handle refusal as a distinct contribution type
- `src/prompts.js` — document `[REFUSE]` directive in agent system prompt
- `src/synthesizer.js` — handle `"refuse"` type in synthesis

**Effort:** Small | **Risk:** Low | **Value:** Medium

---

## 2. Per-Agent Model Assignment

**Status:** Recommended — do second

**Current state:** Models are assigned per tier. If you have 2 providers (e.g., OpenAI + Anthropic), principal/senior get one model and mid/junior get another. All agents within the same tier share the same model. The `participant.config.model` field already exists and is used — just no logic to assign different models to different participants within the same tier.

**What's needed:**
- When auto-composing, prefer diverse models across all participants (not just per tier)
- Allow explicit per-participant model override in `/knit` args
- When models are scarce, allow reuse with a note in the output

**Value:** Medium. Model diversity reduces groupthink. Well-established in multi-agent literature — different models have different reasoning styles, biases, and blind spots.

**Feasibility:**
- Implementation: Small-Medium. Infrastructure already exists (each participant has a `model` field, `getParticipantModel()` reads it). Need better assignment logic in `composer.ts` and `index.ts` args
- Production risk: Low — the model field already exists and is used. Just better assignment logic

**Files to modify:**
- `src/composer.js` — when auto-composing, prefer diverse models across participants
- `src/handlers/knit-handler.js` — allow `models` array in `/knit` args for per-participant overrides
- `src/orchestrator.js` — already reads `participant.config.model`, no changes needed
- `src/services/model-service.js` — add per-participant assignment logic

**Effort:** Small-Medium | **Risk:** Low | **Value:** Medium

---

## 3. Enforced Seniority-Based Rights

**Status:** Deferred — implement governance directives first

**Current state:** Rights are communicated via system prompts but not programmatically enforced. A junior agent could theoretically issue a veto. However, the bigger issue is that vote/veto/force-end directives don't exist yet — so there's nothing to enforce.

**What's needed (full feature):**
- Add `[VETO]`, `[FORCE_END]`, `[CALL_VOTE]` directives that agents can use
- Programmatic enforcement: check `can(participant, "veto")` before processing
- Return guidance to agent if they attempt an action beyond their tier

**Value:** Low-Medium. System prompt guidance works adequately in practice — LLMs generally respect behavioral instructions. Enforcement is correctness/robustness, not a critical gap.

**Feasibility:**
- Implementation: Large. Need to add the governance directives first (parsing, handling, interjection resolution), then add enforcement checks
- Production risk: Low enforcement complexity, but adds agent prompt overhead

**Why deferred:** Cannot enforce rights on directives that don't exist. Implement governance directives first as a separate feature, then add enforcement as a follow-up.

**Effort:** Large | **Risk:** Low | **Value:** Low-Medium

---

## 4. Token-Passing / Talking Stick

**Status:** Deferred — high LLM reliability risk, consider as experimental

**Current state:** Sequential round-robin. `token_path` array tracks order but agents don't actively choose who speaks next.

**What's needed:**
- After each contribution, the agent suggests who speaks next
- `[NEXT: name]` directive parsed from agent response
- Orchestrator respects the choice (skip passed participants)
- Fallback to round-robin on parse failure or invalid choice

**Value:** Medium-High. Makes deliberation feel more organic — a senior can defer to a junior who hasn't spoken, an expert can call on a peer. Breaks rigid round-robin.

**Feasibility:**
- Implementation: Medium. Need `[NEXT: name]` directive, modify round loop to track "next speaker" state, handle skip-if-passed logic, fallback on failure
- Production risk: **High.** Agents may pick the same speaker repeatedly (deadlock), pick passed participants, pick themselves, or fail to follow the format. Needs timeout/fallback logic. Each agent prompt gets longer (must include list of available speakers). LLMs are unreliable at this kind of structured meta-coordination.

**Why deferred:** LLM reliability is the core risk. Round-robin works predictably. Token-passing adds complexity and failure modes. Consider as an experimental opt-in feature (e.g., `token_passing: true` in `/knit` args) once the core system is more mature.

**Effort:** Medium | **Risk:** High | **Value:** Medium-High

---

## Priority Order

| Priority | Feature | Effort | Risk | Value |
|----------|---------|--------|------|-------|
| 1 | Push-Back / Refusal | Small | Low | Medium |
| 2 | Per-Agent Model Assignment | Small-Medium | Low | Medium |
| 3 | Enforced Seniority Rights | Large | Low | Low-Medium |
| 4 | Token-Passing / Talking Stick | Medium | High | Medium-High |

---

## Deferred / Future

These items require foundational features to exist first or carry significant production risk:

- **Agent-initiated round extension** — agent requests "one more round" before convergence. Requires agent-to-orchestrator signaling beyond current contribution types.
- **Cross-round memory** — agents reference their own prior contributions explicitly. Currently agents see the warp but not structured "you said X in round 1" memory.
- **Inter-round reflection** — private reflection prompt between rounds. Requires orchestrator to prompt agents between rounds without it being a "contribution."
- **Governance directives ([VETO], [FORCE_END], [CALL_VOTE])** — prerequisite for enforced seniority rights.

## Recently Implemented

- **Sequential interjection** — post-contribution interjection with pushback (`round-executor.js`)
- **SQLite persistence** — meeting state survives restarts (`database.js`)
- **Dashboard visualization** — real-time HTML progress (`dashboard/`)
- **Modular architecture** — decomposed monoliths into focused modules (`handlers/`, `services/`)

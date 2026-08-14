---
description: Start a multi-agent deliberation session (a 'Loom')
---

Use the `knit` tool to start a Loom deliberation about: $ARGUMENTS

Run the `knit` tool **directly** — do NOT pass `dry_run` or preview the room first. Just invoke it with the question and let the deliberation run. Only use `dry_run` if the user explicitly asks to preview before deliberating.

## When to Use

Invoke `knit` when the user explicitly types `/knit` followed by a question or topic. This creates a structured multi-agent deliberation where AI agents with different expertise levels and perspectives collaborate to produce a synthesized answer.

**Use `/knit` for:**
- Complex decisions requiring multiple perspectives (architecture choices, strategy questions, tradeoff analysis)
- Situations where you want to see dissenting views preserved
- Questions where domain expertise matters (engineering, finance, business, creative)

**Do NOT use `/knit` for:**
- Simple factual questions
- Code generation or debugging tasks
- General conversation or brainstorming without a specific question

## Parameters

- `question` (required): The question or topic for agents to deliberate on
- `context` (optional): Additional background, constraints, or files to consider
- `participants` (optional): Custom participant list. If omitted, the Loom auto-composes a room based on the question's domain
- `max_rounds` (optional): Maximum deliberation rounds (1-10, default: 3)
- `convergence` (optional): How deliberation ends — `consensus`, `majority`, or `moderator_forces` (default)
- `models` (optional): Per-tier model overrides (use `/knit_models` to discover options)
- `dry_run` (optional): Preview the composed room without deliberating. Only use if the user explicitly asks — otherwise run directly.
- `fresh` (optional): Force a fresh loom even if a previous meeting exists
- `turn_mode` (optional): Turn mode — `sequential` (default), `staged` (2-at-a-time), or `parallel` (all concurrently)

## What Happens

1. The Loom discovers available models from your opencode providers
2. It analyzes the question to detect relevant domains (engineering, finance, etc.)
3. It composes a room of 2-7 agents with appropriate expertise
4. Agents take structured turns (or staged/parallel depending on `turn_mode`), interject with priority, and challenge each other
5. Between rounds, each agent receives a summary of the previous round's contributions (delta context)
6. A synthesizer produces a final artifact with decisions, action items, dissenting views, and confidence level

## Configuration

The Loom can be configured via your `opencode.json` file under a `"loom"` key:

```json
{
  "loom": {
    "agentTimeoutMs": 120000,
    "defaultMaxRounds": 3,
    "maxInterjectionsPerRound": 3,
    "convergence": {
      "repetitionOverlapThreshold": 0.45,
      "semanticConvergenceFromRound": 3
    }
  }
}
```

You can also create a `.loomrc.json` in your project directory for project-specific overrides.

## Examples

```
/knit "Should we migrate our authentication from sessions to JWT?"
/knit "What's our Q4 hiring plan?" --max_rounds 5
/knit "Design a caching strategy for our API" --convergence consensus
/knit "Architecture review" --turn_mode parallel
/knit "Fresh start on database design" --fresh
/knit_models  # Preview model assignments before running
loom_viz       # Start the dashboard
```

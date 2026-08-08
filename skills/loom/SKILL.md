---
name: loom
description: Start a multi-agent deliberation where AI agents with different expertise collaborate on a complex question or task
---

# Loom — Multi-Agent Deliberation

A Loom is a structured deliberation session where multiple AI agents sit in a "circle," pass a talking stick, interject with priority, push back on each other, and collaboratively weave a complex output.

## When to Use

Invoke a Loom when:

- The question has no obvious single answer and benefits from multiple perspectives
- You need a decision that accounts for risk, creativity, and feasibility simultaneously
- You want a structured artifact that carries the weight of genuine deliberation (not just one agent's opinion)
- The topic involves tradeoffs that different "stakeholder" perspectives would evaluate differently

## When NOT to Use

Don't use a Loom for:
- Simple factual questions (just ask directly)
- Tasks that require tool use or code execution (Loom agents are deliberation-only)
- Time-sensitive queries (deliberation takes multiple rounds of LLM calls)

## How to Use

### Preview the Room First
```
/knit "Should we migrate our authentication from sessions to JWT?"
```

The Loom shows you the proposed room — who's at the table, their seniority, and their agendas. You can approve it or request changes like "add a security expert" or "make the junior a mid."

### Custom Participants
```
Use the knit tool with:
- name: "Security Architect"
  persona: "You specialize in application security"
  agenda: "Prevent attack surface expansion"
  tier: senior
Question: "Design our auth strategy"
```

### Seniority System

Each tier determines the model, behavior, and deliberation rights:

| Tier | Model | Can Veto | Can End Early |
|------|-------|----------|---------------|
| Junior | Haiku | No | No |
| Mid | Sonnet | No | No |
| Senior | Opus | Yes | No |
| Principal | Opus | Yes | Yes |

### Deliberation Dynamics

- **Token passing**: agents take turns clockwise around the circle
- **Interjection**: any agent can request to speak out of turn with a priority (1-10)
- **Push-back**: the current speaker can contest an interjection if they deem their point more urgent
- **Moderator**: breaks deadlocks when two agents claim equal priority
- **Convergence**: ends when all pass, max rounds reached, or moderator forces synthesis

## Output

The Loom produces structured output with:
- **Decision** — the collective conclusion
- **Reasoning** — key points that led there
- **Action Items** — concrete next steps
- **Dissenting Views** — unresolved minority objections
- **Open Questions** — things that remain unresolved
- **Confidence** — high/medium/low based on degree of consensus

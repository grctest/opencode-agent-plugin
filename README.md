# The Loom

> A multi-agent deliberation protocol for opencode — a knitting machine for AI agents.

The Loom lets you convene a circle of AI agents with different expertise, seniority levels, and agendas. They pass a talking stick, interject with priority, push back on each other, and collaboratively weave complex artifacts through structured deliberation with governed convergence.

## How It's Different

Existing multi-agent frameworks (AutoGen, CrewAI, LangGraph) optimize for **task completion**. The Loom optimizes for **deliberated synthesis** — the output carries the weight of genuine multi-perspective analysis with preserved dissent, minority objections, and governed convergence.

| Feature | Other Frameworks | The Loom |
|---------|-----------------|----------|
| Token-passing / talking stick | ❌ | ✅ |
| Priority interjection | ❌ | ✅ |
| Push-back / refusal | ❌ | ✅ |
| Seniority-based rights | ❌ | ✅ |
| Moderator deadlock resolution | ❌ | ✅ |
| Minority report / preserved dissent | ❌ | ✅ |
| Auto-composed rooms from topic | ❌ | ✅ |
| Real-time progress streaming | ❌ | ✅ |
| Abort / cancellation | ❌ | ✅ |

## Architecture

The Loom runs entirely within a single opencode session. Each participant is modeled as a different system prompt + model override on the same conversation. The user watches the deliberation unfold in real-time in the main chat.

```
┌──────────────────────────────────────────┐
│              THE LOOM                     │
│                                           │
│   ┌──────────┐                            │
│   │Moderator │ ← resolves deadlocks       │
│   └────┬─────┘                            │
│        │                                  │
│   ┌────▼───────────────────────────┐      │
│   │         THE CIRCLE             │      │
│   │                                 │      │
│   │  Proposer ←───── Critic        │      │
│   │     ↓              ↑           │      │
│   │  Domain ──────→ Integrator     │      │
│   │                                 │      │
│   │  (token moves clockwise)        │      │
│   └─────────────────────────────────┘      │
│                                           │
│  Warp = shared context (everyone sees)    │
│  Weft = contributions (knitted in)       │
│  Garment = final artifact (the output)   │
└──────────────────────────────────────────┘
```

## Installation

1. Copy the plugin into your project:

```bash
mkdir -p .opencode/plugin/loom
cp dist/* .opencode/plugin/loom/
```

2. Add to your `opencode.json`:

```json
{
  "plugin": [".opencode/plugin/loom/index.ts"]
}
```

3. Install the skill and command (optional):

```bash
cp -r skills/loom .opencode/skills/
cp commands/knit.md .opencode/commands/
```

## Quick Start

### Preview then Run

```
/knit "Should we migrate our authentication from sessions to JWT?"
```

The Loom first shows you the proposed room of participants. You can approve it or request changes:

```
Add a security expert as principal, and make the mid a DevOps engineer
```

### Custom Participants

```
Use the knit tool with these participants:
- name: "Security Architect"
  persona: "You specialize in application security and threat modeling"
  agenda: "Ensure the solution has no attack surface expansion"
  tier: senior
- name: "Junior Developer"
  persona: "You are a fresh thinker unconstrained by legacy patterns"
  agenda: "Propose modern alternatives others might dismiss"
  tier: junior
Question: "Design our API authentication strategy"
```

## Seniority System

Each participant occupies a **tier** that governs three things: which model runs them, how they behave, and what deliberation rights they have.

| Tier | Model | Behavior | Rights |
|------|-------|----------|--------|
| **Junior** | Haiku 3.5 | Creative, "what if?" thinking | Contribute + interject |
| **Mid** | Sonnet 3.5 | Balanced reasoning, evidence-based | + call votes |
| **Senior** | Opus 3 | Risk-aware, precise, experience-citing | + veto conclusions |
| **Principal** | Opus 3 | Decisive, sees the whole board | + end deliberation |

This creates real organizational dynamics: juniors who think outside the box but can't block progress; seniors who kill bad ideas; principals who cut through deadlock.

## The Deliberation Protocol

1. **Token holder speaks** — reads shared context, contributes (or passes)
2. **Listeners may interject** — submit priority score (1-10)
3. **Push-back** — current speaker can contest the interjection
4. **Deadlock** — if both claim highest priority, the Moderator rules
5. **Convergence** — all agents pass, or max rounds reached, or moderator forces
6. **Output** — the artifact with decisions, action items, dissent, and confidence

## Output

The Loom produces:
1. A synthesized artifact with decisions and reasoning
2. Action items
3. Any unresolved objections (minority report)
4. Open questions that remain
5. A confidence level (high/medium/low)

## Building

```bash
npm run build    # Compile TypeScript
npm run typecheck # Type-check only
```

## Architecture

```
src/
├── index.ts          # Plugin entry point — registers tools
├── loom-engine.ts    # Core deliberation engine (single-session)
├── tiers.ts          # Seniority tier definitions + rights enforcement
├── composer.ts       # Auto-composition + room preview
└── types.ts          # Type definitions

agents/               # Agent persona markdown files
skills/loom/          # Skill definition for discoverability
commands/             # Slash commands
dist/                 # Compiled output
```

## License

MIT

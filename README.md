# The Loom

> A multi-agent deliberation protocol for opencode — a knitting machine for AI agents.

The Loom lets you convene a circle of AI agents with different expertise, seniority levels, and agendas. Each agent runs in its own child session with its own model. They pass a talking stick, interject with priority, push back on each other, and collaboratively weave complex artifacts through structured deliberation with governed convergence.

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
| Dynamic model discovery | ❌ | ✅ |
| Per-agent model assignment | ❌ | ✅ |
| Real-time progress streaming | ❌ | ✅ |
| Abort / cancellation | ❌ | ✅ |

## Architecture

The Loom creates a parent orchestrator session plus one child session per participant. Each child session has its own model (discovered from your opencode providers) and isolated context. The orchestrator mediates communication, resolves interjections, and synthesizes the final output.

### Command Flow

```
User types: /knit "question"
    ↓
commands/knit.md → routes to agent: loom
    ↓
Custom "loom" agent (inherits session's model)
    ↓
Agent calls `knit` tool
    ↓
Plugin code executes (orchestrator + child sessions)
```

### Session Architecture

```
┌──────────────────────────────────────────────┐
│             ORCHESTRATOR SESSION              │
│   (User's main session, inherits model)       │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │          SHARED STATE (files)         │    │
│  │  ├── warp.md (shared context)        │    │
│  │  ├── contributions.json              │    │
│  │  └── state.json                      │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│  │ Child #1 │ │ Child #2 │ │ Child #3 │    │
│  │ (junior) │ │ (mid)    │ │ (senior) │    │
│  │ own model│ │ own model│ │ own model│    │
│  └──────────┘ └──────────┘ └──────────┘    │
│                                              │
│  Each child: own model, own context,         │
│  can read shared files, contribute, interject│
└──────────────────────────────────────────────┘
```

## Installation

### Quick Install (WSL/Linux/macOS)

```bash
npm run install:plugin
```

This detects your opencode config directory, builds the plugin, and installs all files. It also configures the `loom` agent in your `opencode.json`.

### Update Existing Installation

```bash
npm run update:plugin
```

This clears out the old version (files, config entries) and performs a clean reinstall. Use this when updating to a new version.

### Manual Install

```bash
# Build the plugin
npm run build

# Install to opencode config
cp -r dist/* ~/.config/opencode/plugin/loom/
cp commands/*.md ~/.config/opencode/commands/
```

Then add to your `opencode.json`:

```json
{
  "plugin": [".opencode/plugin/loom/index.js"],
  "agent": {
    "loom": {
      "mode": "primary",
      "description": "Loom deliberation orchestrator. Only triggered by /knit command.",
      "prompt": "You are the Loom orchestrator. When invoked via /knit, call the `knit` tool with the user's exact question. When invoked via /knit_models, call the `knit_models` tool. Do not take any other actions."
    }
  }
}
```

## Quick Start

### Commands

| Command | Purpose |
|---------|---------|
| `/knit "question"` | Start a multi-agent deliberation (primary command) |
| `/knit_models` | Discover available models and propose tier assignments |

### Start a Deliberation

```
/knit "Should we migrate our authentication from sessions to JWT?"
```

The Loom discovers your available models, composes a room, and runs the deliberation. The `loom` agent inherits your session's model for orchestration.

### Configure Models (Optional)

```
/knit_models
```

Shows available models and proposes tier assignments. You can accept or request changes like "use Sonnet for senior" or "make junior use Haiku".

## Roles System

Each participant has a **role** (any string) that governs behavior and rights:

| Role | Behavior | Rights |
|------|----------|--------|
| junior | Creative, "what if?" thinking | Contribute + interject |
| mid | Balanced reasoning, evidence-based | + call votes |
| senior | Risk-aware, precise, experience-citing | + veto conclusions |
| principal | Decisive, sees the whole board | + end deliberation |
| *custom* | Adapted to role name | + call votes |

Models are auto-assigned from your available providers, prioritizing free tiers.

## The Deliberation Protocol

1. **Model discovery** — fetches your connected providers and available models
2. **Room composition** — analyzes stakes, generates appropriate roles
3. **Round execution** — each agent contributes in parallel via child sessions
4. **Interjection resolution** — priority-based interruptions with moderator tiebreaker
5. **Convergence** — consensus, majority, or moderator-forced
6. **Synthesis** — final artifact with decisions, action items, dissent, confidence

## Output

The Loom produces:
1. A synthesized artifact with decisions and reasoning
2. Action items
3. Any unresolved objections (minority report)
4. Open questions that remain
5. A confidence level (high/medium/low)

## Project Structure

```
src/
├── index.ts              # Plugin entry — registers knit, knit_models, loom_status tools
├── loom-engine.ts        # Thin wrapper around MeetingOrchestrator
├── orchestrator.ts       # Main deliberation loop (rounds, convergence, synthesis)
├── composer.ts           # Room composition + persona selection
├── model-discovery.ts    # Provider detection + model scoring/assignment
├── tiers.ts              # Role rights + behavioral prompts
├── prompts.ts            # All LLM prompt templates
├── validation.ts         # Zod-based response parsing
├── interjection-resolver.ts  # Interjection priority + resolution
├── warp-manager.ts       # Shared context evolution + LLM compaction
├── synthesizer.ts        # Final artifact generation
├── convergence-checker.ts # Convergence detection logic
├── concurrency.ts        # Semaphore-based parallelism limiting
├── shared-files.ts       # File-based shared state persistence
├── client-types.ts       # SDK client interface + type guard
├── artifact.ts           # Artifact types + confidence derivation
├── moderation.ts         # Moderator intervention + ruling parsing
├── interjections.ts      # Interjection detection pipeline
└── types.ts              # All shared type definitions

test/
├── engine.test.ts        # Orchestrator + LoomEngine unit tests
├── tiers.test.ts         # Tier config + rights tests
├── composer.test.ts      # Room composition tests
├── shared-files.test.ts  # File operations tests
├── validation.test.ts    # Response parsing tests
└── integration.test.ts   # End-to-end smoke test + manual checklist

commands/                 # Slash command definitions
```

## Building

```bash
npm run build           # Compile TypeScript
npm run typecheck       # Type-check only
npm run test            # Run all tests
npm run install:plugin  # Build + install to opencode config
npm run update:plugin   # Clear old version + fresh install
```

## License

MIT

# The Loom

> A multi-agent deliberation protocol for opencode — a knitting machine for AI agents.

The Loom lets you convene a circle of AI agents with different expertise, seniority levels, and agendas. Each agent runs in its own child session with its own model. They pass a talking stick, interject with priority, push back on each other, and collaboratively weave complex artifacts through structured deliberation with governed convergence.

## What The Loom Does

The Loom is a deliberation system where multiple AI agents with different expertise, seniority levels, and agendas collaborate on complex questions. It is designed for situations where you want genuine multi-perspective analysis — with preserved dissent, governed convergence, and a synthesized output that carries the weight of the deliberation.

- Token-passing / talking stick — structured turn-taking between agents
- Priority interjection — agents can interrupt when they have something urgent
- Push-back / refusal — agents can challenge or refuse to agree
- Seniority-based rights — junior to principal tiers with escalating privileges
- Moderator deadlock resolution — breaks ties when agents disagree
- Minority report / preserved dissent — disagreements are recorded, not buried
- Auto-composed rooms from topic — persona selection based on question domain
- Domain-aware persona selection — finance questions get finance experts, etc.
- Dynamic model discovery — finds available models from your opencode providers
- Per-agent model assignment — different agents can use different models
- Real-time HTML progress — watch each agent contribute as it happens
- SQLite persistence with session lifecycle — deliberation state survives restarts
- Collapsible content — expand full agent responses inline

## Architecture

The Loom creates a parent orchestrator session plus one child session per participant. Each child session has its own model (discovered from your opencode providers) and isolated context. The orchestrator mediates communication via a SQLite database, resolves interjections, and synthesizes the final output.

### Command Flow

```
User types: /knit "question"
    ↓
commands/knit.md → main session LLM calls `knit` tool
    ↓
Plugin creates MeetingOrchestrator + SQLite DB
    ↓
Per-round: prompt child → collect response → write to DB → post progress
    ↓
Synthesis child session reads DB → produces final artifact
```

### Session Architecture

```
┌──────────────────────────────────────────────┐
│           ORCHESTRATOR (main session)         │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │         SQLite DATABASE               │    │
│  │  ├── meetings (state, warp, round)   │    │
│  │  ├── participants (config, model)    │    │
│  │  ├── contributions (per-round)       │    │
│  │  ├── interjections (priority)        │    │
│  │  └── agent_responses (history)       │    │
│  └──────────────────────────────────────┘    │
│                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│  │ Child #1 │ │ Child #2 │ │ Child #3 │    │
│  │ (junior) │ │ (mid)    │ │ (senior) │    │
│  │ own model│ │ own model│ │ own model│    │
│  └──────────┘ └──────────┘ └──────────┘    │
│                                              │
│  Progress: HTML messages + metadata updates  │
└──────────────────────────────────────────────┘
```

## Installation

### Quick Install (WSL/Linux/macOS)

```bash
npm run install:plugin
```

This detects your opencode config directory, builds the plugin bundle, and installs all files (plugin, personas, commands).

### Update Existing Installation

```bash
npm run update:plugin
```

This clears out the old version (files, config entries) and performs a clean reinstall. Use this when updating to a new version.

### Manual Install

```bash
# Build the single-file bundle
npm run bundle

# Install to opencode config
cp dist/loom.js ~/.config/opencode/plugins/loom.js
cp -r personas/ ~/.config/opencode/personas/loom/
cp commands/*.md ~/.config/opencode/commands/
```

No `opencode.json` configuration needed — the plugin loads automatically from the `plugins/` directory.

## Quick Start

### Start a Deliberation

```
/knit "Should we migrate our authentication from sessions to JWT?"
```

The Loom auto-discovers your available models, composes a domain-aware room, assigns models to tiers, and runs the deliberation. Progress appears in real-time with HTML formatting and collapsible content.

### Discover Models (Optional)

```
/knit_models
```

Previews available models and proposes tier assignments without running a deliberation. Useful for inspecting what the Loom will use.

### What You See

```
🎬 Loom started — 4 participants:
  • Executive Advisor (principal, executive)
  • Portfolio Manager (senior, finance)
  • Financial Analyst (mid, finance)
  • Budget Hawk (junior, finance)

🤔 Financial Analyst (mid) is thinking...
✅ Financial Analyst (mid) — question:
  ▼ "What's the actual risk tolerance here?..."

🤔 Budget Hawk (junior) is thinking...
✅ Budget Hawk (junior) — challenge:
  ▼ "Have we considered the opportunity cost?..."

📋 Round 1 complete — 2 contributions, 0 interjections
▼ Summary: Round focused on risk assessment...

🔄 Synthesizing final output...
✅ Synthesis complete
```

## Persona System

The Loom includes 24+ personas across 6 domains, defined as JSON files in the `personas/` folder:

| File | Count | Domains |
|------|-------|---------|
| `personas/junior.json` | 8 | general, creative, finance, engineering |
| `personas/mid.json` | 8 | business, engineering, creative, operations |
| `personas/senior.json` | 6 | engineering, finance, business |
| `personas/principal.json` | 4 | engineering, executive, creative, business |

### Domain-Aware Selection

When you ask a question, the Loom analyzes it for domain keywords and selects personas accordingly:

| Question Type | Selected Domains |
|---------------|------------------|
| "Should I buy GameStop stock?" | finance, executive |
| "How do we design our API?" | engineering, creative |
| "What's our go-to-market strategy?" | business, marketing |
| "How do we improve team culture?" | executive, operations |

### Tier Rights

| Tier | Rights |
|------|--------|
| junior | Contribute, interject |
| mid | + call votes |
| senior | + veto conclusions |
| principal | + end deliberation |

### Customizing Personas

Edit the JSON files in `personas/` to add, remove, or modify personas:

```json
{
  "name": "Your Custom Persona",
  "persona": "You think about X. You have deep experience in Y. You always ask Z.",
  "agenda": "Ensure the discussion considers X. Challenge assumptions about Y.",
  "domain": "finance",
  "expertise": ["keyword1", "keyword2"]
}
```

After editing, run `npm run update:plugin` to deploy changes.

## Database Lifecycle

Each `/knit` invocation creates a SQLite database tagged with the opencode session ID:

```
{ProjectDirectory}/.opencode/loom/meetings/{uuid}.db
```

### Lifetime

| Event | Database |
|-------|----------|
| `/knit` invoked | Created with session ID tag |
| Rounds execute | Data accumulated |
| Deliberation completes | **Persists** (not deleted) |
| Session continues | Data available for reference |
| Project closed | **Persists** (session in history) |
| Session deleted from UI | **Deleted** (event hook) |
| Plugin startup | Orphaned DBs cleaned up |

### Schema

| Table | Contents |
|-------|----------|
| `meetings` | Question, context, warp, status, round, convergence mode |
| `participants` | Config, model assignment, child session ID |
| `contributions` | Per-round participant contributions |
| `interjections` | Priority interruptions and resolutions |
| `agent_responses` | Historical agent response text |
| `metadata` | Session ID for orphan detection |

### Multi-Invocation

Running `/knit` multiple times in the same session creates separate databases (one per invocation), all tagged with the same session ID. Deleting the session cleans up all associated databases.

## The Deliberation Protocol

1. **Model discovery** — fetches connected providers and available models
2. **Room composition** — analyzes question domain, selects appropriate personas
3. **Round execution** — sequential per-participant prompting with real-time progress
4. **Interjection resolution** — priority-based interruptions with moderator tiebreaker
5. **Convergence** — consensus, majority, or moderator-forced
6. **Synthesis** — dedicated child session reads full transcript from DB, produces final artifact

## Output

The Looom produces:
1. A synthesized artifact with decisions and reasoning
2. Action items
3. Any unresolved objections (minority report)
4. Open questions that remain
5. A confidence level (high/medium/low)

## Project Structure

```
src/
├── index.ts                  # Plugin entry — tools + event hooks
├── loom-engine.ts            # Thin wrapper around MeetingOrchestrator
├── orchestrator.ts           # Main deliberation loop (rounds, convergence, synthesis)
├── composer.ts               # Room composition + persona selection (loads JSON)
├── database.ts               # SQLite operations + cleanup utilities
├── model-discovery.ts        # Provider detection + model scoring/assignment
├── tiers.ts                  # Role rights + behavioral prompts
├── prompts.ts                # All LLM prompt templates
├── validation.ts             # Response parsing
├── interjection-resolver.ts  # Interjection priority + resolution
├── warp-manager.ts           # Shared context evolution + transcript formatting
├── synthesizer.ts            # Final artifact generation
├── convergence-checker.ts    # Convergence detection logic
├── moderation.ts             # Moderator intervention + ruling parsing
├── interjections.ts          # Interjection detection pipeline
├── client-types.ts           # SDK client interface + type guard
├── artifact.ts               # Artifact types + confidence derivation
└── types.ts                  # All shared type definitions

personas/                     # JSON persona definitions
├── junior.json               # 8 junior personas
├── mid.json                  # 8 mid personas
├── senior.json               # 6 senior personas
├── principal.json            # 4 principal personas
└── domains.json              # Domain keyword mappings

commands/                     # Slash command definitions
├── knit.md                   # Primary /knit command
└── knit_models.md            # Optional model discovery command

test/
├── engine.test.ts            # Orchestrator + LoomEngine unit tests
├── tiers.test.ts             # Tier config + rights tests
├── composer.test.ts          # Room composition tests
├── database.test.ts          # Database operations tests
├── validation.test.ts        # Response parsing tests
└── integration.test.ts       # End-to-end smoke test
```

## Building

```bash
npm run bundle            # Build single-file plugin bundle (esbuild)
npm run build             # Compile TypeScript (type checking)
npm run typecheck         # Type-check only
npm run test              # Run all tests
npm run install:plugin    # Bundle + install to opencode config
npm run update:plugin     # Clear old version + fresh install
```

## License

MIT

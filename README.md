# The Loom

> A multi-agent deliberation protocol for opencode — a knitting machine for AI agents.

The Loom lets you convene a circle of AI agents with different expertise, seniority levels, and agendas. Each agent runs in its own child session. They take structured turns, interject with priority, challenge each other, and collaboratively weave complex artifacts through deliberation with governed convergence.

## How It Works

You ask a question. The Loom detects the domain — engineering, finance, business, creative, executive, or operations — and composes a team of AI agents with relevant expertise. Each agent runs in its own isolated session with its own model.

Agents deliberate in structured rounds: proposing ideas, challenging weak arguments, refining positions, and pushing back on assumptions. They can interject with priority when they have something urgent to say. When agents stall or go in circles, a **moderator** — a separate LLM call using the strongest available model — steps in to break the deadlock, redirect the conversation, or force convergence. Once deliberation ends, a **synthesizer** produces the final artifact: decisions, action items, unresolved dissent, and a confidence level.

A real-time web dashboard shows every agent contributing as it happens. If you run `/knit` again in the same session, it extends the existing deliberation rather than starting fresh.

## Features

- **Structured turn-taking** with priority interjection
- **Tier-based roles** — junior to principal, each with escalating expectations and rights
- **Moderator agent** — spawned on demand to break deadlocks and force convergence
- **Semi-automatic convergence** — detects repetition, diminishing returns, and semantic agreement
- **Minority report** — unresolved dissenting views are preserved in the output
- **Meeting extension** — re-run `/knit` to continue a deliberation with new input
- **Auto-composed rooms** — persona selection based on your question's domain
- **Model discovery** — finds available models from your opencode providers, assigns per tier
- **Custom rooms** — bring your own participants, models, convergence mode, and round limits
- **Real-time dashboard** — four tabs: Overview, Orchestrator, Timeline, and Warp
- **Markdown export** — download the full transcript from the dashboard
- **Configurable** — tune timeouts, word limits, convergence, and more via config

## Installation

```bash
npm run install:plugin    # first install — detects your opencode config, builds and installs everything
npm run update:plugin     # update to latest version
```

No manual configuration needed. The plugin is auto-discovered from your `plugins/` directory.

## Quick Start

```
/knit "Should we migrate our authentication from sessions to JWT?"
```

Preview available models before running:

```
/knit_models
```

Preview the composed room without deliberating:

```
/knit "Your question" --dry_run
```

Launch the dashboard:

```
loom_viz
```

## Commands

| Command | Description |
|---------|-------------|
| `/knit` | Start (or extend) a multi-agent deliberation |
| `/knit_models` | Discover available models and propose tier assignments |
| `/loom_viz` | Start the real-time dashboard (default port 3210) |
| `/loom_stop` | Stop the running dashboard |

### `knit` arguments

| Argument | Description | Default |
|----------|-------------|---------|
| `question` | The question or task to deliberate on | _(required)_ |
| `context` | Additional context, background files, or constraints | — |
| `participants` | Custom participant list (name, persona, agenda, tier) | auto-composed from domain |
| `max_rounds` | Maximum deliberation rounds (1–10) | `3` |
| `convergence` | `consensus`, `majority`, or `moderator_forces` | `moderator_forces` |
| `models` | Per-tier model assignments (use `/knit_models` to discover) | auto-assigned |
| `allow_interjections` | Allow agents to interject during others' turns | `true` |
| `meeting_timeout` | Maximum meeting duration in ms (60000–1800000) | `900000` (15 min) |
| `seed` | Random seed for room composition | current time |
| `dry_run` | Preview the composed room without deliberating | `false` |

## Personas

The Loom ships with 35 personas across 6 domains, organized into four tiers:

| Tier | Count | Domains |
|------|-------|---------|
| junior | 11 | general, creative, engineering, finance, operations, executive, business |
| mid | 10 | engineering, business, finance, creative, operations |
| senior | 8 | engineering, finance, business, creative, operations |
| principal | 6 | engineering, executive, creative, business, finance, operations |

When you ask a question, the Loom analyzes it for domain keywords and selects personas accordingly. For example, a finance question gets finance experts; an engineering question gets engineers.

| Question Type | Domains Selected |
|---------------|------------------|
| "Should I buy GameStop stock?" | finance, executive |
| "How do we design our API?" | engineering, creative |
| "What's our go-to-market strategy?" | business, operations |

Each tier has different behavioral guidance — juniors ask questions and propose ideas, seniors demand evidence and can veto conclusions, and principals can end deliberation when consensus is reached. Personas can be customized by editing the JSON files in the `personas/` directory.

## Dashboard

Run `/loom_viz` to start the real-time web dashboard. It auto-detects the most recent meeting and streams updates as they happen.

- **Overview** — stats, participation matrix, contribution types, and timeline chart
- **Orchestrator** — internal feed showing domain detection, moderation, convergence checks, and round summaries
- **Timeline** — per-round contributions and interjections; click any contribution card to view the full output in a dialog
- **Warp** — the evolving shared context and each agent's perspective (persona, agenda, model)

The dashboard supports light, dark, and system themes. Export the current meeting as Markdown from the header.

## Configuration

The Loom can be configured via a `"loom"` key in your `opencode.json` or via a project-level `.loomrc.json`. Invalid values fall back to defaults with a startup warning.

```json
{
  "loom": {
    "maxContributionWords": 250,
    "maxInterjectionWords": 200,
    "defaultMaxRounds": 3,
    "maxInterjectionsPerRound": 3,
    "convergence": {
      "repetitionOverlapThreshold": 0.45,
      "semanticConvergenceFromRound": 3
    }
  }
}
```

Other available options include agent and synthesis timeouts, word limits, interjection thresholds, moderator triggers, retry policy, max concurrency, and meeting timeout.

## License

MIT

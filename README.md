# The Loom

> A multi-agent deliberation protocol for opencode — a knitting machine for AI agents.

The Loom lets you convene a circle of AI agents with different expertise, seniority levels, and agendas. Each agent runs in its own child session. They take structured turns, request turns with priority, challenge each other, and collaboratively weave complex artifacts through deliberation.

## How It Works

You ask a question. The Loom uses embedding-based similarity search (no LLM domain detection) to compose a team of AI agents with relevant expertise — each persona's description is embedded and matched against your question via `PersonaIndex` cosine similarity. Each agent runs in its own isolated session with its own model.

Agents deliberate in structured rounds: proposing ideas, challenging weak arguments, refining positions, and pushing back on assumptions. They can request turns with priority when they have something urgent to say. When agents stall or go in circles, a **moderator** — a separate LLM call using the strongest available model — steps in to break the deadlock, redirect the conversation, or wrap the deliberation up. Deliberation ends when participants all pass, the round limit is reached, or a hard timeout fires. Once it ends, a **synthesizer** produces the final artifact: decisions, action items, unresolved dissent, and a confidence level.

A real-time web dashboard shows every agent contributing as it happens. If you run `/knit` again in the same session, it extends the existing deliberation rather than starting fresh.

## Features

- **Structured turn-taking** with priority turn requests
- **Tier-based roles** — junior to principal, each with escalating expectations
- **Moderator agent** — spawned on demand to break deadlocks and drive the deliberation to a close
- **Deterministic termination** — participants all pass, round limit reached, or hard timeout
- **Minority report** — unresolved dissenting views are preserved in the output
- **Meeting extension** — re-run `/knit` to continue a deliberation with new input
- **Auto-composed rooms** — persona selection based on your question's domain
- **Model discovery** — finds available models from your opencode providers, assigns per tier
- **Custom rooms** — bring your own participants, models, and round limits
- **Real-time dashboard** — tabs for Overview, Timeline, and Output
- **Markdown export** — download the full transcript from the dashboard
- **Configurable** — tune timeouts, retry behavior, and tool access via config

## Installation

```bash
npm run install:plugin    # first install — detects your opencode config, builds and installs everything
npm run update:plugin     # update to latest version
```

No manual configuration needed. The plugin is auto-discovered from your `plugins/` directory.

The installer automatically downloads the default embedding model (`snowflake-arctic-embed-xs` INT8, ~23MB). If the download fails, you can manually download it later with `npm run model:download`.

## Embedding Models

The Loom uses vector embeddings for RAG-based context retrieval during deliberations. Embedding models are downloaded separately from the plugin and stored in `~/.config/opencode/loom/models/`.

### Downloading Models

```bash
# Download the default model (INT8 quantization, ~23MB)
npm run model:download

# Download a specific model and quantization
npm run model:download -- --model=Snowflake/snowflake-arctic-embed-xs --quant=onnx/model_int8.onnx
```

### Available Models

| Model | Dims | Max Tokens | Quant | Size | Description |
|-------|------|------------|-------|------|-------------|
| `Snowflake/snowflake-arctic-embed-xs` | 384 | 512 | INT8 | ~23 MB | **Default** — tiny but powerful, based on all-MiniLM-L6-v2 |
| `mixedbread-ai/mxbai-embed-xsmall-v1` | 384 | 4096 | INT8 | ~24 MB | Longer context window (4096 tokens) |
| `MongoDB/mdbr-leaf-mt` | 384 | 512 | quantized | ~23 MB | Optimized for retrieval tasks |

### Finding More Models

Browse the MTEB leaderboard to find embedding models suited to your needs:

- [Multilingual models](https://mteb-leaderboard.hf.space/benchmark/MTEB(Multilingual%2C%20v2)?mmods=text&minSize=1&maxSize=1000&openreq=license) — models supporting multiple languages
- [English-only models](https://mteb-leaderboard.hf.space/benchmark/MTEB(eng%2C%20v2)?mmods=text&minSize=1&maxSize=1000&openreq=license) — models optimized for English

Look for models with ONNX exports in their Hugging Face repository. Most sentence-transformers models provide INT8 quantizations suitable for CPU inference.

Bear in mind that some encoding models may require changes to the plugin to work optimally.

### Model Storage

Models are stored globally at:
```
~/.config/opencode/loom/models/Snowflake/snowflake-arctic-embed-xs/
├── model_int8.onnx      # ONNX model weights
├── tokenizer.json       # Tokenizer configuration
└── model.json           # Auto-generated metadata (dims, maxTokens, etc.)
```

### How Embedding Models Are Used

1. **RAG Context Retrieval** — Round summaries and contributions are chunked, embedded, and indexed. When prompting agents, the system retrieves relevant prior context using cosine similarity.

2. **Semantic Drift Detection** — Embeddings are available for computing semantic drift between rounds, but drift is not currently computed or visualized (removed; see `docs/dead-code-review.md`).

The embedding model is initialized at plugin startup (`ensureEmbedderInitialized` in `src/index.js:48`), so `/knit` meetings use real embeddings. If the model is unavailable (e.g., ONNX load fails or model not downloaded), semantic features (vector search, reflection targeting, room composition) degrade visibly via a keyword-based fallback and warnings rather than silent placeholder noise — the meeting otherwise proceeds.

### Where Meetings Live

Meetings are stored per-project (or globally when no workspace):

```
# With workspace directory:
<project>/.opencode/loom/meetings/<uuid>.db      # SQLite + WAL/SHM
<project>/.opencode/loom/meetings/<uuid>.md      # Full markdown report (chat output)

# Without workspace:
~/.config/opencode/loom/meetings/<uuid>.db
~/.config/opencode/loom/meetings/<uuid>.md

# Top-level index (legacy):
~/.config/opencode/loom/loom/session-index.json  # May be empty — per-meeting DBs are authoritative
```

Retention is manual — `session.deleted` event cleans up (`src/index.js:580`), or delete `meetings/<uuid>.db*` yourself. `fresh:true` on `/knit` unlinks `""`, `"-wal"`, `"-shm"` for the current session's loom before starting fresh.

## Quick Start

```
/knit "Should we migrate our authentication from sessions to JWT?"
```

`/knit` runs the deliberation directly. The chat shows a concise summary (rounds, participants, decision); the full report is saved to `.opencode/loom/meetings/<id>.md` and is always available in the dashboard's Output tab.

Preview available models before running:

```
/list_knit_models
```

`/list_knit_models` lists all discovered models with their exact `provider/model` identifiers, cost, context window, reasoning capability, and current enabled/disabled status. You can restrict which models Loom agents use:

```
/enable_knit_models openai/gpt-4.1 anthropic/claude-3-5-sonnet
/disable_knit_models openai/o1
/reset_knit_models
```

Launch the dashboard:

```
loom_viz
```

## Commands

| Command | Description |
|---------|-------------|
| `/knit` | Start (or extend) a multi-agent deliberation |
| `/list_knit_models` | List available models with enabled/disabled status and tier assignments |
| `/enable_knit_models` | Enable specific models for Loom agents |
| `/disable_knit_models` | Disable specific models for Loom agents |
| `/reset_knit_models` | Reset model filter to default (all models enabled) |
| `/loom_viz` | Start the real-time dashboard (default port 3210) |
| `/loom_stop` | Stop the running dashboard |

### `knit` arguments

| Argument | Description | Default |
|----------|-------------|---------|
| `question` | The question or task to deliberate on | _(required)_ |
| `context` | Additional context, background files, or constraints | — |
| `participants` | Custom participant list (name, persona, agenda, tier) | auto-composed from domain |
| `max_rounds` | Maximum deliberation rounds (1–10) | `3` |
| `meeting_timeout` | Maximum meeting duration in ms (60000–1800000) | `900000` (15 min) |
| `fresh` | Force a fresh loom even if a previous meeting exists | `false` |

### `list_knit_models` arguments

_No arguments_ — lists all discovered models with `provider/model` identifiers, cost, context window, reasoning capability, current enabled/disabled status, and the proposed tier assignment plan.

### `enable_knit_models` arguments

| Argument | Description | Default |
|----------|-------------|---------|
| `models` | Exact `provider/model` identifiers to enable | _(required)_ |

### `disable_knit_models` arguments

| Argument | Description | Default |
|----------|-------------|---------|
| `models` | Exact `provider/model` identifiers to disable | _(required)_ |

### `reset_knit_models` arguments

_No arguments_ — clears the filter back to all models.

### `loom_viz` arguments

| Argument | Description | Default |
|----------|-------------|---------|
| `port` | Port number for the dashboard server | `3210` |

## Personas

The Loom ships with 91 personas organized into five tiers (including `civilian` generalists), plus a `domains.json` vocabulary:

| Tier | Count | Domains (sample tags) |
|------|-------|------------------------|
| junior | 14 | general, creative, engineering, finance, operations, executive, business |
| mid | 15 | engineering, business, finance, creative, operations |
| senior | 11 | engineering, finance, business, creative, operations |
| principal | 9 | engineering, executive, creative, business, finance, operations |
| civilian | 42 | generalist — broad cross-domain personas loaded via `getPersonas()` |
| **Total** | **91** | `domains.json` defines the tag vocabulary (6 domain families) |

When you ask a question, the Loom uses **embedding similarity** (not LLM domain detection) to select personas — the question is embedded and the most similar personas per tier are chosen via `PersonaIndex.search` (cosine similarity against `persona_embeddings`). For example, a finance question gets finance experts; an engineering question gets engineers.

| Question Type | Tags Matched |
|---------------|------------------|
| "Should I buy GameStop stock?" | finance, executive |
| "How do we design our API?" | engineering, creative |
| "What's our go-to-market strategy?" | business, operations |

Each tier has different behavioral guidance defined in each persona's `tier_guidance` field. Personas also include a `reflection_guidance` field that specifies how they should approach reflections. Personas can be customized by editing the JSON files in the `personas/` directory. `civilian` tier maps to `mid` temperature (`0.5`) pending explicit `TIER_CONFIG` entry in `src/shared.js`.

## Dashboard

Run `/loom_viz` to start the real-time web dashboard. It auto-detects the most recent meeting and streams updates as they happen.

- **Overview** — stats, participation matrix, contribution types, and timeline chart
- **Timeline** — per-round contributions, turn requests, and orchestrator decisions (moderation, turn ordering, summaries) interleaved; click any item to view full details in a dialog
- **Output** — the final synthesis artifact: decisions, action items, open questions, dissent, confidence, and full text

The dashboard supports light, dark, and system themes. Export the current meeting as Markdown from the header.

## Configuration

The Loom can be configured via a `"loom"` key in your `opencode.json` or via a project-level `.loomrc.json` (top-level keys, no wrapper). Invalid values fall back to defaults with a startup warning.

```json
{
  "loom": {
    "defaultMaxRounds": 3
  }
}
```

Project-level equivalent in `.loomrc.json` (same keys, no `"loom"` wrapper):

```json
{
  "defaultMaxRounds": 4,
  "agentTimeoutMs": 180000
}
```

Other available options include agent and synthesis timeouts, turn request thresholds, moderator triggers, retry policy, max tool calls, meeting timeout, and stall detection (`stallTimeoutMs`, default 5 min).

## Known Limitations

- Desktop-only webapp — not optimized for mobile viewports (responsive floor at 768px single-column, not full mobile)
- No authentication or authorization on the dashboard API
- SQLite-based persistence — not suitable for horizontal scaling
- Per-meeting metrics are persisted to DB; process-wide counters in `metrics.js` are lost on restart and are mostly unpopulated (see `docs/metrics-and-observability.md`)
- SSE reconnection uses exponential backoff but falls back to polling after 10 attempts
- State of play is rule-based derived from full weave (no LLM fabric compaction); round summaries use LLM only when conflict exists (`moderator_forces` mode)
- Dashboard defaults to the most recent meeting (`created_at DESC`); URL deep link `?meeting=<uuid>` / `#<uuid>` preserves selection via history
- No PDF export capability — Markdown (and JSON) only, now fully paginated (no 500-cap)
- If the embedding model is unavailable at startup, room composition / vector search degrade to keyword fallback with visible warnings (not silent noise)

**Schema version:** `meetings.status ∈ {initializing,weaving,converged,exhausted,timeout,cancelled,aborted,deadlocked}` — file pattern `.opencode/loom/meetings/<uuid>.db` — last verified `0.1.0`.

## License

MIT

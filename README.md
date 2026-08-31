# The Loom

> A multi-agent deliberation protocol for opencode — a knitting machine for AI agents.

The Loom lets you convene a circle of AI agents with different expertise, seniority levels, and agendas. Each agent runs in its own child session. They take structured turns, request turns with priority, challenge each other, and collaboratively weave complex artifacts through deliberation.

## How It Works

You ask a question. The Loom uses embedding-based similarity search (no LLM domain detection) to compose a team of AI agents with relevant expertise — every persona's description is embedded, your question is embedded, and the closest match per role tier wins via `PersonaIndex` cosine similarity. Each agent runs in its own ephemeral session with its own model.

Agents deliberate in structured rounds. During a turn an agent isn't limited to writing prose — it interacts with peers directly through real tool calls: `loom_query` queries specific peers (with seven answer modes: factual clarify, stance-taking perspective, forced-research evidence, adversarial critique, risk analysis, assumption surfacing, alternatives), `loom_vote` polls everyone on lettered options, `loom_summon` brings in a guest expert persona, and `loom_request_next` claims speaking priority for the next round. Peer answers, ballots, and tallies are returned **inline within the same turn**, so the speaker synthesizes them into their contribution immediately instead of waiting for future rounds.

Termination is deterministic: everyone passes or fails, the round limit is reached, or a hard timeout or token budget fires. Agents pass by calling the `loom_pass` tool — the meeting ends when all active participants have passed. Once the meeting ends, a neutral **synthesizer** produces the final artifact: decisions, action items, unresolved dissent, and a confidence level, then self-critiques its draft against the transcript.

A real-time web dashboard shows every agent contributing as it happens. If you run `/knit` again in the same session, it extends the existing deliberation rather than starting fresh.

## Features

- **Auto-composed expert rooms** — personas embedded and matched to your question via local embedding similarity; custom rooms also supported
- **Structured rounds** — sequential turn-taking with tier-based expectations and priority turn requests
- **Inline peer interactions** — query peers in seven modes, call votes, summon guest experts; results return within the same turn
- **Tool-using agents** — web search/fetch, project file inspection, semantic recall over prior deliberation context, and structured pass via `loom_pass`
- **Deterministic termination** — pass/fail exhaustion, round limit, hard timeout, or token budget
- **Minority-report synthesis** — neutral synthesizer emits decisions, reasoning, action items, dissent, and confidence, then self-critiques its draft
- **Model discovery** — finds available models from your opencode providers, assigns them per tier, restrictable per session
- **Real-time dashboard** — live timeline with a full prompt/tool audit trail; Markdown export
- **Meeting extension** — re-run `/knit` to continue a deliberation with new input

## Installation

```bash
npm install             # 1. install dependencies
npm run bundle          # 2. build the plugin bundle (dist/loom.js)
npm run install:plugin  # 3. detect your opencode config and install everything
```

To update an existing install:

```bash
npm run update:plugin
```

No manual configuration needed. The plugin is auto-discovered from your `plugins/` directory.

The installer automatically downloads the default embedding model (`snowflake-arctic-embed-xs` INT8, ~23MB). If the download fails, you can manually download it later with `npm run model:download`.

## Embedding Models

The Loom uses vector embeddings for two things: composing the room at meeting start, and RAG-based context retrieval during deliberations. Embedding models are downloaded separately from the plugin and stored in `~/.config/opencode/loom/models/`.

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

1. **Room composition** — At meeting creation, every persona's text (`persona`, `agenda`, `tags`, `expertise`) is embedded into the meeting database. Your `/knit` question is embedded too, and compared against each persona by cosine similarity: for each role slot, the most similar not-yet-used persona in that tier is picked (`PersonaIndex.search`). A finance question gets finance experts; an engineering question gets engineers.

2. **RAG context retrieval** — Round summaries and contributions are chunked, embedded, and indexed. When prompting agents, the system retrieves relevant prior context using cosine similarity, and agents can query the same index directly via `loom_vector_search`.

The embedding model is initialized at plugin startup (`ensureEmbedderInitialized` in `src/index.js:65`, async with 5s race) and separately in the dashboard (`initEmbeddingModel` in `src/dashboard/server/helpers.js:17` with build default). Both use real embeddings; if unavailable, semantic features degrade via keyword fallback with warnings.

### Where Meetings Live

Meetings are stored per-project (or globally when no workspace):

```
# With workspace directory:
<project>/.opencode/loom/meetings/<uuid>.db      # SQLite + WAL/SHM
<project>/.opencode/loom/meetings/<uuid>.md      # Full markdown report (chat output)

# Without workspace:
~/.config/opencode/loom/meetings/<uuid>.db
~/.config/opencode/loom/meetings/<uuid>.md
```

Retention is manual — deleting a session cleans up its meetings (`session.deleted` event), or delete `meetings/<uuid>.db*` yourself. `fresh:true` on `/knit` removes the current session's meeting files before starting fresh.

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
| `participants` | Custom participant list (name, persona, agenda, tier) | auto-composed via embedding similarity |
| `max_rounds` | Maximum deliberation rounds (1–10) | `3` |
| `models` | Explicit per-tier model assignments (`[{tier, provider_id, model_id}]`) | auto-assigned by capability score |
| `dry_run` | Preview the composed room without deliberating | `false` |
| `meeting_timeout` | Maximum meeting duration in ms (`0` = no limit, max 3600000) | `0` (no limit — runs until `max_rounds`/stall/token budget) |
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

The Loom ships with 89 personas organized into five tiers (including `civilian` generalists):

<!-- CENSUS-BEGIN -->
| Tier | Personas |
|------|----------|
| junior | 15 |
| mid | 14 |
| senior | 11 |
| principal | 9 |
| civilian | 40 |
| **Total** | **89** |
<!-- CENSUS-END -->

When you ask a question, the Loom uses **embedding similarity** (not LLM domain detection) to select personas — the question is embedded and the most similar personas per tier are chosen via `PersonaIndex.search` (cosine similarity against `persona_embeddings`). For example, a finance question gets finance experts; an engineering question gets engineers.

| Question Type | Tags Matched |
|---------------|------------------|
| "Should I buy GameStop stock?" | finance, executive |
| "How do we design our API?" | engineering, creative |
| "What's our go-to-market strategy?" | business, operations |

Each tier has different behavioral guidance defined in each persona's `tier_guidance` field, blended with a per-tier doctrine line in the agent system prompt. Personas also include a `reflection_guidance` field used when peers solicit their stance via `loom_query mode=perspective`. Personas can be customized by editing the JSON files in the `personas/` directory. The `civilian` tier maps to `mid` seniority/temperature via `utils/tier.js`.

## Dashboard

Run `/loom_viz` to start the real-time web dashboard. It auto-detects the most recent meeting and streams updates as they happen.

- **Overview** — stats, participation matrix, contribution types, and timeline chart
- **Timeline** — per-round contributions, turn requests, and orchestrator decisions (moderation, turn ordering, summaries) interleaved; click any item to view full details in a dialog
- **Output** — the final synthesis artifact: decisions, action items, open questions, dissent, confidence, and full text

The dashboard supports light, dark, and system themes. Export the current meeting as Markdown from the header.

## Configuration

The Loom resolves configuration from multiple layers, **deep-merged with more-specific wins** (project settings override home settings; invalid values fall back to defaults with a startup warning). Candidates, in order of increasing precedence:

1. `~/.config/opencode/opencode.json` — `"loom"` key (legacy)
2. `~/.config/opencode/.loomrc.json` — top-level keys
3. `~/.config/opencode/opencode.jsonc` — `"loom"` key (JSONC with `//`/`/* */` supported)
4. `~/.config/opencode/.loomrc.jsonc` — top-level keys
5. `<project>/opencode.json` — `"loom"` key
6. `<project>/opencode.jsonc` — `"loom"` key
7. `<project>.loomrc.json` — top-level keys
8. `<project>.loomrc.jsonc` — top-level keys (project wins; only top-level scalars honor `LOOM_*` env)

A project-level `opencode.json` **is** consulted — partial overrides of your home config from a project work as expected.

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

Environment overrides: `LOOM_<KEY>` applies on top of files for scalar schema keys (e.g. `LOOM_AGENT_TIMEOUT_MS=180000`, `LOOM_MODEL_DIVERSITY=false`). Log verbosity is controlled by `LOOM_LOG_LEVEL` (`DEBUG`|`INFO`|`WARN`|`ERROR`|`FATAL`, default `INFO`). The dashboard binds `127.0.0.1` by default for safety; set `dashboard.host` in config to expose it to your LAN deliberately.

Other available options include agent and synthesis timeouts, retry policy, max tool calls, meeting timeout, stall detection (`stallTimeoutMs`, default 10 min (600000 ms)), composition relevance floor (`composition.maxCosineDistance`, default 0.85), token budget (`maxTotalTokens`, `0` = unlimited — a runaway meeting ends early and still synthesizes), same-turn synthesis for inline loom tool results (`agentTools.sameTurnSynthesis`), and embedding model selection (`embeddingModel`/`embeddingQuant`).

## License

MIT

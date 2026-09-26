# The Loom

> A multi-agent deliberation protocol for opencode — a knitting machine for AI agents.

The Loom lets you convene a circle of AI agents with different expertise, seniority levels, and agendas. Each agent runs in its own child session. They take structured turns, request turns with priority, challenge each other, and collaboratively weave complex artifacts through deliberation.

## How It Works

You ask a question. The Loom uses embedding-based similarity search (no LLM domain detection) to compose a team of AI agents with relevant expertise — every persona's description is embedded, your question is embedded, and the closest match per role tier wins via `PersonaIndex` cosine similarity. Each agent runs in its own ephemeral session with its own model.

Agents deliberate in structured rounds. During a turn an agent isn't limited to writing prose — it interacts with peers directly through real tool calls: `loom_query` queries specific peers (with seven answer modes: factual clarify, stance-taking perspective, forced-research evidence, adversarial critique, risk analysis, assumption surfacing, alternatives), `loom_vote` polls everyone on lettered options, `loom_summon` brings in a guest expert persona, and `loom_request_next` claims speaking priority for the next round. Peer answers, ballots, and tallies are returned **inline within the same turn**, so the speaker synthesizes them into their contribution immediately instead of waiting for future rounds.

Termination is deterministic: after the configured minimum rounds, everyone passes or fails, the round limit is reached, or a hard timeout or token budget fires. Agents pass by calling the `loom_pass` tool — the meeting ends when all active participants have passed. Once the meeting ends, a neutral **synthesizer** produces the final artifact: decisions, action items, unresolved dissent, and a confidence level, then self-critiques its draft against the transcript.

A real-time web dashboard is the sole control plane: you preview the suggested room, approve personas (or pick manually) and per-tier models, then start the deliberation. Every agent contribution streams in as it happens, and the final synthesis lives in the dashboard's Output tab — nothing is returned to chat. The Setup tab can extend an existing deliberation with new input rather than starting fresh.

## Features

- **Auto-composed expert rooms** — personas embedded and matched to your question via local embedding similarity; custom rooms also supported
- **Structured rounds** — sequential turn-taking with tier-based expectations and priority turn requests
- **Inline peer interactions** — query peers in seven modes, call votes, summon guest experts; results return within the same turn
- **Tool-using agents** — web search/fetch, project file inspection, forum sub-discussions, and structured pass via `loom_pass`
- **Per-agent carried state** — every turn projects stance + key bullets via `loom_state_patch`, so prompts stay flat and stance flips land in one turn
- **Deterministic termination** — pass/fail exhaustion, round limit, hard timeout, or token budget
- **Minority-report synthesis** — neutral synthesizer emits decisions, reasoning, action items, dissent, and confidence, then self-critiques its draft
- **Model discovery** — finds available models from your opencode providers, assigns them per tier, and lets you override the model per seat in the dashboard Setup tab
- **Real-time dashboard** — live timeline with a full prompt/tool audit trail; Markdown and JSON export
- **Meeting extension** — extend a deliberation with new input from the dashboard Setup tab

## Installation

The opencode runtime must provide Bun (the plugin uses `bun:sqlite` and `Bun.serve`); Node.js is used for development checks and the installer.

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

## Development checks

```bash
npm test             # pure unit/invariant tests
npm run check        # JS/JSX/TS syntax checks
npm run bundle       # build the plugin and dashboard
npm pack --dry-run   # verify the publishable artifact
```

The installer automatically downloads the default embedding model (`snowflake-arctic-embed-xs` INT8, ~23MB). If the download fails, you can manually download it later with `npm run model:download`.

## Embedding Models

The Loom uses vector embeddings for composing the room at meeting start (persona matching). Embedding models are downloaded separately from the plugin and stored in `~/.config/opencode/loom/models/`.

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

Models are stored under `OPENCODE_CONFIG_DIR` when set, otherwise globally at:
```
~/.config/opencode/loom/models/Snowflake/snowflake-arctic-embed-xs/
├── model_int8.onnx      # ONNX model weights
├── tokenizer.json       # Tokenizer configuration
└── model.json           # Auto-generated metadata (dims, maxTokens, etc.)
```

### How Embedding Models Are Used

**Room composition** — At meeting creation, every persona's text (`persona`, `agenda`, `tags`, `expertise`) is embedded into the meeting database. Your question is embedded too, and compared against each persona by cosine similarity: for each role slot, the most similar not-yet-used persona in that tier is picked (`PersonaIndex.search`). A finance question gets finance experts; an engineering question gets engineers. The dashboard Setup tab shows the suggestion for approval before anything runs.

The embedding model is initialized at plugin startup (`ensureEmbedderInitialized` in `src/index.js:65`, async with 5s race) and separately in the dashboard (`initEmbeddingModel` in `src/dashboard/server/helpers.js:17` with build default). Both use real embeddings; if unavailable, room composition degrades via keyword fallback with warnings.

### Where Meetings Live

Meetings are stored per-project (or globally when no workspace):

```
# With workspace directory:
<project>/.opencode/loom/meetings/<uuid>.db      # SQLite + WAL/SHM
<project>/.opencode/loom/meetings/<uuid>.md      # Full markdown report (chat output)

# Without workspace (or with OPENCODE_CONFIG_DIR):
<opencode-config-dir>/loom/meetings/<uuid>.db
<opencode-config-dir>/loom/meetings/<uuid>.md
```

Retention is manual — deleting a session removes its meeting database, WAL/SHM files, and Markdown report (`session.deleted` event), or you can delete the files yourself. Questions, prompts, tool inputs/outputs, and reports may contain sensitive project data; review provider, web-tool, and LAN settings before use.

## Quick Start

```
loom_viz
```

Open the printed URL in your browser. In the **Setup** tab:

1. Enter your question (plus optional context and max rounds).
2. In **Models**, enable the models Loom agents may use (at least one).
3. In **Personas**, **Auto-select** a suggested room or add seats manually from the catalog — each seat shows its assigned model, changeable per seat.
4. Hit **Approve & start deliberation** and follow along in the Timeline tab. The final synthesis lands in the Output tab and is saved to `.opencode/loom/meetings/<id>.md`.

Nothing is returned to chat — the dashboard is the control plane.

> **Deploy note for contributors:** the dashboard serves from `dist/`, and
> install copies (not symlinks) `dist/` into your opencode config dir. After
> changing source, run `npm run bundle` **and** `npm run install:plugin` (or
> `update:plugin`) — `/loom_stop` + `/loom_viz` alone will keep serving the
> previously installed copy.

## Commands

| Command | Description |
|---------|-------------|
| `/loom_viz` | Start the dashboard: the sole control plane for deliberations (default port 3210) |
| `/loom_stop` | Stop the running dashboard |

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

Each tier has different behavioral guidance defined in each persona's `tier_guidance` field, blended with a per-tier doctrine line in the agent system prompt. Personas also include a `reflection_guidance` field used when peers solicit their stance via `loom_query mode=perspective`. Personas can be customized by editing the JSON files in the `personas/` directory. The `civilian` tier maps to `mid` seniority via `utils/tier.js`.

### Writing a persona: the lens is not a body

Agents are **text agents**. Their entire instrument set is `read`, `glob`, `grep`,
`websearch`, `webfetch`, optionally `bash` (allowlisted, off by default), and the
`loom_*` peer tools. A persona therefore shapes *how an agent reasons and what it
demands as evidence* — never what it physically does. A persona may have a body in
its backstory ("you have watched", "in my experience"), but every **instruction**
field (`agenda`, `tier_guidance`, `reflection_guidance`, `anti_patterns`) must be
satisfiable with those tools:

| Instead of | Write |
|---|---|
| "Run the proposal on the cheapest phone" | "Price the interaction from the code: what loads, what blocks, what it costs on a slow connection" |
| "Cite the standard you know by feel" | "Cite the standard you can point to, or reason from first principles and say so" |
| "Observe the team's reaction in the review" | "Name what the review would have to check, and where it would catch the regression" |
| "Test every flow with a screen reader" | "Audit the flow in the markup: focus order, accessible names, announced errors" |
| "Measure the yield on the line" | "Name the numbers: yield, cycle time, the control limit, and the source of each" |

The loader enforces this: `lintEmbodiment` in `composer/persona-loader.js` warns on
device claims, body-only verbs, external-system access, and unverifiable
"you know it by feel" phrasing, and `test/prompt-lint.test.js` fails CI on any
bundled persona that trips it. Two companion lints keep lenses portable
(`lintRangeRule` — at most one analogy, plus an off-ramp sentence) and guidance
from becoming an agenda echo (`lintCircularity`).

## Dashboard

Run `/loom_viz` to start the real-time web dashboard. It auto-detects the most recent meeting and streams updates as they happen.

- **Setup** — preview the suggested room, approve personas (or pick manually), approve per-tier models, then start; extend a finished deliberation with new input
- **Overview** — stats, participation matrix, contribution types, and timeline chart
- **Timeline** — per-round contributions, turn requests, and orchestrator decisions (moderation, turn ordering, summaries) interleaved; click any item to view full details in a dialog
- **Output** — the final synthesis artifact: decisions, action items, open questions, dissent, confidence, and full text

The dashboard supports light, dark, and system themes. Export the current meeting as Markdown or JSON from the Output tab.

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
    "defaultMaxRounds": 4
  }
}
```

Project-level equivalent in `.loomrc.json` (same keys, no `"loom"` wrapper):

```json
{
  "defaultMaxRounds": 4,
  "agentTimeoutMs": 240000
}
```

Environment overrides: `LOOM_<KEY>` applies on top of files for scalar schema keys (e.g. `LOOM_AGENT_TIMEOUT_MS=240000`, `LOOM_MODEL_DIVERSITY=false`). `OPENCODE_CONFIG_DIR` selects the shared opencode configuration and Loom data root; without a workspace, Loom data is stored below that directory. Log verbosity is controlled by `LOOM_LOG_LEVEL` (`DEBUG`|`INFO`|`WARN`|`ERROR`|`FATAL`, default `INFO`). The dashboard binds `127.0.0.1` by default and requires a per-dashboard capability cookie for API access. Bash is disabled by default; enable it only with an explicit Loom permission profile. To expose the dashboard beyond loopback, set `dashboard.host` deliberately and set `LOOM_ALLOW_LAN=1`; authenticated LAN access is still required.

Other available options include agent and synthesis timeouts, retry policy, max tool calls, meeting timeout, stall detection (`stallTimeoutMs`, default 10 min (600000 ms)), composition relevance floor (`composition.maxCosineDistance`, default 0.85), token budget (`maxTotalTokens`, `0` = unlimited — a runaway meeting ends early and still synthesizes), same-turn synthesis for inline loom tool results (`agentTools.sameTurnSynthesis`), and embedding model selection (`embeddingModel`/`embeddingQuant`).

## Operational caveats

- The plugin runtime is Bun-based; the Node checks validate syntax and pure logic but do not replace a live Bun/opencode integration test.
- The dashboard binds to loopback by default. LAN exposure requires both `dashboard.host` and `LOOM_ALLOW_LAN=1`, but the server does not provide TLS; use a trusted network or a TLS reverse proxy.
- Bash is disabled by default. Read, glob, grep, web search, and web fetch tools can still expose project data or make network requests, so enable only the tools and providers the meeting needs.
- Reports, prompts, tool inputs, and model metadata can contain sensitive data. Review retention and provider settings before sharing a meeting.

## License

MIT

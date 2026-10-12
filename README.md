# The Loom

> A multi-agent deliberation plugin for opencode. Ask a question, approve a room of persona agents, and watch them debate it in structured rounds until they converge on a synthesis.

Each agent runs in its own ephemeral session with its own model. They speak in turn, can question and poll each other mid-turn, and pass when they have nothing new to add. A neutral synthesizer writes the final artifact. The web dashboard is the control plane — nothing is returned to chat.

## How it works

1. **You approve the room.** Enter a question in the dashboard Setup tab. The Loom ranks all 349 bundled personas by embedding similarity to your question (flat pool, no quotas) and pre-selects the top 3. You confirm or edit the seats and the per-seat models before anything runs.
2. **Models are assigned per seat.** Each seat gets a random model from your enabled pool; your per-seat picks always win. Persona categories never influence the draw.
3. **Agents deliberate in rounds.** Each round, agents speak sequentially in composition order (the round-summary clerk may override next round's order). Turns see the question, the shared state of play, the agent's own carried state, and current-round contributions only — prompts stay flat, not growing with history.
4. **Agents interact inline.** During a turn an agent can call `loom_query` (modes: `clarify`, `perspective`, `evidence`, `critique`, `risks`, `assumptions`, `alternatives`), `loom_vote` (poll the room on lettered options), `loom_summon` (bring in a guest expert), and `loom_pass` (done contributing). Peer answers return within the same turn so the speaker can cite them immediately. Research tools (`read`, `glob`, `grep`, `websearch`, `webfetch`) are available alongside `loom_forum` side-discussions; `bash` is off by default.
5. **It ends deterministically, then synthesizes.** After the minimum rounds (default 2), the meeting ends when every active agent has passed or failed, the round cap is hit (default 4), or stall detection / cancellation fires. There is no meeting wall-clock timeout. A synthesizer then writes decisions, action items, dissent, and confidence to the dashboard Output tab and to `.opencode/loom/meetings/<id>.md`.

See `ORCHESTRATION_ARCHITECTURE.md` for prompts, schemas, and internals.

## Quick start

Prerequisites: opencode with Bun available (the plugin uses `bun:sqlite` / `Bun.serve`). Node is used for install and checks.

```bash
npm install             # 1. dependencies
npm run bundle          # 2. build dist/loom.js + dashboard
npm run install:plugin  # 3. install into your opencode config
npm run update:plugin   # update an existing install
```

The installer fetches the default embedding model (`Snowflake/snowflake-arctic-embed-xs` INT8, ~23MB) into `<opencode-config>/loom/models/`. Re-fetch manually with `npm run model:download` if needed.

Then:

```
loom_viz
```

Open the printed URL. In **Setup**:

1. Enter your question (+ optional context, max rounds).
2. Enable at least one model.
3. **Auto-select** the suggested room or pick seats manually — each seat's model is changeable.
4. Choose **Plan** (read-only, agents propose diffs) or **Build** (agents may `write`/`edit` files), then **Approve & start**.
5. Follow the Timeline; read the final artifact in Output. Extend a finished run from Setup instead of starting over.

> Contributor note: the dashboard serves the installed copy in your opencode config dir, not your working tree. After changing source, re-run `npm run bundle` **and** `npm run install:plugin` (or `update:plugin`).

## Commands

| Command | Description |
|---------|-------------|
| `/loom_viz` | Start the dashboard (sole control plane, default port 3210) |
| `/loom_stop` | Stop the dashboard (runs keep their state; cancel from the dashboard) |

`/loom_viz` takes one optional arg: `port` (default `3210`).

## Personas

349 bundled personas in six categories. Categories are browsing labels only — they grant no rights, drive no turn order, and never influence model assignment. Selection is one flat embedding ranking; any category (including `nonhuman`) wins seats only by similarity.

<!-- CENSUS-BEGIN -->
| Tier | Personas |
|------|----------|
| junior | 54 |
| mid | 57 |
| senior | 52 |
| principal | 48 |
| civilian | 61 |
| nonhuman | 77 |
| **Total** | **349** |
<!-- CENSUS-END -->

Personas live in `personas/<category>/*.json` (`name`, `persona`, `agenda`, `tags`, plus `category_guidance` / `reflection_guidance`). Add your own under `<opencode-config>/loom/personas/<category>/` — same shape, same name wins over bundled. Agents are text-only: write guidance that is satisfiable with file, search, and peer tools, not physical actions.

## Dashboard

Start with `/loom_viz`. Four tabs:

- **Setup** — question, models, seats, Plan/Build toggle, start; extend finished runs.
- **Overview** — stats, participation, contribution timeline.
- **Timeline** — per-round contributions and orchestrator decisions; click for full prompt/tool detail.
- **Output** — final synthesis artifact. Export as Markdown or JSON.

## Configuration

Deep-merged, project wins over home, invalid values fall back to defaults with a startup warning. Candidates:

- Project: `<project>/opencode.json` (`"loom"` key), `<project>/opencode.jsonc`, `<project>/.loomrc.json`, `<project>/.loomrc.jsonc` (no wrapper key)
- Home: same four filenames under your opencode config dir

```json
{ "loom": { "defaultMaxRounds": 4 } }
```

```json
{ "defaultMaxRounds": 4, "agentTimeoutMs": 1200000 }
```

`LOOM_<KEY>` env vars override files for schema keys (e.g. `LOOM_AGENT_TIMEOUT_MS=1200000`). Key defaults: `defaultMaxRounds: 4`, `minRounds: 2`, `agentTimeoutMs: 1200000` (20min, `0` disables), `stallTimeoutMs: 1800000` (30min), `composition.autoSelectSeats: 3`. Embedding model: `embeddingModel` / `embeddingQuant`. Agent capabilities: `agentTools.*` (`buildMode`, `sameTurnSynthesis`, per-tool toggles).

Meetings are stored per project at `<project>/.opencode/loom/meetings/<uuid>.db` (+ `.md` report), or under the opencode config dir when there is no workspace. Deleting a session deletes its meeting files.

Embedding is required for auto-select only: without a loaded model the Setup tab hides auto-select (manual picking still works), and `loom_summon` hides itself because it ranks guests the same way.

## Requirements & caveats

- Bun-backed runtime; `npm test` / `npm run check` cover pure logic, not live opencode integration.
- Dashboard binds `127.0.0.1` with a per-dashboard capability cookie. LAN exposure needs `dashboard.host` set **and** `LOOM_ALLOW_LAN=1`, still authenticated — and the server provides no TLS, so use a trusted network or reverse proxy.
- `bash` is disabled by default. `read`/`glob`/`grep`/web tools can still expose project data or hit the network — enable only what the meeting needs.
- Prompts, tool I/O, and reports may contain sensitive data. Review provider and retention settings before sharing.

## Development

```bash
npm test             # unit / invariant tests
npm run check        # syntax checks
npm run bundle       # build plugin + dashboard
npm run docs:verify  # arch-doc numeric claims vs code
```

## License

MIT

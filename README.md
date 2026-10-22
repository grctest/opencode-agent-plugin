# Deliberation Dashboard

> Got a hard call to make? Convene a room of AI experts, let them argue it out in structured rounds, and get back a verdict — decisions, action items, and where they disagreed.

Deliberation Dashboard is an opencode plugin. You ask a question, approve a lineup of persona agents, and follow the debate live in a web dashboard. A neutral synthesizer writes the final report when the room converges.

## When to use it

- **Tradeoff decisions** — "Should we migrate auth to JWT?", "Buy or build?", "Which design survives contact with production?"
- **Design and plan reviews** — let security, UX, and ops lenses attack your proposal before users do.
- **Second opinions** — you already have a favorite answer; make the room try to kill it.

## How it works

1. **You pick the room.** Describe your question in the dashboard. Deliberation Dashboard suggests the 3 most relevant personas from its 349-persona catalog, or you pick your own seats and models.
2. **The room debates in rounds.** Agents take turns making their case, challenging each other, calling votes, and pulling in guest experts — all live in front of you.
3. **Agents bow out when done.** Anyone with nothing new to add passes; the debate ends when the room is done or the round cap is reached.
4. **You get a report.** Decisions, reasoning, action items, open questions, and dissenting views land in the dashboard, saved as Markdown next to the meeting.

Technical details live in `ORCHESTRATION_ARCHITECTURE.md`.

## Quick start

Requires opencode and Bun.

```bash
npm install             # 1. dependencies
npm run bundle          # 2. build the plugin + dashboard
npm run install:plugin  # 3. install into your opencode config
npm run update:plugin   # update an existing install
```

The installer downloads a small embedding model (~23MB) used to suggest rooms. If that fails, run `npm run model:download` later.

Then, in opencode:

```
/launch-deliberation-dashboard
```

Open the printed URL. In **Setup**:

1. Enter your question (+ optional context, max rounds).
2. Enable at least one model.
3. **Auto-select** the suggested room or add seats manually — set a model per seat.
4. Choose **Plan** (agents propose changes as diffs) or **Build** (agents may edit your files), then **Approve & start**.
5. Watch the Timeline; read the verdict in Output. Reopen a finished run from Setup to keep deliberating instead of starting over.

## Commands

| Command | Description |
|---------|-------------|
| `/launch-deliberation-dashboard` | Start the dashboard (default port 3210, `port` arg optional) |
| `/shutdown-deliberation-dashboard` | Stop the dashboard (runs keep their state; cancel from the dashboard) |

## Personas

349 bundled personas across six categories — junior to principal, generalists, and non-human perspectives. Any of them can land a seat if they're the best match for your question.

<!-- CENSUS-BEGIN -->
| Category | Personas |
|------|----------|
| junior | 54 |
| mid | 57 |
| senior | 52 |
| principal | 48 |
| civilian | 61 |
| nonhuman | 77 |
| **Total** | **349** |
<!-- CENSUS-END -->

Bring your own: drop persona JSON files in `<opencode-config>/loom/personas/<category>/` and they'll show up in the catalog.

## Dashboard

Four tabs: **Setup** (question, models, seats, start), **Overview** (stats and participation), **Timeline** (every contribution, click for detail), **Output** (the final report — export as Markdown or JSON).

## Configuration

Optional. Project config overrides home config; `LOOM_<KEY>` env vars override both.

```json
{ "loom": { "defaultMaxRounds": 4 } }
```

Common keys: `defaultMaxRounds` (4), `minRounds` (2), `agentTimeoutMs` (20 min), `stallTimeoutMs` (30 min). See `ORCHESTRATION_ARCHITECTURE.md` for the full list.

Meetings live under `<project>/.opencode/loom/meetings/` (one `.db` + one `.md` report each). Without the embedding model, auto-select is hidden and you pick seats manually.

## Safety notes

- The dashboard only listens on localhost unless you deliberately set `dashboard.host` **and** `LOOM_ALLOW_LAN=1`. There is no TLS, so don't expose it bare to untrusted networks.
- Agents can read your files and hit the network via search/fetch. Shell access is off by default — keep it that way unless the debate needs it.
- Transcripts and reports may contain sensitive project details. Check what's in them before sharing.

## Development

```bash
npm test             # unit / invariant tests
npm run check        # syntax checks
npm run bundle       # build plugin + dashboard
npm run docs:verify  # arch-doc numeric claims vs code
```

The dashboard serves the installed copy in your opencode config dir, not your working tree — after changing source, re-run `npm run bundle` **and** `npm run install:plugin` (or `update:plugin`).

## License

MIT

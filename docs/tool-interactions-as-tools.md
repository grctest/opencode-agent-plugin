# Refactor Proposal: Interaction Directives as Tool Calls

> Status: **Plan — awaiting approval** · Authors: Loom team · Date: 2026-05-13  
> Scope: Replace bracket-tag regex (`[QUERY: @id]`, `[EVIDENCE: @id]`, `[CALL_VOTE]`, `[SUMMON: …]`, `[REQUEST_NEXT: …]`) with first-class opencode tool calls that are auditable, retryable, and optionally **synchronous within the invoker’s turn**.

## 1. Why Change?

### Current contract
Prompt `src/prompts.js:799-804` tells agents to append **one trailing directive** after their content. Parser `src/schemas.js:79-235` + `src/validation.js:14-62` extracts them via global regexes:

- `QUERY_TAG_RE = /\[QUERY:\s*@([^\]]+)\]\s*/gi` (line 136)
- `EVIDENCE_TAG_RE = /\[EVIDENCE:\s*@([^\]]+)\]\s*/gi` (line 162)
- `VOTE_TAG_RE = /\[CALL_VOTE\]\s*/gi` (207), `SUMMON_TAG_RE = /\[SUMMON:\s*([^\]]+)\]\s*/gi` (186)
- `REQUEST_NEXT_RE = /\[REQUEST_NEXT:\s*Priority:\s*(\d+),\s*Reason:\s*"([^"]+)"\s*\]/i` (120)

Targets capped `slice(0,2)`, question = `slice(afterLastTag).trim().slice(0,500)` (151-181), Zod validates `targets 1..2` / `question 1..500` (`schemas.js:33-54`). `AgentResponseSchema.safeParse` failure falls back to `{type:"challenge", query:null, ...}` (`validation.js:52`) — silent loss.

Sequential triggers `src/round-executor.js:161-235`:

```
#handlePromptResult → store challenge
→ executeQueries (if query)        — Promise.allSettled, toolChoice:auto, 2-4 sentences
→ executeEvidenceRequests (if evidence) — toolChoice:required, 100-180w
→ executeSummons
→ executeVote
→ runMidRoundReflections (if type===challenge|dissent, 80-150w, toolChoice:auto)
```

All are independent `if`s, not `else`. Order fixed: query → evidence → summon → vote → reflection.

### Failure modes observed

| Input | Regex | Result |
|-------|-------|--------|
| `[QUERY @bob] hi` (no `:`) | requires `:` | `query:null` → no `query_response` |
| `[QUERY: bob] hi` (no `@`) | requires `@` | `null` |
| `[QUERY: @bob]` no question | `question=""` → Zod `min(1)` fails → fallback challenge | no query |
| `[QUERY: @a,@b,@c,@d]` | `slice(0,2)` | `c,d` silently dropped |
| `[QUERY: @nonexistent]` | regex ok, but `allParticipants.find` filter removes | early `return` (line 304) — no error surfaced |
| Natural language `QUERY: @bob ...` | no brackets | `null` |
| Lowercase `[query: @bob]` | `/gi` → works (ok) | — |

User-reported case: `QUERY: @junior_process_scout_0 what's your evidence...` answered inside a `reflection` (`[Reflection on #12]`) rather than a `query_response`. Either regex was slightly off or target filtered, so only `runMidRoundReflections` fired (single reflector via `findMostSimilar` `src/reflection-manager.js:55-88`). The 60% answer was thus not a `loom_vector_search`/`websearch` query but a reflection hallucination.

Evidence’s `toolChoice:required` guarantee is lost when the tag is lost.

Timeline already handles coexistence: `reflectionsByTarget` vs `queryResponsesByTarget` are separate `Map`s with independent `consumed*Ids` sets (`src/dashboard/components/TimelineTab.jsx:463-597`). If both existed they would render as distinct `loom-vrow-reflection` (80px) and `loom-vrow-query-response` rows. The “missing” `query_response` was simply never created, not hidden.

---

## 2. Goal

- **Eliminate regex fragility**: tool args are Zod-validated by opencode; malformed calls become `ToolPart tool:"invalid"` with `attempted_tool` captured in `src/utils/text.js:61-66` → visible as `attempted/failed` rather than silent `null`.
- **Make every interaction auditable**: every `[QUERY]/[EVIDENCE]/[VOTE]/[SUMMON]/[REQUEST_NEXT]` becomes a row in `contributions.tool_calls` (JSON `TEXT` `src/database/schema.js:61`, stringified in `src/database.js:590`, parsed in `src/dashboard/api.js:244`) and shown in the invoker’s dialog `Tool use` tab (`TimelineTab.jsx:880-918`) **and** as an inline timeline badge under the invoker.
- **Optionally return callee responses to caller within the same turn** so the challenger can synthesize answers before the turn ends, instead of waiting for `recent_contributions` in the next round.

## 3. Proposed Tool Set

Define in `src/index.js:116-210` alongside `loom_vector_search` and register via `createKnitHandler(..., agentTools)`:

| Tool | Args (Zod) | Who it prompts | ToolChoice for callee | Output to caller |
|------|------------|----------------|----------------------|------------------|
| `loom_query` | `targets: z.array(z.string()).min(1).max(2)`, `question: z.string().min(1).max(500)` | 1-2 peers (`status !== failed/passed`, not self — `round-executor.js:299-303`) | `auto` (`webfetch,websearch,read,loom_vector_search`) — 2-4 sentences, cite `[#id]` (`round-executor.js:357-362`) | `{responses:[{participantId, contributionId, content, type:"query_response"}]}` |
| `loom_evidence` | same | same | `required` — `Finding + Source + Strength: strong|weak|inconclusive` 100-180w (`round-executor.js:516-520`) | same, but guarantee ≥1 research tool per callee |
| `loom_vote` | `question: z.string().min(1).max(500)` | all active others (`round-executor.js:792-794`) | `none` (poll) — `[Vote: X]` (`round-executor.js:845`) | `{tally:{counts, winner, total}, votes:[...]}` |
| `loom_summon` | `persona_name: string, issue: string(1..500)` | guest expert (persona pool `composer.js`) | `auto` (full map `read,bash,glob,grep` + `loom_vector_search`, `round-executor.js:665-676`) | `{contributionId, persona}` |
| `loom_request_next` | `priority: 1..10 (capped by tier via getPriorityCap)`, `reason: string(1..200)` | — (system) | — | `{granted: bool, reason}` |

All tools share `target` resolution: `allParticipants.find` + self/failed/passed filter, silent drop if `length===0` but return structured error in `output` rather than early `return` with no trace.

### Handler sketch (`src/index.js`)

```ts
loom_query: tool({
  description: "Ask 1-2 peers a focused question. They will answer concisely and cite sources. Use for 'what was said' or clarifying assumptions.",
  args: { targets: tool.schema.array(tool.schema.string()).min(1).max(2), question: tool.schema.string().min(1).max(500) },
  async execute(args, ctx) {
    const m = await resolveMeeting(ctx.sessionID); // src/index.js:70-113 cache+DB+parent fallback
    const db = await MeetingDatabase.create(m.dbPath, m.meetingId);
    const state = ... ; const round = ...;
    // Reuse current executeQueries logic factored into a service:
    const results = await interactionService.executeQueries(round, caller, args, sourceContributionId);
    // results already persisted as query_response rows via db.addContributionWithTurnRequest
    return { responses: results.map(r=>({participantId:r.participant_id, contributionId:r.id, content:r.content})), truncated: false };
  }
})
```

`interactionService` is a thin extraction of `src/round-executor.js:288-603` methods so they can be called from both the old sequential path and the new tool path (no duplication).

## 4. Execution Flow — Same-Turn vs Next-Round

### Today (next-round visibility)

```
caller prompt → {text1, toolResults: [loom_vector_search]} → parse tags → store CHALLENGE → await executeQueries → query_response rows → await runMidRoundReflections → next speaker sees them in buildAgentUserPrompt recent_contributions slice (-12) and State of Play
```

Caller’s `text1` cannot incorporate answers; they appear only for **others** next turn.

### With tool loop (same-turn synthesis)

`RoundExecutor.#executeAgentTurn` currently does single `contract.prompt` (`src/session-contract.js:78-111`, `src/round-executor.js:1227-1236`) then `extractAgentResponse → mapToolResults → parseAgentResponse → return`.

Change to ReAct loop:

```
result1 = await contract.prompt({system, parts:[text], tools:{...loom_query,...originalMap}, toolChoice:auto})
{ text1, toolResults1 } = extractAgentResponse(result1.data) // toolParts are terminal "completed"/"error" (src/utils/text.js:42-47)

loomCalls = toolResults1.filter(t.tool.startsWith("loom_"))
if (loomCalls.length>0) {
  // Execute each loom tool synchronously, persisting callee contributions as today (so timeline shows them)
  const loomOutputs = []
  for (const lc of loomCalls) {
    const out = await handleLoomTool(lc) // calls interactionService, which does Promise.allSettled over targets, creates query_response rows
    loomOutputs.push({ callID: lc.callID, tool: lc.tool, result: out })
  }
  // Second turn: feed tool outputs back to caller for synthesis
  const toolResultParts = loomOutputs.map(o => ({
    type: "text",
    text: `Tool ${o.tool} (${o.callID}) returned:\n${JSON.stringify(o.result).slice(0,4000)}`
  }))
  // Alternatively use dedicated tool-result part type if SDK supports it; else inline as user message
  result2 = await contract.prompt({
    sessionId, // same ephemeral or round-scoped session (src/session-manager.js:68-110 reuse)
    system,
    parts: [
      ...result1.data.parts, // history
      ...toolResultParts
    ],
    tools: originalMapWithoutLoom, // caller synthesis shouldn't re-trigger loom tools (or allow but cap)
    toolChoice: auto,
    model, temperature, timeoutMs: remainingDeadline
  })
  { text2, toolResults2 } = extractAgentResponse(result2.data)
  finalText = text2 ?? text1
  finalToolResults = [...toolResults1, ...toolResults2, ...extractFileBlockTools(finalText)]
} else {
  finalText = text1; finalToolResults = toolResults1;
}
finalResponse = parseAgentResponse(participantId, finalText)
finalResponse.tool_calls = mapToolResults(finalToolResults) // both loom calls + research calls
store finalResponse as CHALLENGE (content is the synthesized text after seeing answers)
```

- **Deadline-aware**: `runPromptPhase` already caps `timeoutMs` by `deadline` (`src/round-executor.js:1038-1050`). Second turn uses `remainingDeadline`.
- **Limits**: `maxToolCallsPerTurn=5` (`src/config.js:57`) must cover both research tools and loom tools combined; truncate with `tool_call_limit` warning (`src/round-executor.js:1263-1288`) already handles.
- **No loop beyond two turns**: cap at one synthesis turn to bound cost. If caller again calls `loom_query` in turn 2, treat as `attempted_tool` error or ignore (return `error: "loom tools only allowed in first turn"`).

**Alternative: keep current sequential post-store timing but still log as tools** — if same-turn synthesis is deemed too costly, we can keep today’s “store challenge then executeQueries” order, but still define `loom_*` tools whose `execute` simply validates and returns `ack: "query dispatched"` without awaiting callee responses. Timeline audit exists, but caller synthesis is still next-round. This is a stepping-stone migration.

Decision point for reviewers: choose **(A) auditable post-store tools without second turn** (minimal latency) vs **(B) ReAct same-turn synthesis** (described above). This doc details (B) but notes (A) as fallback.

## 5. DB Logging

### Existing schema (no migration needed for basic case)

`contributions` (`src/database/schema.js:52-64`, `src/database.js:579-691`):

```
tool_calls TEXT  -- JSON.stringify(mapToolResults output) or null
prompt_context TEXT -- JSON.stringify(promptContext)
```

`mapToolResults` shape (`src/utils/text.js:117-134`, also `src/utils/text.js:198-215` in bundle):

```
{ tool, callID, status, attempted_tool?, title?, output(2k), error(500), input(500 JSON), metadata }
```

Today: `response.tool_calls = mapToolResults(effectiveToolResults)` (`src/round-executor.js:1296`), then `addContributionWithTurnRequest` persists both `tool_calls` and `prompt_context` (`src/database.js:678-691`).

### With loom tools

- **Invoker’s contribution** (`type: challenge/dissent/etc.`): `tool_calls` now contains **both** research tools (`websearch` etc.) **and** `loom_query`/`loom_evidence` entries. For `loom_query`, `input = JSON.stringify({targets, question})`, `output = JSON.stringify({responses:[...]})` (truncated 2k), `status:"completed"` or `"error"` if targets filtered. `attempted_tool` captures `invalid` routing (`src/utils/text.js:61-66`) so `[QUERY: @nonexistent]` becomes visible.
- **Callee contributions** (`type: query_response`, `evidence_response`, `vote_response`, `summoned_response`): created inside `interactionService` via same `mapToolResults` path (`src/round-executor.js:405-414`, `570-573`, `752-753`, `896`). They retain their own `tool_calls` (research tools) and `prompt_context` (`type:"query_response"` etc., `src/round-executor.js:363-374`, `521-533`, `702-714`).
- **Reflection** remains system-triggered, not a caller tool: its `tool_calls` stays research-only, `type:"reflection"`, `prompt_context.type:"reflection"` (`src/reflection-manager.js:134-205`).

No schema migration. If we want per-tool timing, add optional `metadata.durationMs` inside `mapToolResults` `metadata` field (already `any`).

Optional index for faster “show all queries this meeting”: `CREATE INDEX IF NOT EXISTS idx_contributions_tool_calls ON contributions(meeting_id) WHERE tool_calls IS NOT NULL` — not required, keep read path as full fetch + client filter.

## 6. Timeline List Items — Under Invoker

Current `TimelineTab.jsx:437-746` builds `flatItems` per round:

- Groups by `regularByAgent` (`Map<participantId, agent_turn>`) and `*ByTarget` (`Map<targets_which, [contribution]>`) (`TimelineTab.jsx:462-511`).
- Pushes `agent_turn` then `reflectionsByTarget.get(c.id) → reflection`, `queryResponsesByTarget.get(c.id) → query_response`, `evidenceResponsesByTarget.get(c.id) → evidence_response` (`512-562`), with orphan fallbacks (`564-597`).
- Distinct heights `REFLECTION_HEIGHT/QUERY_RESPONSE_HEIGHT/EVIDENCE_RESPONSE_HEIGHT =80` (`96-105`), distinct components `ReflectionRow`/`QueryResponseRow`/`EvidenceResponseRow` (`121-272`), distinct badges `loom-badge-reflection` / `loom-badge-query_response` / etc. (`Cards.jsx:224-350`).

**No change needed for callee rows** — they already render as separate indented `loom-vrow-reflection` / `loom-vrow-query-response` under the triggering `agent_turn`. Both can coexist for same `targets_which` because maps/sets are independent.

**New for invoker**: Add inline tool badge list under the `agent_turn` card itself (not just callee rows):

- In `flatItems` loop, after `items.push({type:"agent_turn", agentId, contributions: agentContribs})`, inspect each `c`’s `tool_calls` for `tool in {loom_query, loom_evidence, loom_vote, loom_summon}`. If present, push a new `item.type:"invocation"` row or augment `agent_turn` props with `invocations: c.tool_calls.filter(isLoom)`.
- Simpler: extend `ContributionItem` (`Cards.jsx:133-181`) to render a footer `loom-invocation-list` when `contribution.tool_calls?.some(isLoom)`: show pills `Query → @scout (2 responses)` / `Evidence → @scout` / `Vote → A)…` with status `ok|error`. Clicking a pill scrolls to corresponding `query_response` row (anchor via `contribution.targets_which`).

This satisfies “show them in the timeline list items under the invoker”.

## 7. Dialog Tool Tab — Inside Invoker

Existing `TimelineTab.jsx:798-878` dialog tabs (`Response | Tool use | Details | Context`) already reads `dialogContribution.contribution.tool_calls` (`TimelineTab.jsx:824-861`) and renders `src/dashboard/components/TimelineTab.jsx:880-918`-style list via `TimelineTab.jsx` pass-through to `Cards.jsx` tool list:

```
if tool_calls && length>0 → map(tc) → header {tool / attempted_tool + title + status} + <pre>input/output/error
else → "No tool calls were recorded for this contribution."
```

**With loom tools**:

- **Caller’s dialog**: `Tool use` now includes `loom_query` entries. Render `input` as `Targets: @a, @b\nQuestion: "..."` (pretty from JSON) and `output` as `2 responses: [#45] scout: "..."`. Keep `callID` for key. If `status:"error"` (e.g., targets filtered), show `attempted/failed` with error `No eligible targets (filtered self/failed/passed)`.
- **Callee’s dialog**: unchanged — shows research tools (`websearch`, `loom_vector_search`, `read`, etc.). Evidence responses will now always have at least one research tool because toolChoice:required is enforced at callee prompt time; if empty, show warning.
- **Synthetic file blocks**: Already synthesized via `extractFileBlockTools` (`src/utils/text.js:76-142` + `TimelineTab` pass-through) as `{tool:"write", synthetic:true}`; keep.

Optional polish: group Loom tools at top of list and research tools below, or add filter tabs `Loom interactions | Research`.

**Context tab**: keep lazy-load via `/api/contribution_context?meeting=&contribution_id=` (`hooks.js` already switched to `include_context=1` for initial load; fallback fetch in `TimelineTab.jsx:343-433` handles old data). For invoker, `prompt_context` should include `system_prompt` + `user_prompt` with Loom tool descriptions, so “why” is visible.

## 8. Config & Prompts

- `src/config.js:34-58` add `agentTools.loom: { loom_query:true, loom_evidence:true, loom_vote:true, loom_summon:true, loom_request_next:true }` (default `true`) plus `NESTED_SCHEMA` entries (`agentTools.loom.loom_vector_search` already exists, add siblings). Keep `reflection.{bash,glob,grep}` as is.
- `resolveBuiltInTools` (`config.js:548-562`) stays for `web*`/`read`/`bash`/`glob`/`grep`/`lsp`; new `resolveLoomTools` returns loom boolean map.
- `#buildToolsMap` (`round-executor.js:1314-1329` and per-phase builders `341-348`, `499-507`, `665-676`, `reflection-manager.js:109-119`) merges `web*` + `loom_*` into single `toolsMap` passed to `contract.prompt`.
- `src/prompts.js:45-105 buildEvidenceGuidance`, `682-816 buildAgentSystemPrompt`, `800-804 OUTPUT CONTRACT` replace/append directive list with tool list. Remove examples of `[QUERY: @...]` and add: `loom_query({targets:[...], question:"..."}) — ask peers; loom_evidence — they must research`.
- Keep `parseAgentResponseRaw` fallback for one release: if text still contains `[QUERY:` after tool loop, synthesize a `loom_query` tool call to preserve audit, but log `deprecated_bracket_tag_used` warning.

## 9. Pseudocode Delta

```js
// src/round-executor.js — #executeAgentTurn (before)
result = await contract.prompt({tools: buildToolsMap(), toolChoice:auto})
{text, toolResults} = extractAgentResponse(result.data)
parsed = parseAgentResponse(participantId, text)
parsed.tool_calls = mapToolResults(toolResults)
store(parsed) // challenge
if (parsed.query) await executeQueries(...)

// After (with loom tools + same-turn synthesis)
toolsMap = {...buildToolsMap(), ...buildLoomMap()} // loom_query etc.
result1 = await contract.prompt({tools: toolsMap, toolChoice:auto})
{text1, toolResults1} = extractAgentResponse(result1.data) // includes loom_vector_search + loom_* ToolParts
loomCalls = toolResults1.filter(t=>t.tool.startsWith("loom_"))
if (loomCalls.length>0) {
  // persist caller’s loom tool calls even before second turn? No, defer until final store
  const outputs = []
  for (const lc of loomCalls) {
    const out = await handleLoomTool(lc, round, caller, sourceContributionIdPlaceholder=null)
    // handleLoomTool creates query_response rows immediately (so they get IDs for targets_which)
    outputs.push(out)
  }
  // Feed back to caller
  result2 = await contract.prompt({
    sessionId, // same ephemeral (round-scoped reuse src/session-manager.js:68-110)
    system,
    parts: [
      ...result1.data.parts,
      {type:"text", text: `Loom tool results:\n${outputs.map(o=> `${o.tool}(${o.callID}) → ${JSON.stringify(o.result).slice(0,3000)}`).join("\n\n")}\n\nNow synthesize your final contribution incorporating these responses. Do not re-request the same peers.`}
    ],
    tools: buildToolsMap(), // without loom tools to avoid loop
    toolChoice: auto,
  })
  {text2, toolResults2} = extractAgentResponse(result2.data)
  finalText = text2 ?? text1
  finalToolResults = [...toolResults1, ...toolResults2, ...extractFileBlockTools(finalText)]
  finalParsed = parseAgentResponse(participantId, finalText) // type now based on finalText prefix
  finalParsed.tool_calls = mapToolResults(finalToolResults)
  // Now store final challenge + loom tool outputs already stored as separate contributions
  store(finalParsed)
  // Do NOT re-run executeQueries from finalParsed.query — loom path already handled
} else {
  // no loom tools → fall back to old bracket path or store directly
  finalParsed = parseAgentResponse(participantId, text1)
  finalParsed.tool_calls = mapToolResults([...toolResults1, ...extractFileBlockTools(text1)])
  store(finalParsed)
  // keep legacy sequential execute* for bracket tags during migration
  if (finalParsed.query) await executeQueries(...)
}
```

`handleLoomTool` is extracted `executeQueries` body: target resolution, `setQueryingParticipants`, `Promise.allSettled` fan-out with `buildQueryPrompt` → `contract.prompt({tools: {webfetch,...}, toolChoice:auto})` per target, `mapToolResults` for callee, `addContributionWithTurnRequest` for callee rows.

Reflection trigger stays after final store: `if (finalParsed.type==="challenge"||"dissent") await runMidRoundReflections(...)` with added exclusion of `loomCall targets` from similarity pool.

## 10. Verification

- **Unit:** `schemas.js` → new tool arg Zod schemas (targets 1..2, question 1..500) mirror old caps; test invalid `targets:[]` → `tool:"invalid"` → `attempted_tool` path (`utils/text.js:61-66`) surfaces in dashboard.
- **Integration:** single `[CHALLENGE] + loom_query` → assert `query_response` row created (`type:query_response`, `targets_which===challengeId`), invoker’s `tool_calls` contains `loom_query` with `output.responses.length===1`, invoker’s dialog `Tool use` shows both `loom_query` and callee’s `Tool use` shows research tools.
- **Same-turn synthesis:** assert invoker’s final `content` contains citation `[#<query_responseId>]` or quoted answer, not just original challenge.
- **Failure modes:** malformed `loom_query` (missing `question`) → `attempted_tool` error, no `query_response` row, warning logged; targets `["nonexistent"]` → `output: {error:"No eligible targets"}` still logged.
- **Timeline:** `flatItems` length for round with challenge+query+reflection = 1 header + 1 agent_turn (caller with inline loom pills) + 1 query_response + 1 reflection + (evidence if any). No whole-round collapse hides only one type.
- **Performance:** 1 extra caller turn per challenge with interaction (up to `needs_correction | 2` rounds). Measure tokens via `callStats.agent_prompts` (`round-executor.js:1211`) and latency via `recordLatency`.
- **DB:** `SELECT tool_calls FROM contributions WHERE type='challenge' AND tool_calls LIKE '%loom_query%'` should return JSON with `callID` linking to `query_response` IDs.

## 11. Risks & Mitigations

- **Cost/latency:** second caller turn doubles LLM calls for interactive turns. Mitigate: cap loom calls to 2 per turn (already), cap second-turn `maxToolCallsPerTurn` separately, and make same-turn synthesis opt-in via `agentTools.loom.sameTurnSynthesis: true` default false for rollout.
- **Deadlock:** caller could repeatedly call `loom_query` in turn 2 → infinite loop. Mitigate: strip loom tools from second turn’s `toolsMap` and limit `handleLoomTool` to one pass.
- **Target starvation:** fan-out to 2 peers in parallel already uses `Promise.allSettled` + `setQueryingParticipants` flag for dashboard liveness. Keep.
- **Migration:** keep bracket parser as fallback that synthesizes `loom_*` tool calls for one version, with deprecation log, then remove in next major.

## 12. Implementation Checklist

1. Define `loom_*` tools in `src/index.js:116-174` + `resolveLoomTools`.
2. Extend `src/config.js:34-58,100,548-562` (defaults, schema, `getConfig`).
3. Update `#buildToolsMap` + per-phase builders to merge loom map; update `src/prompts.js:699-816` system prompt.
4. Factor `executeQueries`/`executeEvidenceRequests`/`executeVote`/`executeSummons` into `src/services/interaction-service.js` for reuse by tool handlers and legacy sequential path.
5. Implement `handleLoomTool` + two-turn loop in `src/round-executor.js:1196-1312` (deadline-aware, `remainingDeadline`, `tool_call_limit` truncation).
6. Update `src/utils/text.js:198-215` `mapToolResults` to pretty-print loom outputs (optional).
7. Update `TimelineTab.jsx:438-597` to render inline loom pills under `agent_turn` and `Cards.jsx:133-181` footer.
8. Keep `TimelineTab.jsx:880-918` dialog `Tool use` as is — it already renders any `tool` in `tool_calls`; just test with `loom_query`.
9. Add tests and `ORCHESTRATION_ARCHITECTURE.md` §22 (directed interactions) update.

## 13. Open Questions

1. Should **same-turn synthesis** be default, or should we ship **audit-only** (post-store) first and enable synthesis behind a flag after measuring latency?
2. Should a challenge be allowed to trigger **both** `loom_query` and `loom_evidence` in one turn (today’s `if` chain allows it), or enforce `query XOR evidence` to bound cost?
3. Should the reflector be **excluded** from `loom_query`/`loom_evidence` target sets for the same challenge to keep “answer” vs “reflection” roles distinct?
4. Should `loom_request_next` also become a tool (currently `REQUEST_NEXT: Priority, Reason` with tier-capped priority `src/schemas.js:128-129`), or keep as tag?


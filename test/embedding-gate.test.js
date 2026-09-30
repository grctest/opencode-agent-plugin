import test from "node:test";
import assert from "node:assert/strict";
import { buildToolsMap } from "../src/round-executor/tools.js";
import { buildAgentSystemPrompt } from "../src/prompts/agent.js";
import { createVoteSummonTools } from "../src/plugin/tools/vote-summon.js";
import { isSummonAvailable, SUMMON_UNAVAILABLE_REASON } from "../src/services/embedding-gate.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";

// loom_summon needs the persona index, which is built entirely from the ONNX
// encoder. Without a model there is nothing to rank the issue against, so the
// tool must disappear rather than hand back an arbitrary guest.
//
// These run in a process with no embedder loaded — the default for a fresh
// checkout — which is exactly the state under test. The positive path needs a
// downloaded model and is covered by running the suite against one.

const AGENT = {
  config: {
    id: "gate_mid", name: "Gate Analyst", tier: "mid",
    persona: "p", agenda: "a", known_biases: [], communication_style: "terse",
    preferred_contribution_types: ["refine"], anti_patterns: [],
    model: { providerID: "test", modelID: "t" },
  },
  status: "listening",
};

function toolsWith(configure) {
  const agentTools = structuredClone(DEFAULT_CONFIG.agentTools);
  configure?.(agentTools);
  return { agentTools, cfg: { agentTools } };
}

test("summon is reported unavailable when no embedding model is loaded", () => {
  assert.equal(isSummonAvailable(), false);
});

test("the refusal names the fix, not just the state", () => {
  assert.match(SUMMON_UNAVAILABLE_REASON, /embedding model/);
  assert.match(SUMMON_UNAVAILABLE_REASON, /model:download|embeddingModel/);
});

test("config alone does not put loom_summon in the tool map", () => {
  const { agentTools, cfg } = toolsWith((at) => { at.loom.loom_summon = true; });
  assert.equal(agentTools.loom.loom_summon, true, "precondition: config permits summon");
  const map = buildToolsMap(cfg, { activeCount: 4 });
  assert.equal("loom_summon" in map, false);
  // Sibling loom tools stay available — the gate is surgical.
  assert.equal(map.loom_query, true);
  assert.equal(map.loom_vote, true);
  assert.equal(map.loom_pass, true);
});

test("summon stays out of the map in solo mode too", () => {
  const { cfg } = toolsWith((at) => { at.loom.loom_summon = true; });
  const map = buildToolsMap(cfg, { activeCount: 1 });
  assert.equal("loom_summon" in map, false);
  assert.equal(map.loom_query, undefined, "solo gating is unchanged");
});

test("the prompt never advertises a tool that was not offered", () => {
  const { agentTools } = toolsWith((at) => { at.loom.loom_summon = true; });
  const sys = buildAgentSystemPrompt(AGENT, { activeCount: 4, agentTools });
  assert.doesNotMatch(sys, /loom_summon/);
});

test("the mandatory peer-interaction note lists only offered tools", () => {
  const { agentTools } = toolsWith((at) => {
    at.loom.loom_summon = true;
    at.mandatory.agentQueries = "mandatory";
  });
  const sys = buildAgentSystemPrompt(AGENT, { activeCount: 4, agentTools });
  const note = sys.match(/\*\*Mandatory this turn:\*\* ([^\n]*)/)?.[1] ?? "";
  assert.doesNotMatch(note, /loom_summon/);
  assert.match(note, /loom_query/);
});

test("the solo note stops steering the agent at a gated tool", () => {
  const { agentTools } = toolsWith((at) => { at.loom.loom_summon = true; });
  const sys = buildAgentSystemPrompt(AGENT, { activeCount: 1, agentTools });
  const soloNote = sys.match(/\*\*Solo mode[^\n]*/)?.[0] ?? "";
  assert.ok(soloNote.length > 0, "precondition: solo note renders");
  assert.doesNotMatch(soloNote, /loom_summon/);
});

test("execute refuses before touching meeting state", async () => {
  let resolveCalls = 0;
  const { loom_summon } = createVoteSummonTools({
    config: { getValue: () => ({ enabled: true, loom: { loom_summon: true } }) },
    resolveMeeting: async () => { resolveCalls++; return null; },
    activeLooms: new Map(),
  });
  const res = await loom_summon.execute(
    { persona_name: "Risk Officer", issue: "Should we ship?" },
    { sessionID: "ses_gate" },
  );
  const payload = JSON.parse(res.output);
  assert.equal(payload.error, "loom_summon unavailable");
  assert.equal(payload.reason, SUMMON_UNAVAILABLE_REASON);
  assert.equal(res.metadata.disabled, true);
  assert.equal(res.title, "loom_summon unavailable");
  // Not reported as "queued": an unresolvable meeting would mask the real
  // reason and the refusal would read as retryable forever.
  assert.equal(payload.queued, undefined);
  assert.equal(resolveCalls, 0, "gating precedes meeting resolution");
});

test("session-context errors still take precedence over the capability gate", async () => {
  const { loom_summon } = createVoteSummonTools({
    config: { getValue: () => ({ enabled: true, loom: { loom_summon: true } }) },
    resolveMeeting: async () => null,
    activeLooms: new Map(),
  });
  const res = await loom_summon.execute({ persona_name: "Risk Officer", issue: "x" }, {});
  assert.equal(JSON.parse(res.output).error, "loom_summon: session context unavailable");
});

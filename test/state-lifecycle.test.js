import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { StateManager } from "../src/services/state-manager.js";
import { RoundExecutor } from "../src/round-executor.js";
import { createStatePatchTool } from "../src/plugin/tools/state-patch.js";
import { createQueryEvidenceTools } from "../src/plugin/tools/query-evidence.js";
import { buildAgentSystemPrompt, buildAgentUserPrompt } from "../src/prompts/agent.js";
import { buildToolsMap } from "../src/round-executor/tools.js";
import { aggregateStateOfPlay, emptyAgentState } from "../src/state-patch.js";

function participant(id, status = "listening", sessionId = null) {
  return {
    config: {
      id,
      name: id,
      tier: "mid",
      persona: "Tests grounded reasoning.",
      agenda: "Verify state continuity.",
      known_biases: [],
      preferred_contribution_types: [],
      anti_patterns: [],
      model: { providerID: "test", modelID: "test-model" },
    },
    tier_config: {},
    status,
    session_id: sessionId,
    contributions_count: 0,
  };
}

function makeManager(participants) {
  return new StateManager({
    id: "meeting-1",
    participants,
    weave: [],
    rounds: [{ number: 1, contributions: [], token_path: [] }],
    current_round: 1,
    max_rounds: 3,
    next_contribution_id: 0,
    status: "weaving",
    state_of_play: "",
  });
}

function fakeDatabase(capture) {
  return {
    addContributionWithTurnRequest(_meetingId, contribution, _turnRequest, statePatch = null) {
      capture.contributions.push({ contribution, statePatch });
    },
    setParticipantStatus() {},
    addToolAudit() {},
    setParticipantReflection() {},
    recordAgentError() {},
    setPersistenceDegraded() {},
  };
}

test("an accepted primary state patch commits its full next state atomically", async () => {
  const target = participant("agent", "speaking", "agent-session");
  const manager = makeManager([target]);
  manager.beginTurn(target.config.id);

  const config = { getValue: (key) => key === "agentTools" ? { ...DEFAULT_CONFIG.agentTools, enabled: false } : undefined };
  const engine = {
    getStateManager: () => manager,
    getDatabase: () => fakeDatabase({ contributions: [] }),
    getRoundExecutor: () => ({ getEffectiveAgentTools: () => DEFAULT_CONFIG.agentTools }),
  };
  const stateTool = createStatePatchTool({
    config,
    resolveMeeting: async () => ({ meetingId: "meeting-1" }),
    activeLooms: new Map([["meeting-1", engine]]),
  }).loom_state_patch;

  const call = await stateTool.execute({
    stance: "Committed stance marker",
    established_add: ["Committed established marker [#1]"],
    contested_add: ["Committed contested marker"],
    open_add: ["Committed open marker"],
    facts_add: ["Committed grounded fact Source: https://example.test [#1]"],
    files_add: ["src/unique-agent.ts"],
  }, { sessionID: "agent-session" });
  assert.equal(call.metadata.applied, true);
  assert.equal(call.metadata.pending, true);

  manager.endTurn();
  const pending = manager.takeLastTurnPatch(target.config.id);
  assert.equal(pending.state.stance, "Committed stance marker");
  assert.equal(pending.state.version, 1);
  assert.equal(pending.next, undefined);

  const capture = { contributions: [] };
  const executor = Object.create(RoundExecutor.prototype);
  executor._stateManager = manager;
  executor._db = fakeDatabase(capture);
  executor._options = { onContribution() {} };
  executor._logger = { info() {}, warn() {}, error() {} };
  const round = manager.getState().rounds[0];
  executor._storeContribution(target, {
    participant_id: target.config.id,
    content: "Committed contribution",
    type: "contribution",
    request_next: null,
    tool_calls: [],
    prompt_context: { state_patch_outcome: "applied" },
  }, round, pending);

  assert.equal(capture.contributions.length, 1);
  assert.equal(capture.contributions[0].statePatch.state.stance, "Committed stance marker");
  assert.equal(manager.getParticipantState(target.config.id).stance, "Committed stance marker");
  assert.equal(target.state_stance, "Committed stance marker");
  assert.equal(target.state_version, 1);
  assert.equal(manager.getParticipantState(target.config.id).files[0], "src/unique-agent.ts");
});

test("committed unique state is used in the next primary prompt and collective State of Play", async () => {
  const state = {
    ...emptyAgentState(),
    stance: "Unique next-turn stance",
    established: ["Unique established item"],
    contested: ["Unique contested item"],
    open: ["Unique open item"],
    facts: ["Unique grounded fact Source: https://example.test [#7]"],
    files: ["src/unique-context.ts"],
    version: 4,
    updated_round: 1,
    updated_contribution_id: 9,
  };
  const agent = participant("creative", "listening");
  const manager = makeManager([agent]);
  manager.setParticipantState(agent.config.id, state);

  const agentTools = structuredClone(DEFAULT_CONFIG.agentTools);
  const systemPrompt = buildAgentSystemPrompt(agent, { activeCount: 2, agentTools });
  const toolsMap = buildToolsMap({ agentTools }, { activeCount: 2 });
  const userPrompt = buildAgentUserPrompt(agent, "", [], 2, "Question", [], "", [], [], state);

  assert.match(systemPrompt, /loom_state_patch/);
  assert.equal(toolsMap.loom_state_patch, true);
  assert.match(userPrompt, /## Your State — CARRIED FORWARD/);
  for (const marker of [
    "Unique next-turn stance",
    "Unique established item",
    "Unique contested item",
    "Unique open item",
    "Unique grounded fact",
    "src/unique-context.ts",
  ]) assert.match(userPrompt, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const stateOfPlay = aggregateStateOfPlay(manager.getAllParticipantStates(), "Question", []);
  for (const marker of [
    "Unique next-turn stance",
    "Unique established item",
    "Unique contested item",
    "Unique open item",
    "Unique grounded fact",
    "src/unique-context.ts",
  ]) assert.match(stateOfPlay, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a same-round peer query receives the target's complete committed state", async () => {
  const responder = participant("responder", "listening");
  const asker = participant("asker", "speaking", "asker-session");
  const manager = makeManager([responder, asker]);
  manager.setParticipantState(responder.config.id, {
    ...emptyAgentState(),
    stance: "Responder private stance",
    established: ["Responder established memory [#3]"],
    contested: ["Responder contested memory"],
    open: ["Responder open memory"],
    facts: ["Responder grounded memory Source: https://example.test [#3]"],
    files: ["src/responder-only.ts"],
    version: 2,
    updated_round: 1,
    updated_contribution_id: 8,
  });

  let capturedPrompt = "";
  const sessionManager = {
    async runEphemeralPrompt(_participant, request) {
      capturedPrompt = request.parts[0].text;
      return { ok: true, data: { parts: [{ type: "text", text: "A grounded answer." }] } };
    },
  };
  const engine = {
    getStateManager: () => manager,
    getSessionManager: () => sessionManager,
    getDatabase: () => fakeDatabase({ contributions: [] }),
    getParticipantModel: () => ({ providerID: "test", modelID: "test-model" }),
  };
  const queryTool = createQueryEvidenceTools({
    config: { getValue: (key) => key === "agentTools" ? DEFAULT_CONFIG.agentTools : undefined },
    resolveMeeting: async () => ({ meetingId: "meeting-1" }),
    activeLooms: new Map([["meeting-1", engine]]),
  }).loom_query;

  const result = await queryTool.execute({
    queries: [{ target: "responder", question: "What is your current position?", mode: "clarify" }],
  }, { sessionID: "asker-session" });
  const payload = JSON.parse(result.output);
  assert.equal(payload.error, undefined);
  assert.match(capturedPrompt, /## Your State — CARRIED FORWARD/);
  for (const marker of [
    "Responder private stance",
    "Responder established memory",
    "Responder contested memory",
    "Responder open memory",
    "Responder grounded memory",
    "src/responder-only.ts",
  ]) assert.match(capturedPrompt, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a fresh perspective state replaces an older stance in subsequent context", () => {
  const agent = participant("perspective-agent", "listening");
  const manager = makeManager([agent]);
  manager.setParticipantState(agent.config.id, {
    ...emptyAgentState(),
    stance: "Old stance",
    established: ["Retained established memory"],
    version: 1,
    updated_round: 1,
  });
  agent.reflection = "Fresh perspective stance";
  manager.markStateDirty(agent.config.id);

  const state = manager.getParticipantState(agent.config.id);
  assert.equal(state.stance, "Fresh perspective stance");
  assert.equal(state.established[0], "Retained established memory");
});

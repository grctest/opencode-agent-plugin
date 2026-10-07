import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { StateManager } from "../src/services/state-manager.js";
import { RoundExecutor } from "../src/round-executor.js";
import { getMeetingBreakdown, clearMeetingBreakdown } from "../src/metrics.js";

// Full-pipeline integration (T2): pipelined tails overlap the next primary,
// merge before persist, and join before the round ends — with stubbed LLM.

function participant(id) {
  return {
    config: {
      id, name: id, category: "mid",
      persona: "Tests grounded reasoning with enough characters to render.",
      agenda: "Verify tail pipelining end to end.",
      known_biases: [], preferred_contribution_types: [], anti_patterns: [],
      model: { providerID: "test", modelID: "test-model" },
    },
    status: "listening", session_id: null, contributions_count: 0,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("pipelined tails overlap next primaries and join before round end", async () => {
  const manager = new StateManager({
    id: "meeting-pipe", participants: [participant("a"), participant("b")],
    weave: [], rounds: [{ number: 1, contributions: [], token_path: [] }],
    current_round: 1, max_rounds: 10, next_contribution_id: 0,
    status: "weaving", state_of_play: "",
  });
  const capture = { contributions: [] };
  const events = [];
  let sessionSeq = 0;
  const contract = {
    prompt: async ({ sessionId, tools, parts }) => {
      const isTail = tools && tools.loom_state_patch === true && Object.keys(tools).length === 1;
      const text = String(parts?.[0]?.text ?? "");
      if (isTail) {
        events.push({ kind: "tail-start", at: Date.now() });
        await sleep(20);
        events.push({ kind: "tail-end", at: Date.now() });
        return { ok: true, data: { parts: [{ type: "text", text: "Tail done, nothing new." }] } };
      }
      const who = text.includes("Seat A") || text.includes("**A**") ? "a" : "b";
      events.push({ kind: `primary-start-${who}`, at: Date.now() });
      await sleep(80);
      events.push({ kind: `primary-end-${who}`, at: Date.now() });
      return { ok: true, data: { parts: [{ type: "text", text: `Prose from ${who} with numbers 12% and 4ms recorded here for grounding.` }] } };
    },
  };
  const sessionManager = {
    getContract: () => contract,
    registerSessionMeeting() {},
    deleteEphemeralSession: async () => {},
    postProgress: async () => {},
    recordCall() {},
  };
  const db = {
    setParticipantStatus() {},
    addContributionWithStatePatch(_m, c) { capture.contributions.push(c); events.push({ kind: "persist", at: Date.now() }); },
    recordAgentError() {},
    listForumTopicsForPrompt: () => [],
  };
  const executor = Object.create(RoundExecutor.prototype);
  executor._stateManager = manager;
  executor._db = db;
  executor._sessionManager = sessionManager;
  executor._options = {
    createEphemeralSession: async () => `sess-${++sessionSeq}`,
    deleteEphemeralSession: async () => {},
    onProgress() {}, onContribution() {}, onPromptActivity() {},
    agentTools: structuredClone(DEFAULT_CONFIG.agentTools),
  };
  executor._logger = { info() {}, warn() {}, error() {}, debug() {} };
  executor._callStats = { agent_prompts: 0 };
  executor._abortControllers = new Set();
  executor._pendingTails = [];
  executor._availableModels = [];
  executor._circuitBreaker = { isHealthy: () => true, recordSuccess() {}, recordFailure() {} };
  executor._getParticipantModel = () => ({ providerID: "test", modelID: "test-model" });
  executor.getEffectiveAgentTools = () => structuredClone(DEFAULT_CONFIG.agentTools);

  const round = manager.getState().rounds[0];
  const active = manager.getParticipants();
  await executor.runPromptPhase(round, active);

  // Both turns committed with prose, both persisted (join happened).
  assert.equal(manager.getWeave().length, 2);
  assert.equal(capture.contributions.length, 2);
  for (const c of manager.getWeave()) {
    assert.match(c.content, /Prose from [ab] with numbers/);
    assert.equal(c.prompt_context.state_patch_outcome, "unverified");
  }
  // Overlap: first tail started before the second primary finished.
  const tailStart = events.find((e) => e.kind === "tail-start").at;
  const primaryEnds = events.filter((e) => e.kind.startsWith("primary-end")).map((e) => e.at);
  assert.ok(primaryEnds.length === 2, "both primaries ran");
  assert.ok(tailStart < Math.max(...primaryEnds), "a tail overlapped a primary");
  // Persist lands after its tail (DB rows carry merged outcomes).
  assert.equal(capture.contributions.length, 2);
  // Per-meeting attribution observed both phases.
  const breakdown = getMeetingBreakdown("meeting-pipe");
  assert.equal(breakdown.calls.agent, 2);
  assert.equal(breakdown.calls.patch_tail, 2);
  assert.equal(breakdown.latencies.llm_prompt_ms.count, 2);
  assert.equal(breakdown.latencies.llm_patch_tail_ms.count, 2);
  clearMeetingBreakdown("meeting-pipe");
});

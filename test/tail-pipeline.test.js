import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { StateManager } from "../src/services/state-manager.js";
import { RoundExecutor } from "../src/round-executor.js";
import { createStatePatchTool } from "../src/plugin/tools/state-patch.js";
import {
  runPatchTailPhase,
  computePatchOutcome,
  TAIL_DEFERRED,
} from "../src/round-executor/agent-turn.js";
import { mapToolResults } from "../src/shared.js";
import { emptyAgentState } from "../src/state-patch.js";

// Pipelined patch tails (T2): tails overlap the next turn and merge before
// persist. Every test below pins output equivalence with the sequential path.

function participant(id, status = "listening", sessionId = null) {
  return {
    config: {
      id,
      name: id,
      category: "mid",
      persona: "Tests grounded reasoning.",
      agenda: "Verify tail pipelining.",
      known_biases: [],
      preferred_contribution_types: [],
      anti_patterns: [],
      model: { providerID: "test", modelID: "test-model" },
    },
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
    addContributionWithStatePatch(_meetingId, contribution, statePatch = null) {
      capture.contributions.push({ contribution: structuredClone(contribution), statePatch: structuredClone(statePatch) });
    },
    addStatePatch(row) { capture.statePatches.push(structuredClone(row)); },
    setParticipantState() {},
    setParticipantStatus() {},
    addToolAudit() {},
    setParticipantReflection() {},
    recordAgentError() {},
    setPersistenceDegraded() {},
  };
}

function makeExecutor(manager, capture) {
  const executor = Object.create(RoundExecutor.prototype);
  executor._stateManager = manager;
  executor._db = fakeDatabase(capture);
  executor._options = { onContribution() {}, onProgress() {} };
  executor._logger = { info() {}, warn() {}, error() {}, debug() {} };
  executor._callStats = { agent_prompts: 0 };
  executor._abortControllers = new Set();
  executor._pendingTails = [];
  return executor;
}

const PHASE1_TOOL_CALLS = [
  { tool: "websearch", callID: "c1", status: "completed", output: "Finding one", input: { q: "x" }, metadata: {} },
];

const TAIL_TOOL_CALLS = [
  { tool: "loom_state_patch", callID: "t1", status: "completed", output: JSON.stringify({ applied: true, version: 2 }), input: { stance: "s" }, metadata: { applied: true, version: 2 } },
];

function tailSlotPatch() {
  return {
    participantId: "agent",
    state: { ...emptyAgentState(), stance: "Pipelined stance", version: 2 },
    input: { stance: "Pipelined stance" },
    output: { applied: true, version: 2 },
  };
}

// --- tail-slot channel ----------------------------------------------------

test("tail-slot channel is isolated from the singleton turn slot", () => {
  const manager = makeManager([participant("agent")]);
  assert.equal(manager.isTailTurn("agent"), false);
  manager.beginTailTurn("agent");
  assert.equal(manager.isTailTurn("agent"), true);
  assert.equal(manager.queueTailPatch("agent", tailSlotPatch()), true);
  assert.equal(manager.queueTailPatch("agent", tailSlotPatch()), false);
  assert.equal(manager.queueTailPatch("agent", tailSlotPatch(), { force: true }), true);
  // Singleton slot untouched by tail traffic.
  assert.equal(manager.takeLastTurnPatch("agent"), null);
  const taken = manager.takeTailPatch("agent");
  assert.equal(taken.state.stance, "Pipelined stance");
  assert.equal(manager.takeTailPatch("agent"), null);
  manager.endTailTurn("agent");
  assert.equal(manager.isTailTurn("agent"), false);
  manager.discardTailPatch("agent");
});

test("patch tool routes to the tail slot while the next turn owns the singleton", async () => {
  const a = participant("agent", "speaking", "a-session");
  const b = participant("other", "speaking", "b-session");
  const manager = makeManager([a, b]);
  manager.beginTurn(b.config.id);
  manager.beginTailTurn(a.config.id);

  const config = { getValue: (key) => key === "agentTools" ? DEFAULT_CONFIG.agentTools : undefined };
  const engine = {
    getStateManager: () => manager,
    getDatabase: () => fakeDatabase({ contributions: [], statePatches: [] }),
    getRoundExecutor: () => ({ getEffectiveAgentTools: () => DEFAULT_CONFIG.agentTools }),
  };
  const stateTool = createStatePatchTool({
    config,
    resolveMeeting: async () => ({ meetingId: "meeting-1" }),
    activeLooms: new Map([["meeting-1", engine]]),
  }).loom_state_patch;

  const call = await stateTool.execute({ stance: "Tail stance while B speaks" }, { sessionID: "a-session" });
  assert.equal(call.metadata.applied, true);
  // Landed in the tail slot — never in the singleton, never applied early.
  const tail = manager.takeTailPatch(a.config.id);
  assert.equal(tail.state.stance, "Tail stance while B speaks");
  assert.equal(manager.takeLastTurnPatch(a.config.id), null);
  assert.equal(manager.getParticipantState(a.config.id).stance, "");
  manager.endTailTurn(a.config.id);
});

test("patch tool still refuses strangers with no turn at all", async () => {
  const c = participant("stranger", "listening", "c-session");
  const manager = makeManager([c]);
  const config = { getValue: (key) => key === "agentTools" ? DEFAULT_CONFIG.agentTools : undefined };
  const engine = {
    getStateManager: () => manager,
    getDatabase: () => fakeDatabase({ contributions: [], statePatches: [] }),
    getRoundExecutor: () => ({ getEffectiveAgentTools: () => DEFAULT_CONFIG.agentTools }),
  };
  const stateTool = createStatePatchTool({
    config,
    resolveMeeting: async () => ({ meetingId: "meeting-1" }),
    activeLooms: new Map([["meeting-1", engine]]),
  }).loom_state_patch;
  const call = await stateTool.execute({ stance: "No turn, no patch" }, { sessionID: "c-session" });
  assert.match(JSON.parse(call.output).error, /active primary turn/);
});

// --- outcome helper -------------------------------------------------------

test("computePatchOutcome covers every branch identically for both paths", () => {
  const base = { patchEnabled: true, statePatchVersion: null, loomPassCall: null, tailRejected: false, tailAttempted: false, tailDetail: null, finalToolResults: [] };
  assert.equal(computePatchOutcome({ ...base, patchEnabled: false }).outcome, "disabled");
  assert.equal(computePatchOutcome({ ...base, statePatchVersion: 3 }).outcome, "applied");
  assert.equal(computePatchOutcome({ ...base, loomPassCall: {} }).outcome, "exempt_pass");
  assert.equal(computePatchOutcome({ ...base, tailRejected: true }).outcome, "rejected");
  assert.equal(computePatchOutcome({ ...base, tailAttempted: true }).outcome, "unverified");
  assert.equal(computePatchOutcome(base).outcome, "never_attempted");
  const bad = [{ tool: "loom_state_patch", status: "error", output: "bad-shape", error: null, metadata: {} }];
  const rejected = computePatchOutcome({ ...base, tailRejected: true, tailDetail: null, finalToolResults: bad });
  assert.equal(rejected.outcome, "rejected");
  assert.equal(rejected.detail, "bad-shape");
});

// --- pipeline equivalence -------------------------------------------------

function phase1Result() {
  return {
    participant_id: "agent",
    content: "Pipelined prose with numbers 12% and 4ms.",
    type: "contribution",
    // As executeAgentTurn's finalize produces them: mapped.
    tool_calls: mapToolResults(structuredClone(PHASE1_TOOL_CALLS)),
    prompt_context: {},
  };
}

function tailOutcome() {
  return {
    finalToolResults: [...structuredClone(PHASE1_TOOL_CALLS), ...structuredClone(TAIL_TOOL_CALLS)],
    tailCalls: structuredClone(TAIL_TOOL_CALLS),
    statePatchVersion: 2,
    tailAttempted: true,
    tailRejected: false,
    tailDetail: null,
  };
}

test("pipelined merge plus persist equals the sequential commit", () => {
  // Sequential reference: everything the old inline path produces.
  const seqCapture = { contributions: [], statePatches: [] };
  const seqManager = makeManager([participant("agent", "speaking", "agent-session")]);
  const seqExecutor = makeExecutor(seqManager, seqCapture);
  const seqRound = seqManager.getState().rounds[0];
  seqManager.beginTurn("agent");
  seqManager.queueTurnPatch("agent", tailSlotPatch());
  seqManager.endTurn();
  const seqPending = seqManager.takeLastTurnPatch("agent");
  const seqResult = {
    ...phase1Result(),
    // As executeAgentTurn's finalize produces them: mapped, tail merged.
    tool_calls: mapToolResults([...structuredClone(PHASE1_TOOL_CALLS), ...structuredClone(TAIL_TOOL_CALLS)]),
    prompt_context: { state_patch_outcome: "applied" },
    state_patch: { version: 2 },
  };
  seqExecutor._storeContribution(seqManager.getParticipant("agent"), seqResult, seqRound, seqPending);

  // Pipelined: stage prose, merge tail, persist with the tail slot as the
  // atomic patch (exact sequential shape).
  const pipeCapture = { contributions: [], statePatches: [] };
  const pipeManager = makeManager([participant("agent", "speaking", "agent-session")]);
  const pipeExecutor = makeExecutor(pipeManager, pipeCapture);
  const pipeRound = pipeManager.getState().rounds[0];
  const p = pipeManager.getParticipant("agent");
  const pipeResult = phase1Result();
  const { contribution } = pipeExecutor._stageContribution(p, pipeResult, pipeRound, null);
  // Prose visible immediately, tail fields absent.
  assert.equal(pipeManager.getWeave().length, 1);
  assert.equal(pipeManager.getWeave()[0].content, "Pipelined prose with numbers 12% and 4ms.");
  assert.equal(pipeManager.getWeave()[0].prompt_context.state_patch_outcome, undefined);
  pipeManager.beginTailTurn("agent");
  pipeManager.queueTailPatch("agent", tailSlotPatch(), { force: true });
  pipeManager.endTailTurn("agent");
  pipeExecutor._mergeTailIntoContribution(p, contribution, pipeResult, tailOutcome());
  const atomic = pipeExecutor._takeTailAtomic("agent", contribution);
  assert.equal(atomic.version, 2);
  assert.equal(atomic.state.updated_contribution_id, contribution.id);
  pipeExecutor._persistStagedContribution(p, contribution, pipeRound, pipeResult, atomic);

  // Same weave content, same outcome, same state, same durable rows
  // (batch_id/created_at are per-commit randomness/clock — normalized).
  const norm = (v) => JSON.parse(JSON.stringify(v, (k, x) =>
    k === "batch_id" || k === "created_at" ? "<dynamic>" : x));
  assert.deepEqual(norm(pipeManager.getWeave()), norm(seqManager.getWeave()));
  assert.equal(pipeResult.prompt_context.state_patch_outcome, "applied");
  assert.equal(pipeResult.state_patch.version, 2);
  assert.deepEqual(
    pipeManager.getParticipantState("agent"),
    seqManager.getParticipantState("agent"),
  );
  assert.equal(pipeCapture.contributions.length, 1);
  assert.equal(seqCapture.contributions.length, 1);
  assert.deepEqual(norm(pipeCapture.contributions[0]), norm(seqCapture.contributions[0]));
  assert.equal(pipeCapture.statePatches.length, seqCapture.statePatches.length);
  assert.equal(pipeCapture.statePatches.length, 0, "atomic commit writes no separate audit row on either path");
  assert.equal(
    pipeCapture.contributions[0].statePatch.state.updated_contribution_id,
    pipeCapture.contributions[0].contribution.id,
  );
});

test("persist failure rolls back by id even when later turns staged since", () => {
  const capture = { contributions: [], statePatches: [] };
  const manager = makeManager([participant("a"), participant("b")]);
  const executor = makeExecutor(manager, capture);
  const round = manager.getState().rounds[0];
  executor._db.addContributionWithStatePatch = () => { throw new Error("disk gone"); };
  const ra = phase1Result();
  ra.participant_id = "a";
  const { contribution: ca } = executor._stageContribution(manager.getParticipant("a"), ra, round, null);
  const rb = phase1Result();
  rb.participant_id = "b";
  executor._stageContribution(manager.getParticipant("b"), rb, round, null);
  assert.equal(manager.getWeave().length, 2);
  executor._persistStagedContribution(manager.getParticipant("a"), ca, round, ra, null);
  const ids = manager.getWeave().map((c) => c.participant_id);
  assert.deepEqual(ids, ["b"]);
  assert.equal(round.contributions.length, 1);
});

// --- runner plumbing ------------------------------------------------------

test("runPatchTailPhase sends a patch-only prompt and records telemetry", async () => {
  const seen = {};
  const host = {
    stateManager: { getMeetingId: () => "m-tail", getParticipantState: () => null, beginTailTurn() { seen.began = true; }, endTailTurn() { seen.ended = true; } },
    sessionManager: {
      getContract: () => ({
        prompt: async (opts) => {
          seen.tools = opts.tools;
          seen.parts = opts.parts.length;
          return { ok: true, data: { parts: [{ type: "text", text: "ok" }] } };
        },
      }),
    },
    logger: { info() {}, warn: (...a) => { seen.warned = a[0]; }, error() {}, debug() {} },
    options: {},
    callStats: { agent_prompts: 0 },
    notifyCallStats: () => {},
  };
  const participant = { config: { id: "agent", name: "Agent", category: "mid" } };
  const out = await runPatchTailPhase(host, {
    participant, model: { providerID: "t", modelID: "m" }, timeoutMs: 60000, currentRound: 1,
    finalText: "Some prose.", finalToolResults: [], agentToolsConfig: DEFAULT_CONFIG.agentTools,
    ephemeralSessionId: "sess", abortSignal: null,
  }, { useTailSlot: true });
  assert.deepEqual(out.finalToolResults, []);
  assert.equal(out.tailAttempted, true);
  assert.equal(out.tailRejected, false);
  assert.equal(out.statePatchVersion, null);
  assert.deepEqual(seen.tools, { loom_state_patch: true });
  assert.equal(seen.parts, 1);
  assert.equal(seen.began, true);
  assert.equal(seen.ended, true);
});

// --- handle routing + join ------------------------------------------------

test("_handlePipelinedResult stages immediately and tracks the tail", async () => {
  const capture = { contributions: [], statePatches: [] };
  const manager = makeManager([participant("agent", "speaking", "agent-session")]);
  const executor = makeExecutor(manager, capture);
  const round = manager.getState().rounds[0];
  const p = manager.getParticipant("agent");
  let ran = false;
  executor._runDeferredTail = async () => { ran = true; };
  const result = { ...phase1Result(), [TAIL_DEFERRED]: { ephemeralSessionId: "sess", deleteSession: false } };
  executor._handlePromptResult(p, result, round, null);
  assert.equal(manager.getWeave().length, 1);
  assert.equal(capture.contributions.length, 0);
  assert.equal(executor._pendingTails.length, 1);
  await executor._settlePendingTails();
  assert.equal(ran, true);
  assert.equal(executor._pendingTails.length, 0);
});

test("_handlePipelinedResult without a tail context persists immediately", () => {
  const capture = { contributions: [], statePatches: [] };
  const manager = makeManager([participant("agent", "speaking", "agent-session")]);
  const executor = makeExecutor(manager, capture);
  const round = manager.getState().rounds[0];
  const p = manager.getParticipant("agent");
  executor._handlePromptResult(p, phase1Result(), round, null);
  assert.equal(manager.getWeave().length, 1);
  assert.equal(capture.contributions.length, 1);
  assert.equal(executor._pendingTails.length, 0);
});

test("_settlePendingTails tolerates rejections", async () => {
  const manager = makeManager([participant("agent")]);
  const executor = makeExecutor(manager, { contributions: [], statePatches: [] });
  executor._pendingTails = [Promise.reject(new Error("boom")), Promise.resolve(1)];
  await executor._settlePendingTails();
  assert.equal(executor._pendingTails.length, 0);
});

import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { StateManager } from "../src/services/state-manager.js";
import { RoundExecutor } from "../src/round-executor.js";
import { RoundService } from "../src/services/round-service.js";
import { MeetingOrchestrator } from "../src/orchestrator.js";
import { runMeeting } from "../src/orchestrator/weaving.js";
import { _promptOrchestrator } from "../src/orchestrator/models.js";
import { isAbortError } from "../src/utils/retry.js";

// "Cancel run" must HALT the meeting, not just the turn that was in flight.
//
// The bug this file pins down: the orchestrator aborted the controllers that
// existed at that instant, the turn's retry loop started a FRESH turn with a
// fresh (un-aborted) controller, and the round walked on to the next speaker.
// The user saw "Cancel run" and then the next agent taking its turn.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function participant(id) {
  return {
    config: {
      id, name: id, category: "mid",
      persona: "Tests grounded reasoning with enough characters to render.",
      agenda: "Verify the cancel halts the meeting end to end.",
      known_biases: [], preferred_contribution_types: [], anti_patterns: [],
      model: { providerID: "test", modelID: "test-model" },
    },
    status: "listening", session_id: null, contributions_count: 0,
  };
}

/**
 * A RoundExecutor wired to a stub contract whose prompts hang until aborted
 * (or a timeout), so a cancel can land mid-turn.
 */
function makeExecutor({ participantIds = ["a", "b"] } = {}) {
  const manager = new StateManager({
    id: "meeting-cancel",
    participants: participantIds.map(participant),
    weave: [], rounds: [{ number: 1, contributions: [], token_path: [] }],
    current_round: 1, max_rounds: 10, next_contribution_id: 0,
    status: "weaving", state_of_play: "",
  });

  const state = { prompts: 0, aborted: 0, agentErrors: [], statuses: {} };
  const contract = {
    prompt: async ({ signal }) => {
      state.prompts++;
      const n = state.prompts;
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 5000);
        if (signal) {
          if (signal.aborted) { clearTimeout(t); reject(new DOMException("Aborted", "AbortError")); return; }
          signal.addEventListener("abort", () => {
            state.aborted++;
            clearTimeout(t);
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        }
      });
      return { ok: true, data: { parts: [{ type: "text", text: `Prose from turn ${n}.` }] } };
    },
  };

  const sessionManager = {
    getContract: () => contract,
    registerSessionMeeting() {}, unregisterSession() {},
    deleteEphemeralSession: async () => {}, postProgress: async () => {}, recordCall() {},
  };
  const db = {
    setParticipantStatus(id, s) { state.statuses[id] = s; },
    addContributionWithStatePatch() {},
    recordAgentError(...args) { state.agentErrors.push(args); },
    listForumTopicsForPrompt: () => [],
  };

  const executor = Object.create(RoundExecutor.prototype);
  Object.assign(executor, {
    _stateManager: manager, _db: db, _sessionManager: sessionManager,
    _options: {
      createEphemeralSession: async () => `sess-${Math.random()}`,
      deleteEphemeralSession: async () => {},
      onProgress() {}, onContribution() {}, onPromptActivity() {},
      agentTools: structuredClone(DEFAULT_CONFIG.agentTools),
    },
    _logger: { info() {}, warn() {}, error() {}, debug() {} },
    _callStats: { agent_prompts: 0 },
    _abortControllers: new Set(),
    _pendingTails: [], _availableModels: [],
    _failureCounts: new Map(), _modelFailureTimes: new Map(),
    _roundSessionIds: new Map(), _tools: null,
  });
  executor._circuitBreaker = { isHealthy: () => true, recordFailure: () => ({ failures: 1 }), recordSuccess: () => {}, clear() {} };
  executor._getParticipantModel = () => ({ providerID: "test", modelID: "test-model" });

  const round = { number: 1, contributions: [], token_path: [] };
  return { executor, manager, round, state };
}

test("a cancel aborts the in-flight turn AND stops the round — no further agent is called", async () => {
  const { executor, round, state } = makeExecutor();
  const running = executor.runPromptPhase(round, executor._stateManager.getParticipants());

  await sleep(150);
  // Exactly what MeetingOrchestrator.cancel() does to the executor.
  executor._abortInflight();

  await Promise.race([running, sleep(4000)]);

  assert.equal(state.aborted, 1, "the in-flight turn was aborted");
  assert.equal(state.prompts, 1, "the next agent was NEVER called — the round stopped");
  assert.equal(state.agentErrors.length, 0, "an aborted turn is not recorded as an agent error");
  assert.equal(state.statuses.a, "listening", "the aborted seat is left open, not failed");
});

test("a turn that starts after the cancel is aborted on arrival", async () => {
  const { executor, round, state } = makeExecutor();
  const controller = new AbortController();
  executor.setHaltSignal(controller.signal);
  controller.abort();          // the meeting was stopped

  const running = executor.runPromptPhase(round, executor._stateManager.getParticipants());
  await Promise.race([running, sleep(2000)]);

  assert.equal(state.prompts, 0, "no prompt was issued after the halt");
});

test("the halt is sticky: _abortInflight() stops later turns too", async () => {
  const { executor, state } = makeExecutor();
  assert.equal(executor.isHalted(), false);
  executor._abortInflight();
  assert.equal(executor.isHalted(), true, "the abort is sticky, not one-shot");
  assert.equal(state.prompts, 0);
});

test("an aborted turn is not a failed participant", async () => {
  const { executor, round, state } = makeExecutor();
  const running = executor.runPromptPhase(round, executor._stateManager.getParticipants());
  await sleep(150);
  executor._abortInflight();
  await Promise.race([running, sleep(4000)]);

  const seat = executor._stateManager.getParticipants().find((p) => p.config.id === "a");
  assert.notEqual(seat.status, "failed", "a cancelled turn must not mark the seat failed");
  assert.equal(state.agentErrors.length, 0);
});

test("isAbortError classifies the abort shapes the turn path sees", () => {
  const abort = new DOMException("Aborted", "AbortError");
  assert.equal(isAbortError(abort), true);
  assert.equal(isAbortError({ name: "Error", message: "The operation was aborted" }), true);
  assert.equal(isAbortError({ name: "Error", message: "provider exploded" }), false);
  assert.equal(isAbortError(null), false);
});

test("the orchestrator's cancel writes the terminal status at once", () => {
  const engine = new MeetingOrchestrator({
    client: null, directory: "/tmp", meetingId: "m-cancel-1",
    question: "q", context: "c", parentSessionId: "p",
    participants: [{ id: "a", name: "A", persona: "p".padEnd(60, "x"), agenda: "a" }],
    maxRounds: 3,
  });
  assert.equal(engine.getState().status, "initializing");

  engine.cancel();

  assert.equal(engine.isHalted(), true, "the run is halted");
  assert.equal(engine.getHaltSignal().aborted, true, "the halt signal is aborted");
  assert.equal(engine.getState().status, "cancelled", "the status is written now, not at the next round boundary");
});

test("a soft cancel (process exit) leaves the meeting resumable", () => {
  const engine = new MeetingOrchestrator({
    client: null, directory: "/tmp", meetingId: "m-cancel-2",
    question: "q", context: "c", parentSessionId: "p",
    participants: [{ id: "a", name: "A", persona: "p".padEnd(60, "x"), agenda: "a" }],
    maxRounds: 3,
  });
  engine.softCancel();
  assert.equal(engine.getState().status, "initializing", "a killed process must not look like a deliberate stop");
  assert.equal(engine.isHalted(), true, "the in-flight turn is still aborted");
});

test("resetHalt gives the meeting a fresh, unaborted signal", () => {
  const engine = new MeetingOrchestrator({
    client: null, directory: "/tmp", meetingId: "m-cancel-3",
    question: "q", context: "c", parentSessionId: "p",
    participants: [{ id: "a", name: "A", persona: "p".padEnd(60, "x"), agenda: "a" }],
    maxRounds: 3,
  });
  engine.cancel();
  assert.equal(engine.getHaltSignal().aborted, true);
  engine.resetHalt();
  assert.equal(engine.getHaltSignal().aborted, false, "an extension re-opens the meeting");
  assert.equal(engine.isHalted(), false);
});

test("cancelling an already-terminal meeting keeps the status without an invalid transition", () => {  const engine = new MeetingOrchestrator({
    client: null, directory: "/tmp", meetingId: "m-cancel-4",
    question: "q", context: "c", parentSessionId: "p",
    participants: [{ id: "a", name: "A", persona: "p".padEnd(60, "x"), agenda: "a" }],
    maxRounds: 3,
  });
  let invalidTransitions = 0;
  const originalTransition = engine._stateManager.transitionTo.bind(engine._stateManager);
  engine._stateManager.transitionTo = (status) => {
    try {
      originalTransition(status);
    } catch (err) {
      if (String(err.message).includes("Invalid status transition")) invalidTransitions++;
      throw err;
    }
  };
  // The meeting reached its natural end (final round summary done) and the
  // run is still winding down (synthesis / post-synthesis passes): the Cancel
  // button is legitimately still active there, and cancelling must abort the
  // in-flight calls WITHOUT trying to transition an absorbing status.
  engine._stateManager.transitionTo("weaving");
  engine._stateManager.transitionTo("max_rounds_reached");
  engine.cancel();
  assert.equal(invalidTransitions, 0, "a terminal meeting is cancelled without an invalid transition attempt");
  assert.equal(engine.getState().status, "max_rounds_reached", "the natural status is kept — it already says the same thing as 'cancelled'");
  assert.equal(engine.isHalted(), true, "the halt still applies: the synthesis call is aborted");
});

/**
 * The meeting-level contract: a cancelled run does NOT synthesize, and the
 * STALL path (which is not a user cancellation) still does.
 */
function makeMeetingCtx({ halted, stallCancelled }) {
  const calls = { synthesized: 0, transitions: [], rounds: 0 };
  const ctx = {
    _cancelled: stallCancelled ? true : (halted ? true : false),
    _halted: !!halted,
    isHalted: () => !!halted,
    _stateManager: {
      getStatus: () => "weaving",
      getParticipants: () => [],
      transitionTo: (s) => calls.transitions.push(s),
    },
    _stallWatchdog: { stallCancelled: !!stallCancelled, start() {}, stop() {}, touch() {} },
    _sessionManager: { postProgress: async () => {} },
    _logger: { info() {}, warn() {}, error() {}, debug() {} },
    _runWeavingLoop: async function () { calls.rounds++; },
    _synthesize: async function () { calls.synthesized++; return "artifact"; },
    _initialize: async () => {},
    initialize: async function () { await ctx._initialize(); },
  };
  return { ctx, calls };
}

test("a cancelled run does not synthesize", async () => {
  const { ctx, calls } = makeMeetingCtx({ halted: true, stallCancelled: false });
  const out = await runMeeting.call(ctx);
  assert.equal(calls.synthesized, 0, "no synthesis prompt after a cancellation");
  assert.equal(out, null);
});

test("the stall path is unchanged — it still finishes the round and synthesizes", async () => {
  const { ctx, calls } = makeMeetingCtx({ halted: false, stallCancelled: true });
  const out = await runMeeting.call(ctx);
  assert.equal(calls.synthesized, 1, "a stall still produces the output from what was collected");
  assert.equal(out, "artifact");
});

/**
 * A halted round is deliberately left OPEN: no round-summary row is written,
 * which is exactly what lets the resume continue the interrupted round (the
 * resume re-drives the seats that never spoke). The State of Play is still
 * refreshed, so the record is never stale.
 */
function makeEngineWithFakeDb() {
  const engine = new MeetingOrchestrator({
    client: null, directory: "/tmp", meetingId: "m-finalize-1",
    question: "q", context: "c", parentSessionId: "p",
    participants: [{ id: "a", name: "A", persona: "p".padEnd(60, "x"), agenda: "a" }],
    maxRounds: 3,
  });
  const writes = { summary: 0, stateOfPlay: 0, persisted: 0 };
  engine._database = {
    transaction: async (fn) => { fn(); },
    setRoundSummary: () => { writes.summary++; },
    setStateOfPlay: () => { writes.stateOfPlay++; },
    setSettledItemsRaw: () => {},
    setParticipantStatus: () => {},
  };
  engine._persistenceService = { persistState: async () => { writes.persisted++; } };
  engine._sessionManager = { postProgress: async () => {} };
  return { engine, writes };
}

test("a halted round is not finalized — it stays open so Resume can continue it", async () => {
  const { engine, writes } = makeEngineWithFakeDb();
  engine._stateManager.transitionTo("cancelled");   // as cancel() does
  engine._halted = true;

  const round = { number: 1, contributions: [{ id: 1, participant_id: "a", type: "contribution", content: "x" }], token_path: ["a"], summary: "" };
  const out = await engine._finalizeRound(round);

  assert.equal(out, false, "the round does not continue");
  assert.equal(writes.summary, 0, "NO round summary — the round stays open for the resume");
  assert.equal(writes.stateOfPlay, 1, "the State of Play is still refreshed");
  assert.equal(engine.getState().status, "cancelled", "the cancelled status is untouched");
  assert.equal(writes.persisted, 1, "the state is persisted");
});

test("a normal round is still finalized (the halt did not disable finalization)", async () => {
  const { engine, writes } = makeEngineWithFakeDb();
  engine._stateManager.transitionTo("weaving");

  const round = { number: 1, contributions: [{ id: 1, participant_id: "a", type: "contribution", content: "x" }], token_path: ["a"], summary: "the summary" };
  const out = await engine._finalizeRound(round);

  assert.equal(out, true, "a normal round continues");
  assert.equal(writes.summary, 1, "the round summary is written");
});

test("through the real round service, a cancel stops the round and skips the clerk", async () => {  const { executor, manager, round, state } = makeExecutor({ participantIds: ["a", "b", "c"] });
  const service = new RoundService({ roundExecutor: executor, stateManager: manager, db: null });

  let clerkCalls = 0;
  const running = service.runRound({
    round,
    activeParticipants: manager.getParticipants(),
    promptOrchestrator: async () => { clerkCalls++; return {}; },
    getDefaultModel: () => ({}),
    getFallbackModel: () => ({}),
    state: manager.getState(),
  });

  await sleep(150);
  executor._abortInflight();
  await Promise.race([running, sleep(4000)]);

  assert.equal(state.prompts, 1, "only the first agent was called — the round stopped at the cancel");
  assert.equal(clerkCalls, 0, "the clerk (an LLM call) never ran");
  assert.equal(state.agentErrors.length, 0);
  const seats = Object.fromEntries(manager.getParticipants().map((p) => [p.config.id, p.status]));
  assert.equal(seats.a, "listening", "the seat that was interrupted stays open, not failed");
  assert.equal(seats.b, "listening", "the seat that was never called stays open");
  assert.equal(seats.c, "listening", "the seat that was never called stays open");
});

test("the round clerk prompt rides with the meeting's halt signal", async () => {
  const controller = new AbortController();
  const seen = [];
  const fakeCtx = {
    _options: {},
    _callStats: {},
    _scheduleStatsFlush() {},
    _orchestratorMessages: [],
    _database: null,
    _meetingId: "m-clerk",
    getHaltSignal: () => controller.signal,
    _sessionManager: {
      promptOrchestrator: async (_system, _model, _message, _timeoutMs, opts) => {
        seen.push(opts);
        return { text: "ok" };
      },
    },
    _logger: { warn() {}, info() {} },
  };
  await _promptOrchestrator.call(fakeCtx, "system", {}, "message", "summary", 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].signal, controller.signal, "the round summary (clerk) prompt carries the halt signal");
});

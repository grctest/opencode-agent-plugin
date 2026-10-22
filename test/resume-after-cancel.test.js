import test from "node:test";
import assert from "node:assert/strict";

import { StateManager } from "../src/services/state-manager.js";
import { restoreStateFromDb } from "../src/meeting-restorer.js";
import { _continueInterruptedRound } from "../src/orchestrator/round.js";
import { canResumeStatus, RESUMABLE_STATUSES } from "../src/constants.js";
import { RoundExecutor } from "../src/round-executor.js";

// "Cancel run" stops the meeting; "Resume" continues it from where it left
// off. These tests pin the two halves of that contract.
//
// The resume path had two latent bugs that made the button a dead end:
//   1. a restored round carried no `token_path`, so the round executor threw
//      "Cannot read properties of undefined (reading 'push')" on the first
//      turn of the resumed round;
//   2. a peer answer (loom_query/loom_vote/...) was counted as a spoken turn,
//      so the peer who had only ANSWERED a question was skipped on resume.

function makeStateManager(overrides = {}) {
  return new StateManager({
    id: "m-resume",
    participants: [
      { config: { id: "a", name: "a" }, status: "listening", session_id: null, contributions_count: 0 },
      { config: { id: "b", name: "b" }, status: "listening", session_id: null, contributions_count: 0 },
    ],
    weave: [], rounds: [], current_round: 0, max_rounds: 4, next_contribution_id: 0,
    status: "initializing", state_of_play: "",
    ...overrides,
  });
}

function makeDb({ status = "cancelled", round = 2, contributions = [] } = {}) {
  return {
    getMeeting: () => ({
      id: "m-resume", status, round, question: "q", context: "c", fabric: "f",
      max_rounds: 4, tags: "[]", next_speaker_id: "b", stats: "{}",
      state_of_play: "", settled_items: "[]",
    }),
    getAllParticipantsWithStatus: () => ([
      { id: "a", name: "a", persona: "p", agenda: "g", category: "mid", status: "listening", contributions_count: 0 },
      { id: "b", name: "b", persona: "p", agenda: "g", category: "mid", status: "listening", contributions_count: 0 },
    ]),
    getContributions: () => contributions,
    getMaxContributionId: () => 0,
    getArtifact: () => null,
    getRoundSummaries: () => ({}),
    getAllParticipantStates: () => [],
    getDatabasePath: () => "/tmp/loom-resume-test.db",
  };
}

test("a cancelled meeting is refused on resume unless the caller allows it", () => {
  const db = makeDb({ status: "cancelled" });
  const sm = makeStateManager();

  assert.throws(
    () => restoreStateFromDb({ db, stateManager: sm, meetingId: "m-resume", options: {} }),
    /already cancelled/,
    "a plain resume still refuses a cancelled meeting",
  );

  const sm2 = makeStateManager();
  const restored = restoreStateFromDb({
    db, stateManager: sm2, meetingId: "m-resume",
    options: { allowResume: true },
  });
  assert.equal(restored.nextSpeakerId, "b");
  assert.equal(sm2.getStatus(), "weaving", "the resumed meeting is weaving again");
});

test("an extension still re-opens a terminal meeting (unchanged)", () => {
  const db = makeDb({ status: "converged" });
  const sm = makeStateManager();
  assert.throws(
    () => restoreStateFromDb({ db, stateManager: sm, meetingId: "m-resume", options: {} }),
    /already converged/,
  );
  const sm2 = makeStateManager();
  restoreStateFromDb({ db, stateManager: sm2, meetingId: "m-resume", options: { allowExtend: true } });
  assert.equal(sm2.getStatus(), "weaving");
});

test("the resume status policy: a stopped meeting resumes, a finished one does not", () => {
  assert.equal(canResumeStatus("weaving"), true);
  assert.equal(canResumeStatus("initializing"), true);
  assert.equal(canResumeStatus("cancelled"), true, "the user stopped it — Resume continues it");
  assert.equal(canResumeStatus("timeout"), true, "the stall stopped it — Resume continues it");
  assert.equal(canResumeStatus("converged"), false, "a finished meeting is extended, not resumed");
  assert.equal(canResumeStatus("max_rounds_reached"), false);
  assert.equal(canResumeStatus("aborted"), false);
  assert.equal(RESUMABLE_STATUSES.has("cancelled"), true);
});

test("a restored round carries a token path (the resume used to throw a TypeError)", () => {
  const db = makeDb({ status: "cancelled", round: 2 });
  const sm = makeStateManager();
  restoreStateFromDb({ db, stateManager: sm, meetingId: "m-resume", options: { allowResume: true } });

  const round = sm.getRounds().find((r) => r.number === 2);
  assert.ok(round, "the interrupted round is restored");
  assert.ok(Array.isArray(round.token_path), "the restored round has a token path");

  // The exact call the round executor makes on the first turn of a resume.
  const executor = Object.create(RoundExecutor.prototype);
  executor._pushTokenPath(round, "a");
  assert.deepEqual(round.token_path, ["a"]);
});

test("the resume continues an OPEN round with only the speakers who did not take a turn", async () => {
  const ran = [];
  const ctx = {
    _stateManager: {
      getCurrentRound: () => 2,
      getRounds: () => ([
        { number: 2, contributions: [
          { id: 1, participant_id: "a", type: "contribution", content: "a spoke" },
        ], summary: "", token_path: ["a"] },
      ]),
      addRound() {},
      getWeave: () => [],
      getParticipants: () => ([
        { config: { id: "a", name: "a" }, status: "listening" },
        { config: { id: "b", name: "b" }, status: "listening" },
      ]),
      getPlannedTurnOrder: () => [],
      getNextSpeakerId: () => null,
      getState: () => ({}),
      transitionTo: () => { throw new Error("transitionTo should not run here"); },
    },
    _roundInitializer: {
      filterActiveParticipants: (_sm, _round) => ({
        activeParticipants: [
          { config: { id: "a", name: "a" }, status: "listening" },
          { config: { id: "b", name: "b" }, status: "listening" },
        ],
        skipped: [],
      }),
    },
    _sessionManager: { postProgress: async () => {} },
    _roundExecutor: {},
    _roundService: {
      runRound: async ({ round, activeParticipants }) => {
        ran.push({ round: round.number, speakers: activeParticipants.map((p) => p.config.id) });
        return { round };
      },
    },
    _finalizeRound: async () => true,
    _notifyUpdate: () => {},
    _logger: { info() {}, warn() {} },
    _options: {},
    _promptOrchestrator: async () => ({}),
    _getOrchestratorModel: () => ({}),
    _getAllowedFallbackModel: () => ({}),
  };

  const out = await _continueInterruptedRound.call(ctx);
  assert.equal(out, true);
  assert.deepEqual(ran, [{ round: 2, speakers: ["b"] }], "only the seat that never spoke is re-driven");
});

test("a peer answer does not count as a spoken turn", async () => {  const ran = [];
  const ctx = {
    _stateManager: {
      getCurrentRound: () => 2,
      getRounds: () => ([
        { number: 2, contributions: [
          // b ANSWERED a's query — b has not taken its own turn yet.
          { id: 1, participant_id: "b", type: "query_response", content: "peer answer", prompt_context: { source_participant_id: "a" } },
        ], summary: "", token_path: [] },
      ]),
      addRound() {},
      getWeave: () => [],
      getParticipants: () => ([
        { config: { id: "a", name: "a" }, status: "listening" },
        { config: { id: "b", name: "b" }, status: "listening" },
      ]),
      getPlannedTurnOrder: () => [],
      getNextSpeakerId: () => null,
      getState: () => ({}),
      transitionTo: () => { throw new Error("transitionTo should not run here"); },
    },
    _roundInitializer: {
      filterActiveParticipants: (_sm, _round) => ({
        activeParticipants: [
          { config: { id: "a", name: "a" }, status: "listening" },
          { config: { id: "b", name: "b" }, status: "listening" },
        ],
        skipped: [],
      }),
    },
    _sessionManager: { postProgress: async () => {} },
    _roundExecutor: {},
    _roundService: {
      runRound: async ({ round, activeParticipants }) => {
        ran.push({ round: round.number, speakers: activeParticipants.map((p) => p.config.id) });
        return { round };
      },
    },
    _finalizeRound: async () => true,
    _notifyUpdate: () => {},
    _logger: { info() {}, warn() {} },
    _options: {},
    _promptOrchestrator: async () => ({}),
    _getOrchestratorModel: () => ({}),
    _getAllowedFallbackModel: () => ({}),
  };

  const out = await _continueInterruptedRound.call(ctx);
  assert.equal(out, true);
  assert.deepEqual(ran, [{ round: 2, speakers: ["a", "b"] }], "both seats still owe a primary turn");
});

test("a fully spoken round with no summary resumes through the CLERK, not an empty finalize", async () => {
  // A cancel that landed while the round clerk was summarizing leaves the
  // round open with every speaker accounted for. Resume must run the clerk
  // (the round's summarize LLM call) before finalizing — finalizing directly
  // would persist an EMPTY summary and drop the clerk's consensus work.
  const ran = [];
  const finalized = [];
  const round = { number: 2, contributions: [
    { id: 1, participant_id: "a", type: "contribution", content: "a spoke" },
    { id: 2, participant_id: "b", type: "contribution", content: "b spoke" },
  ], summary: "", token_path: ["a", "b"] };
  const ctx = {
    isHalted: () => false,
    _stateManager: {
      getCurrentRound: () => 2,
      getRounds: () => [round],
      addRound() {},
      getWeave: () => [],
      getParticipants: () => [],
      getPlannedTurnOrder: () => [],
      getNextSpeakerId: () => null,
      getState: () => ({}),
      transitionTo: () => { throw new Error("transitionTo should not run here"); },
    },
    _roundInitializer: {
      filterActiveParticipants: () => ({ activeParticipants: [], skipped: [] }),
    },
    _sessionManager: { postProgress: async () => {} },
    _roundExecutor: {},
    _roundService: {
      runRound: async ({ round: r, activeParticipants }) => {
        ran.push({ round: r.number, speakers: activeParticipants.map((p) => p.config.id) });
        r.summary = "clerk summary on resume";
        return { round: r };
      },
    },
    _finalizeRound: async (r) => { finalized.push({ summary: r.summary }); return true; },
    _notifyUpdate: () => {},
    _logger: { info() {}, warn() {} },
    _options: {},
    _promptOrchestrator: async () => ({}),
    _getOrchestratorModel: () => ({}),
    _getAllowedFallbackModel: () => ({}),
  };

  const out = await _continueInterruptedRound.call(ctx);
  assert.equal(out, true);
  assert.deepEqual(ran, [{ round: 2, speakers: [] }], "the clerk ran over the completed round (zero new speakers)");
  assert.deepEqual(finalized, [{ summary: "clerk summary on resume" }], "the resumed summary reaches the finalizer");
});

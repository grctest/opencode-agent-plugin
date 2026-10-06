import test from "node:test";
import assert from "node:assert/strict";

import { ensureCurrentRoundShell } from "../src/meeting-restorer.js";
import { _continueInterruptedRound } from "../src/orchestrator/round.js";
import { buildFlatItems } from "../src/dashboard/utils/timeline.js";
import {
  registerPollSystem,
  resetMeetingCursorsIn,
  resetPollCursorsForMeeting,
} from "../src/dashboard/server/poll-cursors.js";

// Regression tests for the round-5 skip: a server kill at the start of round N
// commits meetings.round=N before any turn, leaving zero durable rows for N.
// Resume must re-run N under the same number — never jump to N+1.

function contrib(id, participantId, round) {
  return {
    id,
    participant_id: participantId,
    round,
    type: "primary",
    content: `turn ${id}`,
    targets_which: null,
    batch_id: null,
    tool_calls: null,
    prompt_context: null,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

test("ensureCurrentRoundShell recreates the persisted round when it has no rows", () => {
  const roundMap = new Map([
    [4, { number: 4, contributions: [contrib(1, "a", 4)], summary: "s4" }],
  ]);
  const created = ensureCurrentRoundShell(roundMap, 5, {});
  assert.equal(created, true);
  const shell = roundMap.get(5);
  assert.deepEqual(shell, { number: 5, contributions: [], summary: "" });
});

test("ensureCurrentRoundShell leaves existing rounds and invalid input alone", () => {
  const roundMap = new Map([
    [5, { number: 5, contributions: [contrib(9, "a", 5)], summary: "" }],
  ]);
  assert.equal(ensureCurrentRoundShell(roundMap, 5, {}), false);
  assert.equal(roundMap.get(5).contributions.length, 1);
  assert.equal(ensureCurrentRoundShell(new Map(), 0, {}), false);
  assert.equal(ensureCurrentRoundShell(new Map(), null, {}), false);
});

test("ensureCurrentRoundShell carries a persisted summary when one exists", () => {
  const roundMap = new Map();
  assert.equal(ensureCurrentRoundShell(roundMap, 3, { 3: "done" }), true);
  assert.equal(roundMap.get(3).summary, "done");
});

function makeParticipant(id) {
  return { config: { id, name: id }, status: "listening" };
}

function makeContinueCtx({ currentRound, rounds }) {
  const added = [];
  let finalizedWith = null;
  let ranWith = null;
  const participants = [makeParticipant("a"), makeParticipant("b")];
  return {
    ctx: {
      _stateManager: {
        getCurrentRound: () => currentRound,
        getRounds: () => rounds,
        addRound: (r) => { added.push(r); rounds.push(r); },
        getWeave: () => [],
        getParticipants: () => participants,
        getPlannedTurnOrder: () => [],
        getNextSpeakerId: () => null,
        getState: () => ({}),
        transitionTo: () => { throw new Error("transitionTo should not run here"); },
      },
      _roundInitializer: {
        filterActiveParticipants: () => ({ activeParticipants: participants, skipped: [] }),
      },
      _sessionManager: { postProgress: async () => {} },
      _roundExecutor: {},
      _roundService: {
        runRound: async ({ round, activeParticipants }) => {
          ranWith = { roundNumber: round.number, speakerCount: activeParticipants.length };
          return { round };
        },
      },
      _finalizeRound: async (round) => { finalizedWith = round.number; return true; },
      _notifyUpdate: () => {},
      _logger: { info: () => {}, warn: () => {} },
      _options: {},
      _promptOrchestrator: async () => ({}),
      _getOrchestratorModel: () => ({}),
      _getAllowedFallbackModel: () => ({}),
    },
    added,
    get finalizedWith() { return finalizedWith; },
    get ranWith() { return ranWith; },
  };
}

test("_continueInterruptedRound restarts an empty round under the same number", async () => {
  const rounds = [
    { number: 4, contributions: [contrib(1, "a", 4)], summary: "s4" },
  ];
  const t = makeContinueCtx({ currentRound: 5, rounds });
  const out = await _continueInterruptedRound.call(t.ctx);
  assert.equal(out, true);
  assert.equal(t.added.length, 1, "exactly one shell recreated");
  assert.equal(t.added[0].number, 5, "shell reuses round 5 — no increment to 6");
  assert.equal(t.ranWith.roundNumber, 5);
  assert.equal(t.ranWith.speakerCount, 2, "all speakers re-driven from scratch");
  assert.equal(t.finalizedWith, 5);
});

test("_continueInterruptedRound still continues a partial round with only missing speakers", async () => {
  const rounds = [
    {
      number: 5,
      contributions: [contrib(10, "a", 5)],
      summary: "",
    },
  ];
  const t = makeContinueCtx({ currentRound: 5, rounds });
  const out = await _continueInterruptedRound.call(t.ctx);
  assert.equal(out, true);
  assert.equal(t.added.length, 0, "no shell needed — round already restored");
  assert.equal(t.ranWith.roundNumber, 5);
  assert.equal(t.ranWith.speakerCount, 1, "only the unspoken speaker runs");
});

test("_continueInterruptedRound returns null for an already-finalized round", async () => {
  const rounds = [
    { number: 5, contributions: [contrib(10, "a", 5)], summary: "done" },
  ];
  const t = makeContinueCtx({ currentRound: 5, rounds });
  assert.equal(await _continueInterruptedRound.call(t.ctx), null);
});

test("buildFlatItems gap-fills a skipped historic round as skipped, not pending", () => {
  const grouped = [
    [4, [contrib(1, "a", 4)]],
    [6, [contrib(2, "a", 6)]],
  ];
  const items = buildFlatItems(grouped, {
    activeRound: 6,
    isWeaving: false,
    roundSummaries: {},
  });
  const headers = items.filter((i) => i.type === "header");
  assert.deepEqual(headers.map((h) => h.round), [4, 5, 6]);
  const skipped = headers.find((h) => h.round === 5);
  assert.equal(skipped.isSkipped, true);
  assert.equal(skipped.isActive, false);
  assert.equal(headers.find((h) => h.round === 6).isSkipped ?? false, false);
});

test("buildFlatItems does not mark a summarized empty round as skipped", () => {
  const grouped = [
    [4, [contrib(1, "a", 4)]],
    [6, [contrib(2, "a", 6)]],
  ];
  const items = buildFlatItems(grouped, {
    activeRound: 6,
    isWeaving: false,
    roundSummaries: { 5: "all passed" },
  });
  const skipped = items.filter((i) => i.type === "header").find((h) => h.round === 5);
  assert.equal(skipped.isSkipped, false);
});

function makeCursors() {
  return {
    participantStatusCache: new Map([
      ["m1", "parts"],
      ["state:m1", "state"],
      ["terminal:m1", "true"],
    ]),
    lastRoundSummariesHash: new Map([["m1", "hash"]]),
    lastArtifactCreatedAt: new Map([["m1", "ts"]]),
    pendingQueues: new Map([["m1", [{ type: "state" }]]]),
    lastContributionId: new Map([["m1", 42]]),
  };
}

test("resetMeetingCursorsIn refreshes snapshots but preserves delta cursors", () => {
  const cursors = makeCursors();
  resetMeetingCursorsIn(cursors, "m1");
  assert.equal(cursors.participantStatusCache.has("m1"), false);
  assert.equal(cursors.participantStatusCache.has("state:m1"), false);
  assert.equal(cursors.lastRoundSummariesHash.has("m1"), false);
  assert.equal(cursors.lastArtifactCreatedAt.has("m1"), false);
  assert.equal(cursors.pendingQueues.has("m1"), false);
  // Terminal marker and contribution deltas survive — no replay storm.
  assert.equal(cursors.participantStatusCache.get("terminal:m1"), "true");
  assert.equal(cursors.lastContributionId.get("m1"), 42);
});

test("resetPollCursorsForMeeting reaches registered poll systems", () => {
  const cursors = makeCursors();
  const unregister = registerPollSystem(cursors);
  try {
    resetPollCursorsForMeeting("m1");
    assert.equal(cursors.participantStatusCache.has("state:m1"), false);
    assert.equal(cursors.lastContributionId.get("m1"), 42);
  } finally {
    unregister();
  }
});

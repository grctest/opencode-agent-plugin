import test from "node:test";
import assert from "node:assert/strict";
import { loomToolRefusal, auditLoomTool } from "../src/plugin/tools/audit.js";
import { recordMeetingDegradedReason, getMeetingDegradedReasons, getMetricsSnapshot } from "../src/metrics.js";
import { computeMechanismMix, ARGUMENT_SHAPED_TYPES, DECISION_SHAPED_TYPES } from "../src/utils/contribution-types.js";
import { _computeQualityTelemetry, measureRoundBudget, runFinalRoundPatchGrace } from "../src/orchestrator/synthesis.js";
import { StateManager } from "../src/services/state-manager.js";

// N6/N7/N9/N12 — health signals from prose, the patch cap, the round-budget
// floor, and mechanism-mix visibility.
//
// Before these, deliberation 1355a723 reported `agent_errors: 0`, an empty
// error_log, and 118/118 tool_audit rows `completed` — while four
// contributions described rejected state patches and one described a failed
// forum read that left no audit row at all. The health tables were measuring
// nothing, and the mechanism-mix question (16 ballots, 3 objections) had no
// place to be asked.

function fakeDb() {
  const rows = [];
  return {
    rows,
    addToolAudit({ participantId, round, batchId, tool, input, output, status, title }) {
      rows.push({ participantId, round, batchId, tool, input, output, status, title });
    },
  };
}

function fakeStateManager(participantId = "a") {
  return {
    getCurrentRound: () => 2,
    getState: () => ({ round: 2 }),
  };
}

function fakeCaller(id = "a") {
  return { config: { id, name: "A" }, currentBatchId: "b1" };
}

test("a tool refusal writes an audit row that is not `completed`", () => {
  const db = fakeDb();
  const result = loomToolRefusal({
    db,
    stateManager: fakeStateManager(),
    caller: fakeCaller(),
    meetingId: "m-refusal-1",
    tool: "loom_state_patch",
    input: { stance: "x" },
    error: "only one loom_state_patch call is allowed per turn",
    reason: "state_patch_rejected",
  });
  assert.equal(db.rows.length, 1);
  assert.equal(db.rows[0].status, "rejected");
  assert.equal(db.rows[0].tool, "loom_state_patch");
  assert.match(db.rows[0].output, /only one loom_state_patch call is allowed/);
  // The agent still gets a typed, actionable payload.
  const payload = JSON.parse(result.output);
  assert.equal(payload.error, "only one loom_state_patch call is allowed per turn");
  assert.equal(payload.degraded, true);
  assert.equal(payload.reason, "state_patch_rejected");
  assert.equal(result.metadata.error, true);
  assert.equal(result.metadata.degraded, true);
});

test("a rejected patch is visible in the meeting's degraded reasons", () => {
  const meetingId = "m-refusal-2";
  recordMeetingDegradedReason(meetingId, "state_patch_rejected");
  recordMeetingDegradedReason(meetingId, "state_patch_rejected");
  recordMeetingDegradedReason(meetingId, "tool_call_limit_reached");
  assert.deepEqual(getMeetingDegradedReasons(meetingId), ["state_patch_rejected", "tool_call_limit_reached"]);
  // ...and in the process-wide counters.
  const snapshot = getMetricsSnapshot();
  assert.ok((snapshot.counters.meeting_degraded_reasons.state_patch_rejected ?? 0) >= 2);
  // An unrelated meeting is unaffected.
  assert.deepEqual(getMeetingDegradedReasons("m-not-this-one"), []);
});

test("quality telemetry carries the degraded reasons and the unmeasurable flag", () => {
  const meetingId = "m-refusal-3";
  recordMeetingDegradedReason(meetingId, "state_patch_rejected");
  const ctx = {
    _meetingId: meetingId,
    _stateManager: {
      getWeave: () => [{ type: "contribution", participant_id: "a", round: 1 }],
      getParticipants: () => [{ config: { id: "a" } }],
      getObjections: () => [],
      getMeetingId: () => meetingId,
    },
  };
  const q = _computeQualityTelemetry.call(ctx, {});
  assert.deepEqual(q.meeting_degraded_reasons, ["cost_unmeasurable", "state_patch_rejected"]);
  // cost_unmeasurable stays as its own flag for existing consumers.
  assert.equal(q.cost_unmeasurable, true);
  // N7 — the per-turn high-water mark and the cap are reported together so a
  // round's audited total can never be read as a per-turn overrun.
  assert.equal(q.tool_calls.cap_per_turn, 12);
  assert.equal(q.tool_calls.max_in_a_turn, 0);
});

test("refusals survive a db that throws (never a crash from telemetry)", () => {
  const hostile = { addToolAudit() { throw new Error("db down"); } };
  const result = loomToolRefusal({
    db: hostile,
    stateManager: fakeStateManager(),
    caller: fakeCaller(),
    meetingId: "m-refusal-4",
    tool: "loom_state_patch",
    error: "x",
    reason: "state_patch_rejected",
  });
  assert.match(result.output, /state_patch_rejected/);
  // auditLoomTool itself is already failure-proof; prove it.
  assert.equal(auditLoomTool({ db: hostile, stateManager: fakeStateManager(), caller: fakeCaller(), tool: "loom_state_patch", output: "x" }), undefined);
});

test("N12 — mechanism mix counts argument vs decision per round, and constrains nothing", () => {
  const weave = [
    { id: 1, type: "contribution", round: 1, participant_id: "a" },
    { id: 2, type: "critique_response", round: 1, participant_id: "b" },
    { id: 3, type: "vote_response", round: 1, participant_id: "c" },
    { id: 4, type: "vote_response", round: 1, participant_id: "a" },
    { id: 5, type: "evidence_response", round: 2, participant_id: "b" },
    { id: 6, type: "pass", round: 2, participant_id: "c" },
  ];
  const objections = [
    { id: "o1", round: 1, unresolved: true },
    { id: "o2", round: 1, unresolved: false },
    { id: "o3", round: 2, unresolved: true },
  ];
  const mix = computeMechanismMix(weave, objections);
  assert.equal(mix.argument_shaped, 3);
  assert.equal(mix.decision_shaped, 2);
  assert.equal(mix.other, 1);
  assert.equal(mix.unresolved_objections, 2);
  assert.equal(mix.decision_share, 0.4);
  assert.deepEqual(mix.by_round, [
    { round: 1, argument_shaped: 2, decision_shaped: 2, other: 0, objections: 2, unresolved_objections: 1 },
    { round: 2, argument_shaped: 1, decision_shaped: 0, other: 1, objections: 1, unresolved_objections: 1 },
  ]);
  // The classification is a statement about the record, not a budget.
  assert.equal(ARGUMENT_SHAPED_TYPES.has("vote_response"), false);
  assert.equal(DECISION_SHAPED_TYPES.has("vote_response"), true);
  assert.equal(computeMechanismMix([], []).decision_share, 0);
});

test("N9 — the round-budget floor measures the closing round against the median", () => {
  const healthy = [{ number: 1, span_ms: 684_000 }, { number: 2, span_ms: 1_301_000 }, { number: 3, span_ms: 1_020_000 }, { number: 4, span_ms: 900_000 }];
  const measured = measureRoundBudget(healthy);
  assert.equal(measured.below_floor, false);
  assert.equal(measured.final_span_ms, 900_000);
  // median of 684k, 900k, 1020k, 1301k is the mean of the middle pair.
  assert.equal(measured.median_span_ms, 960_000);
  assert.equal(measured.ratio, 0.938);

  // The 1355a723 shape: 684s, 1301s, 1020s, 382s.
  const starved = [{ number: 1, span_ms: 684_000 }, { number: 2, span_ms: 1_301_000 }, { number: 3, span_ms: 1_020_000 }, { number: 4, span_ms: 382_000 }];
  const starvedMeasure = measureRoundBudget(starved);
  assert.equal(starvedMeasure.below_floor, true);
  assert.ok(starvedMeasure.ratio < 0.6);

  // Not enough data to judge; never a false alarm on a two-round meeting.
  assert.equal(measureRoundBudget([{ number: 1, span_ms: 100 }]).below_floor, false);
  assert.equal(measureRoundBudget([]).below_floor, false);
  assert.equal(measureRoundBudget([{ number: 1 }]).below_floor, false);
});

test("N9 — the closing patch grace gives every unpatched participant a turn", async () => {
  const meetingId = "m-grace";
  const stateManager = new StateManager({
    id: meetingId,
    participants: [
      { config: { id: "a", name: "A", tier: "mid" }, status: "listening", contributions_count: 2 },
      { config: { id: "b", name: "B", tier: "junior" }, status: "listening", contributions_count: 2 },
      { config: { id: "c", name: "C", tier: "civilian" }, status: "failed", contributions_count: 0 },
    ],
    // Only `a` spoke in the final round.
    weave: [{ id: 1, round: 2, participant_id: "a", type: "contribution", content: "x" }],
    rounds: [{ number: 2, contributions: [] }],
    current_round: 2,
    max_rounds: 2,
    status: "max_rounds_reached",
  });
  const prompted = [];
  const ctx = {
    _meetingId: meetingId,
    _cancelled: false,
    _stateManager: stateManager,
    _logger: { info() {}, warn() {} },
    _getParticipantModel: () => ({ providerID: "p", modelID: "m" }),
    _sessionManager: {
      async runEphemeralPrompt(participant) {
        prompted.push(participant.config.id);
        return { ok: true };
      },
    },
  };
  const result = await runFinalRoundPatchGrace.call(ctx);
  // `a` already patched in the final round; `c` failed; `b` gets the grace turn.
  assert.deepEqual(prompted, ["b"]);
  assert.deepEqual(result, { attempted: 1, patched: 1, failed: 0 });
});

test("N9 — the patch grace is skipped when disabled or cancelled", async () => {
  const stateManager = {
    getCurrentRound: () => 4,
    getParticipants: () => [{ config: { id: "a", name: "A", tier: "mid" }, status: "listening" }],
    getWeave: () => [],
  };
  const asked = [];
  const base = {
    _meetingId: "m-grace-off",
    _stateManager: stateManager,
    _logger: { info() {}, warn() {} },
    _getParticipantModel: () => ({ providerID: "p", modelID: "m" }),
    _sessionManager: { async runEphemeralPrompt(p) { asked.push(p.config.id); return { ok: true }; } },
  };
  const cancelled = await runFinalRoundPatchGrace.call({ ...base, _cancelled: true });
  assert.deepEqual(cancelled, { attempted: 0, patched: 0, failed: 0 });
  assert.deepEqual(asked, []);
});

// The N6 acceptance criterion, end to end through the real tool: a meeting
// with a rejected patch reports it in the counters AND in tool_audit.
test("N6 — a rejected state patch is in both the counters and the audit table", async () => {
  const { createStatePatchTool } = await import("../src/plugin/tools/state-patch.js");
  const { DEFAULT_CONFIG } = await import("../src/config/defaults.js");
  const { getMeetingDegradedReasons } = await import("../src/metrics.js");

  const meetingId = "m-patch-rejected";
  const target = {
    config: {
      id: "agent", name: "Agent", tier: "mid",
      persona: "Tests grounded reasoning.", agenda: "Verify state continuity.",
      known_biases: [], preferred_contribution_types: [], anti_patterns: [],
      model: { providerID: "test", modelID: "test-model" },
    },
    tier_config: {},
    status: "speaking",
    session_id: "agent-session",
    contributions_count: 0,
  };
  const manager = new StateManager({
    id: meetingId, participants: [target], weave: [], rounds: [{ number: 1, contributions: [], token_path: [] }],
    current_round: 1, max_rounds: 3, next_contribution_id: 0, status: "weaving", state_of_play: "",
  });
  const audits = [];
  const db = {
    addToolAudit: (row) => audits.push(row),
    setParticipantStatus() {}, setParticipantReflection() {}, addStatePatch() {}, setParticipantState() {},
  };
  const engine = {
    getStateManager: () => manager,
    getDatabase: () => db,
    getRoundExecutor: () => ({ getEffectiveAgentTools: () => DEFAULT_CONFIG.agentTools }),
  };
  const stateTool = createStatePatchTool({
    config: { getValue: (key) => (key === "agentTools" ? { ...DEFAULT_CONFIG.agentTools, enabled: false } : undefined) },
    resolveMeeting: async () => ({ meetingId }),
    activeLooms: new Map([[meetingId, engine]]),
  }).loom_state_patch;

  manager.beginTurn(target.config.id);
  // Second patch in the same turn — the tool refuses it.
  manager.markTurnPatchApplied();
  const refused = await stateTool.execute({ stance: "second patch" }, { sessionID: "agent-session" });

  assert.equal(refused.metadata.error, true);
  assert.equal(refused.metadata.reason, "state_patch_rejected");
  // Counters: a named reason for this meeting.
  assert.ok(getMeetingDegradedReasons(meetingId).includes("state_patch_rejected"));
  // Audit: a row whose status is not `completed`.
  const refusalRows = audits.filter((r) => r.status === "rejected");
  assert.equal(refusalRows.length, 1);
  assert.equal(refusalRows[0].tool, "loom_state_patch");
  assert.equal(refusalRows[0].participantId, "agent");
  assert.match(refusalRows[0].output, /only one loom_state_patch call is allowed per turn/);
});

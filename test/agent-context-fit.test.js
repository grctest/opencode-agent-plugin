// The agent turn's block-aware fit, exercised against the real function.
//
// The fit loop was extracted to a pure helper, and unit tests of that helper
// cannot see the wiring around it — a builder referenced before its declaration,
// or a trimmable block the builder never actually reads, both pass those tests and
// fail only when a turn runs. So this drives promptChildSession itself and
// inspects the prompt it assembled.

import { test } from "node:test";
import assert from "node:assert/strict";
import { promptChildSession } from "../src/round-executor/agent/prompt-session.js";
import { CHARS_PER_TOKEN, HEADROOM } from "../src/utils/context-budget.js";
import { CircuitBreaker } from "../src/utils/retry.js";

const AVAILABLE = [
  { providerID: "test", modelID: "tiny", limit: { context: 8192, output: 4096 } },
  { providerID: "test", modelID: "small", limit: { context: 32000, output: 4096 } },
  { providerID: "test", modelID: "giant", limit: { context: 1000000, output: 4096 } },
];

// The prompt builder bounds every block (per-contribution caps, SoP truncation),
// so a realistic turn tops out around 45k chars. That comfortably clears an 8k
// window (~27.8k char budget) and a 32k one, so `tiny` is the model that
// actually exercises the fit.
const TINY = AVAILABLE[0];
const budgetFor = (m) => Math.floor(m.limit.context * HEADROOM * CHARS_PER_TOKEN);

/**
 * Minimal executor context. The turn is captured and an empty agent response is
 * returned, so the test asserts on what was assembled rather than on parsing.
 */
function fakeExecutor({ model = AVAILABLE[0], weave = [], tools = null } = {}) {
  const captured = [];
  const participant = {
    id: "p1",
    config: { id: "p1", name: "A", category: "standard", persona: "a careful analyst", model: { providerID: model.providerID, modelID: model.modelID } },
    status: "listening",
    reflection: null,
  };
  const ctx = {
    _getParticipantModel: () => ({ providerID: model.providerID, modelID: model.modelID }),
    _availableModels: AVAILABLE,
    _options: { agentTools: tools },
    _logger: { info() {}, warn() {}, error() {}, debug() {} },
    _circuitBreaker: new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 }),
    _modelKey: (m) => `${m?.providerID}/${m?.modelID}`,
    _recordModelFailure() {},
    _recordFallbackFailure() {},
    _recordModelSuccess() {},
    _logError() {},
    _callStats: {},
    _stateManager: {
      getCurrentRound: () => 2,
      getStateOfPlay: () => "SOP " + "s".repeat(2000),
      getWeave: () => weave,
      getQuestion: () => "Should we ship it?",
      getTags: () => [],
      getContext: () => "",
      getMaxRounds: () => 4,
      getActiveParticipants: () => [participant],
      getParticipantState: () => null,
      getAllParticipantStates: () => [],
      getSettledItems: () => [],
      getRounds: () => [{ number: 1, summary: "PREV " + "p".repeat(2000) }],
      getPlannedTurnOrder: () => [],
      getNextSpeakerId: () => "p1",
      consumeNextRoundSteering: () => "",
      getParticipants: () => [participant],
    },
    _executeAgentTurn: async (p, m, timeoutMs, promptContext) => {
      captured.push({ model: m, promptContext });
      return { ok: true, text: "Acknowledged — the migration risk is rollback, not schema.", result: null, error: null };
    },
  };
  return { ctx, participant, captured };
}

test("the turn assembles and reports a prompt without a TDZ or wiring failure", async () => {
  const { ctx, participant, captured } = fakeExecutor();
  await promptChildSession.call(ctx, participant);
  assert.equal(captured.length, 1, "the turn should have reached the model");
  const { promptContext } = captured[0];
  assert.equal(promptContext.round, 2);
  assert.ok(promptContext.user_prompt.length > 0);
  assert.ok(promptContext.system_prompt.length > 0);
  // The audit record keeps the room as it was, not the trimmed view.
  assert.ok(Array.isArray(promptContext.recent_contributions));
});

test("a normal turn is not trimmed on a 1M-window model", async () => {
  const { ctx, participant, captured } = fakeExecutor({ model: AVAILABLE[2] });
  await promptChildSession.call(ctx, participant);
  assert.ok(captured[0].promptContext.user_prompt.length > 0);
});

test("an over-budget turn on a tiny-window model is fitted before it is sent", async () => {
  // Sized past what the builder will actually render (~45k chars assembled),
  // which overruns an 8k window's ~27.8k char budget.
  const weave = Array.from({ length: 12 }, (_, i) => ({
    id: `c${i}`, participant_id: "p2", type: "contribution", round: 2,
    content: `contribution ${i} ` + "x".repeat(12000), targets_which: null,
  }));
  const { ctx, participant, captured } = fakeExecutor({ model: TINY, weave });
  await promptChildSession.call(ctx, participant);
  const { promptContext } = captured[0];
  const budget = budgetFor(TINY);
  const total = promptContext.user_prompt.length + promptContext.system_prompt.length;
  assert.ok(total <= budget, `prompt of ${total} chars exceeds the 32k window budget of ${budget}`);
  // And it really was a fit, not a prompt that never needed one.
  assert.ok(weave.length * 12000 > budget);
});

test("the sacrifice order is real: the evidence cache goes before the live exchange", async () => {
  // loom_query enabled => the prompt carries a Prior Searches (evidence) block.
  const tools = { enabled: true, loom: { loom_query: true, loom_state_patch: true } };
  const weave = Array.from({ length: 12 }, (_, i) => ({
    id: `c${i}`, participant_id: "p2", type: "contribution", round: 2,
    content: `CONTRIB${i}-` + "x".repeat(12000), targets_which: null,
  }));
  const { ctx, participant, captured } = fakeExecutor({ model: TINY, weave, tools });
  // Seed a tool_audit row so the evidence cache is non-empty to begin with.
  ctx._db = {
    // Shape buildEvidenceCache expects: research tools keyed on `tool` with a
    // query in `input`; loom_* rows are deliberately not cached.
    getToolAudits: () => [{
      id: 1, tool: "websearch", status: "completed", round: 2, participant_id: "p2",
      input: { query: "is the migration reversible" },
      output: "PRIORSEARCHRESULT " + "r".repeat(600),
      duration_ms: 5, created_at: Date.now(),
    }],
  };
  ctx._stateManager.getStateOfPlay = () => "STATEOFPLAY " + "p".repeat(20000);
  ctx._stateManager.getRounds = () => [{ number: 1, summary: "LASTROUNDSUMMARY " + "z".repeat(15000) }];

  await promptChildSession.call(ctx, participant);
  const { promptContext } = captured[0];
  const budget = budgetFor(TINY);
  assert.ok(promptContext.user_prompt.length + promptContext.system_prompt.length <= budget);

  // The evidence cache is sacrificed first: it is retrievable again, unlike the
  // contributions already made in this round.
  assert.doesNotMatch(promptContext.user_prompt, /PRIORSEARCHRESULT/, "the evidence cache must be dropped before the weave");
  // The live exchange survives — the newest contribution is still there.
  assert.match(promptContext.user_prompt, /CONTRIB11-/, "the newest contribution must never be sacrificed");
  // And the assignment itself is never trimmed away.
  assert.match(promptContext.user_prompt, /Should we ship it\?/);
});

test("control: the same evidence block survives on a 1M-window model", async () => {
  // Guards the test above against being vacuous: if the evidence block is not
  // rendered at all, "it was dropped" would pass for the wrong reason.
  const tools = { enabled: true, loom: { loom_query: true, loom_state_patch: true } };
  const weave = Array.from({ length: 12 }, (_, i) => ({
    id: `c${i}`, participant_id: "p2", type: "contribution", round: 2,
    content: `CONTRIB${i}-` + "x".repeat(12000), targets_which: null,
  }));
  const { ctx, participant, captured } = fakeExecutor({ model: AVAILABLE[2], weave, tools });
  ctx._db = {
    // Shape buildEvidenceCache expects: research tools keyed on `tool` with a
    // query in `input`; loom_* rows are deliberately not cached.
    getToolAudits: () => [{
      id: 1, tool: "websearch", status: "completed", round: 2, participant_id: "p2",
      input: { query: "is the migration reversible" },
      output: "PRIORSEARCHRESULT " + "r".repeat(600),
      duration_ms: 5, created_at: Date.now(),
    }],
  };
  ctx._stateManager.getStateOfPlay = () => "STATEOFPLAY " + "p".repeat(20000);
  ctx._stateManager.getRounds = () => [{ number: 1, summary: "LASTROUNDSUMMARY " + "z".repeat(15000) }];

  await promptChildSession.call(ctx, participant);
  const { promptContext } = captured[0];
  assert.match(promptContext.user_prompt, /PRIORSEARCHRESULT/, "the evidence block must be rendered when there is room");
  assert.match(promptContext.user_prompt, /CONTRIB11-/);
  assert.match(promptContext.user_prompt, /LASTROUNDSUMMARY/);
});

// ------------------------------------------------ the degradation is recorded

// A guard that shortens a prompt invisibly is worse than no guard, so both
// outcomes are recorded as named degradation reasons at the orchestrator.
import { getMeetingDegradedReasons, getMetricsSnapshot } from "../src/metrics.js";
import { MeetingOrchestrator } from "../src/orchestrator.js";

const { _recordPromptTrim, _recordInputRejection } = MeetingOrchestrator.prototype;

function recorderContext(meetingId) {
  return {
    _meetingId: meetingId,
    _callStats: {},
    _logger: { info() {}, warn() {} },
    _scheduleStatsFlush() {},
  };
}

test("a prompt trim is recorded as a degradation reason, not applied silently", () => {
  const id = "ctx-trim-meeting";
  const ctx = recorderContext(id);
  _recordPromptTrim.call(ctx, 5000, { providerID: "test", modelID: "tiny" });
  const reasons = getMeetingDegradedReasons(id);
  assert.ok(reasons.includes("prompt_trimmed_to_context"), `expected the trim reason, got ${reasons}`);
  assert.equal(ctx._callStats.prompt_trims, 1, "trims are counted, so frequency is visible");
  // Reasons are per-meeting; the keyed counter is process-wide so a dashboard
  // can show how often the guard fires at all.
  assert.equal(
    getMetricsSnapshot().counters.meeting_degraded_reasons.prompt_trimmed_to_context,
    1,
    "the occurrence count is published",
  );
});

test("a provider input rejection is recorded under its own reason", () => {
  const id = "ctx-reject-meeting";
  const ctx = recorderContext(id);
  _recordInputRejection.call(ctx, { type: "context_overflow" }, { providerID: "test", modelID: "tiny" });
  _recordInputRejection.call(ctx, { type: "token_budget_exhausted" }, { providerID: "test", modelID: "tiny" });
  const reasons = getMeetingDegradedReasons(id);
  assert.ok(reasons.includes("provider_context_overflow"));
  assert.ok(reasons.includes("provider_token_budget_exhausted"));
});

test("a rejection without a classification is not recorded as noise", () => {
  const id = "ctx-noise-meeting";
  _recordInputRejection.call(recorderContext(id), null, { providerID: "test", modelID: "tiny" });
  _recordInputRejection.call(recorderContext(id), {}, { providerID: "test", modelID: "tiny" });
  assert.deepEqual(getMeetingDegradedReasons(id), []);
});

import test from "node:test";
import assert from "node:assert/strict";
import { _computeQualityTelemetry } from "../src/orchestrator/synthesis.js";
import { computeMechanismMix } from "../src/utils/contribution-types.js";

// Telemetry is deliberately narrow now.
//
// Removed: all cost/token *reporting* AND all cross-call token accumulation.
// There is no meeting-wide token budget, so there is nothing to accumulate: the
// only input quantity the system controls is one call's payload against that
// call's own model window (utils/context-budget.js), and provider refusals —
// rate limit, token budget exhausted, context overflow — are classified and
// recorded as degradation reasons at the point they happen. So
// input_tokens/output_tokens/total_tokens/cost_unmeasurable are not emitted.
//
// Removed: keyword-derived objection counters. Dissent is the orchestrator's
// judgement, not a regex's, so no objection inventory is computed or published.

function telemetryContext() {
  return {
    _stateManager: {
      getWeave: () => [],
      getParticipants: () => [],
    },
  };
}

test("_computeQualityTelemetry publishes no cost or token telemetry", () => {
  const stats = {
    input_tokens: 100,
    output_tokens: 50,
    latencies: { synthesis_ms: { count: 2, avg: 1000, p50: 900, p95: 1100, max: 1200 } },
  };
  const q = _computeQualityTelemetry.call(telemetryContext(), stats);
  for (const gone of ["input_tokens", "output_tokens", "total_tokens", "cost_unmeasurable"]) {
    assert.equal(gone in q, false, `${gone} should no longer be published`);
  }
});

test("_computeQualityTelemetry keeps latencies — slow LLM calls signal rate limiting", () => {
  const q = _computeQualityTelemetry.call(telemetryContext(), {
    latencies: { llm_prompt_ms: { count: 3, avg: 100, p50: 100, p95: 100, max: 100 } },
  });
  assert.equal(q.latencies.llm_prompt_ms.count, 3);
  assert.equal(q.latencies.llm_prompt_ms.p50, 100);
});

test("_computeQualityTelemetry publishes no objection counters", () => {
  const q = _computeQualityTelemetry.call(telemetryContext(), {});
  for (const gone of ["unresolved_objections", "total_objections"]) {
    assert.equal(gone in q, false, `${gone} should no longer be published`);
  }
});

test("mechanism_mix carries no objection counters", () => {
  const mix = computeMechanismMix([
    { type: "contribution", round: 1 },
    { type: "critique_response", round: 1 },
    { type: "vote_response", round: 1 },
  ]);
  assert.equal(mix.argument_shaped, 2);
  assert.equal(mix.decision_shaped, 1);
  for (const gone of ["objections", "unresolved_objections"]) {
    assert.equal(gone in mix, false, `${gone} should not be in mechanism_mix`);
  }
  for (const row of mix.by_round) {
    for (const gone of ["objections", "unresolved_objections"]) {
      assert.equal(gone in row, false, `${gone} should not be in by_round rows`);
    }
  }
});

test("degraded reasons still surface refusals", () => {
  const q = _computeQualityTelemetry.call(telemetryContext(), {});
  assert.ok(Array.isArray(q.meeting_degraded_reasons));
  // The shape survives even with nothing degraded.
  assert.deepEqual(q.meeting_degraded_reasons, []);
});

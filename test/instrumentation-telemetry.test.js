import test from "node:test";
import assert from "node:assert/strict";
import { isCostTelemetryUnmeasurable, _computeQualityTelemetry } from "../src/orchestrator/synthesis.js";

// P14 — make instrumentation load-bearing: surface token/latency accounting
// and flag a meeting as unmeasurable when all cost counters are zero, so
// quality gates never grade on empty telemetry.

function telemetryContext() {
  return {
    _stateManager: {
      getWeave: () => [],
      getParticipants: () => [],
      getObjections: () => [],
    },
  };
}

test("isCostTelemetryUnmeasurable flags all-zero cost counters", () => {
  assert.equal(isCostTelemetryUnmeasurable({}), true);
  assert.equal(isCostTelemetryUnmeasurable(null), true);
  assert.equal(isCostTelemetryUnmeasurable(undefined), true);
  assert.equal(isCostTelemetryUnmeasurable({ input_tokens: 0, output_tokens: 0, latencies: {} }), true);
  assert.equal(isCostTelemetryUnmeasurable({ input_tokens: 10, output_tokens: 0 }), false);
  assert.equal(isCostTelemetryUnmeasurable({ input_tokens: 0, output_tokens: 5 }), false);
  // latency samples alone make the meeting measurable
  assert.equal(isCostTelemetryUnmeasurable({ latencies: { llm_prompt_ms: { count: 3, avg: 100 } } }), false);
  // empty latency buckets do not
  assert.equal(isCostTelemetryUnmeasurable({ latencies: { llm_prompt_ms: { count: 0, avg: 0 } } }), true);
});

test("_computeQualityTelemetry surfaces token/latency accounting", () => {
  const stats = {
    input_tokens: 100,
    output_tokens: 50,
    latencies: { synthesis_ms: { count: 2, avg: 1000, p50: 900, p95: 1100, max: 1200 } },
  };
  const q = _computeQualityTelemetry.call(telemetryContext(), stats);
  assert.equal(q.input_tokens, 100);
  assert.equal(q.output_tokens, 50);
  assert.equal(q.total_tokens, 150);
  assert.equal(q.latencies.synthesis_ms.count, 2);
  assert.equal(q.latencies.synthesis_ms.p50, 900);
  assert.equal(q.cost_unmeasurable, false);
});

test("_computeQualityTelemetry flags unmeasurable meetings", () => {
  const empty = _computeQualityTelemetry.call(telemetryContext(), {});
  assert.equal(empty.input_tokens, 0);
  assert.equal(empty.output_tokens, 0);
  assert.equal(empty.cost_unmeasurable, true);
  // non-numeric junk must not count as telemetry
  const junk = _computeQualityTelemetry.call(telemetryContext(), { input_tokens: "abc", output_tokens: null });
  assert.equal(junk.cost_unmeasurable, true);
});

test("_computeQualityTelemetry keeps the existing objection counters", () => {
  const ctx = {
    _stateManager: {
      getWeave: () => [{ type: "critique_response", participant_id: "a" }],
      getParticipants: () => [{ config: { id: "a" } }, { config: { id: "b" } }],
      getObjections: () => [{ id: 1, unresolved: true }, { id: 2, unresolved: false }],
    },
  };
  const q = _computeQualityTelemetry.call(ctx, { input_tokens: 5, output_tokens: 5 });
  assert.equal(q.total_objections, 2);
  assert.equal(q.unresolved_objections, 1);
  assert.equal(q.cost_unmeasurable, false);
});

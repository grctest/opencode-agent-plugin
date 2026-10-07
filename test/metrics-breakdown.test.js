import test from "node:test";
import assert from "node:assert/strict";
import {
  recordMeetingCall,
  recordMeetingLatency,
  getMeetingBreakdown,
  clearMeetingBreakdown,
} from "../src/metrics.js";
import { summarizeRound } from "../src/round-summarizer.js";

// Per-meeting LLM call/latency breakdown (T1): attribution at the point of
// the call, isolated per meeting, safe to call with garbage inputs.

test("meeting call counts accumulate per meeting in isolation", () => {
  recordMeetingCall("m1", "agent", 2);
  recordMeetingCall("m1", "agent");
  recordMeetingCall("m2", "agent");
  assert.equal(getMeetingBreakdown("m1").calls.agent, 3);
  assert.equal(getMeetingBreakdown("m2").calls.agent, 1);
  assert.deepEqual(getMeetingBreakdown("m3").calls, {});
  clearMeetingBreakdown("m1");
  clearMeetingBreakdown("m2");
});

test("meeting latency aggregates count/avg/max and ignores invalid input", () => {
  recordMeetingLatency("m1", "llm_prompt_ms", 100);
  recordMeetingLatency("m1", "llm_prompt_ms", 300);
  recordMeetingLatency("m1", "other_ms", 50);
  recordMeetingLatency("m1", null, 10);
  recordMeetingLatency("m1", "llm_prompt_ms", Number.NaN);
  recordMeetingLatency(null, "llm_prompt_ms", 10);
  const lat = getMeetingBreakdown("m1").latencies;
  assert.deepEqual(lat.llm_prompt_ms, { count: 2, avg: 200, max: 300 });
  assert.deepEqual(lat.other_ms, { count: 1, avg: 50, max: 50 });
  clearMeetingBreakdown("m1");
  assert.deepEqual(getMeetingBreakdown("m1"), { calls: {}, latencies: {} });
});

test("summarizeRound attributes its call to the meeting state id", async () => {
  const round = {
    number: 1,
    contributions: [
      { id: 1, participant_id: "a", type: "contribution", content: "Ship it Friday with a rollback plan in place." },
    ],
  };
  const summary = await summarizeRound(
    round,
    { id: "m-sum", question: "Q", tags: [] },
    async () => "Round summary text.",
    () => ({ providerID: "p", modelID: "m" }),
    null,
    [],
    {},
    {},
  );
  assert.equal(summary, "Round summary text.");
  const breakdown = getMeetingBreakdown("m-sum");
  assert.equal(breakdown.calls.summary, 1);
  assert.equal(breakdown.latencies.summary_ms.count, 1);
  clearMeetingBreakdown("m-sum");
});

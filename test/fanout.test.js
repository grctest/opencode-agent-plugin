import test from "node:test";
import assert from "node:assert/strict";
import { mapInBatches, batchDelayForRpm } from "../src/utils/fanout.js";
import { TUNING, DEFAULT_CONFIG, NESTED_SCHEMA } from "../src/config/defaults.js";

test("batchDelayForRpm derives inter-batch delay from budget (5/batch @100rpm => 3000ms)", () => {
  assert.equal(batchDelayForRpm(5, 100), 3000);
  assert.equal(batchDelayForRpm(3, 100), 1800);
  assert.equal(batchDelayForRpm(5, 0), 0);
  assert.equal(batchDelayForRpm(0, 100), 0);
});

test("mapInBatches preserves request order despite out-of-order completion", async () => {
  const items = [1, 2, 3, 4, 5, 6];
  const out = await mapInBatches(
    items,
    async (n) => {
      await new Promise((r) => setTimeout(r, (7 - n) * 5));
      return n * 10;
    },
    { batchSize: 6, delayMs: 0 },
  );
  assert.deepEqual(out.map((r) => r.ok), [true, true, true, true, true, true]);
  assert.deepEqual(out.map((r) => r.value), [10, 20, 30, 40, 50, 60]);
});

test("mapInBatches is all-settled: one failure does not block others", async () => {
  const out = await mapInBatches(
    ["a", "b", "c"],
    async (x) => {
      if (x === "b") throw new Error("boom");
      return x;
    },
    { batchSize: 3, delayMs: 0 },
  );
  assert.equal(out[0].ok, true);
  assert.equal(out[1].ok, false);
  assert.match(out[1].error.message, /boom/);
  assert.equal(out[2].ok, true);
});

test("mapInBatches never exceeds batchSize concurrent executions", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  await mapInBatches(
    items,
    async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return true;
    },
    { batchSize: 3, delayMs: 0 },
  );
  assert.ok(maxInFlight <= 3, `max in flight was ${maxInFlight}`);
});

test("mapInBatches aborts remaining batches on signal", async () => {
  const controller = new AbortController();
  let calls = 0;
  const out = await mapInBatches(
    [1, 2, 3, 4],
    async (n) => {
      calls++;
      if (n === 1) controller.abort();
      return n;
    },
    { batchSize: 1, delayMs: 0, signal: controller.signal },
  );
  assert.equal(calls, 1);
  assert.equal(out[0].ok, true);
  assert.equal(out[3].ok, false);
  assert.equal(out[3].error.name, "AbortError");
});

test("fanout defaults stay within a 100/min budget", () => {
  assert.equal(TUNING.FANOUT.rpm, 100);
  assert.ok(TUNING.FANOUT.queryBatch >= 1);
  assert.ok(TUNING.FANOUT.voteBatch >= 1);
  assert.equal(DEFAULT_CONFIG.agentTools.parallelQueries, true);
  assert.deepEqual(NESTED_SCHEMA["agentTools.parallelQueries"], { type: "boolean" });
});

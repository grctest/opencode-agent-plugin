import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTurnOrderTool } from "../src/plugin/tools/turn-order.js";
import { buildToolsMap, buildToolsMapWithoutLoom } from "../src/round-executor/tools.js";
import { buildRoundSummaryUser } from "../src/round-summarizer.js";
import { fallbackTurnOrder } from "../src/orchestrator/round.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { getMeetingBreakdown, clearMeetingBreakdown } from "../src/metrics.js";

// Orchestrator-only turn-order override (T3): the summary call is the
// orchestrator's single LLM call per round. No second planning call exists.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "src");

function harness(statuses = { a: "listening", b: "listening", c: "listening" }) {
  const applied = {};
  const participants = Object.entries(statuses).map(([id, status]) => ({
    config: { id, name: id.toUpperCase() },
    status,
  }));
  const stateManager = {
    getMeetingId: () => "m-tool",
    getParticipants: () => participants,
    setPlannedTurnOrder: (order) => { applied.order = order; },
    setNextSpeakerId: (id) => { applied.next = id; },
  };
  const engine = { getStateManager: () => stateManager };
  const tools = createTurnOrderTool({
    resolveMeeting: async () => ({ meetingId: "m-tool" }),
    activeLooms: new Map([["m-tool", engine]]),
  });
  return { tools, applied };
}

test("tool applies a valid orchestrator order and sets the next speaker", async () => {
  const { tools, applied } = harness();
  const res = await tools.loom_set_turn_order.execute({ order: ["c", "a", "b"] }, { sessionID: "s1" });
  const out = JSON.parse(res.output);
  assert.equal(out.ok, true);
  assert.deepEqual(out.order, ["c", "a", "b"]);
  assert.deepEqual(applied.order, ["c", "a", "b"]);
  assert.equal(applied.next, "c");
  assert.deepEqual(out.dropped, []);
  assert.deepEqual(out.appended, []);
  const breakdown = getMeetingBreakdown("m-tool");
  assert.equal(breakdown.calls.turn_order, 1);
  clearMeetingBreakdown("m-tool");
});

test("tool drops unknown ids and appends missing seats in rotation order", async () => {
  const { tools, applied } = harness();
  const res = await tools.loom_set_turn_order.execute({ order: ["b", "ghost", "b"] }, { sessionID: "s1" });
  const out = JSON.parse(res.output);
  assert.deepEqual(out.order, ["b", "a", "c"]);
  assert.deepEqual(out.dropped, ["ghost"]);
  assert.deepEqual(out.appended, ["a", "c"]);
  assert.deepEqual(applied.order, ["b", "a", "c"]);
  assert.equal(applied.next, "b");
  clearMeetingBreakdown("m-tool");
});

test("tool excludes failed seats and repairs unknown-only orders", async () => {
  const { tools } = harness({ a: "listening", b: "failed", c: "listening" });
  const res = await tools.loom_set_turn_order.execute({ order: ["c", "b", "a"] }, { sessionID: "s1" });
  const out = JSON.parse(res.output);
  assert.deepEqual(out.order, ["c", "a"]);
  // Unknown-only: the ghost drops and eligible seats append in rotation order.
  const repaired = await tools.loom_set_turn_order.execute({ order: ["ghost"] }, { sessionID: "s1" });
  const fixed = JSON.parse(repaired.output);
  assert.equal(fixed.ok, true);
  assert.deepEqual(fixed.order, ["a", "c"]);
  assert.deepEqual(fixed.dropped, ["ghost"]);
  clearMeetingBreakdown("m-tool");
  // No eligible seats at all: reject instead of setting an empty order.
  const { tools: deadTools } = harness({ a: "failed" });
  const dead = await deadTools.loom_set_turn_order.execute({ order: ["a"] }, { sessionID: "s1" });
  assert.match(JSON.parse(dead.output).error, /no known participant/);
  clearMeetingBreakdown("m-tool");
});

test("tool errors without meeting context instead of queuing", async () => {
  const tools = createTurnOrderTool({ resolveMeeting: async () => null, activeLooms: new Map() });
  const res = await tools.loom_set_turn_order.execute({ order: ["a"] }, { sessionID: "s1" });
  assert.match(JSON.parse(res.output).error, /not ready|no meeting context/);
  const noCtx = createTurnOrderTool({ resolveMeeting: null, activeLooms: null });
  const res2 = await noCtx.loom_set_turn_order.execute({ order: ["a"] }, {});
  assert.match(JSON.parse(res2.output).error, /no meeting context/);
});

test("turn-order tool is never offered to agents", () => {
  const cfgs = [
    { agentTools: structuredClone(DEFAULT_CONFIG.agentTools) },
    { agentTools: { ...structuredClone(DEFAULT_CONFIG.agentTools), loom: { loom_query: false, loom_vote: false } } },
  ];
  for (const { agentTools } of cfgs) {
    for (const activeCount of [1, 5]) {
      assert.ok(!("loom_set_turn_order" in buildToolsMap({ agentTools }, { activeCount })), "agent map must not offer the orchestrator tool");
      assert.ok(!("loom_set_turn_order" in buildToolsMapWithoutLoom({ agentTools }, { activeCount })), "loom-less map must not offer the orchestrator tool");
    }
  }
});

test("summary prompt carries the override block with policy when rostered", () => {
  const round = {
    number: 2,
    contributions: [{ id: 1, participant_id: "a", type: "contribution", content: "A substantive claim with numbers 12% and 4ms recorded here." }],
  };
  const withRoster = buildRoundSummaryUser(round, { question: "Q", tags: [] }, [], {}, {
    roster: [{ id: "a", contributions_count: 1 }, { id: "b", contributions_count: 0 }],
  });
  assert.match(withRoster, /## Next-round turn order \(orchestrator-only override\)/);
  assert.match(withRoster, /loom_set_turn_order/);
  assert.match(withRoster, /Order preference: /);
  const withoutRoster = buildRoundSummaryUser(round, { question: "Q", tags: [] }, [], {}, {});
  assert.doesNotMatch(withoutRoster, /loom_set_turn_order/);
});

test("fallbackTurnOrder keeps composition order and skips failed seats", () => {
  const parts = [
    { config: { id: "junior_0" }, status: "listening" },
    { config: { id: "principal_0" }, status: "listening" },
    { config: { id: "dead_0" }, status: "failed" },
  ];
  assert.deepEqual(fallbackTurnOrder(parts), ["junior_0", "principal_0"]);
  assert.deepEqual(fallbackTurnOrder([]), []);
  assert.deepEqual(fallbackTurnOrder(null), []);
});

test("no second planning call exists in the round path", () => {
  const roundSrc = readFileSync(join(SRC, "orchestrator", "round.js"), "utf-8");
  assert.doesNotMatch(roundSrc, /planTurnOrder/);
  assert.doesNotMatch(roundSrc, /moderation\.js/);
  assert.doesNotMatch(roundSrc, /"turn_order"/);
  const modelsSrc = readFileSync(join(SRC, "orchestrator", "models.js"), "utf-8");
  assert.match(modelsSrc, /loom_set_turn_order/);
});

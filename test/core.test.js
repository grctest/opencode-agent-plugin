import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { applyStatePatch } from "../src/state-patch.js";
import { mergeStateOfPlay } from "../src/state-of-play.js";
import { getBashCommand, isBashCommandAllowed } from "../src/utils/sanitize.js";
import { buildTally, extractVoteLetter } from "../src/utils/vote-tally.js";
import { hasDashboardCapability, isAllowedDashboardHost, isSameOriginRequest } from "../src/dashboard/security.js";
import { buildFlatItems } from "../src/dashboard/utils/timeline.js";
import { SessionContract } from "../src/session-contract.js";
import { StateManager } from "../src/services/state-manager.js";
import { parseJsonContent } from "../scripts/utils.mjs";
import { collectObjections } from "../src/objection-collector.js";
import { ModelManager } from "../src/services/model-manager.js";
import { deepMerge } from "../src/config/utils.js";
import { resolveLoomBaseDir, resolveOpencodeConfigDir } from "../src/paths.js";

test("bash policy rejects shell composition and interpreters", () => {
  assert.equal(isBashCommandAllowed("git status", ["git"]), true);
  assert.equal(isBashCommandAllowed("git status && rm -rf /", ["git"]), false);
  assert.equal(isBashCommandAllowed("npm test", ["npm"]), false);
  assert.equal(isBashCommandAllowed("git log --upload-pack=x", ["git"]), false);
  assert.equal(getBashCommand({ command: "git diff" }), "git diff");
  assert.equal(getBashCommand({}), null);
});

test("state patches are bounded and reversible", () => {
  const first = applyStatePatch(undefined, {
    stance: "Prefer a reversible migration.",
    established_add: ["The current system is stable [ #1 ]"],
  });
  assert.equal(first.next.stance, "Prefer a reversible migration.");
  assert.equal(first.next.established.length, 1);
  const second = applyStatePatch(first.next, {
    remove: ["The current system is stable [ #1 ]"],
    contested_add: ["Rollback cost is not yet measured."],
  });
  assert.equal(second.next.established.length, 0);
  assert.equal(second.next.contested[0], "Rollback cost is not yet measured.");
});

test("state-of-play merge retains unpatched dissent", () => {
  const primary = "## Question\nQ\n\n## Agreements\n- Shared fact";
  const fallback = "## Question\nQ\n\n## Agreements\n- Shared fact\n- Evidence from an unpatched turn";
  const merged = mergeStateOfPlay(primary, fallback);
  assert.match(merged, /Shared fact/);
  assert.match(merged, /unpatched turn/);
});

test("vote tally counts only explicit votes", () => {
  assert.equal(extractVoteLetter("[Vote: b] because it is reversible"), "B");
  const tally = buildTally({
    question: "A) ship B) wait",
    responses: [
      { voter: "one", content: "[Vote: A]" },
      { voter: "two", content: "[Vote: B]" },
      { voter: "three", content: "I prefer A" },
    ],
  });
  assert.equal(tally.counts.A, 1);
  assert.equal(tally.counts.B, 1);
  assert.equal(tally.totalVoters, 2);
});

test("dashboard capability and origin checks fail closed", () => {
  const token = "capability-token";
  const headers = new Headers({ cookie: `loom_dashboard_3210=${token}` });
  assert.equal(hasDashboardCapability(headers, token, "loom_dashboard_3210"), true);
  assert.equal(hasDashboardCapability(new Headers(), token, "loom_dashboard_3210"), false);
  assert.equal(isAllowedDashboardHost("localhost:3210", "127.0.0.1"), true);
  assert.equal(isAllowedDashboardHost("evil.example:3210", "127.0.0.1"), false);
  assert.equal(isSameOriginRequest(new Headers({ origin: "http://evil.example" }), new URL("http://127.0.0.1:3210/api/meetings")), false);
  assert.equal(isSameOriginRequest(new Headers(), new URL("http://127.0.0.1:3210/api/meetings")), true);
});

test("timeline shows the first agent thinking before the first contribution", () => {
  const participant = { id: "agent", name: "Agent", tier: "core" };
  const items = buildFlatItems([], {
    activeRound: 1,
    isWeaving: true,
    thinkingParticipants: [participant],
  });

  assert.deepEqual(items.map(({ type, round }) => ({ type, round })), [
    { type: "header", round: 1 },
    { type: "thinking_turn", round: 1 },
  ]);
  assert.equal(items[1].participant, participant);
});

test("timeline keeps an active pending round ordered and not duplicated", () => {
  const participant = { id: "next", name: "Next", tier: "core" };
  const contribution = { id: 1, round: 1, participant_id: "first", type: "contribution" };
  const items = buildFlatItems([[1, [contribution]]], {
    activeRound: 2,
    isWeaving: true,
    thinkingParticipants: [participant],
  });

  assert.deepEqual(items.map(({ type, round }) => ({ type, round })), [
    { type: "header", round: 1 },
    { type: "agent_turn", round: 1 },
    { type: "header", round: 2 },
    { type: "thinking_turn", round: 2 },
  ]);
});

test("session timeouts abort the provider request", async () => {
  let aborted = false;
  const client = {
    session: {
      prompt: () => new Promise(() => {}),
      abort: async () => { aborted = true; },
    },
  };
  const contract = new SessionContract(client, "/tmp");
  const result = await contract.prompt({ sessionId: "s1", system: "", model: {}, parts: [], timeoutMs: 5 });
  assert.equal(result.ok, false);
  assert.equal(result.error.name, "TimeoutError");
  assert.equal(aborted, true);
});

test("state manager prevents duplicate patches and pass collisions", () => {
  const manager = new StateManager({ id: "m", participants: [], weave: [], rounds: [], current_round: 1, max_rounds: 2, status: "weaving" });
  manager.beginTurn("agent");
  assert.equal(manager.getActiveTurn().patchApplied, false);
  assert.equal(manager.getTurnToolCount(), 0);
  manager.recordTurnTool();
  assert.equal(manager.getTurnToolCount(), 1);
  assert.equal(manager.queueTurnPatch("agent", { participantId: "agent", state: { version: 1 } }), true);
  assert.equal(manager.queueTurnPatch("agent", { participantId: "agent", state: { version: 2 } }), false);
  manager.markTurnPatchApplied();
  assert.equal(manager.getActiveTurn().patchApplied, true);
  manager.endTurn();
  assert.equal(manager.getActiveTurn(), null);
  assert.equal(manager.takeLastTurnPatch("agent").state.version, 1);
  assert.equal(manager.takeLastTurnPatch("agent"), null);
});

test("JSONC config parsing handles comments and trailing commas", () => {
  const parsed = parseJsonContent(`{"loom":{"defaultMaxRounds":4}, // comment\n}`);
  assert.equal(parsed.loom.defaultMaxRounds, 4);
});

test("untyped dissent is included in the objection inventory", () => {
  const participants = [{ config: { id: "a", name: "A" } }];
  const objections = collectObjections({
    participants,
    rounds: [{ number: 1, contributions: [{ id: 1, participant_id: "a", type: "contribution", content: "I disagree because the rollback path is unsafe." }] }],
  });
  assert.equal(objections.length, 1);
  assert.equal(objections[0].unresolved, true);
});

test("safe defaults are finite and shell-free", () => {
  assert.equal(DEFAULT_CONFIG.agentTools.builtIn.bash.enabled, false);
  assert.ok(DEFAULT_CONFIG.agentTimeoutMs > 0);
  assert.ok(DEFAULT_CONFIG.synthesisTimeoutMs > 0);
  assert.ok(DEFAULT_CONFIG.defaultMeetingTimeoutMs > 0);
  assert.ok(DEFAULT_CONFIG.agentTools.maxQueryTargetsPerTurn > 0);
});

test("model paths reject traversal segments", () => {
  const manager = new ModelManager();
  assert.throws(() => manager.getModelDir("../outside"), /Invalid model name/);
  assert.throws(() => manager.getModelDir("provider/../outside"), /Invalid model name/);
  assert.throws(() => manager.getModelDir("provider//outside"), /Invalid model name/);
  assert.match(manager.getModelDir("provider/model-1.0"), /provider\/model-1\.0$/);
});

test("config merging does not mutate nested defaults", () => {
  const defaults = { nested: { enabled: false }, list: [{ value: 1 }] };
  const merged = deepMerge(defaults, { nested: { enabled: true } });
  merged.nested.enabled = false;
  merged.list[0].value = 2;
  assert.equal(defaults.nested.enabled, false);
  assert.equal(defaults.list[0].value, 1);
});

test("OPENCODE_CONFIG_DIR keeps Loom data under the selected config root", () => {
  const previous = process.env.OPENCODE_CONFIG_DIR;
  try {
    process.env.OPENCODE_CONFIG_DIR = "/tmp/opencode-config";
    assert.equal(resolveOpencodeConfigDir(), "/tmp/opencode-config");
    assert.equal(resolveLoomBaseDir(), "/tmp/opencode-config/loom");
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { createEventHandlers } from "../src/plugin/hooks.js";
import { truncateLoomOutputs } from "../src/utils/text.js";
import { boundToolCallsForStorage } from "../src/database/contribution-operations.js";

function makeParticipant(id, sessionId, batchId = null) {
  return {
    config: { id, name: id },
    session_id: sessionId,
    currentBatchId: batchId,
    status: "speaking",
  };
}

function makeEngine({ participants = [], round = 1, auditLog = [] } = {}) {
  const stateManager = {
    getParticipants: () => participants,
    getWeave: () => [],
    getCurrentRound: () => round,
    getState: () => ({ round }),
  };
  const db = {
    addToolAudit: (entry) => { auditLog.push(entry); },
  };
  return {
    getStateManager: () => stateManager,
    getDatabase: () => db,
    _auditLog: auditLog,
  };
}

function makeResolveMeeting(meeting) {
  return async (sessionId) => {
    if (!meeting) return null;
    return { meetingId: meeting.meetingId, sessionIds: [sessionId] };
  };
}

test("tool.execute.after audits built-in websearch into tool_audit", async () => {
  const auditLog = [];
  const engine = makeEngine({
    participants: [makeParticipant("agent_1", "sess_1", "batch_1")],
    round: 2,
    auditLog,
  });
  const activeLooms = new Map([["meeting_1", engine]]);
  const handlers = createEventHandlers({
    directory: "/tmp",
    activeLooms,
    resolveMeeting: makeResolveMeeting({ meetingId: "meeting_1" }),
  });

  await handlers["tool.execute.after"](
    { tool: "websearch", sessionID: "sess_1", callID: "call_1", args: { query: "loom protocol" } },
    { title: "Exa Web Search: loom protocol", output: "results...", metadata: { provider: "exa" } },
  );

  assert.equal(auditLog.length, 1);
  assert.equal(auditLog[0].tool, "websearch");
  assert.equal(auditLog[0].participantId, "agent_1");
  assert.equal(auditLog[0].round, 2);
  assert.equal(auditLog[0].batchId, "batch_1");
  assert.equal(auditLog[0].status, "completed");
  assert.equal(auditLog[0].title, "Exa Web Search: loom protocol");
  assert.equal(auditLog[0].output, "results...");
  assert.deepEqual(auditLog[0].input, JSON.stringify({ query: "loom protocol" }));
});

test("tool.execute.after audits all non-loom built-in tools", async () => {
  const auditLog = [];
  const engine = makeEngine({
    participants: [makeParticipant("agent_1", "sess_1")],
    auditLog,
  });
  const activeLooms = new Map([["meeting_1", engine]]);
  const handlers = createEventHandlers({
    directory: "/tmp",
    activeLooms,
    resolveMeeting: makeResolveMeeting({ meetingId: "meeting_1" }),
  });

  for (const tool of ["websearch", "webfetch", "read", "glob", "grep", "bash", "write", "edit"]) {
    await handlers["tool.execute.after"](
      { tool, sessionID: "sess_1", callID: `call_${tool}`, args: { x: 1 } },
      { title: `${tool} title`, output: `${tool} output`, metadata: {} },
    );
  }

  assert.equal(auditLog.length, 8);
  assert.deepEqual(auditLog.map((a) => a.tool), ["websearch", "webfetch", "read", "glob", "grep", "bash", "write", "edit"]);
});

test("tool.execute.after skips loom_* tools (already audited by execute functions)", async () => {
  const auditLog = [];
  const engine = makeEngine({
    participants: [makeParticipant("agent_1", "sess_1")],
    auditLog,
  });
  const activeLooms = new Map([["meeting_1", engine]]);
  const handlers = createEventHandlers({
    directory: "/tmp",
    activeLooms,
    resolveMeeting: makeResolveMeeting({ meetingId: "meeting_1" }),
  });

  await handlers["tool.execute.after"](
    { tool: "loom_query", sessionID: "sess_1", callID: "call_lq", args: { queries: [] } },
    { title: "loom_query", output: "[]", metadata: {} },
  );

  assert.equal(auditLog.length, 0);
});

test("tool.execute.after skips non-Loom sessions (no meeting resolved)", async () => {
  const auditLog = [];
  const engine = makeEngine({
    participants: [makeParticipant("agent_1", "sess_1")],
    auditLog,
  });
  const activeLooms = new Map([["meeting_1", engine]]);
  const handlers = createEventHandlers({
    directory: "/tmp",
    activeLooms,
    resolveMeeting: makeResolveMeeting(null),
  });

  await handlers["tool.execute.after"](
    { tool: "websearch", sessionID: "sess_other", callID: "call_x", args: { query: "q" } },
    { title: "t", output: "o", metadata: {} },
  );

  assert.equal(auditLog.length, 0);
});

test("tool.execute.after skips when caller cannot be resolved", async () => {
  const auditLog = [];
  const engine = makeEngine({
    participants: [],
    auditLog,
  });
  const activeLooms = new Map([["meeting_1", engine]]);
  const handlers = createEventHandlers({
    directory: "/tmp",
    activeLooms,
    resolveMeeting: makeResolveMeeting({ meetingId: "meeting_1" }),
  });

  await handlers["tool.execute.after"](
    { tool: "websearch", sessionID: "sess_unknown", callID: "call_x", args: { query: "q" } },
    { title: "t", output: "o", metadata: {} },
  );

  assert.equal(auditLog.length, 0);
});

test("tool.execute.after does not throw on engine/db errors", async () => {
  const badEngine = {
    getStateManager: () => { throw new Error("state manager gone"); },
    getDatabase: () => { throw new Error("db gone"); },
  };
  const activeLooms = new Map([["meeting_1", badEngine]]);
  const handlers = createEventHandlers({
    directory: "/tmp",
    activeLooms,
    resolveMeeting: makeResolveMeeting({ meetingId: "meeting_1" }),
  });

  await assert.doesNotReject(() =>
    handlers["tool.execute.after"](
      { tool: "websearch", sessionID: "sess_1", callID: "call_x", args: { query: "q" } },
      { title: "t", output: "o", metadata: {} },
    ),
  );
});

test("tool.execute.after handles non-string output", async () => {
  const auditLog = [];
  const engine = makeEngine({
    participants: [makeParticipant("agent_1", "sess_1")],
    auditLog,
  });
  const activeLooms = new Map([["meeting_1", engine]]);
  const handlers = createEventHandlers({
    directory: "/tmp",
    activeLooms,
    resolveMeeting: makeResolveMeeting({ meetingId: "meeting_1" }),
  });

  await handlers["tool.execute.after"](
    { tool: "websearch", sessionID: "sess_1", callID: "call_x", args: { query: "q" } },
    { title: "t", output: { nested: true }, metadata: {} },
  );

  assert.equal(auditLog.length, 1);
  assert.equal(auditLog[0].output, JSON.stringify({ nested: true }));
});

test("tool.execute.after preserves large websearch outputs losslessly (>12000 chars)", async () => {
  const auditLog = [];
  const engine = makeEngine({
    participants: [makeParticipant("agent_1", "sess_1")],
    auditLog,
  });
  const activeLooms = new Map([["meeting_1", engine]]);
  const handlers = createEventHandlers({
    directory: "/tmp",
    activeLooms,
    resolveMeeting: makeResolveMeeting({ meetingId: "meeting_1" }),
  });
  const big = "r".repeat(25000);

  await handlers["tool.execute.after"](
    { tool: "websearch", sessionID: "sess_1", callID: "call_big", args: { query: "q" } },
    { title: "t", output: big, metadata: {} },
  );

  assert.equal(auditLog.length, 1);
  assert.equal(auditLog[0].output, big);
  assert.equal(auditLog[0].output.length, 25000);
});

test("truncateLoomOutputs passes large outputs through without truncation", () => {
  const calls = [
    { tool: "loom_query", callID: "a", output: "x".repeat(20000) },
    { tool: "loom_vote", callID: "b", output: "y".repeat(20000) },
  ];
  const out = truncateLoomOutputs(calls, 12000, 3500);
  assert.equal(out.length, 2);
  assert.equal(out[0].output.length, 20000);
  assert.equal(out[1].output.length, 20000);
});

test("boundToolCallsForStorage preserves large outputs without truncation", () => {
  const big = "z".repeat(30000);
  const out = boundToolCallsForStorage([{ tool: "websearch", output: big }]);
  assert.equal(out[0].output, big);
});

test("tool.execute.after is a no-op without resolveMeeting", async () => {
  const handlers = createEventHandlers({ directory: "/tmp", activeLooms: new Map() });
  await assert.doesNotReject(() =>
    handlers["tool.execute.after"](
      { tool: "websearch", sessionID: "sess_1", callID: "call_x", args: {} },
      { title: "t", output: "o", metadata: {} },
    ),
  );
});

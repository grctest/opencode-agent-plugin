import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { StateManager } from "../src/services/state-manager.js";
import { buildPeerSettledDigest } from "../src/prompts/blocks.js";
import { buildQueryPrompt, buildEvidencePrompt } from "../src/prompts/interaction-prompts.js";
import { createQueryEvidenceTools } from "../src/plugin/tools/query-evidence.js";
import { emptyAgentState } from "../src/state-patch.js";

// Settled digest for queried peers (T4'): consensus points travel with the
// peer sub-prompt so a peer cannot unknowingly re-litigate signed points.

function participant(id, status = "listening", sessionId = null) {
  return {
    config: {
      id, name: id, category: "mid",
      persona: "Tests grounded reasoning.", agenda: "Verify peer context.",
      known_biases: [], preferred_contribution_types: [], anti_patterns: [],
      model: { providerID: "test", modelID: "test-model" },
    },
    status, session_id: sessionId, contributions_count: 0,
  };
}

function makeManager(participants) {
  return new StateManager({
    id: "meeting-1", participants, weave: [],
    rounds: [{ number: 1, contributions: [], token_path: [] }],
    current_round: 1, max_rounds: 3, next_contribution_id: 0,
    status: "weaving", state_of_play: "",
  });
}

function fakeDatabase(capture) {
  return {
    addContributionWithStatePatch(m, c, s = null) { capture.contributions.push({ c, s }); },
    setParticipantStatus() {}, addToolAudit() {}, setParticipantReflection() {},
    recordAgentError() {}, setPersistenceDegraded() {},
  };
}

const caller = { config: { id: "a", name: "A", category: "mid" } };
const target = { config: { id: "t", name: "T", category: "mid" }, status: "listening" };

test("digest is empty for missing, empty, or malformed input", () => {
  assert.equal(buildPeerSettledDigest(undefined), "");
  assert.equal(buildPeerSettledDigest(null), "");
  assert.equal(buildPeerSettledDigest([]), "");
  assert.equal(buildPeerSettledDigest([{ nope: 1 }, { text: "   " }]), "");
});

test("digest lists settled text, caps entries, and never leaks holder lists", () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ text: `Settled point ${i} [#${i}]`, holders: ["A", "B"] }));
  const out = buildPeerSettledDigest(items, 4);
  assert.match(out, /## Settled — signed, do not re-argue/);
  assert.match(out, /Settled point 0/);
  assert.match(out, /Settled point 3/);
  assert.doesNotMatch(out, /Settled point 4/);
  assert.match(out, /\+2 more settled/);
  assert.doesNotMatch(out, /holders: /);
  assert.match(out, /only with new evidence/);
});

test("peer prompts are byte-identical without settled items", () => {
  const q1 = buildQueryPrompt(caller, target, "note", "Q?", [], 1, 3, "", "clarify", null);
  const q2 = buildQueryPrompt(caller, target, "note", "Q?", [], 1, 3, "", "clarify", null, {});
  const q3 = buildQueryPrompt(caller, target, "note", "Q?", [], 1, 3, "", "clarify", null, { settledItems: [] });
  assert.equal(q1, q2);
  assert.equal(q1, q3);
  const e1 = buildEvidencePrompt(caller, target, "note", "Q?", [], 1, 3, null);
  const e2 = buildEvidencePrompt(caller, target, "note", "Q?", [], 1, 3, null, { settledItems: [{ text: "Signed decision [#9]" }] });
  assert.doesNotMatch(e1, /## Settled/);
  assert.match(e2, /## Settled — signed, do not re-argue/);
  assert.match(e2, /Signed decision \[#9\]/);
});

test("a queried peer sees consensus points but not solo positions", async () => {
  const responder = participant("responder", "listening");
  const asker = participant("asker", "speaking", "asker-session");
  const manager = makeManager([responder, asker]);
  const shared = "Rollback plan exists [#7]";
  for (const id of ["responder", "asker"]) {
    manager.setParticipantState(id, {
      ...emptyAgentState(), stance: `${id} stance`,
      established: [shared, `${id} solo point`],
      version: 1, updated_round: 1,
    });
  }
  let capturedPrompt = "";
  const sessionManager = {
    async runEphemeralPrompt(_participant, request) {
      capturedPrompt = request.parts[0].text;
      return { ok: true, data: { parts: [{ type: "text", text: "A grounded answer." }] } };
    },
  };
  const engine = {
    getStateManager: () => manager,
    getSessionManager: () => sessionManager,
    getDatabase: () => fakeDatabase({ contributions: [] }),
    getParticipantModel: () => ({ providerID: "test", modelID: "test-model" }),
  };
  const queryTool = createQueryEvidenceTools({
    config: { getValue: (key) => key === "agentTools" ? DEFAULT_CONFIG.agentTools : undefined },
    resolveMeeting: async () => ({ meetingId: "meeting-1" }),
    activeLooms: new Map([["meeting-1", engine]]),
  }).loom_query;

  const result = await queryTool.execute({
    queries: [{ target: "responder", question: "What is your position?", mode: "clarify" }],
  }, { sessionID: "asker-session" });
  assert.equal(JSON.parse(result.output).error, undefined);
  assert.match(capturedPrompt, /## Settled — signed, do not re-argue/);
  assert.match(capturedPrompt, /Rollback plan exists/);
  assert.doesNotMatch(capturedPrompt, /responder solo point/);
});

test("no digest when nothing is settled", async () => {
  const responder = participant("responder", "listening");
  const asker = participant("asker", "speaking", "asker-session");
  const manager = makeManager([responder, asker]);
  manager.setParticipantState("responder", {
    ...emptyAgentState(), stance: "Solo stance", established: ["Only mine"], version: 1, updated_round: 1,
  });
  let capturedPrompt = "";
  const sessionManager = {
    async runEphemeralPrompt(_participant, request) {
      capturedPrompt = request.parts[0].text;
      return { ok: true, data: { parts: [{ type: "text", text: "A grounded answer." }] } };
    },
  };
  const engine = {
    getStateManager: () => manager,
    getSessionManager: () => sessionManager,
    getDatabase: () => fakeDatabase({ contributions: [] }),
    getParticipantModel: () => ({ providerID: "test", modelID: "test-model" }),
  };
  const queryTool = createQueryEvidenceTools({
    config: { getValue: (key) => key === "agentTools" ? DEFAULT_CONFIG.agentTools : undefined },
    resolveMeeting: async () => ({ meetingId: "meeting-1" }),
    activeLooms: new Map([["meeting-1", engine]]),
  }).loom_query;

  const result = await queryTool.execute({
    queries: [{ target: "responder", question: "What is your position?", mode: "clarify" }],
  }, { sessionID: "asker-session" });
  assert.equal(JSON.parse(result.output).error, undefined);
  assert.doesNotMatch(capturedPrompt, /## Settled/);
});

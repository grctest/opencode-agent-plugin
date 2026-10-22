import test from "node:test";
import assert from "node:assert/strict";
import { promptChildSession } from "../src/round-executor/agent/prompt-session.js";
import { CircuitBreaker } from "../src/utils/retry.js";

// End-to-end proof for the two failure modes in the recorded meeting.
//
// The meeting hit "Upstream request failed: Endpoint is unavailable." (402)
// on every attempt: six dead calls at ~80s each before the fallback model was
// reached, and then — after the user cancelled — one more 34k-char prompt.
// These tests drive the real turn ladder and count the calls.

const AVAILABLE = [
  { providerID: "test", modelID: "small", limit: { context: 32000, output: 4096 } },
  { providerID: "test", modelID: "giant", limit: { context: 1000000, output: 4096 } },
];

function makeCtx({ failWith, failModel = "giant" }) {
  const calls = [];
  const participant = {
    config: {
      id: "p1", name: "Ana", category: "mid",
      persona: "A careful analyst with enough characters to render the identity block.",
      agenda: "Verify the failure ladder.",
      model: { providerID: "test", modelID: failModel },
    },
    status: "listening",
    reflection: null,
  };
  const ctx = {
    _getParticipantModel: () => ({ providerID: "test", modelID: failModel }),
    _availableModels: AVAILABLE,
    _options: { agentTools: { enabled: true, loom: {} } },
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
      getStateOfPlay: () => "",
      getWeave: () => [],
      getQuestion: () => "Q",
      getTags: () => [],
      getContext: () => "",
      getMaxRounds: () => 4,
      getActiveParticipants: () => [participant],
      getParticipantState: () => null,
      getAllParticipantStates: () => [],
      getSettledItems: () => [],
      getRounds: () => [],
      getPlannedTurnOrder: () => [],
      getNextSpeakerId: () => "p1",
      consumeNextRoundSteering: () => "",
      getParticipants: () => [participant],
    },
    // The turn itself.
    _executeAgentTurn: async (p, m) => {
      calls.push({ kind: "turn", model: m.modelID });
      if (m.modelID === failModel) throw failWith();
      return { ok: true, text: "Answered.", result: null, error: null };
    },
    // The synthesis-recovery path calls the contract DIRECTLY (not through
    // _executeAgentTurn), so it is counted here.
    _sessionManager: {
      getContract: () => ({
        prompt: async ({ model }) => {
          calls.push({ kind: "recovery", model: model.modelID });
          throw failWith();
        },
      }),
    },
  };
  return { ctx, participant, calls };
}

test("a provider outage goes straight to the fallback — one call to the dead model, no recovery", async () => {
  const outage = Object.assign(new Error("Upstream request failed: Endpoint is unavailable."), {
    status: 402,
    providerError: "APIError",
  });
  const { ctx, participant, calls } = makeCtx({ failWith: () => outage });
  await promptChildSession.call(ctx, participant);

  const dead = calls.filter((c) => c.model === "giant");
  const recoveries = calls.filter((c) => c.kind === "recovery");
  const fallbacks = calls.filter((c) => c.model === "small");

  // BEFORE the fix: 3 turn attempts + 2 recovery prompts to the dead model.
  assert.equal(dead.length, 1, `the dead endpoint must be called once, not ${dead.length}`);
  assert.equal(recoveries.length, 0, "a provider outage has nothing to recover from");
  // …and the healthy model served the turn.
  assert.equal(fallbacks.length, 1, "the fallback model must have served the turn");
});

test("an aborted turn makes no further calls — no recovery, no fallback", async () => {
  const aborted = Object.assign(new Error("Aborted"), { name: "AbortError" });
  const { ctx, participant, calls } = makeCtx({ failWith: () => aborted });
  const result = await promptChildSession.call(ctx, participant);

  assert.equal(calls.length, 1, `an aborted turn must not prompt again (calls: ${JSON.stringify(calls)})`);
  assert.equal(calls.filter((c) => c.kind === "recovery").length, 0);
  assert.equal(calls.filter((c) => c.model === "small").length, 0, "a cancelled meeting must not fall back");
  assert.ok(result?.error, "the abort is reported as the turn's error");
});

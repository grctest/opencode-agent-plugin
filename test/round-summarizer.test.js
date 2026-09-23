import test from "node:test";
import assert from "node:assert/strict";
import { StateManager } from "../src/services/state-manager.js";
import { buildAgentStatesContext, summarizeRound } from "../src/round-summarizer.js";
import { RoundService } from "../src/services/round-service.js";
import { emptyAgentState } from "../src/state-patch.js";

function makeManager() {
  const participant = {
    config: { id: "agent", name: "Agent", tier: "mid" },
    status: "listening",
    session_id: "session",
    contributions_count: 0,
  };
  return new StateManager({
    id: "meeting",
    participants: [participant],
    weave: [],
    rounds: [{ number: 1, contributions: [], token_path: [] }],
    current_round: 1,
    max_rounds: 3,
    next_contribution_id: 0,
    status: "weaving",
    state_of_play: "",
    question: "Question",
    tags: [],
  });
}

function populatedState(overrides = {}) {
  return {
    ...emptyAgentState(),
    stance: "Current effective stance",
    established: ["Current established memory [#1]"],
    contested: ["Current contested memory"],
    open: ["Current open memory"],
    facts: ["Current grounded fact Source: https://example.test [#2]"],
    files: ["src/current.ts"],
    version: 3,
    updated_round: 2,
    updated_contribution_id: 7,
    ...overrides,
  };
}

test("state-manager summary snapshots are immutable and expose projected perspectives", () => {
  const manager = makeManager();
  manager.setParticipantState("agent", populatedState({ stance: "Committed stance", version: 2 }));
  manager.getParticipant("agent").reflection = "Fresh perspective stance";
  manager.markStateDirty("agent");

  const projected = manager.getParticipantStateSnapshots();
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected[0]), true);
  assert.equal(Object.isFrozen(projected[0].state), true);
  assert.equal(Object.isFrozen(projected[0].state.established), true);
  assert.equal(projected[0].projected, true);
  assert.equal(projected[0].state.stance, "Fresh perspective stance");
  assert.equal(manager.getAllParticipantStates()[0].state.stance, "Committed stance");

  manager.setParticipantState("agent", populatedState({ stance: "Later committed stance", version: 4 }));
  assert.equal(projected[0].state.stance, "Fresh perspective stance");
  assert.equal(manager.getParticipantStateSnapshots()[0].state.stance, "Later committed stance");
  assert.equal(manager.getParticipantStateSnapshots()[0].projected, false);
});

test("agent-state summary context attributes every holder and bounds state content", () => {
  const longItem = `<script>alert(1)</script> ${"x".repeat(400)} <<<LOOM_EVIL>>> newline\nnext`;
  const context = buildAgentStatesContext([
    {
      id: "creative",
      name: "Creative Disruptor",
      tier: "junior",
      status: "listening",
      projected: true,
      state: populatedState({
        established: ["Current established memory [#1]", ...Array.from({ length: 7 }, (_, i) => `Established ${i}`), "Ninth state item"],
        contested: [longItem],
      }),
    },
    {
      id: "empty",
      name: "Empty Agent",
      tier: "mid",
      status: "passed",
      projected: false,
      state: emptyAgentState(),
    },
  ]);

  assert.match(context, /## Current Agent States/);
  assert.match(context, /Creative Disruptor.*creative.*junior.*listening.*state v3/);
  assert.match(context, /effective projection from a same-round perspective response; not yet committed/);
  assert.match(context, /Empty Agent.*empty.*passed.*state v0/);
  assert.match(context, /\(no state content\)/);
  assert.match(context, /Current established memory \[#1\]/);
  assert.match(context, /Current grounded fact Source: https:\/\/example\.test \[#2\]/);
  assert.match(context, /src\/current\.ts/);
  assert.doesNotMatch(context, /Ninth state item/);
  assert.doesNotMatch(context, /<script>/);
  assert.doesNotMatch(context, /<<<LOOM_EVIL>>>/);
});

test("round summary prompt receives current attributed states and evidence rules", async () => {
  let prompt = "";
  const round = {
    number: 2,
    contributions: [{ id: 1, participant_id: "agent", type: "contribution", content: "A current position." }],
    turn_requests: [],
  };
  await summarizeRound(
    round,
    { question: "Question", tags: [], participants: [] },
    async (_system, _model, message) => {
      prompt = message;
      return "Summary";
    },
    () => ({ providerID: "test", modelID: "test-model" }),
    null,
    [{
      id: "agent",
      name: "Agent",
      tier: "mid",
      status: "listening",
      projected: false,
      state: populatedState(),
    }],
  );

  assert.match(prompt, /Current Agent States/);
  assert.match(prompt, /Current effective stance/);
  assert.match(prompt, /Agent States are remembered positions and standing context, not independent evidence/);
  assert.match(prompt, /do not add a separate Agent States bullet/);
  assert.doesNotMatch(prompt, /## Agent States \(carried\)/);
});

test("round service snapshots state after prompt execution, not from the pre-round state", async () => {
  const manager = makeManager();
  manager.setParticipantState("agent", populatedState({ stance: "Pre-round stance", version: 1 }));
  const staleState = manager.getState();
  let prompt = "";
  const round = {
    number: 1,
    contributions: [{ id: 1, participant_id: "agent", type: "contribution", content: "Fresh answer." }],
    turn_requests: [],
  };
  const roundExecutor = {
    resetRoundStats() {},
    setDeadline() {},
    async runPromptPhase(targetRound) {
      manager.setParticipantState("agent", populatedState({ stance: "Freshly committed stance", version: 2 }));
      targetRound.contributions.push({ id: 1, participant_id: "agent", type: "contribution", content: "Fresh answer." });
    },
  };
  const service = new RoundService({ roundExecutor, stateManager: manager });

  await service.runRound({
    round,
    activeParticipants: [manager.getParticipant("agent")],
    state: staleState,
    promptOrchestrator: async (_system, _model, message) => {
      prompt = message;
      return "Summary";
    },
    getHighestTierModel: () => ({ providerID: "test", modelID: "test-model" }),
    getFallbackModel: null,
  });

  assert.match(prompt, /Freshly committed stance/);
  assert.match(prompt, /state v2/);
  assert.doesNotMatch(prompt, /Pre-round stance/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { StateManager } from "../src/services/state-manager.js";
import { buildAgentStatesContext, buildRoundSummarySystem, buildRoundSummaryUser, summarizeRound } from "../src/round-summarizer.js";
import { RoundService } from "../src/services/round-service.js";
import { SynthesisCoordinator } from "../src/synthesis-coordinator.js";
import { buildSynthesisPrompt } from "../src/prompts/synthesis.js";
import { buildOrchestratorPromptPreview } from "../src/dashboard/server/orchestrator-preview.js";
import { emptyAgentState } from "../src/state-patch.js";
import { computeSteeringHint } from "../src/orchestrator/round.js";

function makeManager() {
  const participant = {
    config: { id: "agent", name: "Agent", category: "mid", },
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
      category: "junior",
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
      category: "mid",
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

test("a small roster shows every agent state instead of dropping whole participants", () => {
  const states = ["ada", "grace", "linus"].map((id) => ({
    id,
    name: id.toUpperCase(),
    category: "mid",
    status: "listening",
    state: populatedState({ stance: "S".repeat(1000) }),
  }));
  const context = buildAgentStatesContext(states);
  for (const id of ["ada", "grace", "linus"]) {
    assert.match(context, new RegExp(id.toUpperCase()));
  }
  assert.doesNotMatch(context, /further agent state\(s\) omitted/);
});

test("clerk prompt carries the phase label without the participant round contract", () => {
  const round = {
    number: 1,
    contributions: [{ id: 1, participant_id: "agent", type: "contribution", content: "A substantive position with numbers 12% and 4ms." }],
  };
  const prompt = buildRoundSummaryUser(round, { question: "Q", tags: [] }, [], {}, { maxRounds: 1 });
  assert.match(prompt, /Single-round deliberation \(round 1\/1\)/);
  assert.doesNotMatch(prompt, /Your contribution must add/);
  assert.doesNotMatch(prompt, /End with Position/);
  assert.doesNotMatch(prompt, /Stake your own position first/);
  const system = buildRoundSummarySystem({}, 1);
  assert.match(system, /you do not contribute to it/);
  assert.match(system, /never end with "Position:"/);
});

test("the final round does not ask for a next-round speaker order", () => {
  const round = {
    number: 4,
    contributions: [{ id: 1, participant_id: "agent", type: "contribution", content: "A substantive position with numbers 12% and 4ms." }],
  };
  const roster = [{ id: "agent", contributions_count: 1 }, { id: "peer", contributions_count: 0 }];
  const finalPrompt = buildRoundSummaryUser(round, { question: "Q", tags: [] }, [], {}, { maxRounds: 4, roster });
  assert.doesNotMatch(finalPrompt, /Next-round turn order/);
  const openPrompt = buildRoundSummaryUser({ ...round, number: 2 }, { question: "Q", tags: [] }, [], {}, { maxRounds: 4, roster });
  assert.match(openPrompt, /Next-round turn order/);
});

test("round summary prompt receives current attributed states and evidence rules", async () => {
  let prompt = "";
  const round = {
    number: 2,
    contributions: [{ id: 1, participant_id: "agent", type: "contribution", content: "A current position." }],
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
      category: "mid",
      status: "listening",
      projected: false,
      state: populatedState(),
    }],
  );

  assert.match(prompt, /Current Agent States/);
  assert.match(prompt, /Current effective stance/);
  assert.match(prompt, /Agent States are remembered positions and standing context, not independent evidence/);
  assert.match(prompt, /do not add a separate Agent States bullet/);
  // The pairing rule: the clerk writes holder NAME + [#id] in its bullets.
  assert.match(prompt, /Pair every \[#id\] with the holder's NAME/);
  assert.doesNotMatch(prompt, /## Agent States \(carried\)/);
});

test("clerk contribution lines show the holder NAME with the id (resolvable at a glance)", async () => {
  let prompt = "";
  const round = {
    number: 2,
    contributions: [
      { id: 1, participant_id: "dr_sarah_3", type: "contribution", content: "A current position." },
      { id: 2, participant_id: "unknown_seat", type: "contribution", content: "From a seat the roster lost." },
    ],
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
    [],
    {},
    {
      roster: [
        { id: "dr_sarah_3", name: "Dr. Sarah", contributions_count: 1, status: "listening" },
        { id: "other", name: "Other", contributions_count: 0, status: "listening" },
      ],
    },
  );
  assert.match(prompt, /\[#1\] Dr\. Sarah \(dr_sarah_3\) \[CONTRIBUTION\]/, "roster name rides the line");
  assert.match(prompt, /\[#2\] unknown_seat \[CONTRIBUTION\]/, "unknown name falls back to the raw id");
});

test("clerk referee duties are always-on, even when operator customInstructions are set (O1)", () => {
  const bare = buildRoundSummarySystem({ summaryStyle: "balanced", customInstructions: "" });
  assert.match(bare, /note any contribution that re-states State of Play or its own prior position without a delta/);
  assert.match(bare, /state whether a decision rule \(trigger \+ date \+ owner\) exists/);
  const custom = buildRoundSummarySystem({ summaryStyle: "balanced", customInstructions: "Challenge weak evidence." });
  // Plan §O1: restatement/gate duties are contract enforcement, not a style
  // preference — they survive operator customInstructions on purpose.
  assert.match(custom, /note any contribution that re-states State of Play or its own prior position without a delta/);
  assert.match(custom, /decision rule \(trigger \+ date \+ owner\) exists/);
});

// Audit C2 — the clerk's State-of-Play excerpt must carry WHOLE items. It
// used to be a 600-char slice of the document, which — because the SoP opens
// with `## Question` and `## Tags` — usually carried the question and cut the
// consensus section mid-bullet.
test("the clerk's prior-state excerpt carries whole items", () => {
  const round = {
    number: 2,
    contributions: [{ id: 1, participant_id: "agent", type: "contribution", content: "A substantive position with numbers 12% and 4ms." }],
  };
  const sop = [
    "## Question", "A question long enough to push the consensus section past a 600-character slice of the document.", "",
    "## Tags", "engineering, security, planning, migration, rollout, operations", "",
    "## Agreements & Proposals", "- Phased rollout over Q1-Q2", "- Short-lived access tokens are essential", "",
    "## Disagreements & Concerns", "- Token revocation remains unsolved",
  ].join("\n");
  const prompt = buildRoundSummaryUser(round, { question: "Q", tags: [] }, [], {}, { stateOfPlay: sop, roster: [], maxRounds: 4 });
  const excerpt = prompt.split("<<<LOOM_PRIOR_STATE_OF_PLAY>>>_BEGIN_")[1]?.split("<<<LOOM_PRIOR_STATE_OF_PLAY>>>_END_")[0] ?? "";
  assert.match(excerpt, /Phased rollout over Q1-Q2/);
  assert.match(excerpt, /Short-lived access tokens are essential/);
  assert.match(excerpt, /Token revocation remains unsolved/);
  // The question is not what the excerpt is for.
  assert.doesNotMatch(excerpt, /A question long enough/);
  // Every line is a whole item (a bullet), never a fragment.
  for (const line of excerpt.split("\n").filter((l) => l.trim())) {
    assert.ok(line.trim().startsWith("- "), `excerpt line is not a whole item: ${JSON.stringify(line)}`);
  }
});

// Audit C3 — the synthesis prompt must announce the window the ORCHESTRATOR
// model actually has, not a hardcoded 200k.
test("the synthesis prompt states the orchestrator model's real window", () => {
  const coordinator = new SynthesisCoordinator({ async postProgress() {} }, {});
  const system = coordinator["#orchestratorSynthesisSystem"]?.({});
  // The private-field path is not reachable from a test; assert on the public
  // builders instead.
  const withWindow = buildSynthesisPrompt("Q", "t", [], [], "", "", { contextWindow: 32000 });
  assert.match(withWindow, /32k window/);
  assert.doesNotMatch(withWindow, /200k window/);
  const without = buildSynthesisPrompt("Q", "t", [], [], "", "", {});
  assert.doesNotMatch(without, /200k window/, "an unknown window must not be invented");
  assert.match(without, /large window/);
});

// Audit H — the deliverable states its own provenance: the scale of the
// deliberation, whether a BALLOT was held (two of the three recorded meetings
// held none, and the reader could not tell that a Decision Rule was prose
// rather than a tally), and the share of the room it cites.
test("the artifact states its own provenance", async () => {
  const prompts = [];
  const sessionManager = {
    async postProgress() {},
    async createOrchestratorSynthesisSession() { return "orchestrator-synthesis"; },
    getContract() {
      return {
        async prompt({ system, model }) {
          prompts.push({ system, model });
          return {
            ok: true,
            text: "## Executive Summary\nSummary\n\n## Reasoning\nReasoning\n\n## Dissenting Views\nNone — the room converged\n\n## Action Items\nNone\n\n## Open Questions\nNone\n\n## Confidence\nLow",
            tokens: { input: 1, output: 1 },
          };
        },
      };
    },
  };
  const coordinator = new SynthesisCoordinator(sessionManager, {});
  const result = await coordinator.run({
    transcriptData: {
      question: "Question",
      tags: [],
      rounds: [
        {
          number: 1,
          contributions: [
            { id: 1, participant_id: "a", type: "contribution", content: "A substantive position with numbers 12%." },
            { id: 2, participant_id: "b", type: "vote_response", content: "[Vote: A] because of the cost." },
          ],
        },
      ],
    },
    participants: [
      { config: { id: "a", name: "Ada" }, status: "listening", contributions_count: 1 },
      { config: { id: "b", name: "Ben" }, status: "listening", contributions_count: 1 },
    ],
    model: { providerID: "orchestrator", modelID: "summarizer" },
    onStart: () => {},
    onComplete: () => {},
  });
  assert.match(result.output, /\*Deliberation: 1 round · 2 contributions · 2 participants · 1 vote held \(1 ballot\)/);
  assert.match(result.output, /% of contributions cited in this artifact/);
});

// Audit D3 — the closing-round steer is ratchet-aware: when a ballot was
// already held, it asks for a CONFIRMATION ballot on the superseded question
// (the synthesis doctrine's rule 6 expects that ballot to exist).
test("the closing-round steer asks for a confirmation ballot", () => {
  const base = { roundNumber: 4, maxRounds: 4, voteEnabled: true, contributionsThisRound: 3, critiqueCount: 0, hasSynthesis: false };
  const first = computeSteeringHint({ ...base, votesHeld: 0, votesThisRound: 0 });
  assert.match(first, /no ballot has been held/);
  const ratchet = computeSteeringHint({ ...base, votesHeld: 1, votesThisRound: 0 });
  assert.match(ratchet, /re-poll the superseded question/);
  assert.match(ratchet, /latest ballot, not the original/);
  // A ballot cast in THIS round needs no nudge.
  assert.equal(computeSteeringHint({ ...base, votesHeld: 2, votesThisRound: 1 }), null);
  // The mid-deliberation nudge is unchanged.
  const mid = computeSteeringHint({ roundNumber: 2, maxRounds: 4, votesHeld: 0, votesThisRound: 0, voteEnabled: true, contributionsThisRound: 2 });
  assert.match(mid, /nothing has been priced as a decision/);
  // The consolidation nudge fires when the decision-shaped nudge does not
  // (a vote was already held) and the round was critique-heavy.
  const consol = computeSteeringHint({ roundNumber: 2, maxRounds: 4, votesHeld: 1, votesThisRound: 1, voteEnabled: true, contributionsThisRound: 4, critiqueCount: 3, hasSynthesis: false });
  assert.match(consol, /synthesize positions/);
  // …and not when the round already synthesized.
  const consolSkip = computeSteeringHint({ roundNumber: 2, maxRounds: 4, votesHeld: 1, votesThisRound: 1, voteEnabled: true, contributionsThisRound: 4, critiqueCount: 3, hasSynthesis: true });
  assert.equal(consolSkip, null);
});

// Audit D4 — the degraded fallback must not emit two sections with the same
// heading, and must not claim "Medium" confidence for an artifact the
// synthesizer never wrote.
test("the degraded fallback synthesis has one Open Questions section", () => {
  const coordinator = new SynthesisCoordinator({ async postProgress() {} }, {});
  const out = coordinator.fallbackSynthesis({
    question: "Q",
    tags: [],
    rounds: [{
      number: 1,
      contributions: [
        { id: 1, participant_id: "a", type: "contribution", content: "We should adopt the incremental plan." },
        { id: 2, participant_id: "b", type: "critique_response", content: "The rollback path is unsafe." },
        { id: 3, participant_id: "c", type: "contribution", content: "Is the migration reversible?" },
      ],
    }],
  }, "");
  assert.equal((out.match(/## Open Questions/g) ?? []).length, 1, "two Open Questions sections leaked");
  assert.match(out, /## Confidence\nLow \(synthesis incomplete due to error\)/);
});

test("round service snapshots state after prompt execution, not from the pre-round state", async () => {
  const manager = makeManager();
  manager.setParticipantState("agent", populatedState({ stance: "Pre-round stance", version: 1 }));
  const staleState = manager.getState();
  let prompt = "";
  const round = {
    number: 1,
    contributions: [{ id: 1, participant_id: "agent", type: "contribution", content: "Fresh answer." }],
  };
  const roundExecutor = {
    resetRoundStats() {},
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
    getDefaultModel: () => ({ providerID: "test", modelID: "test-model" }),
    getFallbackModel: null,
  });

  assert.match(prompt, /Freshly committed stance/);
  assert.match(prompt, /state v2/);
  assert.doesNotMatch(prompt, /Pre-round stance/);
});

test("final synthesis uses the orchestrator model and behavior profile", async () => {
  const prompts = [];
  const sessionManager = {
    async postProgress() {},
    async createOrchestratorSynthesisSession() {
      return "orchestrator-synthesis";
    },
    getContract() {
      return {
        async prompt({ system, model }) {
          prompts.push({ system, model });
          return {
            ok: true,
            text: "## Executive Summary\nSummary\n\n## Reasoning\nReasoning\n\n## Confidence\nLow\n\n## Dissenting Views\nNone\n\n## Open Questions\nNone\n\n## Action Items\nNone\n\n## References\nNone",
            tokens: { input: 1, output: 1 },
          };
        },
      };
    },
  };
  const coordinator = new SynthesisCoordinator(sessionManager, {
    role: "adversarial_reviewer",
    customInstructions: "Challenge weak evidence.",
    decisionPosture: "action_oriented",
    synthesisStyle: "technical_audit",
  });
  const result = await coordinator.run({
    transcriptData: { question: "Question", tags: [], rounds: [] },
    participants: [],
    objections: [],
    model: { providerID: "orchestrator", modelID: "summarizer" },
    onStart: () => {},
    onComplete: () => {},
  });

  assert.equal(prompts.length, 2);
  for (const prompt of prompts) {
    assert.deepEqual(prompt.model, { providerID: "orchestrator", modelID: "summarizer" });
    // Legacy adversarial_reviewer input normalizes to rigorous_auditor; the
    // operator block appears exactly once (no verbatim duplication).
    assert.match(prompt.system, /rigorous auditor/);
    assert.doesNotMatch(prompt.system, /adversarial reviewer/);
    assert.match(prompt.system, /Operator instructions: Challenge weak evidence\./);
    assert.equal(prompt.system.split("Operator instructions:").length - 1, 1);
    assert.match(prompt.system, /technical audit/);
    // Posture lives in the user-prompt doctrine now, not the system prompt.
    assert.doesNotMatch(prompt.system, /Decision posture/);
  }
  assert.match(result.output, /## Executive Summary/);
  // Posture renders in the user-prompt doctrine beside the numbered rules.
  const user = buildSynthesisPrompt("Q", "t", [], [], "",  "", { decisionPosture: "action_oriented" });
  assert.match(user, /Operator decision posture:.*prioritize concrete next actions/);
  assert.match(user, /outranked by every numbered rule below/);
  const userDefault = buildSynthesisPrompt("Q", "t", [], [], "",  "", {});
  assert.doesNotMatch(userDefault, /Operator decision posture/);
});

test("orchestrator preview maps each setting to an exact prompt fragment", () => {
  const preview = buildOrchestratorPromptPreview({
    orchestrator: {
      model: "test/preview-model",
      role: "adversarial_reviewer",
      customInstructions: "Challenge weak evidence.",
      turnOrderPolicy: "anti_starvation",
      summaryStyle: "exhaustive",
      decisionPosture: "action_oriented",
      synthesisStyle: "technical_audit",
    },
    question: "Should previews show configuration impact?",
    context: "Use a synthetic fixture.",
    participants: [
      { id: "alpha", name: "Alpha", category: "senior", persona: "Strategic.", agenda: "Direction." },
      { id: "beta", name: "Beta", category: "mid", persona: "Operational.", agenda: "Feasibility." },
      { id: "gamma", name: "Gamma", category: "junior", persona: "Extra.", agenda: "Extra." },
    ],
  });

  assert.equal(preview.staticPreview, true);
  assert.equal(preview.model, "test/preview-model");
  assert.equal(preview.roundSummary.impacts.length, 5);
  assert.equal(preview.finalSynthesis.impacts.length, 5);
  // Per-task scoping: role/posture/custom do not reach the summary system.
  assert.doesNotMatch(preview.roundSummary.system, /adversarial reviewer/);
  assert.doesNotMatch(preview.roundSummary.system, /rigorous auditor/);
  assert.doesNotMatch(preview.roundSummary.system, /Decision posture/);
  assert.doesNotMatch(preview.roundSummary.system, /Operator instructions/);
  assert.match(preview.roundSummary.system, /Be exhaustive/);
  assert.match(preview.finalSynthesis.system, /rigorous auditor/);
  // Posture moved to the user-prompt doctrine (same authority as the rules).
  assert.doesNotMatch(preview.finalSynthesis.system, /Decision posture/);
  assert.match(preview.finalSynthesis.user, /prioritize concrete next actions/);
  assert.match(preview.finalSynthesis.system, /technical audit/);
  assert.match(preview.roundSummary.user, /Should previews show configuration impact\?/);
  assert.match(preview.finalSynthesis.user, /Should previews show configuration impact\?/);
  assert.doesNotMatch(preview.finalSynthesis.user, /Gamma/);
  assert.deepEqual(preview.roundSummary.impacts.map((impact) => impact.key), ["model", "role", "customInstructions", "decisionPosture", "summaryStyle"]);
  assert.deepEqual(preview.finalSynthesis.impacts.map((impact) => impact.key), ["model", "role", "customInstructions", "decisionPosture", "synthesisStyle"]);
  assert.match(preview.roundSummary.user, /\[tools: read\]/);
  assert.equal(preview.sampleProvenance[0].source, "Current Step 1 draft");
  assert.equal(preview.sampleProvenance[2].source, "Current Step 3 seats");
  assert.match(preview.boundaryNote, /escaped deliberation data/);
  assert.equal(preview.unusedByThesePrompts[0].label, "Turn-order policy");
  assert.equal(preview.unusedByThesePrompts[0].value, "anti_starvation");
});

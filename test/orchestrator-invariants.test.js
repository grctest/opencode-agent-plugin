import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOrchestratorInstruction,
  getOrchestratorRoleSentence,
  getSummaryBand,
  getSynthesisGuidance,
  normalizeOrchestratorConfig,
  orchestratorContextPolicy,
  ORCHESTRATOR_OPTION_SCOPE,
  scopeOrchestratorConfig,
  validateOrchestratorConfig,
} from "../src/orchestrator/models.js";
import { buildOrchestratorSynthesisSystem } from "../src/synthesis-coordinator.js";
import { buildRoundSummarySystem, buildRoundSummaryUser } from "../src/round-summarizer.js";
import { buildSynthesisPrompt } from "../src/prompts/synthesis.js";
import { fallbackTurnOrder } from "../src/orchestrator/round.js";
import { createTurnOrderTool } from "../src/plugin/tools/turn-order.js";
import { clearMeetingBreakdown } from "../src/metrics.js";
import { LATEST_SCHEMA_VERSION } from "../src/database/schema.js";
import { validateSynthesisSections, finalizeSynthesis } from "../src/synthesizer.js";

// Orchestrator prompt-invariant suite (ORCHESTRATOR-PROMPT-AUDIT.md §7):
// every option-safety and option-coupling property, as deterministic
// pure-function assertions needing no LLM.

const FULL = {
  role: "rigorous_auditor",
  customInstructions: "Challenge weak evidence hard.",
  decisionPosture: "consensus_seeking",
  summaryStyle: "exhaustive",
  synthesisStyle: "technical_audit",
  turnOrderPolicy: "anti_starvation",
};

// O2 — the synthesis system contains the operator block exactly once.
test("synthesis system injects the operator block exactly once", () => {
  const sys = buildOrchestratorSynthesisSystem(FULL);
  assert.equal(sys.split("Operator instructions:").length - 1, 1);
  assert.equal(sys.split("You are the Loom orchestrator:").length - 1, 1);
  // Posture belongs to the user-prompt doctrine now, not the system.
  assert.doesNotMatch(sys, /Decision posture/);
});

// Step 2 — per-task scoping: no out-of-scope option text per task.
test("operator block is scoped per task", () => {
  assert.equal(buildOrchestratorInstruction(FULL, "summary"), "");
  assert.equal(buildOrchestratorInstruction(FULL, "turn_order"), "");
  const synth = buildOrchestratorInstruction(FULL, "synthesis");
  assert.match(synth, /rigorous auditor/);
  assert.match(synth, /Operator instructions/);
  assert.doesNotMatch(synth, /Decision posture/);
  assert.match(synth, /never license forcing agreement/);
  // Legacy callers keep the old shape (minus posture, which moved channels).
  assert.match(buildOrchestratorInstruction(FULL), /rigorous auditor/);
  assert.deepEqual(Object.keys(ORCHESTRATOR_OPTION_SCOPE).sort(), ["moderation", "summary", "synthesis", "turn_order"]);
  assert.deepEqual(scopeOrchestratorConfig(FULL, "summary"), {});
});

// O6 — legacy role maps forward; custom+empty falls back instead of dangling.
test("role rename is backward compatible and custom requires instructions", () => {
  assert.equal(normalizeOrchestratorConfig({ role: "adversarial_reviewer" }).role, "rigorous_auditor");
  assert.match(getOrchestratorRoleSentence({ role: "custom" }), /neutral facilitator/);
  assert.match(
    getOrchestratorRoleSentence({ role: "custom", customInstructions: "Be terse." }),
    /custom coordinator/,
  );
});

// O7/Step 6 — style drives word band and context budget, not just emphasis.
// Audit B1 — it also drives the OUTPUT SHAPE: the word band and the bullet
// contract were two independent instructions, so "concise" (120-200 words) was
// asked for 5-7 bullets of 1-3 sentences plus six sections — a contradiction
// the model resolved by dropping sections, and the two it dropped first
// (Settled, Next) are the two the rest of the system consumes.
test("summary style drives word band, context budget, and output shape", () => {
  const concise = getSummaryBand({ summaryStyle: "concise" });
  const balanced = getSummaryBand({ summaryStyle: "balanced" });
  const exhaustive = getSummaryBand({ summaryStyle: "exhaustive" });
  assert.equal(concise.words, "120-200");
  assert.equal(concise.budget, 6000);
  assert.equal(balanced.words, "180-350");
  assert.equal(balanced.budget, 12000);
  assert.equal(exhaustive.words, "350-600");
  assert.equal(exhaustive.budget, 20000);
  // The shape is a real instruction, and it moves with the band.
  assert.match(concise.shape, /3-4 bullets/);
  assert.match(balanced.shape, /5-7 bullets/);
  assert.match(exhaustive.shape, /7-9 bullets/);
  assert.match(buildRoundSummarySystem({ summaryStyle: "exhaustive" }), /350-600 words/);
  assert.match(buildRoundSummarySystem({ summaryStyle: "concise" }), /120-200 words/);
  const policy = orchestratorContextPolicy({ summaryStyle: "exhaustive" }, "summary");
  assert.equal(policy.budget, 20000);
  assert.equal(policy.shape, exhaustive.shape);
  const plain = orchestratorContextPolicy({ summaryStyle: "concise" }, "summary");
  assert.equal(plain.budget, 6000);
  // The clerk prompt states the band and its shape together, and never asks
  // for a bullet count the band cannot hold.
  const round = { number: 1, contributions: [{ id: 1, participant_id: "a", type: "contribution", content: "A substantive claim with numbers 12% and 4ms." }] };
  const concisePrompt = buildRoundSummaryUser(round, { question: "Q", tags: [] }, [], { summaryStyle: "concise" });
  assert.match(concisePrompt, /## Output — 3-4 bullets, one line each/);
  assert.doesNotMatch(concisePrompt, /## Output — 5-7 bullets/);
  assert.match(concisePrompt, /Settled and Next are never omitted/);
  // The band owns the bullet LIST too — a concise summary is not asked for six
  // sections with six long descriptions.
  assert.doesNotMatch(concisePrompt, /- \*\*Evidence:\*\* Tool or vec-grounded evidence introduced/);
  assert.match(concisePrompt, /- \*\*Settled:\*\* one line per newly converged item/);
  const balancedPrompt = buildRoundSummaryUser(round, { question: "Q", tags: [] }, [], { summaryStyle: "balanced" });
  assert.match(balancedPrompt, /- \*\*Evidence:\*\* Tool or vec-grounded evidence introduced/);
  assert.match(balancedPrompt, /## Output — 5-7 bullets, each 1-3 sentences/);
});

// O1/Step 6 — context now VARIES with the relevant option (the property that
// did not hold before this change).
test("round-summary context varies with summaryStyle", () => {
  const round = {
    number: 2,
    contributions: Array.from({ length: 7 }, (_, i) => ({
      id: i, participant_id: `p${i}`, type: "contribution",
      content: `Substantive contribution ${i} with numbers 12% and 4ms. `.repeat(40),
    })),
  };
  const concise = buildRoundSummaryUser(round, { question: "Q", tags: [] }, [], { summaryStyle: "concise" });
  const exhaustive = buildRoundSummaryUser(round, { question: "Q", tags: [] }, [], { summaryStyle: "exhaustive" });
  assert.ok(exhaustive.length > concise.length, "context must vary with style");
  assert.match(exhaustive, /350-600/);
  assert.match(concise, /120-200/);
});

// The standalone turn-order planner is gone: the summary call is the
// orchestrator's single LLM call per round, and ordering travels via the
// orchestrator-only tool. The operator's turnOrderPolicy steers the summary's
// override block instead of a second prompt.
test("turn-order policy steers the summary override block", () => {
  const round = { number: 1, contributions: [{ id: 1, participant_id: "a", type: "contribution", content: "A substantive claim with numbers 12% and 4ms here." }] };
  const roster = { roster: [{ id: "a", contributions_count: 1 }] };
  const evidence = buildRoundSummaryUser(round, { question: "Q", tags: [] }, [], { turnOrderPolicy: "evidence_first" }, roster);
  assert.match(evidence, /Order preference: .*evidence/i);
  const starve = buildRoundSummaryUser(round, { question: "Q", tags: [] }, [], { turnOrderPolicy: "anti_starvation" }, roster);
  assert.match(starve, /Order preference: .*least recently|spoken least/i);
});

// Step 3 — posture in user doctrine; conversational rule covers files.
test("posture sits beside the doctrine rules; conversational grounding covers files", () => {
  const user = buildSynthesisPrompt("Q", "t", [], [], "",  "", { decisionPosture: "consensus_seeking" });
  assert.match(user, /Operator decision posture:.*defensible consensus/);
  const conv = buildSynthesisPrompt("Should we adopt a four-day week?", "t", [], [], "",  "", {});
  assert.match(conv, /Do not reference files, diffs, or code/);
});

// Audit C3 — the synthesizer's system prompt announces the window the
// ORCHESTRATOR MODEL actually has. It used to hardcode "200k", which told a
// 32k model to write to a budget it did not have.
test("the synthesizer system prompt states the real context window", () => {
  const small = buildOrchestratorSynthesisSystem({}, 32000);
  assert.match(small, /32k window/);
  assert.doesNotMatch(small, /200k window/);
  const large = buildOrchestratorSynthesisSystem({}, 200000);
  assert.match(large, /200k window/);
  // Unknown window: honest, not invented.
  const unknown = buildOrchestratorSynthesisSystem({}, null);
  assert.doesNotMatch(unknown, /200k window/);
  assert.match(unknown, /large window/);
});

// Audit B4 — the FINAL artifact check keeps the style-aware rules. It used to
// run without the style, so an artifact that still lacked a Decision Rule
// passed the last gate.
test("the final artifact check keeps the Decision Rule requirement", () => {
  const spectrum = [
    "## Executive Summary", "The room split.", "",
    "## Decision", "No single decision — spectrum below:", "",
    "## Reasoning", "- discussed", "",
    "## Open Questions", "- none", "",
    "## Action Items", "- none", "",
    "## Confidence", "Medium.",
  ].join("\n");
  const missing = validateSynthesisSections(spectrum, "decision_oriented");
  assert.ok(missing.includes("Decision Rule"), `expected the Decision Rule to be missing, got ${JSON.stringify(missing)}`);
  // The finalizer (which is what ships) must surface it too — together with
  // the dissent slot, which the artifact also lacks.
  const { output } = finalizeSynthesis(spectrum, { question: "Q", rounds: [] }, [], { synthesisStyle: "decision_oriented" });
  assert.match(output, /did not generate the following sections: .*Decision Rule/);
  assert.match(output, /Dissenting Views/);
});

// No-seniority — category appears nowhere in orchestrator decision inputs;
// the summary roster carries ids only.
test("summary roster carries no seniority signal", () => {
  const round = { number: 1, contributions: [{ id: 1, participant_id: "junior_0", type: "contribution", content: "A substantive claim with numbers 12% and 4ms recorded." }] };
  const prompt = buildRoundSummaryUser(round, { question: "Q", tags: [] }, [], { turnOrderPolicy: "balanced" }, {
    roster: [
      { id: "junior_0", contributions_count: 1 },
      { id: "principal_0", contributions_count: 9 },
    ],
  });
  assert.doesNotMatch(prompt, /\(junior|\(principal|\(senior|\(mid\)|\(civilian/);
  assert.match(prompt, /Next-round turn order \(orchestrator's call\)/);
  // The roster shows the round's speaking order, so the orchestrator can see
  // the pattern it is the only one able to fix (audit D).
  const withOrder = buildRoundSummaryUser(
    round,
    { question: "Q", tags: [] },
    [],
    { turnOrderPolicy: "balanced" },
    {
      roster: [
        { id: "junior_0", contributions_count: 1, spoke_this_round: true, spoke_first: true },
        { id: "principal_0", contributions_count: 9, spoke_this_round: true, spoke_first: false },
      ],
    },
  );
  assert.match(withOrder, /spoke FIRST this round/);
  assert.match(withOrder, /spoke this round/);
});

test("turn-order default keeps composition order (no planner call)", () => {
  const participants = [
    { config: { id: "junior_0", name: "Jun", category: "junior", }, status: "listening", contributions_count: 1 },
    { config: { id: "principal_0", name: "Prin", category: "principal", }, status: "listening", contributions_count: 9 },
  ];
  assert.deepEqual(fallbackTurnOrder(participants), ["junior_0", "principal_0"]);
});

test("turn-order override applies the orchestrator order when available", async () => {
  const applied = {};
  const tools = createTurnOrderTool({
    resolveMeeting: async () => ({ meetingId: "m-inv" }),
    activeLooms: new Map([["m-inv", {
      getStateManager: () => ({
        getMeetingId: () => "m-inv",
        getParticipants: () => [
          { config: { id: "a", name: "A" }, status: "listening" },
          { config: { id: "b", name: "B" }, status: "listening" },
        ],
        setPlannedTurnOrder: (order) => { applied.order = order; },
        setNextSpeakerId: (id) => { applied.next = id; },
      }),
    }]]),
  });
  const res = await tools.loom_set_turn_order.execute({ order: ["b", "a"] }, { sessionID: "s1" });
  assert.deepEqual(JSON.parse(res.output).order, ["b", "a"]);
  assert.deepEqual(applied.order, ["b", "a"]);
  assert.equal(applied.next, "b");
  clearMeetingBreakdown("m-inv");
});

test("synthesis participants and dissent carry no tier", () => {
  const prompt = buildSynthesisPrompt(
    "Q", "t",
    [{ config: { id: "a", name: "Ada", category: "principal", }, status: "listening", contributions_count: 2 }],
    [], "",  "", {},
  );
  assert.doesNotMatch(prompt, /\(principal\)/);
  assert.doesNotMatch(prompt, /\{Holder\}.*\{tier\}/);
  // The dissent SLOT exists (audit E) — the room's live disagreement is the
  // orchestrator's judgement, carried into the artifact — and it is filled by
  // the orchestrator's Contested bullet, never by a detector.
  assert.match(prompt, /## Dissenting Views/);
  assert.match(prompt, /Contested bullet/);
  assert.match(prompt, /do not go hunting for new dissent/i);
});

// Step 5 — clerk context: round position, tier-free roster, SoP excerpt.
test("clerk prompt carries position, roster, and prior state", () => {
  const prompt = buildRoundSummaryUser(
    { number: 4, contributions: [{ id: 1, participant_id: "p0", type: "contribution", content: "We should adopt X." }] },
    { question: "Q", tags: [] },
    [],
    { summaryStyle: "balanced" },
    {
      maxRounds: 5,
      roster: [
        { id: "p0", contributions_count: 3, status: "listening" },
        { id: "p1", contributions_count: 1, status: "passed" },
      ],
      stateOfPlay: "## Agreements\n- short-lived tokens",
    },
  );
  assert.match(prompt, /Late deliberation \(round 4\/5\)/);
  assert.match(prompt, /p0 — 3 contributions/);
  assert.doesNotMatch(prompt, /\(mid\)|\(senior\)|\(junior\)|\(principal\)|\(civilian\)/);
  assert.match(prompt, /PRIOR_STATE_OF_PLAY/);
});

// Step 8 — rejected values are reported, not silently coerced.
test("invalid orchestrator values are reported with the normalized config", () => {
  const { config, rejected } = validateOrchestratorConfig({ role: "agressive", summaryStyle: "balanced", decisionPosture: "whatever" });
  assert.equal(config.role, "neutral_facilitator");
  assert.equal(config.summaryStyle, "balanced");
  assert.deepEqual(rejected.map((r) => r.field).sort(), ["decisionPosture", "role"]);
  assert.deepEqual(validateOrchestratorConfig({}).rejected, []);
});

// Schema invariant: a single version, no migrations pre-userbase.
test("schema stays a single version", () => {
  assert.equal(LATEST_SCHEMA_VERSION, 1);
});

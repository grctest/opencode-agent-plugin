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
import { buildTurnOrderPrompt } from "../src/prompts/turn-order.js";
import { buildSynthesisPrompt } from "../src/prompts/synthesis.js";
import { planTurnOrder } from "../src/moderation.js";
import { getPriorityCap } from "../src/utils/tier.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "../src/database/schema.js";

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
test("summary style drives word band and context budget", () => {
  assert.deepEqual(getSummaryBand({ summaryStyle: "concise" }), { words: "120-200", budget: 6000 });
  assert.deepEqual(getSummaryBand({ summaryStyle: "balanced" }), { words: "180-350", budget: 12000 });
  assert.deepEqual(getSummaryBand({ summaryStyle: "exhaustive" }), { words: "350-600", budget: 20000 });
  assert.match(buildRoundSummarySystem({ summaryStyle: "exhaustive" }), /350-600 words/);
  assert.match(buildRoundSummarySystem({ summaryStyle: "concise" }), /120-200 words/);
  const policy = orchestratorContextPolicy({ summaryStyle: "exhaustive" }, "summary");
  assert.equal(policy.budget, 20000);
  const plain = orchestratorContextPolicy({ summaryStyle: "concise" }, "summary");
  assert.equal(plain.budget, 6000);
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
    turn_requests: [],
  };
  const concise = buildRoundSummaryUser(round, { question: "Q", tags: [] }, [], { summaryStyle: "concise" });
  const exhaustive = buildRoundSummaryUser(round, { question: "Q", tags: [] }, [], { summaryStyle: "exhaustive" });
  assert.ok(exhaustive.length > concise.length, "context must vary with style");
  assert.match(exhaustive, /350-600/);
  assert.match(concise, /120-200/);
});

test("turn-order context varies with turnOrderPolicy", () => {
  const base = ["S".repeat(2000), "R".repeat(1000),
    [{ participant_id: "a", priority: 8, reason: "evidence reason here", hasEvidence: true }],
    [{ config: { id: "a", name: "A", tier: "mid" }, status: "listening", contributions_count: 3 }]];
  const balanced = buildTurnOrderPrompt(...base, { turnOrderPolicy: "balanced" });
  const evidence = buildTurnOrderPrompt(...base, { turnOrderPolicy: "evidence_first" });
  const starve = buildTurnOrderPrompt(...base, { turnOrderPolicy: "anti_starvation" });
  assert.ok(!balanced.includes("## Evidence Signals"));
  assert.ok(evidence.includes("## Evidence Signals"));
  assert.ok(!balanced.includes("quietest first"));
  assert.ok(starve.includes("quietest first"));
});

// Step 3 — posture in user doctrine; conversational rule covers files.
test("posture sits beside the doctrine rules; conversational grounding covers files", () => {
  const user = buildSynthesisPrompt("Q", "t", [], [], "", [], "", { decisionPosture: "consensus_seeking" });
  assert.match(user, /Operator decision posture:.*defensible consensus/);
  const conv = buildSynthesisPrompt("Should we adopt a four-day week?", "t", [], [], "", [], "", {});
  assert.match(conv, /Do not reference files, diffs, or code/);
});

// No-seniority — tier appears nowhere in orchestrator decision inputs.
test("turn-order prompt carries no seniority signal", () => {
  const prompt = buildTurnOrderPrompt(
    "## Key Facts\n- fact one",
    "summary",
    [{ participant_id: "junior_0", priority: 8, reason: "urgent mitigation" }],
    [
      { config: { id: "junior_0", name: "Jun", tier: "junior" }, status: "listening", contributions_count: 1 },
      { config: { id: "principal_0", name: "Prin", tier: "principal" }, status: "listening", contributions_count: 9 },
    ],
    { turnOrderPolicy: "balanced" },
  );
  assert.doesNotMatch(prompt, /\(junior|\(principal|\(senior|\(mid\)|\(civilian/);
  assert.doesNotMatch(prompt, /seniority principal/);
  assert.doesNotMatch(prompt, /already capped by tier/);
  assert.match(prompt, /never seniority/);
});

test("turn-order fallback ignores seniority", async () => {
  const participants = [
    { config: { id: "junior_0", name: "Jun", tier: "junior" }, status: "listening", contributions_count: 1 },
    { config: { id: "principal_0", name: "Prin", tier: "principal" }, status: "listening", contributions_count: 9 },
  ];
  const ordered = await planTurnOrder({
    stateOfPlay: "",
    roundSummary: "",
    turnRequests: [
      { participant_id: "principal_0", priority: 5, reason: "follow-up" },
      { participant_id: "junior_0", priority: 8, reason: "urgent mitigation" },
    ],
    participants,
    promptFn: async () => { throw new Error("force fallback"); },
    getHighestTierModel: () => null,
  });
  assert.deepEqual(ordered.slice(0, 2), ["junior_0", "principal_0"]);
});

test("priority caps are uniform across tiers", () => {
  for (const tier of ["junior", "mid", "senior", "principal", "civilian", "unknown"]) {
    assert.equal(getPriorityCap(tier), 10);
  }
});

test("synthesis participants and dissent carry no tier", () => {
  const prompt = buildSynthesisPrompt(
    "Q", "t",
    [{ config: { id: "a", name: "Ada", tier: "principal" }, status: "listening", contributions_count: 2 }],
    [], "", [], "", {},
  );
  assert.doesNotMatch(prompt, /\(principal\)/);
  assert.doesNotMatch(prompt, /\{Holder\}.*\{tier\}/);
  assert.match(prompt, /\*\*\{Holder\}\*\*:/);
});

// Step 5 — clerk context: round position, tier-free roster, SoP excerpt, requests.
test("clerk prompt carries position, roster, prior state, and requests", () => {
  const prompt = buildRoundSummaryUser(
    { number: 4, contributions: [{ id: 1, participant_id: "p0", type: "contribution", content: "We should adopt X." }], turn_requests: [] },
    { question: "Q", tags: [] },
    [],
    { summaryStyle: "balanced" },
    {
      maxRounds: 5,
      roster: [
        { id: "p0", contributions_count: 3, status: "listening" },
        { id: "p1", contributions_count: 1, status: "passed" },
      ],
      turnRequests: [{ participant_id: "p1", priority: 7, reason: "have mitigations" }],
      stateOfPlay: "## Agreements\n- short-lived tokens",
    },
  );
  assert.match(prompt, /Late deliberation \(round 4\/5\)/);
  assert.match(prompt, /p0 — 3 contributions/);
  assert.doesNotMatch(prompt, /\(mid\)|\(senior\)|\(junior\)|\(principal\)|\(civilian\)/);
  assert.match(prompt, /PRIOR_STATE_OF_PLAY/);
  assert.match(prompt, /have mitigations/);
});

// Step 8 — rejected values are reported, not silently coerced.
test("invalid orchestrator values are reported with the normalized config", () => {
  const { config, rejected } = validateOrchestratorConfig({ role: "agressive", summaryStyle: "balanced", decisionPosture: "whatever" });
  assert.equal(config.role, "neutral_facilitator");
  assert.equal(config.summaryStyle, "balanced");
  assert.deepEqual(rejected.map((r) => r.field).sort(), ["decisionPosture", "role"]);
  assert.deepEqual(validateOrchestratorConfig({}).rejected, []);
});

// Schema invariant: migration list length must equal the latest version.
test("schema migrations stay in lockstep with the latest version", () => {
  assert.equal(MIGRATIONS.length, LATEST_SCHEMA_VERSION);
  assert.ok(LATEST_SCHEMA_VERSION >= 10);
});

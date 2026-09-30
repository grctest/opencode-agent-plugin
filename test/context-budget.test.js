// Per-model input context guard.
//
// The system tracks no cross-call token cost. The one input quantity it
// controls is a single call's payload against the window of the model that call
// is about to use — and those windows differ by orders of magnitude (32k, 128k,
// 256k, 1M), so every limit here is resolved per model, never globally.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHARS_PER_TOKEN,
  HEADROOM,
  resolveContextLimit,
  budgetCharsFor,
  estimateTokens,
  estimatePayloadTokens,
  exceedsContextBudget,
  trimPayloadToBudget,
  fitPromptToBudget,
} from "../src/utils/context-budget.js";

const AVAILABLE = [
  { providerID: "anthropic", modelID: "small", limit: { context: 32000, output: 8192 } },
  { providerID: "anthropic", modelID: "large", limit: { context: 200000, output: 64000 } },
  { providerID: "google", modelID: "giant", limit: { context: 1000000, output: 64000 } },
  { providerID: "openai", modelID: "no-limit-metadata", limit: {} },
];

// ---------------------------------------------------------------- resolution

test("resolveContextLimit reads the window of the specific model asked for", () => {
  assert.equal(resolveContextLimit({ providerID: "anthropic", modelID: "small" }, AVAILABLE), 32000);
  assert.equal(resolveContextLimit({ providerID: "anthropic", modelID: "large" }, AVAILABLE), 200000);
  assert.equal(resolveContextLimit({ providerID: "google", modelID: "giant" }, AVAILABLE), 1000000);
});

test("a 32k model is not granted a 1M model's budget", () => {
  const small = budgetCharsFor({ providerID: "anthropic", modelID: "small" }, AVAILABLE);
  const giant = budgetCharsFor({ providerID: "google", modelID: "giant" }, AVAILABLE);
  assert.ok(giant > small * 20, `expected giant budget to dwarf small, got ${giant} vs ${small}`);
  assert.ok(small <= 32000 * HEADROOM * CHARS_PER_TOKEN + 1);
});

test("resolveContextLimit returns null for unknown models — null means no guard", () => {
  assert.equal(resolveContextLimit({ providerID: "anthropic", modelID: "nope" }, AVAILABLE), null);
  assert.equal(resolveContextLimit({ providerID: "ghost", modelID: "small" }, AVAILABLE), null);
  assert.equal(resolveContextLimit({ providerID: "openai", modelID: "no-limit-metadata" }, AVAILABLE), null);
  assert.equal(resolveContextLimit(null, AVAILABLE), null);
  assert.equal(resolveContextLimit({ modelID: "large" }, AVAILABLE), null);
  assert.equal(resolveContextLimit({ providerID: "anthropic" }, AVAILABLE), null);
});

test("malformed or non-positive context limits are ignored, not trusted", () => {
  for (const bad of [0, -1, NaN, Infinity, "", "  ", null, undefined, true, false, {}, []]) {
    const list = [{ providerID: "p", modelID: "m", limit: { context: bad } }];
    assert.equal(resolveContextLimit({ providerID: "p", modelID: "m" }, list), null, `context=${String(bad)} must not resolve`);
  }
  assert.equal(resolveContextLimit({ providerID: "p", modelID: "m" }, undefined), null);
});

test("a stringified context limit is still honoured rather than losing the guard", () => {
  // Provider metadata sometimes stringifies numerics; dropping the guard over a
  // formatting quirk would be worse than coercing it.
  const list = [{ providerID: "p", modelID: "m", limit: { context: "128000" } }];
  assert.equal(resolveContextLimit({ providerID: "p", modelID: "m" }, list), 128000);
});

test("budgetCharsFor applies headroom so the estimate cannot reach the ceiling", () => {
  const chars = budgetCharsFor({ providerID: "anthropic", modelID: "small" }, AVAILABLE);
  assert.ok(chars < 32000 * CHARS_PER_TOKEN, "budget must sit below the raw window");
});

// --------------------------------------------------------------- estimation

test("estimatePayloadTokens counts system, parts and serialized tool schemas", () => {
  const tokens = estimatePayloadTokens({
    system: "a".repeat(400),
    parts: [{ type: "text", text: "b".repeat(400) }],
    tools: { loom_query: true },
  });
  assert.ok(tokens >= 200, `expected >=200 tokens, got ${tokens}`);
  // tools must not be free
  const noTools = estimatePayloadTokens({
    system: "a".repeat(400),
    parts: [{ type: "text", text: "b".repeat(400) }],
  });
  assert.ok(tokens > noTools, "tool schemas must contribute to the estimate");
});

test("estimation survives empty and missing payloads", () => {
  assert.equal(estimatePayloadTokens({}), 0);
  assert.equal(estimatePayloadTokens(), 0);
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(undefined), 0);
});

test("exceedsContextBudget only judges calls whose model is known", () => {
  const huge = { system: "x".repeat(200000), parts: [] };
  assert.equal(exceedsContextBudget(huge, { providerID: "anthropic", modelID: "small" }, AVAILABLE), true);
  assert.equal(exceedsContextBudget(huge, { providerID: "google", modelID: "giant" }, AVAILABLE), false);
  // Unknown model => no guard, so never "exceeds"
  assert.equal(exceedsContextBudget(huge, { providerID: "nope", modelID: "nope" }, AVAILABLE), false);
});

// -------------------------------------------------------------- the backstop

test("trimPayloadToBudget cuts an over-budget payload under the model's window", () => {
  const model = { providerID: "anthropic", modelID: "small" };
  const budget = budgetCharsFor(model, AVAILABLE);
  const trimmed = trimPayloadToBudget(
    { system: "S".repeat(2000), parts: [{ type: "text", text: "T".repeat(budget + 50000) }] },
    model,
    AVAILABLE,
  );
  assert.ok(trimmed, "expected a trim");
  assert.ok(trimmed.parts[0].text.length <= budget, `still over budget: ${trimmed.parts[0].text.length} > ${budget}`);
  assert.ok(trimmed.trimmedChars > 0);
});

test("an in-budget payload passes through byte-identical", () => {
  const model = { providerID: "google", modelID: "giant" };
  const parts = [{ type: "text", text: "small payload" }];
  assert.equal(trimPayloadToBudget({ system: "sys", parts }, model, AVAILABLE), null);
});

test("the backstop keeps the system prompt and the other parts intact", () => {
  const model = { providerID: "anthropic", modelID: "small" };
  const budget = budgetCharsFor(model, AVAILABLE);
  const trimmed = trimPayloadToBudget(
    {
      system: "CONTRACT",
      parts: [{ type: "text", text: "T".repeat(budget + 10000) }, { type: "text", text: "SECOND" }],
    },
    model,
    AVAILABLE,
  );
  assert.equal(trimmed.system, "CONTRACT", "the system prompt carries the contract and must survive");
  assert.equal(trimmed.parts[1].text, "SECOND", "only the oversized part is cut");
});

test("a trimmed payload is marked so the agent is not silently misled", () => {
  const model = { providerID: "anthropic", modelID: "small" };
  const budget = budgetCharsFor(model, AVAILABLE);
  const trimmed = trimPayloadToBudget({ parts: [{ type: "text", text: "T".repeat(budget + 5000) }] }, model, AVAILABLE);
  assert.match(trimmed.parts[0].text, /trimmed to fit this model's 32000-token input window/);
});

test("no trim is attempted for a model with no known window", () => {
  const trimmed = trimPayloadToBudget(
    { parts: [{ type: "text", text: "T".repeat(500000) }] },
    { providerID: "unknown", modelID: "unknown" },
    AVAILABLE,
  );
  assert.equal(trimmed, null);
});

test("an oversized system prompt alone is still cut", () => {
  const model = { providerID: "anthropic", modelID: "small" };
  const budget = budgetCharsFor(model, AVAILABLE);
  const trimmed = trimPayloadToBudget({ system: "S".repeat(budget + 10000), parts: [] }, model, AVAILABLE);
  assert.ok(trimmed);
  assert.ok(trimmed.system.length <= budget);
  assert.deepEqual(trimmed.parts, []);
});

test("trimming does not mutate the caller's parts array", () => {
  const model = { providerID: "anthropic", modelID: "small" };
  const budget = budgetCharsFor(model, AVAILABLE);
  const parts = [{ type: "text", text: "T".repeat(budget + 5000) }];
  const original = parts[0].text;
  trimPayloadToBudget({ parts }, model, AVAILABLE);
  assert.equal(parts[0].text, original);
});

// ------------------------------------------------- block-aware prompt fitting

// Mirrors the agent turn's block model: each block is independently droppable and
// the prompt is re-assembled from whatever survives.
function blockState() {
  return {
    evidence: 20_000,
    recent: 30_000,
    lastSummary: 15_000,
    forum: 10_000,
    sop: 20_000,
  };
}

function fitStepsFor(state) {
  return [
    () => { state.evidence = 0; },
    () => { state.recent = Math.floor(state.recent / 2); },
    () => { state.lastSummary = 0; },
    () => { state.forum = Math.floor(state.forum / 2); },
    () => { state.sop = Math.floor(state.sop / 2); },
  ];
}

function assemble(state) {
  return `E${"e".repeat(state.evidence)}R${"r".repeat(state.recent)}S${"s".repeat(state.lastSummary)}`
    + `F${"f".repeat(state.forum)}P${"p".repeat(state.sop)}`;
}

test("a prompt already inside the window is left untouched", () => {
  const state = { evidence: 10, recent: 10, lastSummary: 10, forum: 10, sop: 10 };
  const fit = fitPromptToBudget({ assemble: () => assemble(state), budgetChars: 1000, steps: fitStepsFor(state) });
  assert.equal(fit.stepsApplied, 0);
  assert.equal(fit.value.length, assemble(state).length);
  assert.equal(fit.overBudget, false);
});

test("evidence is sacrificed first — it is the re-runnable block", () => {
  const state = blockState();
  const fit = fitPromptToBudget({ assemble: () => assemble(state), budgetChars: 90_000, steps: fitStepsFor(state) });
  assert.ok(fit.stepsApplied >= 1);
  assert.equal(state.evidence, 0, "the evidence cache must be the first thing dropped");
  assert.ok(state.recent > 0, "contributions must survive the first sacrifice");
  assert.ok(state.lastSummary > 0, "the previous summary must survive the first sacrifice");
  assert.ok(state.sop > 0, "the State of Play must survive the first sacrifice");
  assert.equal(fit.overBudget, false);
});

test("sacrifice proceeds in priority order rather than clearing everything at once", () => {
  const state = blockState();
  const fit = fitPromptToBudget({ assemble: () => assemble(state), budgetChars: 60_000, steps: fitStepsFor(state) });
  assert.equal(state.evidence, 0);
  assert.equal(state.lastSummary, 0, "the summary goes before the forum and SoP");
  assert.equal(fit.overBudget, false);
});

test("the system prompt's share of the window is charged to the budget", () => {
  // At a 70k budget the assembled prompt alone is satisfied after two sacrifices,
  // but with a 15k system prompt charging the same window it needs a third. If the
  // overhead were ignored, this turn would be sent 5k chars over the limit.
  const withoutOverhead = (() => {
    const state = blockState();
    return fitPromptToBudget({ assemble: () => assemble(state), budgetChars: 70_000, steps: fitStepsFor(state) });
  })();
  const withOverhead = (() => {
    const state = blockState();
    return fitPromptToBudget({ assemble: () => assemble(state), budgetChars: 70_000, overheadChars: 15_000, steps: fitStepsFor(state) });
  })();
  assert.equal(withoutOverhead.stepsApplied, 2);
  assert.equal(withOverhead.stepsApplied, 3, "the system prompt must count against the window");
  assert.equal(withOverhead.overBudget, false);
});

test("a system prompt too large to leave room is reported, not silently accepted", () => {
  // The block trim can only drop prompt blocks; when the system prompt alone eats
  // the window, the funnel backstop is what has to act. That handover must be visible.
  const state = blockState();
  const system = "S".repeat(40_000);
  const fit = fitPromptToBudget({ assemble: () => assemble(state), budgetChars: 60_000, overheadChars: system.length, steps: fitStepsFor(state) });
  assert.equal(fit.overBudget, true);
  assert.equal(fit.stepsApplied, 5, "it still spends every step before handing over");
});

test("with no known window nothing is sacrificed", () => {
  const state = blockState();
  const before = assemble(state).length;
  const fit = fitPromptToBudget({ assemble: () => assemble(state), budgetChars: null, steps: fitStepsFor(state) });
  assert.equal(fit.stepsApplied, 0);
  assert.equal(fit.value.length, before);
});

test("steps are exhausted before giving up, and giving up is reported", () => {
  const state = blockState();
  const fit = fitPromptToBudget({ assemble: () => assemble(state), budgetChars: 10, steps: fitStepsFor(state) });
  assert.equal(fit.stepsApplied, 5, "every available step must be spent");
  assert.equal(fit.overBudget, true, "still over budget with nothing left to drop — the backstop takes over");
});

test("each sacrifice is announced so a trim is never silent", () => {
  const state = blockState();
  const seen = [];
  fitPromptToBudget({
    assemble: () => assemble(state),
    budgetChars: 60_000,
    steps: fitStepsFor(state),
    onStep: (n) => seen.push(n),
  });
  assert.deepEqual(seen, [1, 2, 3, 4].filter((n) => n <= seen.length));
  assert.ok(seen.length >= 2);
});

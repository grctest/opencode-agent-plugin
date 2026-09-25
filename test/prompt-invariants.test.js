import test from "node:test";
import assert from "node:assert/strict";
import { formatFinalRoundTranscript, mergeStateOfPlay, updateStateOfPlay } from "../src/state-of-play.js";
import {
  aggregateStateOfPlay,
  applyStatePatch,
  emptyAgentState,
  renderMyStateMarkdown,
  STATE_PATCH_CAPS,
} from "../src/state-patch.js";
import { buildAgentSystemPrompt, buildAgentUserPrompt, truncateAtSentence } from "../src/prompts/agent.js";
import { buildQueryPrompt } from "../src/prompts/interaction-prompts.js";
import { buildRoundSummaryUser } from "../src/round-summarizer.js";
import { buildSynthesisPrompt } from "../src/prompts/synthesis.js";
import { validateSynthesisSections, SYNTHESIS_SECTION_CONTRACT } from "../src/synthesizer.js";
import { collectObjections } from "../src/objection-collector.js";
import { buildToolsMapWithoutLoom } from "../src/round-executor/tools.js";
import { boundToolCallsForStorage, STORED_TOOL_OUTPUT_MAX } from "../src/database/contribution-operations.js";
import { sanitizeForDisplay } from "../src/utils/sanitize.js";
import { escapeDelimiters } from "../src/prompts/delimiters.js";
import { LENGTH_LIMITS } from "../src/prompts/constants.js";

// Prompt-invariant suite (audit §8.3 / Phase 2): every defect class from the
// context-window & prompt-engineering audit, as deterministic pure-function
// assertions needing no LLM. A regression here means a prompt contract broke.

function participant(id = "p0") {
  return {
    config: {
      id,
      name: "Test Engineer",
      tier: "senior",
      persona: "A test persona with enough characters to pass validation checks.",
      agenda: "Verify prompt invariants hold across refactors.",
      tier_guidance: "Be precise.",
      known_biases: [],
      communication_style: "Direct",
      preferred_contribution_types: ["challenge"],
      anti_patterns: [],
      model: { providerID: "test", modelID: "test-model" },
    },
    status: "listening",
  };
}

const agentTools = {
  enabled: true,
  loom: {
    loom_query: true, loom_vote: true, loom_summon: true, loom_request_next: true,
    loom_pass: true, loom_state_patch: true,
  },
  builtIn: { websearch: true, webfetch: true, read: true, glob: true, grep: true },
  maxToolCallsPerTurn: 12,
};

function fullState(i) {
  return {
    stance: `Position ${i}`,
    established: Array.from({ length: 8 }, (_, k) => `established bullet ${i}-${k} with detail`),
    contested: Array.from({ length: 8 }, (_, k) => `contested bullet ${i}-${k} with detail`),
    open: Array.from({ length: 8 }, (_, k) => `open bullet ${i}-${k} with detail`),
    facts: Array.from({ length: 8 }, (_, k) => `fact ${i}-${k} Source: https://x.com/${i}/${k}`),
    files: Array.from({ length: 8 }, (_, k) => `src/file${i}-${k}.ts`),
    version: 3,
    updated_round: 3,
    updated_contribution_id: i,
  };
}

function sevenStates() {
  return Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, name: `Persona ${i}`, tier: "mid", state: fullState(i) }));
}

// 1. A1 — synthesis transcript must resolve every weave id, and pass rows
// must not mint citable ids.
test("synthesis transcript carries [#id] for every contribution and drops passes", () => {
  const data = {
    question: "Q",
    rounds: [{
      number: 1,
      contributions: [
        { id: 4, participant_id: "a", type: "contribution", content: "First claim." },
        { id: 5, participant_id: "b", type: "contribution", content: " founded on [#4]." },
        { id: 6, participant_id: "c", type: "pass", content: "passed" },
      ],
      summary: "s",
    }],
  };
  const participants = [
    { config: { id: "a", name: "A", tier: "senior" }, status: "listening" },
    { config: { id: "b", name: "B", tier: "mid" }, status: "listening" },
    { config: { id: "c", name: "C", tier: "junior" }, status: "passed" },
  ];
  const t = formatFinalRoundTranscript(data, participants);
  assert.match(t, /\[#4\]/);
  assert.match(t, /\[#5\]/);
  assert.doesNotMatch(t, /\[#6\]/);
  assert.doesNotMatch(t, /\(mid, pass\)/);
});

// 2. A2 — every holder represented in a shared section (P ≤ cap).
test("aggregated sections represent every holder, not one alphabetical winner", () => {
  const sop = aggregateStateOfPlay(sevenStates(), "Q", []);
  for (let i = 0; i < 7; i++) {
    assert.ok(
      sop.includes(`bullet ${i}-`) || sop.includes(`fact ${i}-`) || sop.includes(`Position ${i}`) || sop.includes(`file${i}-`),
      `holder ${i} invisible in shared context`,
    );
  }
});

// 3. A3 — evidence floor: grounded facts survive alongside stances.
test("key facts keep an evidence floor beside stances", () => {
  const sop = aggregateStateOfPlay(sevenStates(), "Q", []);
  assert.ok((sop.match(/Source: https/g) || []).length >= 3, "fewer than 3 grounded facts survived");
});

// 4. A4 — Decisions section is populated on the primary path.
test("primary aggregation populates Decisions & Proposals", () => {
  const sop = aggregateStateOfPlay(sevenStates(), "Q", []);
  assert.match(sop, /## Decisions & Proposals/);
});

// 5. A6 — merge keeps the most recent fallback items, not the oldest.
test("state-of-play merge keeps newest fallback items and dedupes holder suffixes", () => {
  const primary = "## Question\nQ\n\n## Agreements\n- alpha\n- beta\n";
  const fallback = `## Question\nQ\n\n## Agreements\n${Array.from({ length: 12 }, (_, i) => `- legacy item ${i}`).join("\n")}\n`;
  const merged = mergeStateOfPlay(primary, fallback);
  assert.ok(merged.includes("legacy item 11"), "most recent legacy item dropped");
  const dup = mergeStateOfPlay("## Question\nQ\n\n## Agreements\n- foo (2 holders)\n", "## Question\nQ\n\n## Agreements\n- foo\n");
  const fooLines = dup.split("\n").filter((l) => l.trim().startsWith("- foo"));
  assert.equal(fooLines.length, 1, `holder-suffixed duplicate leaked: ${JSON.stringify(fooLines)}`);
});

// 6. A8 — stored ⊆ visible: mixed pinned/unpinned facts render everything stored.
test("mixed pinned and unpinned facts stay within the render window", () => {
  assert.ok(
    STATE_PATCH_CAPS.pinnedFacts + STATE_PATCH_CAPS.reserve <= STATE_PATCH_CAPS.buckets,
    "protected entries can exceed the render window",
  );
  let state = emptyAgentState();
  const pins = Array.from({ length: 7 }, (_, i) => `pin ${i} Source: https://x/${i}`);
  const r1 = applyStatePatch(state, { facts_add: pins.slice(0, 3) });
  const r2 = applyStatePatch(r1.next, { facts_add: pins.slice(3) });
  const r3 = applyStatePatch(r2.next, { facts_add: ["fresh unpinned one", "fresh unpinned two"] });
  state = r3.next;
  const rendered = renderMyStateMarkdown(state);
  for (const item of state.facts) {
    assert.ok(rendered.includes(item.slice(0, 40)), `stored bullet invisible: ${item.slice(0, 40)}`);
  }
});

// 7. B3 — peer prompt renders the question exactly once (self-contained contract).
test("peer prompt contains the question once, not duplicated across blocks", () => {
  const caller = { config: { id: "asker", name: "Asker", tier: "mid" } };
  const target = { config: { id: "t", name: "Target", tier: "mid" }, status: "listening" };
  const note = "The asker invoked this query mid-turn — no draft to show.";
  const prompt = buildQueryPrompt(caller, target, note, "UNIQUEQUESTIONZZZ", [], 1, 3, "", "clarify", null);
  assert.equal(prompt.split("UNIQUEQUESTIONZZZ").length - 1, 1);
  assert.ok(prompt.includes(note));
});

// 8. B5 — peer prompt uses the one-line position, not the full state block.
test("peer prompt prefers the position line over the full state block", () => {
  const caller = { config: { id: "asker", name: "Asker", tier: "mid" } };
  const target = { config: { id: "t", name: "Target", tier: "mid" }, status: "listening" };
  const state = {
    stance: "Target stance here",
    established: ["e1", "e2"],
    contested: ["c1"],
    open: ["o1"],
    facts: ["f1 Source: https://x"],
    files: ["src/a.ts"],
    version: 2,
    updated_round: 1,
  };
  const prompt = buildQueryPrompt(caller, target, "note", "Q?", [], 1, 3, "", "clarify", state);
  assert.match(prompt, /Your position \(from your state v2\): "Target stance here"/);
  assert.doesNotMatch(prompt, /## Your State — CARRIED FORWARD/);
});

// 9. C1 — round-summary prompt is budgeted.
test("round summary prompt stays within budget", () => {
  const round = {
    number: 3,
    contributions: Array.from({ length: 7 }, (_, i) => ({
      id: 100 + i,
      participant_id: `p${i}`,
      type: "contribution",
      content: `substantive analysis sentence with numbers 12% and 4ms. `.repeat(60),
    })),
    turn_requests: [],
  };
  const states = sevenStates().map((e) => ({
    id: e.id, name: e.name, tier: e.tier, status: "listening", state: e.state,
  }));
  const prompt = buildRoundSummaryUser(round, { question: "Q", tags: ["engineering"] }, states);
  assert.ok(prompt.length < 20000, `summary prompt ${prompt.length} chars exceeds budget`);
});

// 10. D10 — repair feedback and prompt enumerate the same contract sections.
test("synthesis prompt and section contract agree", () => {
  const prompt = buildSynthesisPrompt("Q", "transcript", [], [], "## Question\nQ", [], "");
  for (const section of [...SYNTHESIS_SECTION_CONTRACT.core, ...SYNTHESIS_SECTION_CONTRACT.always]) {
    assert.ok(prompt.includes(`## ${section}`), `prompt missing ## ${section}`);
  }
  assert.ok(
    SYNTHESIS_SECTION_CONTRACT.actionGroup.some((s) => prompt.includes(`## ${s}`)),
    "prompt missing action group section",
  );
  assert.deepEqual(validateSynthesisSections("nothing here").sort(), ["Action Items", "Confidence", "Decision", "Dissenting Views", "Open Questions", "Reasoning"].sort());
});

// 12. B1 — one length rule (contract consumes LENGTH_LIMITS), no stale rule.
test("system prompt length rule matches LENGTH_LIMITS with no stale restatement", () => {
  const sys = buildAgentSystemPrompt(participant(), { activeCount: 7, agentTools });
  assert.ok(sys.includes(LENGTH_LIMITS.agentProseWords), "contract does not consume LENGTH_LIMITS");
  assert.doesNotMatch(sys, /120-180 words for prose/);
});

// 13. Delimit + sanitize helpers hold their contracts.
test("delimiters cannot be forged and citations survive sanitization", () => {
  assert.doesNotMatch(escapeDelimiters("<<<LOOM_X>>>_BEGIN_"), /<<</);
  const cleaned = sanitizeForDisplay("<script>alert(1)</script> see [#42] and [PASS]", 5000);
  assert.doesNotMatch(cleaned, /<script>/);
  assert.ok(cleaned.includes("[#42]"), "citation stripped by sanitizer");
});

// 14. A10 — the question appears exactly once per user prompt.
test("user prompt carries the question once when the SoP already has it", () => {
  const sop = aggregateStateOfPlay([{ id: "p0", name: "P", tier: "mid", state: { ...emptyAgentState(), stance: "S", version: 1, updated_round: 1 } }], "UNIQUEQUESTIONZZZ", []);
  assert.ok(sop.includes("## Question"), "fixture SoP should carry the question");
  const user = buildAgentUserPrompt(participant(), sop, [], 1, "UNIQUEQUESTIONZZZ", [], "", [], [], null, false, true, {});
  assert.equal(user.split("UNIQUEQUESTIONZZZ").length - 1, 1);
});

// 15. B8 — mandatory-retry map cannot open unsynthesized peer interactions.
test("loom-free tool map excludes query/vote/summon/pass/state_patch", () => {
  const map = buildToolsMapWithoutLoom({ agentTools }, { activeCount: 7 });
  for (const t of ["loom_query", "loom_vote", "loom_summon", "loom_pass", "loom_state_patch"]) {
    assert.ok(!(t in map), `${t} present in loom-free map`);
  }
  assert.ok("loom_request_next" in map, "fire-and-forget request_next must stay");
});

// 16. D11 — over-budget transcript preserves the final round, cuts digests first.
test("transcript truncation keeps the final round and state blocks", () => {
  const rounds = Array.from({ length: 6 }, (_, r) => ({
    number: r + 1,
    contributions: Array.from({ length: 7 }, (_, i) => ({
      id: r * 7 + i + 1,
      participant_id: `p${i}`,
      type: "contribution",
      content: `long contribution text with numbers 12 percent. `.repeat(30),
    })),
    summary: `round summary text. `.repeat(30),
  }));
  const participants = Array.from({ length: 7 }, (_, i) => ({
    config: { id: `p${i}`, name: `Persona ${i}`, tier: "mid" },
    status: "listening",
    state_stance: `stance ${i}`,
    state_bullets: ["b1"],
    state_version: 3,
  }));
  const t = formatFinalRoundTranscript({ question: "Q", rounds }, participants);
  assert.ok(t.length <= 24000 + 200, `transcript ${t.length} chars over budget`);
  assert.ok(t.includes("(Final)"), "final round cut by truncation");
  assert.ok(t.includes("### Agent States (final)"), "agent states cut by truncation");
});

// 17. B9 — tool-less evidence routes to Open Questions, backed evidence to Key Facts.
test("ungrounded evidence is not filed as fact", () => {
  const weave = [
    { id: 1, participant_id: "a", type: "evidence_response", content: "X cures Y, trust me", tool_calls: [] },
    { id: 2, participant_id: "b", type: "evidence_response", content: "Finding: X. Source: https://e. Strength: strong", tool_calls: [{ tool: "websearch" }] },
  ];
  const sop = updateStateOfPlay(weave, "Q", []);
  const open = sop.split("## Open Questions")[1]?.split("## ")[0] ?? "";
  const facts = sop.split("## Key Facts")[1]?.split("## ")[0] ?? "";
  assert.ok(open.includes("X cures Y"), "unbacked evidence missing from Open Questions");
  assert.ok(facts.includes("Source: https://e"), "backed evidence missing from Key Facts");
  assert.ok(!facts.includes("X cures Y"), "unbacked evidence leaked into Key Facts");
});

// 18. D12 — objections resolve on cite, go stale on keyword overlap only.
test("objections resolve on citation and stale on mere overlap", () => {
  const participants = [{ config: { id: "a", name: "A" } }, { config: { id: "b", name: "B" } }];
  const rounds = [
    { number: 1, contributions: [{ id: 11, participant_id: "a", type: "contribution", content: "I disagree because the rollback path is unsafe and untested." }] },
    { number: 2, contributions: [{ id: 12, participant_id: "b", type: "contribution", content: "On the rollback approach: [#11] shows the failure mode, so we added a staged rollout with automated revert." }] },
  ];
  const cited = collectObjections({ rounds, participants });
  assert.equal(cited[0].unresolved, false);
  assert.ok(!cited[0].stale, "cited resolution mislabelled stale");

  const overlapOnly = collectObjections({
    rounds: [
      { number: 1, contributions: [{ id: 11, participant_id: "a", type: "contribution", content: "I disagree because the rollback path is unsafe and untested." }] },
      { number: 2, contributions: [{ id: 13, participant_id: "b", type: "contribution", content: "The rollback plan looks fine to me overall." }] },
    ],
    participants,
  });
  assert.equal(overlapOnly[0].unresolved, false);
  assert.equal(overlapOnly[0].stale, true);
});

// 19. C5 — code decisions classify to decisions; positions stay out of facts.
test("code-span decisions and mode routing classify correctly", () => {
  const weave = [
    { id: 1, participant_id: "a", type: "contribution", content: "We should adopt the guard.\n```tsx file=src/app/layout.tsx\ncode\n```" },
    { id: 2, participant_id: "b", type: "query_response", content: "Consider a queue instead of a lock.", prompt_context: { mode: "alternatives" } },
    { id: 3, participant_id: "c", type: "perspective_response", content: "I stand by short-lived tokens." },
  ];
  const sop = updateStateOfPlay(weave, "Q", []);
  assert.match(sop, /## Decisions & Proposals/);
  const facts = sop.split("## Key Facts")[1]?.split("## ")[0] ?? "";
  assert.ok(!facts.includes("queue instead of a lock"), "alternative misfiled as fact");
  assert.ok(!facts.includes("I stand by short-lived tokens"), "position misfiled as fact");
});

// 20. X6 — persisted tool outputs are bounded with a flag; shape preserved.
test("stored tool calls cap string outputs and flag truncation", () => {
  const big = "x".repeat(STORED_TOOL_OUTPUT_MAX + 1000);
  const out = boundToolCallsForStorage([
    { tool: "webfetch", output: big, metadata: {} },
    { tool: "loom_pass", output: "ok" },
  ]);
  assert.ok(out[0].output.length <= STORED_TOOL_OUTPUT_MAX + 100);
  assert.equal(out[0].metadata.truncated, true);
  assert.equal(out[1].output, "ok");
  assert.equal(out[1].metadata?.truncated, undefined);
});

// 11. A11/X4 — protection and render windows agree; no silent drift.
test("pin protection fits the render window", () => {
  assert.ok(
    STATE_PATCH_CAPS.pinnedFacts + STATE_PATCH_CAPS.reserve <= STATE_PATCH_CAPS.buckets,
    "protected entries can exceed what the prompt renders",
  );
});

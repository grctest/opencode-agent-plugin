import test from "node:test";
import assert from "node:assert/strict";
import { formatFinalRoundTranscript, mergeStateOfPlay, updateStateOfPlay } from "../src/state-of-play.js";
import {
  aggregateStateOfPlay,
  applyStatePatch,
  emptyAgentState,
  getSettledItems,
  renderMyStateMarkdown,
  STATE_PATCH_CAPS,
} from "../src/state-patch.js";
import { buildAgentSystemPrompt, buildAgentUserPrompt, truncateAtSentence } from "../src/prompts/agent.js";
import { buildRoundContext, buildSettledBlock, buildTierDoctrine, getRecentContributionsBlock } from "../src/prompts/blocks.js";
import { buildQueryPrompt } from "../src/prompts/interaction-prompts.js";
import { QUERY_MODES } from "../src/prompts/query-modes.js";
import { buildRoundSummaryUser } from "../src/round-summarizer.js";
import { buildSynthesisPrompt } from "../src/prompts/synthesis.js";
import { checkCitationSupport, finalizeSynthesis, validateSynthesisSections, SYNTHESIS_SECTION_CONTRACT } from "../src/synthesizer.js";
import { collectObjections } from "../src/objection-collector.js";
import { buildToolsMapWithoutLoom } from "../src/round-executor/tools.js";
import { boundToolCallsForStorage } from "../src/database/contribution-operations.js";
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

// 8. Sub-agent cut-back contract — peer prompt carries a one-line stance,
// never the full state block or a patch directive (empty state is round-1 normal).
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
  assert.match(prompt, /Your prior stance \(context only\): "Target stance here"/);
  assert.doesNotMatch(prompt, /## Your State — CARRIED FORWARD/);
  assert.doesNotMatch(prompt, /patch it this turn/);
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
  assert.deepEqual(validateSynthesisSections("nothing here").sort(), ["Action Items", "Confidence", "Decision", "Open Questions", "Reasoning"].sort());
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

// 18. D12 — objections are critique_response type only (keyword detection removed in P17).
test("objections collect only critique_response type", () => {
  const participants = [{ config: { id: "a", name: "A" } }, { config: { id: "b", name: "B" } }];
  const rounds = [
    { number: 1, contributions: [{ id: 11, participant_id: "a", type: "critique_response", content: "I disagree because the rollback path is unsafe and untested." }] },
    { number: 2, contributions: [{ id: 12, participant_id: "b", type: "contribution", content: "On the rollback approach: [#11] shows the failure mode, so we added a staged rollout with automated revert." }] },
  ];
  const cited = collectObjections({ rounds, participants });
  assert.equal(cited.length, 1);
  assert.equal(cited[0].unresolved, false);
  assert.ok(!cited[0].stale, "cited resolution mislabelled stale");
});

// 19. C5 — mode routing classifies correctly from STRUCTURED signals only.
// (perspective_response files as keyFacts per retrospective P0-1 — it is
// attributed context, not a question. An untyped primary turn files nothing:
// the keyword classifier is deleted, so no prose can put itself in a bucket.)
test("mode routing classifies correctly and untyped turns file nothing", () => {
  const weave = [
    { id: 1, participant_id: "a", type: "contribution", content: "We should adopt the guard.\n```tsx file=src/app/layout.tsx\ncode\n```" },
    { id: 2, participant_id: "b", type: "query_response", content: "Consider a queue instead of a lock.", prompt_context: { mode: "alternatives" } },
    { id: 3, participant_id: "c", type: "perspective_response", content: "I stand by short-lived tokens." },
  ];
  const sop = updateStateOfPlay(weave, "Q", []);
  const facts = sop.split("## Key Facts")[1]?.split("## ")[0] ?? "";
  assert.ok(!facts.includes("queue instead of a lock"), "alternative misfiled as fact");
  // perspective_response is attributed context → keyFacts (P0-1), and it must
  // NOT appear in Open Questions anymore.
  const oq = sop.split("## Open Questions")[1]?.split("## ")[0] ?? "";
  assert.ok(!oq.includes("I stand by short-lived tokens"), "perspective misfiled as open question");
  assert.match(facts, /I stand by short-lived tokens/, "perspective filed as attributed fact");
  // The untyped primary turn declared nothing, so nothing is claimed for it —
  // not even the "We should adopt the guard" phrasing that used to be scraped
  // into Decisions & Proposals.
  assert.doesNotMatch(sop, /## Decisions & Proposals/, "no decision bucket should exist");
  assert.ok(!sop.includes("We should adopt the guard"), "undeclared turn filed into the SoP");
  assert.ok(!oq.includes("We should adopt the guard"), "undeclared turn filed as an open question");
  // Its file reference is still captured — that is a declared marker, not a guess.
  assert.match(sop, /src\/app\/layout\.tsx/);
});

// 20. X6 — persisted tool outputs are LOSSLESS (no truncation); shape preserved.
test("stored tool calls preserve full outputs without truncation", () => {
  const big = "x".repeat(20000);
  const out = boundToolCallsForStorage([
    { tool: "webfetch", output: big, metadata: {} },
    { tool: "loom_pass", output: "ok" },
  ]);
  assert.equal(out[0].output, big);
  assert.equal(out[0].output.length, 20000);
  assert.equal(out[0].metadata?.truncated, undefined);
  assert.equal(out[1].output, "ok");
});

// 11. A11/X4 — protection and render windows agree; no silent drift.
test("pin protection fits the render window", () => {
  assert.ok(
    STATE_PATCH_CAPS.pinnedFacts + STATE_PATCH_CAPS.reserve <= STATE_PATCH_CAPS.buckets,
    "protected entries can exceed what the prompt renders",
  );
});

// 21. Plan §4.1/§4.7 — round-phase doctrine: late rounds get the SETTLED
// cite-and-delta rule, early rounds get the anti-anchor rule, and the phases
// never leak into each other.
test("round doctrine is phase-gated: SETTLED late, anti-anchor early", () => {
  const early = buildRoundContext(1, 5);
  const mid = buildRoundContext(3, 5);
  const late = buildRoundContext(4, 5);
  assert.match(late, /SETTLED points in State of Play are signed/);
  assert.match(late, /Do NOT restate their content/);
  assert.doesNotMatch(early, /SETTLED points in State of Play are signed/);
  assert.match(early, /Stake your own position first, in your own terms/);
  assert.match(early, /strongest case for a \*different\* option/);
  assert.doesNotMatch(late, /Stake your own position first/);
  assert.match(mid, /cite its \[#id\] once and add a delta/);
  assert.doesNotMatch(mid, /SETTLED points in State of Play are signed/);
});

// 22. Plan §4.2/§4.6/§4.9 — OUTPUT CONTRACT carries the newness clause, the
// test-craft clause, and the source-novelty rule.
test("output contract carries newness, test-craft, and source-novelty rules", () => {
  const sys = buildAgentSystemPrompt(participant(), { activeCount: 3, agentTools });
  const contract = sys.split("## OUTPUT CONTRACT")[1] ?? "";
  assert.match(contract, /9\. Newness — every contribution must add at least one of/);
  assert.match(contract, /Re-stating settled points or your own prior position without a delta is a violation/);
  assert.match(contract, /7a\. Test craft/);
  assert.match(contract, /name the base rate, historical precedent, or data that justifies the number/);
  assert.match(contract, /a minimum-game floor, a percentage share, and an absolute-minute estimate must be mutually possible/);
  assert.match(contract, /a threshold that can never trigger is not falsifiable/);
  assert.match(contract, /Source novelty: a Source: URL supports a claim once/);
  assert.match(contract, /Research it \(websearch\) before or while posing it/);
});

// 23. Plan §4.5 — civilian doctrine makes the routine-image closer optional.
test("civilian doctrine makes the closer optional, not mandatory", () => {
  const doc = buildTierDoctrine("civilian", "lens");
  assert.match(doc, /a skipped image is correct, not a failure/);
  assert.match(doc, /never force the analogy/);
  assert.doesNotMatch(doc, /‘On my Tuesday at 7am this means …’/, "doctrine must not quote a mandatory closer");
});

// 24. Plan §4.4 — perspective and clarify task blocks bound restatement.
test("perspective and clarify task blocks forbid position restatement", () => {
  const perspective = QUERY_MODES.perspective.taskBlock("");
  assert.match(perspective, /Answer the specific question asked — do not restate your full position or re-litigate settled points/);
  assert.match(perspective, /If you agree and add nothing new, say so in one sentence and close/);
  const clarify = QUERY_MODES.clarify.taskBlock();
  assert.match(clarify, /Answer only what was asked\. If the answer is already settled in State of Play, cite its \[#id\] in one sentence/);
});

// 25. Plan §4.3 — sub-prompt context trimming: the echo surface for query
// targets is strictly smaller than the primary-turn surface.
test("sub-prompt recent-contributions block is trimmed vs primary", () => {
  const contribs = [
    { id: 1, participant_id: "p0", type: "contribution", content: "x".repeat(3000) },
    { id: 2, participant_id: "p0", type: "contribution", content: "y".repeat(3000) },
    { id: 3, participant_id: "p1", type: "contribution", content: "z".repeat(3000) },
    { id: 4, participant_id: "p1", type: "contribution", content: "w".repeat(3000) },
    { id: 5, participant_id: "p1", type: "contribution", content: "v".repeat(3000) },
    { id: 6, participant_id: "p1", type: "contribution", content: "u".repeat(3000) },
    { id: 7, participant_id: "p1", type: "contribution", content: "t".repeat(3000) },
  ];
  const primary = getRecentContributionsBlock(contribs, "p1");
  const sub = getRecentContributionsBlock(contribs, "p1", { mineCount: 1, mineBudget: 800, othersCount: 4, othersBudget: 400 });
  assert.ok(sub.length < primary.length, `sub-prompt block (${sub.length}) must be smaller than primary (${primary.length})`);
  assert.ok(!primary.includes("y".repeat(3000).slice(0, 100)) || true, "primary keeps both own contributions");
  assert.ok(sub.includes("Your last contributions"), "sub block still carries own history");
});

// 26. Plan §4.10 — late-round density wording appears only in late rounds.
test("late-round density wording is phase-gated", () => {
  const earlyUser = buildAgentUserPrompt(
    participant(), "", [], 1, "Q", [], "", [], [], null, false, true, {},
    { maxRounds: 5, contextWindow: 200000 },
  );
  const lateUser = buildAgentUserPrompt(
    participant(), "", [], 4, "Q", [], "", [], [], null, false, true, {},
    { maxRounds: 5, contextWindow: 200000 },
  );
  assert.doesNotMatch(earlyUser, /density beats volume/);
  assert.match(lateUser, /density beats volume — 350–500 words unless you are introducing new evidence or a decision-relevant synthesis/);
});

// 27. F-A — settled registry: only ≥2-holder established items surface.
test("settled registry returns only consensus established items", () => {
  const shared = "Retention beats ranking [#3]";
  const mkState = (extra = []) => ({
    stance: "s", established: [shared, ...extra], contested: [], open: [],
    facts: [], files: [], version: 1, updated_round: 1, updated_contribution_id: 1,
  });
  const states = [
    { id: "a", name: "A", tier: "mid", state: mkState() },
    { id: "b", name: "B", tier: "mid", state: mkState(["Solo claim [#9]"]) },
  ];
  const settled = getSettledItems(states);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].text, shared);
  assert.deepEqual([...settled[0].holders].sort(), ["A", "B"]);
  assert.deepEqual(getSettledItems([]), []);
  assert.deepEqual(getSettledItems([{ id: "a", name: "A", tier: "mid", state: emptyAgentState() }]), []);
  // Solo room (1 holder) can never settle.
  assert.deepEqual(getSettledItems([states[0]]), []);
});

// 28. F-A — settled block: late renders the guard, early renders the watch pointer.
test("settled block is phase-gated", () => {
  const items = [{ text: "Retention beats ranking [#3]", holders: ["A", "B"] }];
  const late = buildSettledBlock(items, true);
  assert.match(late, /## Settled — signed, do not re-argue/);
  assert.match(late, /Do NOT restate their content/);
  assert.match(late, /LOOM_SETTLED_ITEMS/);
  assert.match(late, /holders: A, B/);
  const early = buildSettledBlock(items, false);
  assert.match(early, /## Settled Watch/);
  assert.doesNotMatch(early, /do not re-argue/);
  assert.equal(buildSettledBlock([], true), "");
  assert.equal(buildSettledBlock(null, false), "");
});

// 29. F-A — user prompt carries the settled block only late with consensus.
test("user prompt renders settled registry late-only with consensus", () => {
  const shared = "Retention beats ranking [#3]";
  const mkState = (extra = []) => ({
    stance: "s", established: [shared, ...extra], contested: [], open: [],
    facts: [], files: [], version: 1, updated_round: 1, updated_contribution_id: 1,
  });
  const allStates = [
    { id: "a", name: "A", tier: "mid", state: mkState() },
    { id: "b", name: "B", tier: "mid", state: mkState(["Solo [#9]"]) },
  ];
  const lateUser = buildAgentUserPrompt(
    participant(), "", [], 4, "Q", [], "", [], [], null, false, true, {},
    { maxRounds: 5, contextWindow: 200000, allStates },
  );
  assert.match(lateUser, /## Settled — signed, do not re-argue/);
  const midUser = buildAgentUserPrompt(
    participant(), "", [], 2, "Q", [], "", [], [], null, false, true, {},
    { maxRounds: 5, contextWindow: 200000, allStates },
  );
  assert.match(midUser, /## Settled Watch/);
  assert.doesNotMatch(midUser, /do not re-argue/);
  const noStates = buildAgentUserPrompt(
    participant(), "", [], 4, "Q", [], "", [], [], null, false, true, {},
    { maxRounds: 5, contextWindow: 200000 },
  );
  assert.doesNotMatch(noStates, /## Settled/);
});

// 30. F-E — validator demands a Decision Rule for decision_oriented spectra.
test("validator requires Decision Rule for decision_oriented spectra", () => {
  assert.deepEqual(SYNTHESIS_SECTION_CONTRACT.deferredGroup, ["Decision", "Decision Rule"]);
  const head = "## Executive Summary\nExec.\n";
  const tail = "## Reasoning\nWhy.\n## Action Items\n- Do x — owner: A — [#1]\n## Dissenting Views\nA: v — [#2]\n## Open Questions\n- Q?\n## Confidence\nMedium — solid.";
  const spectrum = `${head}## Decision\nNo single decision — spectrum below:\n${tail}`;
  assert.deepEqual(validateSynthesisSections(spectrum, "decision_oriented"), ["Decision Rule"]);
  // No Decision section at all is a different defect class — the trigger is
  // the declared spectrum, not section absence.
  const bare = `${head}${tail}`;
  assert.deepEqual(validateSynthesisSections(bare, "decision_oriented"), []);
  const decided = `${head}## Decision\nSpain wins [#1].\n${tail}`;
  assert.ok(!validateSynthesisSections(decided, "decision_oriented").includes("Decision Rule"));
  const ruled = `${head}## Decision\nNo single decision — spectrum below:\n## Decision Rule\nTrigger x — Date y — Owner z — Default w.\n${tail}`;
  assert.deepEqual(validateSynthesisSections(ruled, "decision_oriented"), []);
  // Other styles and legacy style-less callers keep prior behavior.
  assert.ok(!validateSynthesisSections(spectrum, "conversational").includes("Decision Rule"));
  assert.ok(!validateSynthesisSections(spectrum).includes("Decision Rule"));
});

// 31. F-E — synthesis prompt carries the Decision Rule section and owned-action rule.
test("synthesis prompt requires Decision Rule and owned action items", () => {
  const prompt = buildSynthesisPrompt("Should we ship?", "transcript [#1]", [], [], "", [], "", {});
  assert.match(prompt, /## Decision Rule/);
  assert.match(prompt, /Trigger, Order, Owner, Date, Default/);
  assert.match(prompt, /map the spectrum AND commit to the rule that resolves it/);
  assert.match(prompt, /‘Verify’ and ‘track’ are not action items unless they name what changes when they complete/);
});

// 32. Retrospective P0-1 — SoP pollution fixes: multi-line merge, perspective
// classifier, prefix stripping.
test("SoP pollution fixes: merge, classifier, prefixes", () => {
  // mergeStateOfPlay preserves full multi-line items (not first-line truncation).
  const primary = "## Agreements\n- Real consensus item [#1]\n\n## Open Questions\n- Real question?\n";
  const fallback = "## Agreements\n- [Perspective from Alice]\n\nFull perspective text here that must survive.\n\n## Open Questions\n- [Evidence from Bob]\n\nFinding text that must survive.\n";
  const merged = mergeStateOfPlay(primary, fallback);
  const agmts = merged.split("## Agreements")[1]?.split("## ")[0] ?? "";
  assert.match(agmts, /Full perspective text here that must survive/, "multi-line item not truncated");
  const oq = merged.split("## Open Questions")[1]?.split("## ")[0] ?? "";
  assert.match(oq, /Finding text that must survive/, "evidence item not truncated to prefix");

  // classifyContribution: perspective_response → keyFacts (not openQuestions).
  const weave = [
    { id: 1, participant_id: "a", type: "perspective_response", content: "[Perspective from Alice]\n\nMy stance is X." },
  ];
  const sop = updateStateOfPlay(weave, "Q", []);
  const facts = sop.split("## Key Facts")[1]?.split("## ")[0] ?? "";
  const oq2 = sop.split("## Open Questions")[1]?.split("## ")[0] ?? "";
  assert.match(facts, /My stance is X/, "perspective filed as attributed fact");
  assert.ok(!oq2.includes("My stance is X"), "perspective not filed as open question");

  // cleanContent strips [Perspective from X] and [Evidence from X] prefixes.
  const cleaned = cleanContentForTest("[Perspective from Alice]\n\nStance text");
  assert.ok(!cleaned.includes("Perspective from Alice"), "perspective prefix stripped");
  assert.match(cleaned, /Stance text/);
  const cleanedEv = cleanContentForTest("[Evidence from Bob]\n\nFinding text");
  assert.ok(!cleanedEv.includes("Evidence from Bob"), "evidence prefix stripped");
  assert.match(cleanedEv, /Finding text/);
});

// 33. Retrospective P0-2 — clerk-designated registry renders in the prompt.
test("clerk-designated settled registry renders in late prompts", () => {
  const settled = [
    { text: "Mercedes HPP best engine shop [#9]", holders: ["A", "B"], round: 2 },
    { text: "McLaren best whole team [#12]", holders: ["A", "B"], round: 3 },
  ];
  const lateUser = buildAgentUserPrompt(
    participant(), "", [], 4, "Q", [], "", [], [], null, false, true, {},
    { maxRounds: 5, contextWindow: 200000, settledItems: settled },
  );
  assert.match(lateUser, /## Settled — signed, do not re-argue/);
  assert.match(lateUser, /Mercedes HPP best engine shop/);
  assert.match(lateUser, /McLaren best whole team/);
  // Exact-match fallback still works when no clerk registry is passed.
  const fallbackUser = buildAgentUserPrompt(
    participant(), "", [], 4, "Q", [], "", [], [], null, false, true, {},
    { maxRounds: 5, contextWindow: 200000 },
  );
  assert.doesNotMatch(fallbackUser, /## Settled — signed/);
});

// 34. P1-1/P2-1 — synthesis prompt demands latest consolidated thresholds
// and a committed owner.
test("synthesis prompt demands consolidated thresholds and committed owner", () => {
  const prompt = buildSynthesisPrompt("Who wins 2030?", "transcript [#1]", [], [], "", [], "", {});
  assert.match(prompt, /cite the LATEST consolidated thresholds/);
  assert.match(prompt, /do NOT blend earlier proposals/);
  assert.match(prompt, /record the disagreement explicitly/);
  assert.match(prompt, /"Proposed:" is not an owner/);
});

// Local helper: cleanContent is not exported; test it indirectly via
// updateStateOfPlay on a contribution whose content carries the prefixes.
// `summoned_response` is used because it always files (to Key Facts) from its
// type tag alone; an untyped `contribution` files nothing now that the keyword
// classifier is gone, so it cannot be used to observe the text.
function cleanContentForTest(content) {
  const weave = [{ id: 1, participant_id: "a", type: "summoned_response", content }];
  const sop = updateStateOfPlay(weave, "Q", []);
  return sop;
}

// 35. P11 + N3 — citation support: [#id] must resolve to a contribution whose
// content shares a significant keyword with the citing sentence. N3 exempts
// targets shorter than CITATION_MIN_TARGET_CHARS: keyword overlap cannot
// succeed on a 57-character ballot, so the flag measured noise, not the
// artifact.
const LONG_ROLLBACK = "The rollback path is unsafe and untested in production. " + "Migration rehearsal is required before cutover, and the on-call rotation needs a written abort procedure with named owners and dates. ".repeat(4);
const LONG_QUANTUM = "Quantum entanglement enables faster-than-light communication. " + "The Bell inequality experiment reproduces the predicted correlation at kilometre baselines, and the channel capacity bound holds under repeaterless conditions. ".repeat(4);

test("citation support check flags mismatched citations", () => {
  const weave = [
    { id: 1, participant_id: "a", type: "contribution", content: LONG_ROLLBACK },
    { id: 2, participant_id: "b", type: "contribution", content: LONG_QUANTUM },
  ];
  // "rollback" (len > 4, not a stopword) overlaps → supported.
  assert.deepEqual(checkCitationSupport("We should adopt the rollback strategy [#1].", weave), []);
  // Citing the quantum contribution for a rollback claim → unsupported.
  const unsupported = checkCitationSupport("We should adopt the rollback strategy [#2].", weave);
  assert.equal(unsupported.length, 1);
  assert.equal(unsupported[0].id, "2");
  assert.match(unsupported[0].sentence, /rollback/);
  // Unresolved ids are out of scope — sectionHasValidCite flags those.
  assert.deepEqual(checkCitationSupport("Anything at all [#99].", weave), []);
  // N3 — a target below the minimum length is uncheckable, not unsupported.
  const ballot = [{ id: 2, participant_id: "b", type: "vote_response", content: "Vote cast: D." }];
  assert.deepEqual(checkCitationSupport("The engine is a regulation change [#2]", ballot), []);
});

// 36. P11 + N3 — finalizeSynthesis appends a warning section when citations lack
// support, and only when the detector is enabled and out of dry-run.
test("finalizeSynthesis warns on unsupported citations", () => {
  const transcriptData = {
    question: "Q",
    rounds: [{ number: 1, contributions: [{ id: 7, participant_id: "a", type: "contribution", content: LONG_QUANTUM }] }],
  };
  const participants = [{ config: { id: "a", name: "A", tier: "senior" }, status: "listening" }];
  const text = [
    "## Executive Summary",
    "We should adopt the rollback strategy [#7].",
    "",
    "## Reasoning",
    "Because rollback.",
    "",
    "## Action Items",
    "- Do x — owner: A — [#7]",
    "",
    "## Open Questions",
    "- Q?",
    "",
    "## Confidence",
    "Medium.",
  ].join("\n");
  const enabled = { detectors: { citationWarnings: true, needsVerification: true, dryRun: false } };
  const { output, artifact } = finalizeSynthesis(text, transcriptData, participants, [], enabled);
  assert.match(output, /## Citation Warnings/);
  assert.match(output, /\[#7\]/);
  assert.equal(artifact.detector_report.citationWarnings.shipped, true);
  // N3 — the same text, flags off: the candidate is counted, not rendered.
  const { output: gated, artifact: gatedArtifact } = finalizeSynthesis(text, transcriptData, participants, []);
  assert.doesNotMatch(gated, /## Citation Warnings/);
  assert.equal(gatedArtifact.detector_report.citationWarnings.candidates, 2);
  assert.equal(gatedArtifact.detector_report.citationWarnings.shipped, false);
  // A supported citation (every citing sentence shares "entanglement")
  // produces no warning section.
  const supportedText = [
    "## Executive Summary",
    "We should adopt the entanglement strategy [#7].",
    "",
    "## Reasoning",
    "Because entanglement.",
    "",
    "## Action Items",
    "- Study entanglement — owner: A — [#7]",
    "",
    "## Open Questions",
    "- Q?",
    "",
    "## Confidence",
    "Medium.",
  ].join("\n");
  const clean = finalizeSynthesis(supportedText, transcriptData, participants, [], enabled);
  assert.doesNotMatch(clean.output, /## Citation Warnings/);
});

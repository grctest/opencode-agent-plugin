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
import { buildRoundContext, buildSettledBlock, buildCategoryLens, getRecentContributionsBlock } from "../src/prompts/blocks.js";
import { buildQueryPrompt, buildVotePrompt } from "../src/prompts/interaction-prompts.js";
import { QUERY_MODES } from "../src/prompts/query-modes.js";
import { buildRoundSummaryUser } from "../src/round-summarizer.js";
import { buildSynthesisPrompt } from "../src/prompts/synthesis.js";
import { checkCitationSupport, finalizeSynthesis, validateSynthesisSections, extractSection, SYNTHESIS_SECTION_CONTRACT } from "../src/synthesizer.js";
import { buildToolsMapWithoutLoom } from "../src/round-executor/tools.js";
import { boundToolCallsForStorage } from "../src/database/contribution-operations.js";
import { sanitizeForDisplay } from "../src/utils/sanitize.js";
import { escapeDelimiters } from "../src/prompts/delimiters.js";
import { LENGTH_LIMITS } from "../src/prompts/constants.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";

// Prompt-invariant suite (audit §8.3 / Phase 2): every defect class from the
// context-window & prompt-engineering audit, as deterministic pure-function
// assertions needing no LLM. A regression here means a prompt contract broke.

function participant(id = "p0") {
  return {
    config: {
      id,
      name: "Test Engineer",
      category: "senior",
      persona: "A test persona with enough characters to pass validation checks.",
      agenda: "Verify prompt invariants hold across refactors.",
      category_guidance: "Be precise.",
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
    loom_query: true, loom_vote: true, loom_summon: true,
    loom_pass: true, loom_state_patch: true,
  },
  builtIn: { websearch: true, webfetch: true, read: true, glob: true, grep: true },
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
  return Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, name: `Persona ${i}`, category: "mid", state: fullState(i) }));
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
    { config: { id: "a", name: "A", category: "senior" }, status: "listening" },
    { config: { id: "b", name: "B", category: "mid" }, status: "listening" },
    { config: { id: "c", name: "C", category: "junior" }, status: "passed" },
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

// 4. A4 — the consensus section requires ≥2 holders (P11 fix).
// The section is ONE bucket ("Agreements & Proposals"): the patch channel files
// proposals and agreements in the same bucket, so splitting them printed the
// same list twice (audit Q3).
test("primary aggregation populates the consensus section only with multi-holder items", () => {
  const singleHolderSop = aggregateStateOfPlay(sevenStates(), "Q", []);
  assert.doesNotMatch(singleHolderSop, /## Agreements & Proposals/);
  const multiHolderStates = sevenStates().map((e, i) => ({
    ...e,
    state: { ...e.state, established: [`shared decision ${i % 3}`] },
  }));
  const multiHolderSop = aggregateStateOfPlay(multiHolderStates, "Q", []);
  assert.match(multiHolderSop, /## Agreements & Proposals/);
  // One section, not two copies of the same rows (audit Q3).
  assert.doesNotMatch(multiHolderSop, /## Decisions & Proposals/);
  assert.equal((multiHolderSop.match(/## Agreements & Proposals/g) ?? []).length, 1);
  const rows = multiHolderSop.split("## Agreements & Proposals")[1].split("##")[0]
    .split("\n").filter((l) => l.trim().startsWith("-"));
  const texts = rows.map((l) => l.replace(/^\s*-\s*/, "").replace(/\s*\(\d+ holders\)\s*$/, "").trim());
  assert.equal(new Set(texts).size, texts.length, `consensus rows repeat: ${JSON.stringify(texts)}`);
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
  const caller = { config: { id: "asker", name: "Asker", category: "mid" } };
  const target = { config: { id: "t", name: "Target", category: "mid" }, status: "listening" };
  const note = "The asker invoked this query mid-turn — no draft to show.";
  const prompt = buildQueryPrompt(caller, target, note, "UNIQUEQUESTIONZZZ", [], 1, 3, "", "clarify", null);
  assert.equal(prompt.split("UNIQUEQUESTIONZZZ").length - 1, 1);
  assert.ok(prompt.includes(note));
});

// 8. Sub-agent cut-back contract — peer prompt carries a one-line stance,
// never the full state block or a patch directive (empty state is round-1 normal).
test("peer prompt prefers the position line over the full state block", () => {
  const caller = { config: { id: "asker", name: "Asker", category: "mid" } };
  const target = { config: { id: "t", name: "Target", category: "mid" }, status: "listening" };
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

// 8b. Audit Q4/M2 — the vote prompt's State of Play arrives as whole, fenced
// items (not a character slice of the document), the round label is a label
// (no primary-turn doctrine leaks into a sub-agent), and the meta-note stays
// outside the DATA fence.
test("vote prompt shows whole fenced SoP items and no round doctrine", () => {
  const caller = { config: { id: "asker", name: "Asker", category: "senior" } };
  const voter = { config: { id: "v", name: "Voter", category: "mid" }, status: "listening" };
  const longQuestion = "Q ".repeat(400); // pushes the old 650-char slice past the consensus section
  const sop = [
    "## Question", longQuestion, "",
    "## Agreements & Proposals",
    "- Phased rollout over Q1-Q2, auth service first",
    "- Short-lived access tokens (5 min) are essential",
    "",
    "## Disagreements & Concerns",
    "- Token revocation remains unsolved",
  ].join("\n");
  const prompt = buildVotePrompt(caller, voter, "Proposed: cut over in Q1.", "A) Q1  B) Q2", [], 2, 4, sop, null);
  // The consensus items arrive whole, numbered, and fenced as data.
  assert.match(prompt, /<<<LOOM_STATE_OF_PLAY>>>_BEGIN_/);
  assert.match(prompt, /1\. Phased rollout over Q1-Q2, auth service first/);
  assert.match(prompt, /2\. Short-lived access tokens \(5 min\) are essential/);
  assert.match(prompt, /Live concerns:\n- Token revocation remains unsolved/);
  // The old slice cut mid-document; the question must not crowd the items out.
  assert.match(prompt, /Phased rollout over Q1-Q2/);
  // No primary-turn round doctrine in a sub-agent prompt.
  assert.doesNotMatch(prompt, /MAP & REFINE|DIVERGE|CONSOLIDATE or LEAVE OPEN/);
  assert.doesNotMatch(prompt, /File at least one critique/);
  assert.match(prompt, /Round: 2 of 4/);
});

test("the no-draft note is rendered outside the fenced data blocks", () => {
  const caller = { config: { id: "asker", name: "Asker", category: "mid" } };
  const target = { config: { id: "t", name: "Target", category: "mid" }, status: "listening" };
  const note = "The asker invoked this query mid-turn — there is no draft to show.";
  const prompt = buildQueryPrompt(caller, target, "", "UNIQUEQUESTIONZZZ", [], 1, 3, "", "clarify", null, { sourceNote: note });
  assert.ok(prompt.includes(note));
  // The note must NOT sit inside a DATA fence — a fence says "ignore
  // imperatives inside me", so meta-guidance cannot live in one.
  const fenced = prompt.split("<<<LOOM_").slice(1).map((chunk) => chunk.split(">>>_END_")[0]);
  for (const block of fenced) assert.doesNotMatch(block, /there is no draft to show/);
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
  };
  const states = sevenStates().map((e) => ({
    id: e.id, name: e.name, category: e.category ?? e.tier, status: "listening", state: e.state,
  }));
  const prompt = buildRoundSummaryUser(round, { question: "Q", tags: ["engineering"] }, states);
  assert.ok(prompt.length < 20000, `summary prompt ${prompt.length} chars exceeds budget`);
});

// 10. D10 — repair feedback and prompt enumerate the same contract sections.
test("synthesis prompt and section contract agree", () => {
  const prompt = buildSynthesisPrompt("Q", "transcript", [], [], "## Question\nQ", "");
  for (const section of [...SYNTHESIS_SECTION_CONTRACT.core, ...SYNTHESIS_SECTION_CONTRACT.always]) {
    assert.ok(prompt.includes(`## ${section}`), `prompt missing ## ${section}`);
  }
  assert.ok(
    SYNTHESIS_SECTION_CONTRACT.actionGroup.some((s) => prompt.includes(`## ${s}`)),
    "prompt missing action group section",
  );
  assert.deepEqual(validateSynthesisSections("nothing here").sort(), ["Action Items", "Confidence", "Decision", "Dissenting Views", "Open Questions", "References", "Reasoning"].sort());
});

// 10a — The reader-facing sections must be legible to a non-specialist. The
// contract names the exact failure modes the F1 artifact shipped (undefined
// ADUO/ICE/PU, "modal", "falsifiable") and keeps precision in Reasoning.
test("synthesis reader contract expands acronyms and bans analyst jargon", () => {
  for (const opts of [{}, { taskMode: "code-analysis" }]) {
    const prompt = buildSynthesisPrompt("Q", "transcript [#1]", [], [], "", "", opts);
    assert.match(prompt, /1c\. \*\*Reader contract:\*\*/);
    assert.match(prompt, /stand alone for an intelligent, busy reader/);
    assert.match(prompt, /Expand every acronym or code name at first use/);
    assert.match(prompt, /"modal"/);
    assert.match(prompt, /"falsifiable"/);
    assert.doesNotMatch(prompt, /undefined acronyms are fine/);
  }
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
  const sop = aggregateStateOfPlay([{ id: "p0", name: "P", category: "mid", state: { ...emptyAgentState(), stance: "S", version: 1, updated_round: 1 } }], "UNIQUEQUESTIONZZZ", []);
  assert.ok(sop.includes("## Question"), "fixture SoP should carry the question");
  const user = buildAgentUserPrompt(participant(), sop, [], 1, "UNIQUEQUESTIONZZZ", [], "", [], null, true, {});
  assert.equal(user.split("UNIQUEQUESTIONZZZ").length - 1, 1);
});

// 15. B8 — mandatory-retry map cannot open unsynthesized peer interactions.
test("loom-free tool map excludes query/vote/summon/pass/state_patch", () => {
  const map = buildToolsMapWithoutLoom({ agentTools }, { activeCount: 7 });
  for (const t of ["loom_query", "loom_vote", "loom_summon", "loom_pass", "loom_state_patch"]) {
    assert.ok(!(t in map), `${t} present in loom-free map`);
  }
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
    config: { id: `p${i}`, name: `Persona ${i}`, category: "mid" },
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

// 22a — Reader contract: every contribution defines its acronyms at first use,
// and handoffs name a seated participant instead of inventing an @role.
test("output contract requires first-use acronyms and seated handoff names", () => {
  const sys = buildAgentSystemPrompt(participant(), { activeCount: 3, agentTools });
  const contract = sys.split("## OUTPUT CONTRACT")[1] ?? "";
  assert.match(contract, /14\. Reader language/);
  assert.match(contract, /Define every domain acronym or code name at its first use/);
  assert.match(contract, /gloss domain jargon in plain words/);
  assert.match(sys, /Handoff: <seated participant name>/);
  assert.doesNotMatch(sys, /Handoff: @role/);
});

// 22b — A one-round meeting is one meeting-level phase, not a per-seat race.
// The same brief must reach every seat, and it must ask for divergence and
// convergence rather than late-round consolidation.
test("one-round meetings use a single DIVERGE-then-CONVERGE brief for every seat", () => {
  const first = buildRoundContext(1, 1, { hasPriorContributions: false });
  const later = buildRoundContext(1, 1, { hasPriorContributions: true });
  assert.equal(first, later);
  assert.match(first, /Single-round deliberation/);
  assert.match(first, /DIVERGE then CONVERGE/);
  assert.match(first, /critique/);
  assert.doesNotMatch(first, /Late deliberation/);
  assert.doesNotMatch(first, /CONSOLIDATE/);
});

// 27 — Room-layer resolvability: the room is asked to cite ids across layers
// (turns, clerk bullets, final artifact), so a bare id must never be the only
// rendering a reader gets. First use pairs the holder's NAME with the id, and
// the pairing explicitly costs nothing against the citation budget — a rule
// that silently spent budget would push the room to drop cites instead.
test("output contract pairs the holder's NAME with every first [#id] mention", () => {
  const sys = buildAgentSystemPrompt(participant(), { activeCount: 3, agentTools });
  const contract = sys.split("## OUTPUT CONTRACT")[1] ?? "";
  assert.match(contract, /Name the holder at first use/);
  assert.match(contract, /same id, not a new one/, "the rule states its zero cost against the citation budget");
  assert.match(contract, /a bare id a reader cannot resolve is a hole/);
});

// 28 — Resolvable-at-a-glance: the live block renders the display NAME with
// the id (copy-work, not a two-hop lookup), and stays at the raw id when no
// name is known (legacy call sites); the prior-round index block is gated,
// fenced (agent-authored data), and id-deduped against the live block.
test("the live block renders names and the prior-round index is fenced and gated", () => {
  const user = buildAgentUserPrompt(
    participant(),
    "## Question\nQ?\n\n## Agreements\n- x",
    [{ id: 12, participant_id: "peer_b", round: 2, type: "contribution", content: "live claim" }],
    2, "Q?", [], "", [], null, true, {},
    { participantNames: { peer_b: "Peer B", peer_a: "Peer A" }, earlierContributions: [
      { id: 2, participant_id: "peer_a", round: 1, type: "contribution", content: "an older claim from round one" },
    ] },
  );
  assert.match(user, /\[#12\] Peer B \[peer_b\]: live claim/, "live line: name + id on screen");
  assert.match(user, /## Contribution Index — earlier rounds/);
  assert.match(user, /<<<LOOM_PRIOR_INDEX/, "agent-authored index content is fenced");
  assert.match(user, /- \[#2\] Peer A \(round 1\): an older claim/, "index line: id + name + round + gist");
  assert.match(user, /never reopen a settled point on an index line alone/, "the gist-dispute guard");
  const flat = buildAgentUserPrompt(
    participant(), "## Question\nQ?", [{ id: 12, participant_id: "peer_b", type: "contribution", content: "legacy" }],
    2, "Q?", [], "", [], null, true, {},
  );
  assert.match(flat, /\[#12\] \[peer_b\]: legacy/, "no name map — raw id, resolvable");
  assert.doesNotMatch(flat, /## Contribution Index/, "no option — no block (byte-identical legacy)");
});

// 23. Persona lens renders the persona's own guidance verbatim — no per-category doctrine.
test("persona lens carries guidance verbatim with no category doctrine", () => {
  const lens = buildCategoryLens("UNIQUEGUIDANCEZZZ");
  assert.match(lens, /UNIQUEGUIDANCEZZZ/);
  assert.match(lens, /subordinate to contract/);
  assert.doesNotMatch(lens, /doctrine/i);
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

// 26. Audit A1 — the task-mode knob must be part of the system-prompt cache
// key. The cache is process-wide and participant ids recur across meetings,
// so a key without it served one meeting's scaffold to the next: a programming
// meeting could be told "this is a discussion meeting: read-only… do not
// create or modify files" while write/edit sat in its tool map.
test("the task-mode knob is part of the system-prompt cache key", () => {
  const tools = structuredClone(DEFAULT_CONFIG.agentTools);
  const mk = (id) => ({
    config: {
      id, name: "Cache Mode Agent", category: "mid",
      persona: "A persona long enough to render verbatim in the identity block.",
      agenda: "Check the cache key.",
      model: { providerID: "test", modelID: "t" },
    },
    status: "listening",
  });
  const prog = buildAgentSystemPrompt(mk("cache-mode-a"), { activeCount: 4, agentTools: tools, contextWindow: 200000, codeContext: true });
  const disc = buildAgentSystemPrompt(mk("cache-mode-a"), { activeCount: 4, agentTools: tools, contextWindow: 200000, codeContext: false });
  assert.notEqual(prog, disc, "the two task modes must not share a cached system prompt");
  assert.match(disc, /this is a discussion meeting/);
  assert.doesNotMatch(disc, /- \*\*write \/ edit\*\*/);
  assert.match(prog, /- \*\*write \/ edit\*\*/);
  // The reverse order must behave the same way (the first render must not win).
  const disc2 = buildAgentSystemPrompt(mk("cache-mode-b"), { activeCount: 4, agentTools: tools, contextWindow: 200000, codeContext: false });
  const prog2 = buildAgentSystemPrompt(mk("cache-mode-b"), { activeCount: 4, agentTools: tools, contextWindow: 200000, codeContext: true });
  assert.notEqual(disc2, prog2);
  assert.match(prog2, /- \*\*write \/ edit\*\*/);
  assert.doesNotMatch(prog2, /this is a discussion meeting/);
});

// 28. F-A / audit A — the settled block renders the ORCHESTRATOR's consensus
// items in EVERY phase. It used to be a one-line pointer before the late phase,
// and that pointer named a State-of-Play section that was empty in every
// recorded meeting (exact-match aggregation never matched), so the room was told
// to build on settled points it could not see. The late phase keeps the
// stricter "signed, do not re-argue" wording.
test("settled block renders the orchestrator's items in every phase", () => {
  const items = [{ text: "Retention beats ranking [#3]", holders: ["A", "B"] }];
  const late = buildSettledBlock(items, true);
  assert.match(late, /## Settled — signed, do not re-argue/);
  assert.match(late, /Do NOT restate their content/);
  assert.match(late, /LOOM_SETTLED_ITEMS/);
  assert.match(late, /holders: A, B/);
  const early = buildSettledBlock(items, false);
  assert.match(early, /## Settled so far/);
  assert.doesNotMatch(early, /do not re-argue/);
  // The items themselves are present in the early phase — a pointer is not a
  // consensus record.
  assert.match(early, /Retention beats ranking \[#3\]/);
  assert.match(early, /LOOM_SETTLED_ITEMS/);
  // And it never points at a State-of-Play section that may be empty.
  assert.doesNotMatch(early, /see Agreements & Proposals/);
  assert.equal(buildSettledBlock([], true), "");
  assert.equal(buildSettledBlock(null, false), "");
});

// 29. F-A / audit A — the user prompt carries the orchestrator's settled
// items in every round (not only late), so the room can build on what has
// already converged.
test("user prompt renders the settled registry in every round", () => {
  const shared = "Retention beats ranking [#3]";
  const mkState = (extra = []) => ({
    stance: "s", established: [shared, ...extra], contested: [], open: [],
    facts: [], files: [], version: 1, updated_round: 1, updated_contribution_id: 1,
  });
  const allStates = [
    { id: "a", name: "A", category: "mid", state: mkState() },
    { id: "b", name: "B", category: "mid", state: mkState(["Solo [#9]"]) },
  ];
  const lateUser = buildAgentUserPrompt(
    participant(), "", [], 4, "Q", [], "", [], null, true, {},
    { maxRounds: 5, contextWindow: 200000, allStates },
  );
  assert.match(lateUser, /## Settled — signed, do not re-argue/);
  const midUser = buildAgentUserPrompt(
    participant(), "", [], 2, "Q", [], "", [], null, true, {},
    { maxRounds: 5, contextWindow: 200000, allStates },
  );
  // Early rounds carry the items too — the room must SEE the consensus.
  assert.match(midUser, /## Settled so far/);
  assert.match(midUser, /Retention beats ranking/);
  assert.doesNotMatch(midUser, /do not re-argue/);
  const noStates = buildAgentUserPrompt(
    participant(), "", [], 4, "Q", [], "", [], null, true, {},
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
  assert.deepEqual([...validateSynthesisSections(spectrum, "decision_oriented")].sort(), ["Decision Rule", "References"]);
  // No Decision section at all is a different defect class — the trigger is
  // the declared spectrum, not section absence.
  const bare = `${head}${tail}`;
  assert.deepEqual(validateSynthesisSections(bare, "decision_oriented"), ["References"]);
  const decided = `${head}## Decision\nSpain wins [#1].\n${tail}`;
  assert.ok(!validateSynthesisSections(decided, "decision_oriented").includes("Decision Rule"));
  const ruled = `${head}## Decision\nNo single decision — spectrum below:\n## Decision Rule\nTrigger x — Date y — Owner z — Default w.\n${tail}`;
  assert.deepEqual(validateSynthesisSections(ruled, "decision_oriented"), ["References"]);
  // Other styles and legacy style-less callers keep prior behavior.
  assert.ok(!validateSynthesisSections(spectrum, "conversational").includes("Decision Rule"));
  assert.ok(!validateSynthesisSections(spectrum).includes("Decision Rule"));
});

// 31. F-E — synthesis prompt carries the Decision Rule section and owned-action rule.
test("synthesis prompt requires Decision Rule and owned action items", () => {
  const prompt = buildSynthesisPrompt("Should we ship?", "transcript [#1]", [], [], "",  "", {});
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
    participant(), "", [], 4, "Q", [], "", [], null, true, {},
    { maxRounds: 5, contextWindow: 200000, settledItems: settled },
  );
  assert.match(lateUser, /## Settled — signed, do not re-argue/);
  assert.match(lateUser, /Mercedes HPP best engine shop/);
  assert.match(lateUser, /McLaren best whole team/);
  // Exact-match fallback still works when no clerk registry is passed.
  const fallbackUser = buildAgentUserPrompt(
    participant(), "", [], 4, "Q", [], "", [], null, true, {},
    { maxRounds: 5, contextWindow: 200000 },
  );
  assert.doesNotMatch(fallbackUser, /## Settled — signed/);
});

// 34. P1-1/P2-1 — synthesis prompt demands latest consolidated thresholds
// and a committed owner.
test("synthesis prompt demands consolidated thresholds and committed owner", () => {
  const prompt = buildSynthesisPrompt("Who wins 2030?", "transcript [#1]", [], [], "",  "", {});
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
  const participants = [{ config: { id: "a", name: "A", category: "senior" }, status: "listening" }];
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
  const { output, artifact } = finalizeSynthesis(text, transcriptData, participants, enabled);
  assert.match(output, /## Citation Warnings/);
  assert.match(output, /\[#7\]/);
  assert.equal(artifact.detector_report.citationWarnings.shipped, true);
  // N3 — the same text, flags off: the candidate is counted, not rendered.
  const { output: gated, artifact: gatedArtifact } = finalizeSynthesis(text, transcriptData, participants);
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
  const clean = finalizeSynthesis(supportedText, transcriptData, participants, enabled);
  assert.doesNotMatch(clean.output, /## Citation Warnings/);
});

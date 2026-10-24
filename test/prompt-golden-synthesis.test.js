import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildSynthesisPrompt } from "../src/prompts/synthesis.js";
import { buildQueryPrompt, buildEvidencePrompt, buildVotePrompt } from "../src/prompts/interaction-prompts.js";
import { QUERY_MODES } from "../src/prompts/query-modes.js";

// Golden synthesis + peer prompts (W4, audit final_analysis_Todo_items.md; extends
// test/prompt-golden.test.js's mechanics from agent prompts to the synthesis
// layer and the loom_query/loom_vote peer layer). Section hashes make accidental
// prompt edits show up as a reviewable diff — update the EXPECTED hashes
// deliberately, in the same commit as the prompt change, and say why in the
// commit message. These prompts are the study run's only evidence of documented
// behavior (rule 3a fence contract, ratchet directive, engagement ledger,
// per-mode peer contracts), so drift here is drift in the deliberation's
// contract, not cosmetic rewording.

function sectionHashes(text) {
  const out = {};
  for (const chunk of text.trim().split(/\n[ \t]*(?=## )/)) {
    const m = chunk.match(/^## (.+?)(?:\n|$)/);
    out[(m ? m[1] : "(preamble)").trim()] = createHash("sha1")
      .update(chunk.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);
  }
  return out;
}

function wholeHash(text) {
  return createHash("sha1").update(String(text)).digest("hex").slice(0, 8);
}

// ---- Fixed fixture ----------------------------------------------------------

const sourceAgent = {
  config: { id: "golden_source", name: "Golden Source", category: "senior" },
  status: "listening",
};
const targetAgent = {
  config: { id: "golden_target", name: "Golden Target", category: "mid", reflection_guidance: "Weigh reversible costs first." },
  status: "listening",
  reflection: "",
};
const roundContributions = [
  { participant_id: "peer_a", type: "contribution", content: "Stage by region first — the blast radius halves. [#4]" },
  { participant_id: "golden_source", type: "contribution", content: "I propose immediate rollout; the pipeline is tested twice over. [#7]" },
  { participant_id: "peer_b", type: "vote_response", content: "[Vote: A]" },
];
const QUESTION = "Roll out the deploy pipeline now, or stage it by region first?";
const TRANSCRIPT = [
  "[#7] Golden Source: I propose immediate rollout; the pipeline is tested twice over.",
  "[#4] Peer A: Stage by region first — the blast radius halves.",
].join("\n");
const SOP = "## Agreements & Proposals\n- The pipeline is tested twice over\n## Decisions & Disagreements\n- Region staging halves the blast radius";
const USER_CONTEXT = "We need a decision before Friday's release freeze.";

// ---- Expected: synthesis (conversational, rich opts) ------------------------

const EXPECTED_SYNTH_RICH = {
  "(preamble)": "444556b4c1c2",
  "Mode: Conversational (open-ended)": "301333363cd4",
  // 2026-10-23 (P2.7 ratchet): appears only when opts.ratchetBallot is set.
  "Ratchet (internal directive — act on it)": "8f870550ce92",
  "Original Question": "052d530832c9",
  "Tags (topic)": "7214ac3c96a3",
  "Original User Context (from the person who asked)": "79a0d1e3ffde",
  "State of Play (Final — PRIMARY source)": "9bb2c020acee",
  "Agreements & Proposals": "9e566c83712e",
  "Decisions & Disagreements": "5fae82f9e101",
  // 2026-10-23 (N8 ledger): appears only when opts.engagement reports uncited peers.
  "Engagement Ledger (internal check — not a source)": "62ea20308a08",
  "Deliberation Transcript (supporting detail — cite [#id] when using it)": "8f40a11009af",
  "Participants (activity)": "4b1b58818200",
  "Synthesis Doctrine": "e85c145468f9",
  "Length — concise but thorough (200k window — verbose welcome, yapping not)": "643b38ad6b8e",
  "Required Sections — output these exact headings in this order, even if empty (write “None” where appropriate)": "42fa4ae82330",
  "Executive Summary": "45f094afeb05",
  "Decision": "53687260c8d0",
  "Decision Rule": "729a0be71ce1",
  "Reasoning": "8b5a261d695b",
  "Dissenting Views": "8b0963d8dec8",
  "Action Items": "cdad00fc5df3",
  "Open Questions": "b17ad0dab00e",
  "References": "38b15990ad1b",
  "Confidence": "6738e4f95919",
  "Negative Example (do NOT do this)": "639d64fcd7ba",
  "Good Fragment (abstract, domain-free)": "5d69ba69fa8d",
};

const EXPECTED_SYNTH_MINIMAL = {
  "(preamble)": "444556b4c1c2",
  "Mode: Conversational (open-ended)": "c8d2d97fc46c",
  "Original Question": "052d530832c9",
  "Deliberation Transcript (supporting detail — cite [#id] when using it)": "8f40a11009af",
  "Synthesis Doctrine": "14ce38773942",
  "Length — concise but thorough (large window — verbose welcome, yapping not)": "b8a9d98b69d5",
  "Required Sections — output these exact headings in this order, even if empty (write “None” where appropriate)": "42fa4ae82330",
  "Executive Summary": "45f094afeb05",
  "Decision": "53687260c8d0",
  "Decision Rule": "729a0be71ce1",
  "Reasoning": "8b5a261d695b",
  "Dissenting Views": "8b0963d8dec8",
  "Action Items": "cdad00fc5df3",
  "Open Questions": "b17ad0dab00e",
  "References": "38b15990ad1b",
  "Confidence": "6738e4f95919",
  "Negative Example (do NOT do this)": "639d64fcd7ba",
  "Good Fragment (abstract, domain-free)": "5d69ba69fa8d",
};

const EXPECTED_SYNTH_CODE = {
  "(preamble)": "444556b4c1c2",
  "Mode: Code-Analysis (PLAN mode — read-only: propose diffs; mark live edits as Proposed)": "c4ba63ef0960",
  "Original Question": "95e25f44726f",
  "Tags (topic)": "c20541711cf9",
  "Deliberation Transcript (supporting detail — cite [#id] when using it)": "8f40a11009af",
  "Synthesis Doctrine": "52f9b1b0938f",
  "Length — concise but thorough (200k window — verbose welcome, yapping not)": "49e88780cc7c",
  "Required Sections — output these exact headings in this order, even if empty (write “None” where appropriate)": "42fa4ae82330",
  "Executive Summary": "45f094afeb05",
  "Decision": "53687260c8d0",
  "Decision Rule": "729a0be71ce1",
  "Reasoning": "8b5a261d695b",
  "Dissenting Views": "8b0963d8dec8",
  "Proposed Fix": "19cca5065f08",
  "Files Involved": "aee8380083c5",
  "Action Items": "6af18e7be94c",
  "Open Questions": "b17ad0dab00e",
  "References": "11d2053f883d",
  "Confidence": "6738e4f95919",
  "Negative Example (do NOT do this)": "639d64fcd7ba",
  "Negative Example (code) — do NOT do this": "3c480c0ccbb1",
  "Good Fragment (abstract, domain-free)": "5d69ba69fa8d",
  "Good Fragment (code-analysis)": "dd75b100ca5f",
};

// ---- Expected: per-mode peer system prompts ---------------------------------

const EXPECTED_PEER_SYS = {
  clarify: "b51128ac",
  perspective: "1f71d3b5",
  critique: "ad986c2d",
  risks: "55cc5e32",
  assumptions: "8290f4ee",
  alternatives: "9b58afc1",
  // evidence's system prompt is covered via buildEvidencePrompt below.
};

const EXPECTED_QUERY_HEADER_INSTRUMENTED = {
  // Every fence, room line, stance line, settled digest and source note renders
  // inside the header chunk (no `## ` between them), so its hash covers drift
  // anywhere in the peer's context assembly, not just the header line.
  clarify: "60f0aa8e87e8",
  perspective: "23b54aa767f4",
  critique: "eec61b02c506",
  risks: "d100b4f892b5",
  assumptions: "21f1cee3d10e",
  alternatives: "f119c0a30861",
};

const EXPECTED_QUERY_TASKS = {
  clarify: "a2cd87d53a35",
  perspective: "90b7deaa38e4",
  critique: "e2f22984ea50",
  risks: "0e6380955cba",
  assumptions: "0b68c0ea939b",
  alternatives: "b542ece72ac2",
};

const EXPECTED_EVIDENCE = {
  "Evidence Request — to Golden Target (mid) from Golden Source (senior)": "0a9b24836c1d",
  "Task": "7e05bbcbc77f",
  "Tools Available To You (sub-agent scope)": "0a4a56e72d60",
};

const EXPECTED_VOTE = {
  "Vote Requested — to Golden Target (mid) from Golden Source (senior)": "767b2491406e",
  "Task — Cast Your Vote": "2dec9fb65668",
};

// ---- Tests ------------------------------------------------------------------

function synthFixture() {
  return [
    buildSynthesisPrompt(QUESTION, TRANSCRIPT,
      [{ config: { name: "Golden Source" }, contributions_count: 2, status: "listening" },
       { config: { name: "Clean Analyst" }, contributions_count: 1, status: "passed" }],
      ["operations"], SOP, USER_CONTEXT,
      { contextWindow: 200000, decisionPosture: "preserve_spectrum",
        engagement: { plain_contributions: 2, peer_uncited: 1, self_cites: 0, uncited_plain_ids: [4] },
        ratchetBallot: true },
    ),
    buildSynthesisPrompt(QUESTION, TRANSCRIPT, [], [], "", ""),
    buildSynthesisPrompt("Fix the bug in src/api.ts — how?", TRANSCRIPT, [], ["engineering"], "", "", { contextWindow: 200000 }),
  ];
}

test("golden synthesis prompt (rich opts) sections are unchanged", () => {
  assert.deepEqual(sectionHashes(synthFixture()[0]), EXPECTED_SYNTH_RICH);
});

test("golden synthesis prompt (minimal opts) sections are unchanged", () => {
  assert.deepEqual(sectionHashes(synthFixture()[1]), EXPECTED_SYNTH_MINIMAL);
});

test("golden synthesis prompt (code-analysis mode) sections are unchanged", () => {
  assert.deepEqual(sectionHashes(synthFixture()[2]), EXPECTED_SYNTH_CODE);
});

test("synthesis golden keeps doctrine-last-then-sections ordering and no stray ratchet/ledger when unset", () => {
  const [rich, minimal] = synthFixture();
  assert.ok(rich.includes("## Ratchet (internal directive"), "rich fixture must carry the ratchet directive section");
  assert.ok(!minimal.includes("## Ratchet (internal directive"), "unset ratchetBallot must emit no directive section");
  assert.ok(!minimal.includes("## Engagement Ledger"), "unset engagement must emit no ledger section");
});

const peerKeys = Object.keys(QUERY_MODES).filter((k) => k !== "evidence");

test("golden per-mode peer system prompts are unchanged", () => {
  for (const key of peerKeys) {
    const meta = QUERY_MODES[key];
    const sys = meta.systemPrompt(targetAgent, key === "perspective" ? "Weigh reversible costs first." : "");
    assert.equal(wholeHash(sys), EXPECTED_PEER_SYS[key], `peer systemPrompt("${key}") drifted`);
  }
});

test("peer prompt invariants: every mode carries identity, budget, and the fence ban", () => {
  for (const key of Object.keys(QUERY_MODES)) {
    const meta = QUERY_MODES[key];
    const sys = meta.systemPrompt({ config: { id: "x", name: "X", category: "mid" } });
    assert.ok(sys.includes("(mid)"), `${key}: peer system prompt names the category`);
    assert.match(sys, /never emit <<< or >>>/i, `${key}: fence ban present`);
    assert.match(sys, /words|sentences/, `${key}: response budget present`);
  }
});

function peerFixture() {
  return buildQueryPrompt(sourceAgent, targetAgent, "I propose immediate rollout [#7].",
    "Is Friday realistic?", roundContributions, 2, 4, SOP, "clarify",
    { stance: "Rollout now.", version: 3 },
    { settledItems: ["pipeline tested twice"], sourceNote: "The asker invoked this query mid-turn." });
}

test("golden buildQueryPrompt headers are unchanged per mode", () => {
  for (const key of peerKeys) {
    const p = buildQueryPrompt(sourceAgent, targetAgent, "I propose immediate rollout [#7].",
      "Is Friday realistic?", roundContributions, 2, 4, SOP, key,
      { stance: "Rollout now.", version: 3 },
      { settledItems: ["pipeline tested twice"], sourceNote: "The asker invoked this query mid-turn." });
    const h = sectionHashes(p);
    const expectedHeader = `${key === "clarify" ? "Direct Query" : `${key.charAt(0).toUpperCase() + key.slice(1)} Request`} — to Golden Target (mid) from Golden Source (senior)`;
    assert.equal(h[expectedHeader], EXPECTED_QUERY_HEADER_INSTRUMENTED[key], `${key} header chunk drifted`);
    assert.equal(h["Task"], EXPECTED_QUERY_TASKS[key], `${key} task block drifted`);
    assert.equal(h["Tools Available To You (sub-agent scope)"], "1c35bc182860", `${key} tool guidance drifted`);
  }
});

test("golden buildEvidencePrompt sections are unchanged", () => {
  const p = buildEvidencePrompt(sourceAgent, targetAgent, "Deploy gating needs evidence [#7].",
    "What do audits say about staged rollouts?", roundContributions, 2, 4,
    { stance: "Staged first.", version: 3 }, { settledItems: [] });
  assert.deepEqual(sectionHashes(p), EXPECTED_EVIDENCE);
});

test("golden buildVotePrompt sections are unchanged", () => {
  const p = buildVotePrompt(sourceAgent, targetAgent, "Motion: rollout now [#7].", "Roll out now?",
    roundContributions, 2, 4, SOP, { stance: "Yes.", version: 3 });
  assert.deepEqual(sectionHashes(p), EXPECTED_VOTE);
});

test("peer prompt context guards: fences close, room excludes self-echo and ballots", () => {
  const p = peerFixture();
  const begin = /<<<LOOM_PEER_CONTRIBUTION>>>_BEGIN_/.test(p);
  const qBegin = /<<<LOOM_PEER_QUESTION>>>_BEGIN_/.test(p);
  assert.ok(begin && qBegin, "contribution and question both fenced");
  assert.equal((p.match(/_END_/g) ?? []).length, 2, "exactly two fence closers");
  assert.ok(p.includes("Recent from the room:"), "room block present");
  assert.ok(!p.includes("no tags"), "task must not leak contradictory contract text");
});

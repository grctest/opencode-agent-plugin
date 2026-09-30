import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { updateStateOfPlay, mergeStateOfPlay } from "../src/state-of-play.js";
import { reconcileNumericalConflicts, finalizeSynthesis } from "../src/synthesizer.js";

// Two prose interpreters were deleted outright, not hardened:
//
//   classifyByKeywords    — decided which state-of-play bucket an agent's prose
//                           belonged in from words like "we should" / "agree",
//                           and its output was the room's primary shared
//                           context.
//   RETRACTION_PATTERNS   — 11 English-phrase regexes decided that a
//                           contribution withdrew a claim, then value+unit
//                           string matching decided which downstream numbers
//                           were tainted.
//
// Both were the same mistake as the vote tally: code guessing at meaning, then
// presenting the guess as a record. These tests pin the deletions.

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|jsx|mjs)$/.test(p)) out.push(p);
  }
  return out;
}

test("neither prose interpreter exists in the source graph", () => {
  const forbidden = [
    "classifyByKeywords",
    "RETRACTION_PATTERNS",
    "findRetractions",
    "propagateRetractions",
    "registerRetractedFigures",
    "annotateRetractedClaims",
    "annotateRetractedFigures",
    "runRetractionFalsifier",
  ];
  for (const file of walk("src")) {
    const body = readFileSync(file, "utf8");
    for (const symbol of forbidden) {
      assert.ok(!body.includes(symbol), `${file} still references the deleted ${symbol}`);
    }
  }
});

test("no source file matches agent prose for retraction phrasing", () => {
  // The detector's own vocabulary must not reappear anywhere: a house style
  // that does not match the regex was a retraction that silently was not one.
  const phrasing = [/\bi retract\b/i, /\bi withdraw\b/i, /\bscratch that\b/i, /\bno longer stand by\b/i];
  for (const file of walk("src")) {
    const body = readFileSync(file, "utf8");
    for (const re of phrasing) {
      assert.ok(!re.test(body), `${file} still matches retraction phrasing (${re})`);
    }
  }
});

test("an untyped primary turn files nothing into the state of play", () => {
  const weave = [
    { id: 1, participant_id: "a", type: "contribution", content: "We should migrate to the new queue. I agree the rollback is untested. Is that right? Decided: adopt it." },
  ];
  const sop = updateStateOfPlay(weave, "Q", []);
  // Every keyword the old classifier keyed on is present, and none of them put
  // the turn anywhere.
  assert.ok(!sop.includes("migrate to the new queue"), "prose filed despite no declaration");
  assert.doesNotMatch(sop, /## Decisions & Proposals/, "a decision bucket was invented");
  assert.doesNotMatch(sop, /## Agreements/, "an agreement bucket was invented");
  assert.doesNotMatch(sop, /## Open Questions/, "an open-question bucket was invented");
  assert.doesNotMatch(sop, /## Disagreements/, "a disagreement bucket was invented");
  assert.doesNotMatch(sop, /## Key Facts/, "a key-fact bucket was invented");
});

test("typed peer responses still file, from their type tag alone", () => {
  const weave = [
    { id: 1, participant_id: "a", type: "critique_response", content: "The rollback path is unsafe." },
    { id: 2, participant_id: "b", type: "query_response", content: "What is the p99?", prompt_context: { mode: "risks" } },
    { id: 3, participant_id: "c", type: "summoned_response", content: "From the carrier side, the constraint is homologation." },
  ];
  const sop = updateStateOfPlay(weave, "Q", []);
  assert.match(sop, /## Disagreements/, "critique_response should file as disagreement");
  assert.match(sop, /## Open Questions/, "risks-mode query should file as open question");
  assert.match(sop, /## Key Facts/, "summoned_response should file as fact");
  assert.match(sop, /homologation/);
});

test("an undeclared turn does not force the legacy weave scan", () => {
  // round.js used to run the O(T) scan whenever a primary turn's state patch
  // did not land, because the keyword classifier would then file the prose.
  // With the classifier gone that scan could not capture the content it named,
  // so the condition is gone with it.
  const round = readFileSync("src/orchestrator/round.js", "utf8");
  assert.ok(!round.includes("hasUncapturedContribution"), "the scan-forcing condition is still there");
  assert.ok(!round.includes("state_patch_outcome"), "the patch-miss condition is still there");
  // The scan itself still runs when state coverage is incomplete.
  assert.match(round, /!stateCoverageComplete \|\| !newStateOfPlay/);
});

test("mergeStateOfPlay keeps the declared state when the fallback is empty", () => {
  // With untyped turns no longer filing, the fallback SoP is empty more often.
  // The declared aggregate must survive that untouched.
  const primary = "## Question\nQ\n\n## Agreements\n- Base table convention is pinned and owned [#19]\n";
  const merged = mergeStateOfPlay(primary, updateStateOfPlay([{ id: 1, participant_id: "a", type: "contribution", content: "We should adopt it." }], "Q", []));
  assert.match(merged, /Base table convention is pinned and owned/);
  assert.ok(!merged.includes("We should adopt it"));
});

test("a numeric conflict is versioned, never silently resolved by phrasing", () => {
  const weave = [
    { id: 18, participant_id: "a", round: 1, type: "contribution", content: "The works-vs-supplier scoring is a 16.7pp swing on 2026, n=12." },
    { id: 25, participant_id: "a", round: 2, type: "contribution", content: "I retract my earlier claim that the works-vs-supplier scoring is a 16.7pp swing — the sample was stale. The correct figure is 3.1pp." },
  ];
  const report = reconcileNumericalConflicts(weave);
  for (const conflict of report.conflicts) {
    assert.notEqual(conflict.resolution?.basis, "retraction");
    assert.notEqual(conflict.falsifier?.method, "retraction-lookup");
  }
});

test("the artifact carries no retraction markers or fields", () => {
  const transcriptData = {
    question: "Q",
    rounds: [{ number: 1, contributions: [
      { id: 18, participant_id: "a", type: "contribution", round: 1, content: "x".repeat(500) },
      { id: 25, participant_id: "a", type: "contribution", round: 1, content: "y".repeat(500) },
    ] }],
  };
  const participants = [{ config: { id: "a", name: "A", tier: "mid" }, status: "listening" }];
  const text = [
    "## Executive Summary", "Nothing settled.", "",
    "## Decision", "Adopt the plan [#18] because it is the best option available today.", "",
    "## Reasoning", "One claim [#18].", "",
    "## Action Items", "— do a thing — owner: A — [#18]", "",
    "## Open Questions", "- none", "",
    "## Confidence", "Medium.",
  ].join("\n");
  const { artifact, output } = finalizeSynthesis(text, transcriptData, participants, []);
  assert.ok(!("retractions" in artifact), "artifact still exposes a retractions field");
  assert.ok(!("retracted_figures" in artifact), "artifact still exposes a retracted_figures field");
  assert.doesNotMatch(output, /⚠ retracted/);
  assert.doesNotMatch(output, /⚠ contains retracted/);
});

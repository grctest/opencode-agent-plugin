import test from "node:test";
import assert from "node:assert/strict";
import {
  findNumericalConflicts,
  extractNumericClaims,
  isRealQuantityLabel,
  checkCitationSupport,
  reconcileNumericalConflicts,
  finalizeSynthesis,
  resolveDetectorPolicy,
  CITATION_MIN_TARGET_CHARS,
} from "../src/synthesizer.js";

// N3 — detector precision gate. Both automated artifact sections were live in
// shipped artifacts and both were majority-false in deliberation 1355a723:
//
//   Needs Verification   banded `2027` against `77`, `12 works` against `40
//                        points`, and matched on the literal label "vs".
//   Citation Warnings    flagged a 57-character ballot, which keyword overlap
//                        cannot succeed on by construction.
//
// The fixes: a conflict requires unit + label + time order; uncheckable
// targets are exempt; synthesized-from attributions are exempt; both sections
// ship off by default and run dry so precision can be measured first.

function weave(...rows) {
  return rows.map(([id, participantId, round, content, type = "contribution"]) => ({
    id,
    participant_id: participantId,
    type,
    round,
    content,
  }));
}

test("a year and a percentage are not two versions of one quantity", () => {
  // The generated row was: `published: v1 = 2027 [#25] vs v2 = 77 [#39] — band
  // [77, 2027]`. Different units, so the pair must never be built.
  const w = weave(
    [25, "a", 1, "The published 2027 calendar lists twenty-four races."],
    [39, "b", 2, "The published win share is 77% under the base table."],
  );
  const conflicts = findNumericalConflicts(w).filter((c) => c.quantity.includes("published"));
  assert.equal(conflicts.length, 0, "mismatched units must not form a conflict");
});

test("12 works and 40 points are different units and never meet", () => {
  const w = weave(
    [18, "a", 1, "Team works 12 constructors shipped a car."],
    [21, "b", 2, "The same constructors scored 40 points in the table."],
  );
  const versioned = reconcileNumericalConflicts(w).conflicts.filter((c) => c.status === "versioned");
  assert.equal(versioned.length, 0);
});

test("a label that is a connector word is not a quantity", () => {
  const w = weave(
    [8, "a", 1, "The gap versus expectation is 0.5 % on the sample."],
    [23, "b", 2, "The gap versus expectation is 14 % on the wider sample."],
  );
  // "vs" is syntax: the matcher was reading its own punctuation.
  assert.equal(findNumericalConflicts(w).filter((c) => c.quantity === "vs").length, 0);
  // "versus" spelled out is the same word and is filtered too.
  const spelled = extractNumericClaims("The rate versus baseline is 5% here.");
  assert.ok(!spelled.some((c) => c.quantity.split(/\s+/).includes("versus")));
  assert.equal(isRealQuantityLabel("vs"), false);
  assert.equal(isRealQuantityLabel("win"), false, "a bare count unit is not a label");
  assert.equal(isRealQuantityLabel("antonelli win"), true);
});

test("genuine same-quantity revisions still conflict and version", () => {
  const w = weave(
    [1, "a", 1, "The win-share floor is 84% on the base table."],
    [2, "b", 2, "The win-share floor is 47% once the wins are re-counted."],
  );
  const phrase = findNumericalConflicts(w).find((c) => c.granularity === "phrase");
  assert.ok(phrase, "a real revision must survive the precision gate");
  assert.deepEqual(phrase.values, [47, 84]);
  assert.equal(phrase.unit, "%");
});

test("the unit net requires a shared label, not just a shared count unit", () => {
  // Two different quantities that merely reduce to the same count unit.
  const w = weave(
    [1, "a", 1, "Antonelli will win 8 races next season."],
    [2, "b", 2, "Hamilton will win 5 races next season."],
  );
  const units = findNumericalConflicts(w).filter((c) => c.granularity === "unit");
  assert.equal(units.length, 0, "different drivers are different quantities");
  // Same label on both sides → still a conflict.
  const same = weave(
    [1, "a", 1, "Antonelli will win 8 races next season."],
    [2, "b", 2, "No — Antonelli wins 6 races next season."],
  );
  const kept = findNumericalConflicts(same).filter((c) => c.granularity === "unit");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].label, "antonelli");
});

test("citation check ignores targets too short to check", () => {
  const short = "Vote cast: D.";
  const w = [
    { id: 2, content: short, type: "vote_response" },
    { id: 7, content: "The base table convention is pinned and owned by the room since round one, with sources and an as-of round [#3].", type: "contribution" },
  ];
  assert.equal(CITATION_MIN_TARGET_CHARS, 400);
  // Unrelated sentence citing the ballot: exempt because the ballot is 16 chars.
  assert.equal(checkCitationSupport("The engine is a regulation change [#2]", w).length, 0);
  // A long, unrelated target is still flagged.
  const wLong = [
    { id: 2, content: "x".repeat(500), type: "contribution" },
  ];
  assert.equal(checkCitationSupport("The engine is a regulation change [#2]", wLong).length, 1);
});

test("citation check exempts synthesized-from attributions", () => {
  const w = [
    { id: 13, content: "The scoring term freeze and the swing are documented in the base table revision log, with owners and dates [#4].", type: "contribution" },
    { id: 17, content: "y".repeat(500), type: "contribution" },
  ];
  const text = "Proposed — synthesized from [#13][#17]";
  assert.equal(checkCitationSupport(text, w).length, 0);
});

test("both detectors are off and dry by default", () => {
  const policy = resolveDetectorPolicy();
  assert.equal(policy.needsVerification, false);
  assert.equal(policy.citationWarnings, false);
  assert.equal(policy.dryRun, true);
  assert.equal(policy.precisionFloor, 0.9);
});

test("a flag-on, dry-run-off run ships the section and records the count", () => {
  const transcriptData = {
    question: "Who wins?",
    rounds: [
      { number: 1, contributions: [{ id: 1, participant_id: "a", type: "contribution", round: 1, content: "x".repeat(500) }] },
    ],
  };
  const participants = [{ config: { id: "a", name: "A", category: "senior", }, status: "listening" }];
  const text = [
    "## Executive Summary", "Nothing settled.", "",
    "## Decision", "We should adopt the plan because it is the best option available today.", "",
    "## Reasoning", "One claim.", "",
    "## Action Items", "— do a thing — owner: A", "",
    "## Open Questions", "- none", "",
    "## Confidence", "Low.",
  ].join("\n");
  const on = finalizeSynthesis(text, transcriptData, participants, {
    detectors: { needsVerification: true, citationWarnings: true, dryRun: false },
  });
  assert.equal(on.artifact.detector_report.needsVerification.shipped, true);
  assert.ok(on.artifact.detector_report.needsVerification.candidates >= 1);
});

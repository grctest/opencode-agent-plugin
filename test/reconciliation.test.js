import test from "node:test";
import assert from "node:assert/strict";
import {
  extractNumericClaims,
  findNumericalConflicts,
  reconcileNumericalConflicts,
  shouldReserveReconciliationRound,
  finalizeSynthesis,
} from "../src/synthesizer.js";

// P10 — pre-synthesis reconciliation pass: one pass resolves-or-versions
// every numerical conflict and RUNS (not merely states) the cheapest falsifier.

function weave(...rows) {
  return rows.map(([id, participantId, round, content]) => ({
    id,
    participant_id: participantId,
    type: "contribution",
    round,
    content,
  }));
}

test("extractNumericClaims pulls quantity/unit/value and drops structural noise", () => {
  const claims = extractNumericClaims("Antonelli will win 8 races in 2027, with a 33% win rate.");
  const byUnit = Object.fromEntries(claims.map((c) => [c.unit, c]));
  // "win 8 races" — the 8 counts wins; the phrase's unit wins over "races"
  assert.equal(byUnit.win.value, 8);
  assert.equal(byUnit.win.quantity, "antonelli win");
  assert.equal(byUnit["%"].value, 33);
  // "in 2027" is structural noise — no surviving quantity phrase, no unit
  assert.ok(!claims.some((c) => c.value === 2027));
});

test("extractNumericClaims drops round/version/line noise", () => {
  const claims = extractNumericClaims("In round 3, see line 42 and version 2: the threshold is 10.8.");
  assert.ok(!claims.some((c) => c.value === 3));
  assert.ok(!claims.some((c) => c.value === 42));
  assert.ok(!claims.some((c) => c.value === 2));
  assert.ok(claims.some((c) => c.value === 10.8));
});

test("findNumericalConflicts groups by phrase and by count unit", () => {
  const w = weave(
    [1, "a", 1, "Antonelli will win 8 races."],
    [2, "b", 2, "No — Antonelli wins 6 races."],
  );
  const conflicts = findNumericalConflicts(w);
  const phrase = conflicts.find((c) => c.granularity === "phrase");
  const unit = conflicts.find((c) => c.granularity === "unit");
  assert.ok(phrase, "phrase-level conflict expected");
  assert.deepEqual(phrase.values, [6, 8]);
  assert.equal(phrase.quantity, "antonelli win");
  assert.ok(unit, "unit-level conflict expected");
  assert.equal(unit.quantity, "win");
});

test("findNumericalConflicts ignores consistent values and single-contribution quantities", () => {
  const w = weave(
    [1, "a", 1, "Antonelli will win 8 races."],
    [2, "b", 2, "Agreed — Antonelli wins 8 races."],
    [3, "c", 2, "The season has 25 races."],
  );
  assert.equal(findNumericalConflicts(w).length, 0);
});

test("reconcileNumericalConflicts no longer infers a retraction from phrasing", () => {
  // The retraction detector was 11 English-phrase regexes deciding that a
  // contribution withdrew a claim, and the retraction-lookup falsifier then
  // resolved a numeric conflict from that guess. Both are deleted: a sentence
  // is not a retraction because it contains the word "retract". The two values
  // are now treated as a genuine, unresolved conflict and versioned.
  const w = weave(
    [1, "a", 1, "Antonelli will win 8 races this season, dominating the championship."],
    [2, "a", 2, "I retract my earlier claim that Antonelli will win 8 races this season. Antonelli wins 6 races."],
  );
  const report = reconcileNumericalConflicts(w);
  const phrase = report.conflicts.find((c) => c.granularity === "phrase");
  assert.equal(phrase.status, "versioned");
  assert.notEqual(phrase.resolution?.basis, "retraction");
  assert.notEqual(phrase.falsifier.method, "retraction-lookup");
  assert.deepEqual(phrase.versions.map((v) => v.value), [8, 6]);
});

test("reconcileNumericalConflicts resolves rounding-level disagreement", () => {
  const w = weave(
    [1, "a", 1, "The win rate is 33%."],
    [2, "b", 2, "The win rate is 33.4%."],
  );
  const report = reconcileNumericalConflicts(w);
  assert.equal(report.conflicts.length, 1);
  const c = report.conflicts[0];
  assert.equal(c.status, "resolved");
  assert.equal(c.resolution.basis, "arithmetic");
  assert.equal(c.resolution.value, 33.4);
  assert.match(c.resolution.detail, /rounding tolerance/);
});

test("reconcileNumericalConflicts resolves a count against a stated rate and denominator", () => {
  const w = weave(
    [1, "a", 1, "Antonelli has a 33% win rate this season."],
    [2, "b", 2, "Antonelli won 8 races."],
    [3, "c", 2, "The season has 25 races."],
    [4, "a", 1, "Antonelli won 6 races."],
  );
  const report = reconcileNumericalConflicts(w);
  const phrase = report.conflicts.find((c) => c.granularity === "phrase");
  assert.equal(phrase.status, "resolved");
  assert.equal(phrase.resolution.basis, "arithmetic");
  assert.equal(phrase.resolution.value, 8);
  assert.match(phrase.resolution.detail, /8 \/ 25 = 32\.0% ≈ stated 33%/);
});

test("reconcileNumericalConflicts versions unresolvable conflicts v1/v2 with a rule", () => {
  const w = weave(
    [1, "a", 1, "Antonelli will win 11 races."],
    [2, "b", 3, "Antonelli will win 8 races."],
  );
  const report = reconcileNumericalConflicts(w);
  const phrase = report.conflicts.find((c) => c.granularity === "phrase");
  assert.equal(phrase.status, "versioned");
  assert.deepEqual(phrase.versions.map((v) => v.value), [11, 8]);
  assert.equal(phrase.versions[0].contributionId, 1);
  assert.equal(phrase.versions[1].contributionId, 2);
  assert.match(phrase.reconciliationRule, /later value supersedes/);
  assert.equal(phrase.falsifier.method, "band");
  assert.equal(phrase.falsifier.ran, true);
  assert.equal(phrase.falsifier.reconciled, false);
  assert.equal(report.versionedCount >= 1, true);
});

test("shouldReserveReconciliationRound fires when R-final yields a new conflicting dataset", () => {
  const w = weave(
    [1, "a", 1, "Antonelli will win 11 races."],
    [2, "b", 3, "Antonelli will win 8 races."],
  );
  const report = reconcileNumericalConflicts(w);
  assert.equal(report.reserveRoundRecommended, true);
  assert.equal(shouldReserveReconciliationRound(w, report), true);
  // same conflict, but the revision landed in round 1 — no headroom needed
  const early = weave(
    [1, "a", 1, "Antonelli will win 11 races."],
    [2, "b", 1, "Antonelli will win 8 races."],
  );
  const earlyReport = reconcileNumericalConflicts(early);
  assert.equal(earlyReport.reserveRoundRecommended, false);
  assert.equal(shouldReserveReconciliationRound(early, earlyReport), false);
});

test("finalizeSynthesis counts versioned conflicts but does not ship them by default (N3)", () => {
  const transcriptData = {
    question: "Who wins the most races?",
    rounds: [
      { number: 1, contributions: [{ id: 1, participant_id: "a", type: "contribution", round: 1, content: "Antonelli will win 11 races." }] },
      { number: 2, contributions: [{ id: 2, participant_id: "b", type: "contribution", round: 2, content: "Antonelli will win 8 races." }] },
    ],
  };
  const participants = [
    { config: { id: "a", name: "A", category: "senior", }, status: "listening" },
    { config: { id: "b", name: "B", category: "mid", }, status: "listening" },
  ];
  const text = [
    "## Executive Summary",
    "Antonelli is the modal pick.",
    "",
    "## Reasoning",
    "Two counts were stated.",
    "",
    "## Action Items",
    "— Verify the win count — owner: A",
    "",
    "## Open Questions",
    "- Which count is right?",
    "",
    "## Confidence",
    "Medium.",
  ].join("\n");
  // Detectors ship OFF and dry (N3): the conflict is found and counted, but a
  // section that cannot state its precision does not reach the deliverable.
  const { artifact, output } = finalizeSynthesis(text, transcriptData, participants);
  assert.doesNotMatch(output, /## Needs Verification/);
  assert.equal(artifact.detector_report.needsVerification.shipped, false);
  assert.ok(artifact.detector_report.needsVerification.candidates >= 1, "candidates are still counted for the precision audit");
  // Structured report is unaffected — the truth is available either way.
  assert.match(artifact.reconciliation.conflicts.find((c) => c.status === "versioned").quantity, /antonelli win/);
  assert.equal(artifact.reconciliation.versionedCount >= 1, true);
  assert.equal(artifact.reconciliation.reserveRoundRecommended, true);
});

test("finalizeSynthesis ships Needs Verification once the flag is on and dry-run is off", () => {
  const transcriptData = {
    question: "Who wins the most races?",
    rounds: [
      { number: 1, contributions: [{ id: 1, participant_id: "a", type: "contribution", round: 1, content: "Antonelli will win 11 races." }] },
      { number: 2, contributions: [{ id: 2, participant_id: "b", type: "contribution", round: 2, content: "Antonelli will win 8 races." }] },
    ],
  };
  const participants = [
    { config: { id: "a", name: "A", category: "senior", }, status: "listening" },
    { config: { id: "b", name: "B", category: "mid", }, status: "listening" },
  ];
  const text = [
    "## Executive Summary", "Antonelli is the modal pick.", "",
    "## Reasoning", "Two counts were stated.", "",
    "## Action Items", "— Verify the win count — owner: A", "",
    "## Open Questions", "- Which count is right?", "",
    "## Confidence", "Medium.",
  ].join("\n");
  const { artifact, output } = finalizeSynthesis(text, transcriptData, participants, {
    detectors: { needsVerification: true, citationWarnings: true, dryRun: false },
  });
  assert.match(output, /## Needs Verification/);
  assert.match(output, /antonelli win: v1 = 11 win \[#1\] vs v2 = 8 win \[#2\]/);
  assert.match(output, /falsifier: band/);
  assert.equal(artifact.detector_report.needsVerification.shipped, true);
  assert.equal(artifact.detector_report.policy.dryRun, false);
});

test("the enabled flag still stays dry while dryRun is on", () => {
  const transcriptData = {
    question: "Who wins?",
    rounds: [
      { number: 1, contributions: [{ id: 1, participant_id: "a", type: "contribution", round: 1, content: "Antonelli will win 11 races." }] },
      { number: 2, contributions: [{ id: 2, participant_id: "b", type: "contribution", round: 2, content: "Antonelli will win 8 races." }] },
    ],
  };
  const participants = [
    { config: { id: "a", name: "A", category: "senior", }, status: "listening" },
    { config: { id: "b", name: "B", category: "mid", }, status: "listening" },
  ];
  const text = [
    "## Executive Summary", "Antonelli is the modal pick.", "",
    "## Reasoning", "Two counts were stated.", "",
    "## Action Items", "— Verify the win count — owner: A", "",
    "## Open Questions", "- Which count is right?", "",
    "## Confidence", "Medium.",
  ].join("\n");
  const { artifact, output } = finalizeSynthesis(text, transcriptData, participants, {
    detectors: { needsVerification: true, dryRun: true },
  });
  assert.doesNotMatch(output, /## Needs Verification/);
  assert.equal(artifact.detector_report.policy.needsVerification, true);
  assert.ok(artifact.detector_report.needsVerification.candidates >= 1);
});

test("finalizeSynthesis adds no reconciliation section when numbers agree", () => {
  const transcriptData = {
    question: "Who wins?",
    rounds: [{ number: 1, contributions: [{ id: 1, participant_id: "a", type: "contribution", round: 1, content: "Antonelli will win 8 races." }] }],
  };
  const participants = [{ config: { id: "a", name: "A", category: "senior", }, status: "listening" }];
  const text = [
    "## Executive Summary", "Antonelli.",    "",
    "## Reasoning", "One count.", "",
    "## Action Items", "- None",
    "", "## Open Questions", "- None.", "",
    "## Confidence", "Medium.",
  ].join("\n");
  const { artifact, output } = finalizeSynthesis(text, transcriptData, participants);
  assert.doesNotMatch(output, /numerical conflict\(s\)/);
  assert.equal(artifact.reconciliation.versionedCount, 0);
  assert.equal(artifact.reconciliation.reserveRoundRecommended, false);
});

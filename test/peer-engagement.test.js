import test from "node:test";
import assert from "node:assert/strict";
import { computeEngagementMetrics, findUncitedPlainContributions } from "../src/round-summarizer.js";
import { computeEngagementLedger } from "../src/synthesis-coordinator.js";
import { buildSynthesisPrompt } from "../src/prompts/synthesis.js";
import { finalizeSynthesis } from "../src/synthesizer.js";

// N8 — peer engagement enforced at synthesis.
//
// The round clerk already names peer-uncited plain contributions per round,
// but the deliverable is written later: 6 of 12 plain contributions were
// peer-uncited, self-cites had risen to 13, and synthesis coverage had slipped
// to 0.929 with nothing in force. The rule now travels with the synthesis
// prompt, and the artifact carries the measured ledger.

const WEAVE = [
  { id: 1, type: "contribution", round: 1, participant_id: "a", content: "The denominator convention is pinned and owned [#0]." },
  { id: 2, type: "contribution", round: 1, participant_id: "b", content: "I disagree with the rate on this sample." },
  { id: 3, type: "critique_response", round: 1, participant_id: "a", content: "Answering #1 directly: the n is too small." },
  { id: 4, type: "vote_response", round: 1, participant_id: "b", content: "[Vote: C] because the fork is reversible." },
  { id: 5, type: "contribution", round: 2, participant_id: "a", content: "Revised: I no longer stand by the earlier band, see [#2] and [#3]." },
];

test("findUncitedPlainContributions ignores responses and ballots", () => {
  const uncited = findUncitedPlainContributions(WEAVE);
  // #2 is the only plain contribution with no [#id]; the rest engage a peer.
  assert.deepEqual(uncited.map((c) => c.id), [2]);
  // A vote response is inherently a ballot, not an uncited claim.
  assert.equal(findUncitedPlainContributions([WEAVE[3]]).length, 0);
  // A critique_response answers a peer by construction.
  assert.equal(findUncitedPlainContributions([WEAVE[2]]).length, 0);
});

test("computeEngagementMetrics counts self-cites and coverage", () => {
  const withSelfCite = [...WEAVE, { id: 6, type: "contribution", round: 2, participant_id: "a", content: "Restating my own point [#6] for the record." }];
  const metrics = computeEngagementMetrics(withSelfCite);
  assert.equal(metrics.plain_contributions, 4);
  assert.equal(metrics.peer_uncited, 1);
  assert.equal(metrics.self_cites, 1);
  // Coverage is null until there is an artifact to measure against.
  assert.equal(metrics.coverage, null);

  const artifact = "The room pinned the denominator [#1] and revised the band [#5].";
  const covered = computeEngagementMetrics(withSelfCite, artifact);
  // 6 non-pass contributions, 2 cited.
  assert.equal(covered.coverage, 0.333);
  assert.deepEqual(covered.uncited_ids.sort((x, y) => x - y), [2, 3, 4, 6]);
});

test("the synthesis prompt names the uncited contributions", () => {
  const ledger = computeEngagementLedger({ rounds: [{ number: 1, contributions: WEAVE }] });
  assert.equal(ledger.peer_uncited, 1);
  assert.deepEqual(ledger.uncited_plain_ids, [2]);
  const prompt = buildSynthesisPrompt("Q?", "transcript", [], [], "",  "", { engagement: ledger });
  assert.match(prompt, /## Engagement Ledger \(clerk check — P7\)/);
  assert.match(prompt, /\[#2\]/);
  assert.match(prompt, /1 of 3 plain contributions engage no peer/);
});

test("a clean room gets no ledger section", () => {
  const engaged = WEAVE.map((c) => (c.id === 2 ? { ...c, content: "Revised against the pinned convention [#1]." } : c));
  const ledger = computeEngagementLedger({ rounds: [{ number: 1, contributions: engaged }] });
  assert.equal(ledger.peer_uncited, 0);
  const prompt = buildSynthesisPrompt("Q?", "transcript", [], [], "",  "", { engagement: ledger });
  assert.doesNotMatch(prompt, /Engagement Ledger/);
});

test("the artifact carries the measured engagement ledger", () => {
  const transcriptData = {
    question: "Q?",
    rounds: [{ number: 1, contributions: WEAVE }],
  };
  const participants = [{ config: { id: "a", name: "A", category: "mid", }, status: "listening" }];
  const text = [
    "## Executive Summary", "The convention is pinned [#1].", "",
    "## Decision", "Keep the pinned denominator [#1].", "",
    "## Reasoning", "The revision is recorded [#5].", "",
    "## Action Items", "- Own the convention — owner: A — [#1]", "",
    "## Open Questions", "- none", "",
    "## Confidence", "Medium.",
  ].join("\n");
  const { artifact } = finalizeSynthesis(text, transcriptData, participants);
  assert.equal(artifact.engagement.plain_contributions, 3);
  assert.equal(artifact.engagement.peer_uncited, 1);
  // #2, #3 and #4 are never cited in the artifact.
  assert.deepEqual(artifact.engagement.uncited_ids.sort((x, y) => x - y), [2, 3, 4]);
  assert.equal(artifact.engagement.coverage, 0.4);
});

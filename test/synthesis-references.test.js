/**
 * The final artifact's [#N] citation ids must resolve for a HUMAN reader, not
 * only for the pipeline: every [#
N] appears at least once paired with the
 * participant's NAME (prompt rule 1b), and the artifact ends with a
 * ## References index — the synthesizer's own lines preserved, every id it
 * missed backfilled deterministically (name, round, first ~120 chars). No LLM
 * call, so the backfill cannot invent a gist, a name, or a round.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { finalizeSynthesis, validateSynthesisSections, SYNTHESIS_SECTION_CONTRACT } from "../src/synthesizer.js";
import { buildSynthesisPrompt } from "../src/prompts/synthesis.js";

const PARTICIPANTS = [
  { config: { id: "ada", name: "Ada" }, status: "listening" },
  { config: { id: "ben", name: "Ben" }, status: "listening" },
  { config: { id: "cleo", name: "Cleo" }, status: "listening" },
];

function roundsFixture() {
  const long = (t, n) => `${t} `.repeat(n).trim();
  return [
    { number: 1, contributions: [
      { id: 2, participant_id: "cleo", type: "contribution", content: long("2027 PU rules are a mid-cycle tweak: 420 kW ICE, +5% fuel flow, 58/42 split, 375 kW harvest — not a reset.", 3) },
    ] },
    { number: 2, contributions: [
      { id: 4, participant_id: "ada", type: "contribution", content: long("Sprint wins must not count toward the title — only Grand Prix wins across the 24-round calendar score.", 3) },
      { id: 7, participant_id: "ben", type: "contribution", content: long("Ties are a real outcome, not something to split — share the title rather than invent a countback.", 3) },
    ] },
  ];
}

const ARTIFACT_NO_INDEX = [
  "## Executive Summary", "Scoring settled.", "",
  "## Decision", "Most Grand Prix wins across 24 rounds [#2][#4][#7]; the countback question stayed live in [#T9]; constructor answered separately.", "",
  "## Reasoning", "- Scoring definition agreed [#4]", "",
  "## Open Questions", "- none", "",
  "## Action Items", "- none", "",
  "## Confidence", "High",
].join("\n");

test("cited ids the synthesizer did not list are backfilled mechanically", () => {
  const { output, artifact } = finalizeSynthesis(ARTIFACT_NO_INDEX, { question: "Q", rounds: roundsFixture() }, PARTICIPANTS, {});
  const index = output.split("## References")[1] ?? "";
  assert.ok(index.length > 0, "the artifact must carry a ## References section");
  // Every cited id resolves: name, round, excerpt — deterministically.
  assert.match(index, /- \[#4\] — Ada, Round 2 — "/);
  assert.match(index, /- \[#7\] — Ben, Round 2 — "/);
  assert.match(index, /- \[#2\] — Cleo, Round 1 — "/);
  // Excerpts come from the cited contributions, not invented gists.
  assert.match(index, /Sprint wins must not count toward the title/);
  // No LLM call means the flagged note tells the reader what happened.
  assert.match(index, /Mechanically backfilled/);
  // The narrative body is untouched by the backfill.
  assert.match(artifact.content, /Most Grand Prix wins across 24 rounds \[#2\]\[#4\]\[#7\]/);
});

test("the synthesizer's own index entries are preserved verbatim", () => {
  const withIndex = `${ARTIFACT_NO_INDEX}\n\n## References\n- [#4] — Ada — Round 2 — dispersed: the author's own one-line gist\n`;
  const { output } = finalizeSynthesis(withIndex, { question: "Q", rounds: roundsFixture() }, PARTICIPANTS, {});
  const index = output.split("## References")[1] ?? "";
  // The LLM line survives untouched…
  assert.match(index, /the author's own one-line gist/);
  // …and only the ids it missed gain mechanical lines.
  assert.match(index, /- \[#2\] — Cleo/);
  assert.match(index, /- \[#7\] — Ben/);
  assert.equal((index.match(/- \[#4\]/g) ?? []).length, 1, "no duplicate entry for a listed id");
});

test("an artifact citing nothing gets a None line instead of a repair note", () => {
  const bare = "## Executive Summary\nDecided.\n\n## Decision\nShip it.\n\n## Reasoning\n- why\n\n## Open Questions\n- none\n\n## Action Items\n- none\n\n## Confidence\nHigh";
  const { output } = finalizeSynthesis(bare, { question: "Q", rounds: roundsFixture() }, PARTICIPANTS, {});
  const index = output.split("## References")[1] ?? "";
  assert.match(index, /None — the artifact cites no contribution ids\./);
  assert.equal((output.match(/## References/g) ?? []).length, 1);
});

test("forum thread refs resolve from the caller's topic map", () => {
  const { output } = finalizeSynthesis(ARTIFACT_NO_INDEX, { question: "Q", rounds: roundsFixture() }, PARTICIPANTS, {
    forumTopics: [{ id: 9, title: "Countback discussion" }],
  });
  const index = output.split("## References")[1] ?? "";
  assert.match(index, /- \[#T9\] — forum thread — Countback discussion/);
});

test("a thread ref with no map degrades honestly, not silently", () => {
  const { output } = finalizeSynthesis(ARTIFACT_NO_INDEX, { question: "Q", rounds: roundsFixture() }, PARTICIPANTS, {});
  const index = output.split("## References")[1] ?? "";
  assert.match(index, /thread title unavailable/);
});

test("the index is not scanned as citation evidence", () => {
  // A weak claim whose gist paraphrase shares NO keywords with the cited
  // contribution: only the Decision sentence may be flagged, not its own index
  // line — the index is a map, not a claim. The cited contribution is long
  // enough to enter the support check (min target chars).
  const filler = "the widget tempo allocation drifts nightly in sync with the quorum window and the zephyr harness sees it first every cycle. ";
  const transcript = { question: "Q", rounds: [
    { number: 1, contributions: [{ id: 1, participant_id: "ada", type: "contribution", content: `Zephyr quorum ${filler.repeat(8)}` }] },
  ] };
  const text = [
    "## Executive Summary", "Open thread carried.", "",
    "## Decision", "The wobble cadence stays unexplained [#1].", "",
    "## References", "- [#1] — Ada — Round 1 — the first-round framing", "",
    "## Open Questions", "- none", "",
    "## Action Items", "- none", "",
    "## Confidence", "Low",
  ].join("\n");
  const { artifact } = finalizeSynthesis(text, transcript, PARTICIPANTS, { detectors: { citationWarnings: true, dryRun: false } });
  assert.equal(artifact.detector_report.citationWarnings.candidates, 1, "exactly the body sentence — never the index line itself");
});

test("coverage counts body engagement, not the appendix", () => {
  const transcriptData = { question: "Q", rounds: roundsFixture() };
  const { artifact } = finalizeSynthesis(ARTIFACT_NO_INDEX, transcriptData, PARTICIPANTS, {});
  // The backfill lists every id, but coverage is the body's engagement —
  // a marker line must not silently flip an unengaged contribution to "covered".
  assert.equal(artifact.engagement.uncited_ids.length, 0);
  assert.ok(Number.isFinite(artifact.engagement.coverage));
});

test("the section contract requires References and the prompt teaches it", () => {
  assert.ok(SYNTHESIS_SECTION_CONTRACT.always.includes("References"), "References must be an always-required section");
  assert.ok(validateSynthesisSections("## Reasoning\nx\n").includes("References"), "a missing index is flagged");
  const prompt = buildSynthesisPrompt("Q", "t", [], [], "", "", {});
  assert.match(prompt, /## References/);
  assert.match(prompt, /References resolve for a human/);
  // Rule 1b: names paired with ids — taught in the doctrine AND rendered in the example.
  assert.match(prompt, /Ada \[#2\]/);
  // The example carries its own index (few-shot imitation must work for us).
  const example = prompt.split("## Good Fragment")[1] ?? "";
  assert.match(example, /## References/);
  assert.match(example, /- \[#4\] — Ada/);
});

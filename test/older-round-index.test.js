/**
 * Room-layer resolvability — every [#id] the room is asked to cite must resolve
 * for a HUMAN as well as the pipeline, at every layer that travels:
 *
 *   - agent primary turns: holder NAME paired with the id at first use (rule 2),
 *     and the live block renders `Name [id]` so the pairing is copy-work, not
 *     a two-hop lookup;
 *   - the prior-round citable index: the live window is the CURRENT round only,
 *     so older ids resolve only through the `## Contribution Index` block —
 *     deduped by id against the live block, budget-capped oldest-first, honest
 *     truncation, fenced like every other agent-authored block;
 *   - the clerk: every bullet pairs ids with the holder's NAME, and the
 *     contribution lines the clerk reads carry the name too.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { buildAgentUserPrompt, buildAgentSystemPrompt } from "../src/prompts/agent.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { buildPriorRoundContributionIndex, PRIOR_INDEX_BUDGET_CHARS } from "../src/state-of-play.js";
import { formatContribution } from "../src/round-summarizer.js";

const PARTICIPANT = { config: { id: "me", name: "Me", category: "mid" }, status: "listening" };

const SO_P = "## Question\nQ?\n\n## Agreements\n- x";

// The helper: id + name + round + gist, oldest first, no pass rows, dedup by id.

test("index lines carry id, holder name, round, gist — oldest rounds first", () => {
  const out = buildPriorRoundContributionIndex(
    [
      { id: 7, participant_id: "ben", round: 2, type: "contribution", content: "Ties are a real outcome, not something to split — share the title rather than invent a countback." },
      { id: 2, participant_id: "ada", round: 1, type: "contribution", content: "Sprint wins must not count toward the title." },
    ],
    new Set(),
    { ada: "Ada", ben: "Ben" },
  );
  assert.match(out, /- \[#2\] Ada \(round 1\): Sprint wins/);
  assert.match(out, /- \[#7\] Ben \(round 2\): Ties are a real outcome/);
  assert.ok(out.indexOf("#2] Ada") < out.indexOf("#7] Ben"), "oldest rounds first");
});

test("ids already rendered in the live block are excluded by id, not by round", () => {
  // Round 13 is an EARLIER round by number, but id 9 is in the live window —
  // excluded. Round 12's id 8 stays.
  const out = buildPriorRoundContributionIndex(
    [
      { id: 8, participant_id: "ada", round: 12, type: "contribution", content: "a claim" },
      { id: 9, participant_id: "ben", round: 13, type: "contribution", content: "another claim" },
    ],
    ["9"],
    {},
  );
  assert.match(out, /\[#8\]/);
  assert.doesNotMatch(out, /\[#9\]/);
});

test("pass rows, states, and reflections never mint index lines", () => {
  const out = buildPriorRoundContributionIndex(
    [
      { id: 1, participant_id: "a", round: 1, type: "pass", content: "nothing new" },
      { id: 2, participant_id: "a", round: 1, type: "vote_response", content: "ballot A" },
      { id: 3, participant_id: "a", round: 1, type: "reflection", content: "reflecting" },
    ],
    new Set(),
    {},
  );
  assert.equal(out, "");
});

test("budget truncation is honest and cuts the tail (newest older rounds)", () => {
  const many = [];
  for (let i = 1; i <= 60; i++) {
    many.push({ id: i, participant_id: "a", round: Math.ceil(i / 6), type: "contribution", content: `claim ${"word ".repeat(20)}` });
  }
  const out = buildPriorRoundContributionIndex(many, new Set(), {}, { budgetChars: 900 });
  assert.ok(out.length < 900 + 200, "the block respects its budget");
  assert.match(out, /index truncated to fit the budget — \d+ contribution line/, "truncation is announced");
  assert.match(out, /\[#1\]/, "oldest first — round 1 survives");
  assert.doesNotMatch(out, /\[#60\]/, "the newest older round is cut first");
});

test("a too-long gist is cut at the cap with an ellipsis, not silently quoted whole", () => {
  const long = "sprinting toward the wire ".repeat(30);
  const out = buildPriorRoundContributionIndex(
    [{ id: 4, participant_id: "ada", round: 1, type: "contribution", content: long }],
    new Set(),
    { ada: "Ada" },
  );
  const gist = out.match(/\[#4\] Ada \(round 1\): (.+)\n/)?.[1] ?? "";
  assert.equal(gist.length, 120 + "…".length);
  assert.ok(gist.endsWith("…"), "the cut is visible");
});

// The block: gated, fenced, and the live lines carry names.

const PROMPT_OPTS = (users) => ({
  maxRounds: 10,
  contextWindow: 200000,
  participantNames: { ada: "Ada", ben: "Ben" },
  earlierContributions: users,
});

function priorFixture() {
  return [
    { id: 2, participant_id: "ada", round: 1, type: "contribution", content: "Sprint wins must not count toward the title." },
    { id: 7, participant_id: "ben", round: 2, type: "contribution", content: "Ties are a real outcome, not something to split." },
  ];
}

const USER_OPTS = (overrides = {}) => ({
  maxRounds: 10, contextWindow: 200000, ...overrides,
});

// buildAgentUserPrompt(participant, sop, recent, round, q, tags, ctx, peers, myState, queryOn, caps, options)

function buildUser(recent, options) {
  return buildAgentUserPrompt(
    PARTICIPANT, SO_P, recent, 3, "Q?", [], "", [], null, true, {}, options,
  );
}

test("the index block renders fenced, with the dispute guard below it", () => {
  const user = buildUser([], USER_OPTS({ earlierContributions: priorFixture(), participantNames: { ada: "Ada", ben: "Ben" } }));
  assert.match(user, /## Contribution Index — earlier rounds/);
  assert.match(user, /<<<LOOM_PRIOR_INDEX/);
  assert.match(user, /- \[#2\] Ada \(round 1\): Sprint wins/);
  assert.match(user, /never reopen a settled point on an index line alone/, "the gist-dispute guard rides the block");
  assert.ok(user.indexOf("## Contribution Index") < user.indexOf("## Live — Recent Contributions"), "the index sits before the live window");
});

test("live lines render the holder NAME with the id when the map has it", () => {
  const user = buildUser([{ id: 12, participant_id: "ben", round: 3, type: "contribution", content: "live claim" }], USER_OPTS({ participantNames: { ben: "Ben" } }));
  assert.match(user, /\[#12\] Ben \[ben\]: live claim/, "name + id on screen");
});

test("without the name the line stays resolvable by raw id (legacy shape)", () => {
  const user = buildUser([{ id: 12, participant_id: "ben", round: 3, type: "contribution", content: "live claim" }], USER_OPTS({}));
  assert.match(user, /\[#12\] \[ben\]: live claim/);
});

test("no earlier contributions — no block; the prompt is the legacy shape", () => {
  const user = buildUser([], USER_OPTS({}));
  assert.doesNotMatch(user, /## Contribution Index/);
  assert.doesNotMatch(user, /LOOM_PRIOR_INDEX/);
});

test("live ids never leak into the index block (same id, both layers)", () => {
  const user = buildUser(
    [{ id: 7, participant_id: "ben", round: 3, type: "contribution", content: "live repeat of an old id" }],
    USER_OPTS({ earlierContributions: priorFixture(), participantNames: { ada: "Ada", ben: "Ben" } }),
  );
  const live = user.split("## Live — Recent Contributions")[1] ?? "";
  assert.match(live, /\[#7\] Ben \[ben\]/);
  // The index body is between the two headings; id 7 belongs to the live layer only.
  const index = (user.split("## Contribution Index — earlier rounds")[1] ?? "").split("## Live — Recent Contributions")[0] ?? "";
  assert.doesNotMatch(index, /\[#7\]/);
  assert.match(index, /\[#2\] Ada/, "the index keeps the ids it owns");
});

// The agent contract: the pairing rule is taught, and the budget claim is pinned.

test("the agent system prompt teaches the NAME-pairing rule with its budget cost", () => {
  const sys = buildAgentSystemPrompt(PARTICIPANT, { activeCount: 3, agentTools: structuredClone(DEFAULT_CONFIG.agentTools) });
  assert.match(sys, /Name the holder at first use/);
  assert.match(sys, /same id, not a new one/, "the rule states its zero cost against the citation budget");
  assert.match(sys, /a bare id a reader cannot resolve is a hole/);
});

// The clerk reads names too.

test("formatContribution renders the display NAME with the raw id", () => {
  const line = formatContribution(
    { id: 5, participant_id: "dr_sarah_3", type: "contribution", content: "scoring math" },
    new Map(),
    new Map([["dr_sarah_3", "Dr. Sarah"]]),
  );
  assert.match(line, /^\- \[#5\] Dr\. Sarah \(dr_sarah_3\) \[CONTRIBUTION\]: scoring math$/);
});

test("formatContribution falls back to the raw id when no name is known", () => {
  const line = formatContribution(
    { id: 5, participant_id: "ghost", type: "contribution", content: "x" },
    new Map(),
    new Map(),
  );
  assert.match(line, /^\- \[#5\] ghost \[CONTRIBUTION\]: x$/);
});

test("the default index budget is bounded", () => {
  assert.ok(PRIOR_INDEX_BUDGET_CHARS >= 1600 && PRIOR_INDEX_BUDGET_CHARS <= 3000);
});

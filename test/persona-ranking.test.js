import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRankingResult,
  getAutoSelectSeats,
  embedderUnavailableError,
  EMBEDDER_UNAVAILABLE,
  formatRoomPreview,
  rankAllPersonas,
} from "../src/composer/room.js";
import { similarityOf, similarityPercent } from "../src/composer/similarity.js";
import { getPersonas } from "../src/composer/persona-loader.js";

// Room composition is a flat ranked pool: every persona is scored against the
// question and the ordering is the whole answer. These tests pin the two
// properties that were most expensive to get wrong under the old seniority design —
// that distance alone decides the order, and that a missing embedder is a hard
// stop rather than a silent keyword substitution.

const row = (persona_name, category, distance) => ({ persona_name, category, distance });

test("buildRankingResult sorts ascending by distance across all categories", () => {
  const { ranked } = buildRankingResult([
    row("C", "senior", 0.9),
    row("A", "junior", 0.1),
    row("B", "nonhuman", 0.5),
    row("D", "principal", 0.3),
  ], 3);
  assert.deepEqual(ranked.map((r) => r.name), ["A", "D", "B", "C"]);
});

test("buildRankingResult applies no category quota — three of one category can win", () => {
  // The removed design capped each category's contribution. A flat pool must be
  // willing to return three juniors in a row if they are genuinely closest.
  const { ranked, selected } = buildRankingResult([
    row("J1", "junior", 0.10),
    row("J2", "junior", 0.11),
    row("J3", "junior", 0.12),
    row("P1", "principal", 0.90),
  ], 3);
  assert.deepEqual(ranked.map((r) => r.name), ["J1", "J2", "J3", "P1"]);
  assert.deepEqual(selected.map((r) => r.name), ["J1", "J2", "J3"]);
});

test("buildRankingResult breaks distance ties by name so the list is reproducible", () => {
  const rows = [row("Zoe", "mid", 0.4), row("Ada", "mid", 0.4), row("Mo", "mid", 0.4)];
  const a = buildRankingResult(rows, 3).ranked.map((r) => r.name);
  const b = buildRankingResult([...rows].reverse(), 3).ranked.map((r) => r.name);
  assert.deepEqual(a, ["Ada", "Mo", "Zoe"]);
  assert.deepEqual(a, b, "input order must not affect the ranking");
});

test("selected is a strict prefix of ranked", () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(`P${i}`, "mid", i / 100));
  const { ranked, selected } = buildRankingResult(rows, 4);
  assert.equal(selected.length, 4);
  assert.deepEqual(selected, ranked.slice(0, 4));
});

test("autoSelectSeats is honoured, clamped to the catalog, and defaulted to 3", () => {
  const rows = Array.from({ length: 5 }, (_, i) => row(`P${i}`, "mid", i / 10));
  assert.equal(buildRankingResult(rows, 2).selected.length, 2);
  assert.equal(buildRankingResult(rows, 99).selected.length, 5, "never exceeds the catalog");
  assert.equal(buildRankingResult(rows, 0).autoSelectCount, getAutoSelectSeats());
  assert.equal(buildRankingResult([], 3).autoSelectCount, 0);
  assert.deepEqual(buildRankingResult([], 3).ranked, []);
});

test("getAutoSelectSeats defaults to 3", () => {
  assert.equal(getAutoSelectSeats(), 3);
});

test("non-finite distances sort last rather than poisoning the top slice", () => {
  const { ranked } = buildRankingResult([
    row("ok", "mid", 0.5),
    row("bad", "mid", Number.NaN),
  ], 2);
  assert.deepEqual(ranked.map((r) => r.name), ["ok", "bad"]);
});

test("embedderUnavailableError carries the code the API maps to 503", () => {
  const err = embedderUnavailableError("no model");
  assert.equal(err.code, EMBEDDER_UNAVAILABLE);
  assert.match(err.message, /no model/);
});

test("rankAllPersonas rejects an empty question", async () => {
  await assert.rejects(() => rankAllPersonas("   "), /question required/);
});

test("ranking either produces a full list or refuses loudly — never an empty room", async () => {
  // The dashboard warms the persona index in the background. That is a
  // convenience, not a new dependency, and this assertion has to hold in both
  // environments — so it branches on what actually happened rather than
  // assuming an embedder is or isn't present.
  //
  // The failure mode this guards against: a warm that failed (or never ran)
  // leaving `ranked` empty, which the dialog would render as a room with no
  // personas while presenting it as the closest matches.
  let result = null;
  let thrown = null;
  try {
    result = await rankAllPersonas("what is the probability of the forecast model being right?");
  } catch (err) {
    thrown = err;
  }

  if (thrown) {
    assert.equal(thrown.code, EMBEDDER_UNAVAILABLE, `unexpected failure: ${thrown.message}`);
    return;
  }
  assert.ok(result.ranked.length > 0, "a successful ranking must not be empty");
  assert.equal(result.selected.length, result.autoSelectCount);
  assert.deepEqual(result.selected, result.ranked.slice(0, result.autoSelectCount));
});

test("the persona catalog spans several categories a flat ranking can mix", () => {
  const personas = getPersonas();
  const categories = Object.keys(personas).filter((t) => (personas[t] ?? []).length > 0);
  assert.ok(categories.length >= 6, `expected six populated categories, got ${categories.join(",")}`);
  assert.ok(categories.includes("nonhuman"), "nonhuman personas rank in the same pool as human ones");
});

// Similarity display: the store returns L2-equivalent distance, so the dialog
// has to invert it before showing a percentage.

test("similarityOf inverts the L2 distance the vector store returns", () => {
  assert.equal(similarityOf(0), 1, "zero distance is a perfect match");
  assert.equal(similarityOf(Math.SQRT2), 0, "orthogonal vectors score zero");
  assert.equal(similarityPercent(0), 100);
  assert.equal(similarityOf(Number.NaN), 0);
  assert.equal(similarityOf("nope"), 0);
});

test("similarityPercent is monotonic in similarity", () => {
  assert.ok(similarityPercent(0.2) > similarityPercent(0.6));
  assert.ok(similarityPercent(0.6) > similarityPercent(1.0));
});

test("formatRoomPreview renders the selected slice of a ranking", () => {
  const result = buildRankingResult([
    row("Reef Ecologist", "mid", 0.12),
    row("Auth Lead", "senior", 0.31),
    row("Actuarial Analyst", "mid", 0.44),
    row("Keyboard Historian", "civilian", 1.9),
  ], 3);
  const md = formatRoomPreview(result);
  assert.match(md, /Proposed Deliberation Room/);
  assert.match(md, /Reef Ecologist/);
  assert.match(md, /4 personas selected/);
  assert.doesNotMatch(md, /Keyboard Historian/, "unselected personas are not listed");
});
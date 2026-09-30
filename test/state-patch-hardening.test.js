import test from "node:test";
import assert from "node:assert/strict";
import {
  coerceStatePatch,
  mergeStatePatches,
  applyStatePatch,
  emptyAgentState,
  STATE_PATCH_CAPS,
} from "../src/state-patch.js";
import { StatePatchSchema } from "../src/schemas.js";

// loom_state_patch hardening: a patch must never fail on shape.
// Every shape below was observed rejecting a real patch in meeting
// 0d5acaba (8 of 21 attempts rejected: 6 string-length, 2 nested-object).

test("coerceStatePatch accepts a bare string where a list was expected", () => {
  const { patch, notes, empty } = coerceStatePatch({ established_add: "one bullet" });
  assert.equal(empty, false);
  assert.deepEqual(patch.established_add, ["one bullet"]);
  assert.ok(notes.some((n) => n.includes("bare string")));
});

test("coerceStatePatch flattens the recursive {established_add:{contested_add:{...}}} nest", () => {
  // Verbatim shape rejected in production.
  const { patch, notes, empty } = coerceStatePatch({
    established_add: { contested_add: { contested_add: { item: ["The 55% figure was carried over"] } } },
  });
  assert.equal(empty, false);
  assert.deepEqual(patch.established_add, ["The 55% figure was carried over"]);
  assert.ok(notes.some((n) => n.includes("flattened")));
});

test("coerceStatePatch collects string leaves from mixed nested shapes", () => {
  const { patch } = coerceStatePatch({
    facts_add: { a: "first fact Source: fia.com", b: { c: ["second fact [#7]"] } },
  });
  assert.deepEqual(patch.facts_add, ["first fact Source: fia.com", "second fact [#7]"]);
});

test("coerceStatePatch keeps a stance longer than the old 400-char maximum", () => {
  const long = "x".repeat(1200);
  const { patch, empty } = coerceStatePatch({ stance: long });
  assert.equal(empty, false);
  assert.equal(patch.stance.length, 1200);
  // Storage trims rather than refusing.
  const { next } = applyStatePatch(undefined, patch);
  assert.equal(next.stance.length, STATE_PATCH_CAPS.stanceMax);
});

test("coerceStatePatch keeps bullets longer than the old 280-char maximum", () => {
  const long = "y".repeat(900);
  const { patch } = coerceStatePatch({ established_add: [long] });
  assert.equal(patch.established_add[0].length, 900);
  const { next } = applyStatePatch(undefined, patch);
  assert.equal(next.established[0].length, STATE_PATCH_CAPS.bulletMax);
});

test("coerceStatePatch accepts more bullets than the old per-call cap of 3", () => {
  const items = ["a", "b", "c", "d", "e", "f"];
  const { patch } = coerceStatePatch({ established_add: items });
  assert.equal(patch.established_add.length, 6);
  // Buckets still bound at 8 by FIFO eviction, so storage is still bounded.
  const { next } = applyStatePatch(undefined, patch);
  assert.ok(next.established.length <= STATE_PATCH_CAPS.buckets);
});

test("coerceStatePatch ignores unknown keys instead of rejecting the patch", () => {
  const { patch, droppedKeys, notes, empty } = coerceStatePatch({
    stance: "held",
    established: ["unknown-key field"],
    stancey: "typo",
  });
  assert.equal(empty, false);
  assert.equal(patch.stance, "held");
  assert.deepEqual(droppedKeys, ["established", "stancey"]);
  assert.ok(notes.some((n) => n.includes("unknown key")));
});

test("coerceStatePatch reports an empty patch without throwing", () => {
  for (const input of [{}, { stance: "" }, { established_add: [] }, { nonsense: 1 }, null, undefined, "string"]) {
    const r = coerceStatePatch(input);
    assert.equal(r.empty, true, `expected empty for ${JSON.stringify(input)}`);
    assert.ok(Array.isArray(r.patch.established_add));
  }
});

test("coerceStatePatch survives a cyclic object without recursing forever", () => {
  const cyclic = { a: "real bullet" };
  cyclic.self = cyclic;
  const { patch, empty } = coerceStatePatch({ established_add: cyclic });
  assert.equal(empty, false);
  assert.deepEqual(patch.established_add, ["real bullet"]);
});

test("coerceStatePatch coerces numbers and booleans to text", () => {
  const { patch } = coerceStatePatch({ established_add: [42, true] });
  assert.deepEqual(patch.established_add, ["42", "true"]);
});

test("StatePatchSchema cannot reject any of the previously-failing shapes", () => {
  const previouslyRejected = [
    { stance: "x".repeat(401) },
    { established_add: ["y".repeat(281)] },
    { established_add: ["a", "b", "c", "d"] },
    { established_add: { contested_add: { contested_add: { item: ["z"] } } } },
    { stance: 42 },
    { established_add: "bare string" },
    { unknown_key: "ignored" },
  ];
  for (const input of previouslyRejected) {
    const r = StatePatchSchema.safeParse(input);
    assert.equal(r.success, true, `schema rejected ${JSON.stringify(input).slice(0, 60)}`);
  }
});

test("coerced patches apply cleanly and preserve content", () => {
  const { patch } = coerceStatePatch({
    stance: "Mercedes leads; the number is a resolver output, not an estimate.",
    established_add: { contested_add: { item: ["2027 PU is a rebalance, not a new generation [#1]"] } },
    facts_add: ["Jolpica wins field is GP-only Source: github.com/jolpica [#5]"],
  });
  const { next, applied } = applyStatePatch(emptyAgentState(), patch);
  assert.match(next.stance, /Mercedes leads/);
  assert.equal(next.established.length, 1);
  assert.equal(next.facts.length, 1);
  assert.equal(applied.stance, true);
  assert.equal(next.version, 1);
});

test("mergeStatePatches folds a second call into the first", () => {
  const a = coerceStatePatch({ stance: "first", established_add: ["one"] }).patch;
  const b = coerceStatePatch({ established_add: ["two"], facts_add: ["Source: x [#2]"] }).patch;
  const merged = mergeStatePatches(a, b);
  assert.equal(merged.stance, "first");
  assert.deepEqual(merged.established_add, ["one", "two"]);
  assert.equal(merged.facts_add.length, 1);
});

test("mergeStatePatches lets a later stance win", () => {
  const a = coerceStatePatch({ stance: "first" }).patch;
  const b = coerceStatePatch({ stance: "second" }).patch;
  assert.equal(mergeStatePatches(a, b).stance, "second");
});

test("applying two patches in sequence accumulates rather than replacing", () => {
  const first = applyStatePatch(undefined, coerceStatePatch({ established_add: ["alpha"] }).patch);
  const second = applyStatePatch(first.next, coerceStatePatch({ established_add: ["beta"] }).patch);
  assert.deepEqual(second.next.established, ["alpha", "beta"]);
  assert.equal(second.next.version, 2);
});

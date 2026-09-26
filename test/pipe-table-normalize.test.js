import test from "node:test";
import assert from "node:assert/strict";
import { normalizePipeTables } from "../src/utils/markdown-tables.js";

test("inserts a missing delimiter row so the spectrum table parses", () => {
  const input = [
    "| Position | Holder(s) | Evidence | Tradeoff |",
    "| A: Spain repeats | Coach [#10] | Peak-age core intact [#3] | Home rest at cost of base rate |",
    "| B: France challenger | Engineer [#3] | Mbappe ceiling [#3] | Upside at cost of transition |",
  ].join("\n");
  const out = normalizePipeTables(input);
  const lines = out.split("\n");
  assert.equal(lines.length, 4);
  assert.equal(lines[1], "| --- | --- | --- | --- |");
});

test("leaves valid tables untouched (idempotent)", () => {
  const input = [
    "| Position | Holder(s) |",
    "| --- | --- |",
    "| A | Coach |",
  ].join("\n");
  assert.equal(normalizePipeTables(input), input);
});

test("handles alignment delimiters as already valid", () => {
  const input = "| A | B |\n| :--- | ---: |\n| x | y |";
  assert.equal(normalizePipeTables(input), input);
});

test("ignores single pipe lines and mismatched column counts", () => {
  assert.equal(normalizePipeTables("a | b"), "a | b");
  const input = "| A | B |\n| x | y | z |";
  assert.equal(normalizePipeTables(input), input);
});

test("leaves fenced code blocks untouched", () => {
  const input = ["```", "| A | B |", "| x | y |", "```"].join("\n");
  assert.equal(normalizePipeTables(input), input);
});

test("repairs only the broken table when mixed with a valid one", () => {
  const input = [
    "| A | B |",
    "| --- | --- |",
    "| x | y |",
    "",
    "| P | Q | R |",
    "| a | b | c |",
  ].join("\n");
  const lines = normalizePipeTables(input).split("\n");
  assert.equal(lines[5], "| --- | --- | --- |");
  assert.equal(lines.length, 7);
});

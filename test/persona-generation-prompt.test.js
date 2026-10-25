import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPersonaGenerationPrompt,
  clampGenerateCount,
  MAX_GENERATE_COUNT,
  MIN_GENERATE_COUNT,
  DEFAULT_GENERATE_COUNT,
  GENERATION_CATEGORIES,
  CONTRIBUTION_TYPES,
} from "../src/prompts/persona-generation.js";

test("count clamps to the advertised 1..8 range with a 3 default", () => {
  assert.equal(MAX_GENERATE_COUNT, 8, "the dialog offers up to 8 seats");
  assert.equal(MIN_GENERATE_COUNT, 1);
  assert.equal(DEFAULT_GENERATE_COUNT, 3);
  assert.equal(clampGenerateCount(0), 1, "0 falls to the floor, never an empty room");
  assert.equal(clampGenerateCount(-4), 1);
  assert.equal(clampGenerateCount(99), 8, "the ceiling is what the schema validates");
  assert.equal(clampGenerateCount("5"), 5, "form values arrive as strings");
  assert.equal(clampGenerateCount("not a number"), DEFAULT_GENERATE_COUNT);
  assert.equal(clampGenerateCount(undefined), DEFAULT_GENERATE_COUNT);
});

test("the prompt demands exactly N personas and embeds the query", () => {
  const question = "Should we migrate to the new billing engine this quarter?";
  const { system, text } = buildPersonaGenerationPrompt({ question, count: 5 });
  assert.match(text, /Design exactly 5 distinct persona definitions/);
  assert.match(text, /JSON array of exactly 5 objects/);
  assert.ok(text.includes(question), "the question must reach the model verbatim");
  assert.ok(!text.includes("<context>"), "no empty context section when none was given");
  assert.match(system, /ONLY a JSON array/, "the system prompt pins the output shape too");
});

test("context is embedded when present", () => {
  const { text } = buildPersonaGenerationPrompt({
    question: "Q",
    context: "We already tried a partial migration in Q2.",
    count: 3,
  });
  assert.ok(text.includes("<context>"));
  assert.ok(text.includes("We already tried a partial migration in Q2."));
});

test("the diversity contract and angle field are hard requirements", () => {
  const { text } = buildPersonaGenerationPrompt({ question: "Q", count: 3 });
  assert.match(text, /## Diversity contract \(hard requirements\)/);
  assert.match(text, /No two personas may share the same primary lens/);
  assert.match(text, /do not make them all senior/, "seniority spread is part of the contract");
  assert.match(text, /No generic archetypes/);
  assert.match(text, /## The angle field/);
  assert.match(text, /"angle":/, "every schema carries angle so the UI can show what differs");
});

test("existing catalog names are listed as must-not-reuse", () => {
  const { text } = buildPersonaGenerationPrompt({
    question: "Q",
    count: 3,
    avoidNames: ["Ada Lovelace-II"],
  });
  assert.match(text, /Names you must NOT reuse/);
  assert.ok(text.includes("Ada Lovelace-II"));
  assert.match(text, /1 existing personas/, "the count tells the model how big the catalog is");
});

test("categories and contribution types stay inside the corpus vocabulary", () => {
  const { text } = buildPersonaGenerationPrompt({ question: "Q", count: 3 });
  for (const c of GENERATION_CATEGORIES) {
    assert.ok(text.includes(c), `category enum must include ${c}`);
  }
  const schemaLine = text.split("\n").find((l) => l.includes("preferred_contribution_types"));
  assert.ok(schemaLine, "the schema must declare preferred_contribution_types");
  for (const t of CONTRIBUTION_TYPES) {
    assert.ok(schemaLine.includes(t), `contribution vocabulary must include ${t}`);
  }
  assert.match(text, /Never <behavior> — instead, <alternative>/, "anti-pattern shape matches the lints");
});

test("nearby catalog personas are surfaced, capped at 6, with a differ instruction", () => {
  const { text } = buildPersonaGenerationPrompt({
    question: "Q",
    count: 3,
    nearby: [{ name: "Security Budget Hawk", category: "senior", agenda: "Keep the blast radius small." }],
  });
  assert.match(text, /take a deliberately different angle/);
  assert.ok(text.includes("Security Budget Hawk"));
  assert.ok(text.includes("Keep the blast radius small."));

  const many = Array.from({ length: 12 }, (_, i) => ({
    name: `Zeta-${String(i).padStart(2, "0")}`,
    category: "mid",
    agenda: `agenda ${i}`,
  }));
  const capped = buildPersonaGenerationPrompt({ question: "Q", count: 3, nearby: many }).text;
  assert.ok(capped.includes("Zeta-05"), "the sixth nearest persona is included");
  assert.ok(!capped.includes("Zeta-06"), "the nearby list caps at 6 rows");
});

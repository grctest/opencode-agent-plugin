import test from "node:test";
import assert from "node:assert/strict";
import { parseGeneratedPersonas, sanitizeGeneratedPersona } from "../src/persona-generation.js";

const basePersona = (name, over = {}) => ({
  name,
  persona: `You are ${name}, the concrete lens this fixture stands behind, with enough detail to clear the minimum length floor.`,
  agenda: `Push the decision toward the ${name} outcome in this deliberation.`,
  category: "mid",
  angle: `${name} take on the question`,
  tags: ["alpha", "beta"],
  expertise: ["testing", "fixtures"],
  ...over,
});

test("parses a fenced model response into clean personas", () => {
  const json = JSON.stringify([basePersona("One"), basePersona("Two")]);
  const { personas, rejected, parseError } = parseGeneratedPersonas(`Here you go:\n\`\`\`json\n${json}\n\`\`\``, {
    count: 3,
  });
  assert.equal(parseError, null);
  assert.equal(personas.length, 2);
  assert.deepEqual(rejected, []);
  assert.equal(personas[0].name, "One");
});

test("unfenced JSON with surrounding prose also parses", () => {
  const json = JSON.stringify([basePersona("Solo")]);
  const { personas, parseError } = parseGeneratedPersonas(`Sure! ${json} Done.`, { count: 3 });
  assert.equal(parseError, null);
  assert.equal(personas.length, 1);
});

test("clamps to the requested count instead of seating extras", () => {
  const json = JSON.stringify(
    ["A", "B", "C", "D", "E"].map((n) => basePersona(`Person ${n}`)),
  );
  const { personas, rejected, parseError } = parseGeneratedPersonas(json, { count: 2 });
  assert.equal(parseError, null);
  assert.equal(personas.length, 2, "only the requested number survives");
  assert.deepEqual(rejected, [], "extras past the count are dropped, not rejected");
});

test("catalog name collisions and in-batch duplicates are rejected with a reason", () => {
  const json = JSON.stringify([
    basePersona("One"),
    basePersona("ONE"),
    basePersona("Fresh Lens"),
  ]);
  const { personas, rejected, parseError } = parseGeneratedPersonas(json, {
    count: 3,
    existingNames: ["fresh lens"],
  });
  assert.equal(parseError, null);
  assert.equal(personas.length, 1, "the first 'One' seats; 'ONE' collides in-batch, 'Fresh Lens' with the catalog");
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every((r) => r.reason === "name already exists"));
});

test("a response with no JSON array fails loudly, not silently", () => {
  const { personas, rejected, parseError } = parseGeneratedPersonas("Sorry, I cannot help with that.");
  assert.equal(parseError, "no JSON array found in model response");
  assert.deepEqual(personas, []);
  assert.deepEqual(rejected, []);
});

test("malformed JSON inside the array reports invalid JSON", () => {
  const { personas, parseError } = parseGeneratedPersonas('[{"name": broken}]', { count: 3 });
  assert.match(parseError, /^invalid JSON:/);
  assert.deepEqual(personas, []);
});

test("sanitize clamps over-budget fields instead of rejecting the persona", () => {
  const long = "x".repeat(5000);
  const longAngle = "a".repeat(400);
  const result = sanitizeGeneratedPersona(
    basePersona("Long Lens", { persona: long, angle: longAngle }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.persona.persona.length, 4000, "persona clamps to the disk budget");
  assert.equal(result.persona.angle.length, 180, "angle clamps to its 180-char budget");
});

test("sanitize rejects shapes the loader would refuse", () => {
  assert.equal(sanitizeGeneratedPersona(null).reason, "not an object");
  assert.equal(sanitizeGeneratedPersona(basePersona("")).reason, "missing name");
  assert.equal(sanitizeGeneratedPersona(basePersona("No Tags", { tags: [] })).reason, "tags required");
});

test("sanitize defaults an invalid category to civilian", () => {
  const result = sanitizeGeneratedPersona(basePersona("Odd Cat", { category: "not a valid slug" }));
  assert.equal(result.ok, true);
  assert.equal(result.persona.category, "civilian");
});

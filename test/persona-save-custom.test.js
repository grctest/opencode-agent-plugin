import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const configDir = mkdtempSync(join(tmpdir(), "loom-persona-save-"));
process.env.LOOM_CONFIG_DIR = configDir;

const { persistGeneratedPersonas } = await import("../src/dashboard/server/control/personas.js");
const { getPersonas, invalidatePersonaCache } = await import("../src/composer/persona-loader.js");

const customDir = join(configDir, "personas", "custom");

const fixture = (name, over = {}) => ({
  name,
  persona: `You are ${name}, the concrete lens this fixture stands behind, with enough detail to clear the minimum length floor.`,
  agenda: `Push the decision toward the ${name} outcome in this deliberation.`,
  category: "mid",
  angle: `${name} take on the question`,
  tags: ["alpha", "beta"],
  expertise: ["testing", "fixtures"],
  ...over,
});

test("a valid persona is written to the custom folder, atomic and private", () => {
  const { saved, skipped } = persistGeneratedPersonas([fixture("Probe Lens")]);
  assert.deepEqual(saved, ["Probe Lens"]);
  assert.deepEqual(skipped, []);

  const file = join(customDir, "probe-lens.json");
  assert.ok(existsSync(file), "slugified filename");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(raw.name, "Probe Lens");
  assert.equal(raw.category, "mid", "the persona keeps its own lens, not a folder-derived one");
  assert.ok(!("custom" in raw), "origin is derived from the folder, never stored in the file");
  assert.equal(statSync(file).mode & 0o777, 0o600, "persona text is user-private");
});

test("names already in the bundled catalog are skipped, never overwritten", () => {
  invalidatePersonaCache();
  const bundled = getPersonas().mid?.[0]?.name;
  assert.ok(bundled, "the bundled catalog must have mid personas to collide with");
  const { saved, skipped } = persistGeneratedPersonas([fixture(bundled)]);
  assert.deepEqual(saved, []);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, "name already exists");
});

test("duplicates inside one batch are skipped after the first write", () => {
  const { saved, skipped } = persistGeneratedPersonas([
    fixture("Batch Twin"),
    fixture("BATCH TWIN"),
  ]);
  assert.deepEqual(saved, ["Batch Twin"]);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, "name already exists");
});

test("a slug that already holds a different persona gets a numeric suffix", () => {
  const { saved, skipped } = persistGeneratedPersonas([fixture("Probe*Lens")]);
  assert.deepEqual(skipped, []);
  assert.deepEqual(saved, ["Probe*Lens"]);
  assert.ok(existsSync(join(customDir, "probe-lens-2.json")), "second file beside the first");
  assert.equal(
    JSON.parse(readFileSync(join(customDir, "probe-lens.json"), "utf8")).name,
    "Probe Lens",
    "the original file is untouched",
  );
});

test("an invalid persona is skipped with a recorded reason", () => {
  const { saved, skipped } = persistGeneratedPersonas([fixture("No Tags", { tags: [] })]);
  assert.deepEqual(saved, []);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, "tags required");
});

test("saving twice never duplicates a persona", () => {
  const again = persistGeneratedPersonas([fixture("Probe Lens")]);
  assert.deepEqual(again.saved, []);
  assert.equal(again.skipped.length, 1);
});

test("the loader marks saved personas custom and files them under the custom group", () => {
  invalidatePersonaCache();
  const all = getPersonas();
  assert.ok(Array.isArray(all.custom) && all.custom.length >= 1, "the custom folder becomes its own catalog group");
  const found = all.custom.find((p) => p.name === "Probe Lens");
  assert.ok(found, "saved persona is visible to the catalog");
  assert.equal(found.custom, true, "origin flag is derived from the user-dir path at load time");
  assert.equal(found.category, "mid", "file category survives the round trip");
});

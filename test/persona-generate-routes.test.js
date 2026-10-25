import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const configDir = mkdtempSync(join(tmpdir(), "loom-gen-routes-"));
process.env.LOOM_CONFIG_DIR = configDir;

const { runtime } = await import("../src/dashboard/server/control/runtime.js");
const {
  handleGeneratePersonas,
  handleSavePersonas,
  isGenerationInFlight,
  GENERATION_TIMEOUT_MS,
  MAX_SAVE_BATCH,
} = await import("../src/dashboard/server/control/personas.js");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel) => readFileSync(join(root, rel), "utf8");

const post = (path, body) =>
  new Request(`http://loom.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const fixture = (name, over = {}) => ({
  name,
  persona: `You are ${name}, the concrete lens this fixture stands behind, with enough detail to clear the minimum length floor.`,
  agenda: `Push the decision toward the ${name} outcome in this deliberation.`,
  category: "mid",
  tags: ["alpha", "beta"],
  ...over,
});

// Registered first on purpose: the runtime gate is what these handlers check
// before anything else, and runtime is still untouched at this point.
test("both handlers refuse while the control plane is not ready", async () => {
  assert.equal(runtime.client, null, "test expects an untouched runtime");
  const gen = await handleGeneratePersonas(post("/api/personas/generate", { question: "q?" }));
  assert.equal(gen.status, 503);
  const save = await handleSavePersonas(post("/api/personas/save", { personas: [] }));
  assert.equal(save.status, 503);
  assert.equal(isGenerationInFlight(), false, "the in-flight flag starts clear");
});

test("with the runtime ready, generation requires a real question first", async () => {
  runtime.client = {};
  runtime.directory = configDir;
  runtime.ownerSessionId = "test-session";
  runtime.activeLooms = new Map();

  const empty = await handleGeneratePersonas(post("/api/personas/generate", {}));
  assert.equal(empty.status, 400);
  const emptyBody = await empty.json();
  assert.match(emptyBody.error, /question required/);

  const tooShort = await handleGeneratePersonas(post("/api/personas/generate", { question: "a" }));
  assert.equal(tooShort.status, 400);
});

test("generation without enabled models says so instead of calling an LLM", async () => {
  const res = await handleGeneratePersonas(
    post("/api/personas/generate", { question: "Should we ship the new billing engine?" }),
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /no enabled models/);
  assert.equal(isGenerationInFlight(), false, "no generation started");
});

test("save validates the batch before touching disk", async () => {
  const noArray = await handleSavePersonas(post("/api/personas/save", {}));
  assert.equal(noArray.status, 400);
  assert.match((await noArray.json()).error, /personas array required/);

  const tooMany = await handleSavePersonas(
    post("/api/personas/save", {
      personas: Array.from({ length: MAX_SAVE_BATCH + 1 }, (_, i) => fixture(`Batch ${i}`)),
    }),
  );
  assert.equal(tooMany.status, 400);
  assert.match((await tooMany.json()).error, new RegExp(`at most ${MAX_SAVE_BATCH} personas per save`));
  assert.equal(MAX_SAVE_BATCH, 8, "matches the 1..8 generation ceiling");
});

test("save round-trips through the HTTP handler", async () => {
  const res = await handleSavePersonas(
    post("/api/personas/save", { personas: [fixture("Route Roundtrip")] }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.saved, ["Route Roundtrip"]);
  assert.deepEqual(body.skipped, []);
});

test("the routes are registered and dispatched to these handlers", () => {
  const serverSrc = readSrc("src/dashboard/server.js");
  assert.match(serverSrc, /\["\/api\/personas\/generate", \["POST"\]\]/, "generate route is POST-registered");
  assert.match(serverSrc, /\["\/api\/personas\/save", \["POST"\]\]/, "save route is POST-registered");
  assert.match(serverSrc, /if \(url\.pathname === "\/api\/personas\/generate"\) \{\s*return handleGeneratePersonas\(req\);/);
  assert.match(serverSrc, /if \(url\.pathname === "\/api\/personas\/save"\) \{\s*return handleSavePersonas\(req\);/);

  const controlSrc = readSrc("src/dashboard/server/control.js");
  assert.match(controlSrc, /handleGeneratePersonas,[\s\S]*?handleSavePersonas/, "facade re-exports both handlers");
});

test("the generation handler keeps its concurrency, model, and failure guards", () => {
  const src = readSrc("src/dashboard/server/control/personas.js");
  assert.match(src, /if \(generationInFlight\)[\s\S]{0,200}?409/, "a second request while one runs gets 409");
  assert.match(src, /generation_in_flight/);
  assert.match(src, /\?\? available\[0\]/, "no model specified falls back to the first enabled one");
  assert.match(src, /code: "generation_unusable"/, "unparseable output is a 422 the dialog can retry");
  assert.equal(GENERATION_TIMEOUT_MS, 120000, "one LLM call gets the documented 120s budget");
  assert.match(src, /persistGeneratedPersonas/, "saving is a testable core, not only an HTTP handler");
});

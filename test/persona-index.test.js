import test from "node:test";
import assert from "node:assert/strict";
import { cosineSimilarity, findMostSimilar } from "../src/utils/vector.js";
import { PersonaIndex, clearEmbeddingCache, clearPersonaStore, getPersonaIndexStatus, warmPersonaIndex } from "../src/services/persona-index.js";

// Vector math backing in-memory persona search (no model needed).

test("cosineSimilarity handles identical, orthogonal, and opposite vectors", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
});

test("cosineSimilarity rejects mismatched lengths and zero vectors safely", () => {
  assert.ok(Number.isNaN(cosineSimilarity([1, 0], [1, 0, 0])));
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.ok(Number.isNaN(cosineSimilarity(null, [1])));
});

test("findMostSimilar picks the best candidate and honors excludeId", () => {
  const candidates = [
    { id: "a", embedding: [1, 0] },
    { id: "b", embedding: [0, 1] },
    { id: "c", embedding: null },
  ];
  assert.equal(findMostSimilar([1, 0.1], candidates).id, "a");
  assert.equal(findMostSimilar([1, 0.1], candidates, "a").id, "b");
  assert.equal(findMostSimilar([1, 0], []), null);
});

// PersonaIndex without an initialized embedder: search returns empty results
// rather than throwing. Room composition treats an empty ranking as
// embedder-unavailable rather than degrading to a keyword match.

test("searchAll on an empty store returns []", async () => {
  clearPersonaStore();
  const idx = new PersonaIndex();
  assert.deepEqual(await idx.searchAll(new Float32Array([1, 0, 0])), []);
});

test("searchAll rejects invalid query embeddings", async () => {
  clearPersonaStore();
  const idx = new PersonaIndex();
  assert.deepEqual(await idx.searchAll(null), []);
  assert.deepEqual(await idx.searchAll(undefined), []);
});

test("clearEmbeddingCache and clearPersonaStore are safe to call repeatedly", () => {
  clearEmbeddingCache();
  clearPersonaStore();
  clearEmbeddingCache();
  clearPersonaStore();
});

// --- background warm ------------------------------------------------------
//
// The dashboard warms the persona store as soon as the embedder is ready so the
// first auto-select click does not pay for indexing. These tests pin the three
// properties that warm relies on: it never rejects, it never runs twice
// concurrently, and its status is honest about failure.

test("index status starts empty after a clear", () => {
  clearPersonaStore();
  assert.deepEqual(getPersonaIndexStatus(), { state: "empty", count: 0, message: null });
});

test("warmPersonaIndex never rejects when no embedder is loaded", async () => {
  // With no model, every per-persona embed fails. The warm must absorb that:
  // an unhandled rejection here would take the dashboard process down, and the
  // embedder's own readiness must not depend on the catalog embedding cleanly.
  clearPersonaStore();
  const n = await warmPersonaIndex();
  assert.equal(typeof n, "number");
  const status = getPersonaIndexStatus();
  assert.ok(["error", "indexing"].includes(status.state) || n > 0, `unexpected status ${status.state}`);
  if (n === 0) assert.equal(status.state, "error", "a zero-persona run must report error, never ready");
});

test("concurrent warmPersonaIndex calls share a single run", async () => {
  clearPersonaStore();
  const [a, b, c] = await Promise.all([
    warmPersonaIndex(),
    warmPersonaIndex(),
    warmPersonaIndex(),
  ]);
  assert.equal(a, b, "concurrent callers must observe the same run");
  assert.equal(b, c);
});

test("a warm that indexed nothing reports error rather than ready", async () => {
  // `ready` is what the dashboard gates the auto-select button on, so it must
  // never be reported for an empty store — that would surface a button which
  // then opens a dialog with no personas in it.
  clearPersonaStore();
  await warmPersonaIndex();
  const status = getPersonaIndexStatus();
  if (status.count === 0) assert.notEqual(status.state, "ready");
});

test("clearPersonaStore resets in-flight state and status", () => {
  clearPersonaStore();
  assert.equal(getPersonaIndexStatus().state, "empty");
});

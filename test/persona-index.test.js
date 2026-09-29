import test from "node:test";
import assert from "node:assert/strict";
import { cosineSimilarity, findMostSimilar } from "../src/utils/vector.js";
import { PersonaIndex, clearEmbeddingCache, clearPersonaStore } from "../src/services/persona-index.js";

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

// PersonaIndex without an initialized embedder: search degrades to empty
// results (callers fall back to keyword composition), never throws.

test("searchWithEmbedding on an empty store returns []", async () => {
  clearPersonaStore();
  const idx = new PersonaIndex();
  assert.deepEqual(await idx.searchWithEmbedding(new Float32Array([1, 0, 0]), "mid", 5), []);
});

test("searchWithEmbedding rejects invalid query embeddings", async () => {
  clearPersonaStore();
  const idx = new PersonaIndex();
  assert.deepEqual(await idx.searchWithEmbedding(null, "mid", 5), []);
  assert.deepEqual(await idx.searchWithEmbedding(undefined, "junior", 5), []);
});

test("clearEmbeddingCache and clearPersonaStore are safe to call repeatedly", () => {
  clearEmbeddingCache();
  clearPersonaStore();
  clearEmbeddingCache();
  clearPersonaStore();
});

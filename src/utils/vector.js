/**
 * Vector similarity utilities for in-memory embedding comparisons.
 * Used for persona-based reflection targeting and other similarity lookups.
 */

/**
 * Computes cosine similarity between two embedding vectors.
 * Returns a value between -1 and 1 (1 = identical, 0 = orthogonal, -1 = opposite).
 * @param {Float32Array|number[]} a
 * @param {Float32Array|number[]} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return -1;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Finds the most similar embedding in a list of candidates.
 * @param {Float32Array} query - The query embedding
 * @param {Array<{id: string, embedding: Float32Array}>} candidates
 * @param {string} [excludeId] - ID to exclude from consideration
 * @returns {{id: string, similarity: number}|null}
 */
export function findMostSimilar(query, candidates, excludeId = null) {
  if (!query || !candidates || candidates.length === 0) return null;
  let best = null;
  for (const c of candidates) {
    if (c.id === excludeId || !c.embedding) continue;
    const sim = cosineSimilarity(query, c.embedding);
    if (!best || sim > best.similarity) {
      best = { id: c.id, similarity: sim };
    }
  }
  return best;
}

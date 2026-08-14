import { Logger, extractErrorInfo } from "../logger.js";

const embedLogger = new Logger();

export const EMBEDDING_DIM = 384;

// Deterministic seeded PRNG for placeholder embeddings
function mulberry32(seed) {
  let t = seed;
  return function () {
    t |= 0;
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash);
}

/**
 * Placeholder embedding service.
 * Returns a deterministic 384-dim vector based on text hash.
 * Replace with real model (snowflake-arctic-embed-xs or bge-micro-v2) later.
 */
let realEmbedFn = null;

export async function initializeEmbedder(embedFn) {
  realEmbedFn = embedFn;
}

/**
 * Generates a 384-dim Float32Array embedding for the given text.
 * Uses real embedder if initialized, otherwise falls back to placeholder.
 */
export async function embedText(text) {
  if (realEmbedFn) {
    try {
      return await realEmbedFn(text);
    } catch (err) {
      embedLogger.warn("embed_fallback", "Real embedder failed — using placeholder", extractErrorInfo(err));
    }
  }
  return placeholderEmbed(text);
}

/**
 * Generates a deterministic placeholder embedding from text hash.
 * Produces normalized vectors suitable for cosine similarity.
 */
function placeholderEmbed(text) {
  const seed = hashString(text);
  const rng = mulberry32(seed);
  const vec = new Float32Array(EMBEDDING_DIM);
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    vec[i] = rng() * 2 - 1;
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    vec[i] /= norm;
  }
  return vec;
}

/**
 * Computes cosine similarity between two dense vectors.
 * Both must be Float32Array of the same length.
 */
export function cosineSimilarityDense(a, b) {
  if (a.length !== b.length) return 0;
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

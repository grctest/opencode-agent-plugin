/**
 * Embedding service for Loom deliberation engine.
 * Provides pluggable embedding with placeholder fallback.
 */

import { Logger, extractErrorInfo } from "../logger.js";
import { ModelManager } from "./model-manager.js";

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

// Real model state
let currentModel = null;
let currentDim = EMBEDDING_DIM;
let currentMaxTokens = 512;

/**
 * Initialize the embedding service with a real model.
 * @param {string} modelName - Model name (e.g., "Snowflake/snowflake-arctic-embed-xs")
 * @param {string} quant - Quantization path (e.g., "onnx/model_int8.onnx")
 * @param {string} projectRoot - Project root directory
 */
export async function initializeEmbedder(modelName, quant = "onnx/model_int8.onnx", projectRoot) {
  const manager = new ModelManager(projectRoot);

  try {
    const { session, tokenizer, dims, maxTokens } = await manager.loadModel(modelName, quant);
    currentModel = { session, tokenizer, manager, dims, maxTokens };
    currentDim = dims;
    currentMaxTokens = maxTokens;
    embedLogger.info("embedder_initialized", `Embedding service initialized with ${modelName} (${dims}d, maxTokens=${maxTokens})`);
  } catch (err) {
    embedLogger.warn("embedder_init_failed", `Failed to initialize embedder: ${err.message}`, extractErrorInfo(err));
    throw err;
  }
}

/**
 * Check if a real embedder is initialized.
 */
export function isEmbedderInitialized() {
  return currentModel !== null;
}

/**
 * Get the current embedding dimension.
 */
export function getEmbeddingDim() {
  return currentDim;
}

/**
 * Get the current max token limit.
 */
export function getEmbeddingMaxTokens() {
  return currentMaxTokens;
}

/**
 * Generate an embedding for the given text.
 * Uses real embedder if initialized, otherwise falls back to placeholder.
 */
export async function embedText(text) {
  if (currentModel) {
    try {
      return await currentModel.manager.embed(
        currentModel.session,
        currentModel.tokenizer,
        text,
        currentModel.dims,
        currentModel.maxTokens
      );
    } catch (err) {
      embedLogger.warn("embed_fallback", "Real embedder failed — using placeholder", extractErrorInfo(err));
    }
  }
  return placeholderEmbed(text);
}

/**
 * Generate a deterministic placeholder embedding from text hash.
 * Produces normalized vectors suitable for cosine similarity.
 */
function placeholderEmbed(text) {
  const seed = hashString(text);
  const rng = mulberry32(seed);
  const vec = new Float32Array(currentDim);
  let norm = 0;
  for (let i = 0; i < currentDim; i++) {
    vec[i] = rng() * 2 - 1;
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < currentDim; i++) {
    vec[i] /= norm;
  }
  return vec;
}

/**
 * Embedding service for Loom deliberation engine.
 * Provides pluggable embedding. Semantic features require a real model;
 * if none is loaded, embedText() throws so callers can degrade visibly.
 */

import { Logger, extractErrorInfo } from "../logger.js";
import { ModelManager } from "./model-manager.js";

const embedLogger = new Logger();

export const EMBEDDING_DIM = 384;

// Real model state
let currentModel = null;
let currentDim = EMBEDDING_DIM;
let currentMaxTokens = 512;
let initInFlight = null;

/**
 * Initialize the embedding service with a real model.
 * Idempotent: if the same model is already loaded, this is a no-op.
 * Concurrent callers share one in-flight load.
 * @param {string} modelName - Model name (e.g., "Snowflake/snowflake-arctic-embed-xs")
 * @param {string} quant - Quantization path (e.g., "onnx/model_int8.onnx")
 * @param {string} projectRoot - Project root directory
 */
export async function initializeEmbedder(modelName, quant = "onnx/model_int8.onnx", projectRoot) {
  if (currentModel?.name === modelName) return;
  if (initInFlight) return initInFlight;

  initInFlight = doInitialize(modelName, quant, projectRoot).finally(() => {
    initInFlight = null;
  });
  return initInFlight;
}

/**
 * Ensures a real embedder is loaded in this process. If one is already
 * initialized (or an init is in flight), that load is shared. Throws if the
 * model cannot be loaded, so callers can surface degraded semantic features.
 * @returns {Promise<void>}
 */
export async function ensureEmbedderInitialized(modelName, quant = "onnx/model_int8.onnx", projectRoot) {
  if (currentModel) return;
  if (initInFlight) return initInFlight;
  return initializeEmbedder(modelName, quant, projectRoot);
}

async function doInitialize(modelName, quant, projectRoot) {
  const manager = new ModelManager(projectRoot);

  const { session, tokenizer, dims, maxTokens } = await manager.loadModel(modelName, quant);
  currentModel = { name: modelName, session, tokenizer, manager, dims, maxTokens };
  currentDim = dims;
  currentMaxTokens = maxTokens;
  embedLogger.info("embedder_initialized", `Embedding service initialized with ${modelName} (${dims}d, maxTokens=${maxTokens})`);
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
 * Generate an embedding for the given text using the real model.
 * Throws if no embedder is initialized or inference fails — never silently
 * degrades, so callers can render honest "semantic features unavailable" state.
 */
export async function embedText(text) {
  if (!currentModel) {
    throw new Error("Embedding service not initialized — semantic features are disabled. Load a model to enable them.");
  }
  try {
    return await currentModel.manager.embed(
      currentModel.session,
      currentModel.tokenizer,
      text,
      currentModel.dims,
      currentModel.maxTokens,
    );
  } catch (err) {
    embedLogger.warn("embed_failed", "Real embedder failed", extractErrorInfo(err));
    throw err;
  }
}
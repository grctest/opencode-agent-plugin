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
/** @type {{ modelName: string, quant: string, promise: Promise<void> } | null} */
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
  // Key-aware in-flight caching (audit 06 V3): only share the in-flight load when
  // it is for the SAME (model, quant) pair.
  if (currentModel?.name === modelName && currentModel?.quant === quant) return;
  if (initInFlight && initInFlight.modelName === modelName && initInFlight.quant === quant) {
    return initInFlight.promise;
  }

  const promise = doInitialize(modelName, quant, projectRoot);
  initInFlight = { modelName, quant, promise };
  try {
    return await promise;
  } finally {
    if (initInFlight?.promise === promise) initInFlight = null;
  }
}

/**
 * Ensures a real embedder is loaded in this process. If one is already
 * initialized (or an init is in flight), that load is shared. Throws if the
 * model cannot be loaded, so callers can surface degraded semantic features.
 * @returns {Promise<void>}
 */
export async function ensureEmbedderInitialized(modelName, quant = "onnx/model_int8.onnx", projectRoot) {
  if (initInFlight) return initInFlight.promise;
  // Key-aware init (audit 06 V3): a mismatched already-loaded model must be
  // reloaded loudly rather than silently no-op'd.
  if (currentModel) {
    if (currentModel.name === modelName && currentModel.quant === quant) return;
    embedLogger.warn(
      "embedder_model_mismatch",
      `Embedding service already loaded ${currentModel.name} but ${modelName} was requested — reloading`,
    );
    currentModel = null;
  }
  return initializeEmbedder(modelName, quant, projectRoot);
}

async function doInitialize(modelName, quant, projectRoot) {
  const manager = new ModelManager(projectRoot);

  const { session, tokenizer, dims, maxTokens, meta } = await manager.loadModel(modelName, quant);
  currentModel = { name: modelName, quant, session, tokenizer, manager, dims, maxTokens, meta };
  currentDim = dims;
  currentMaxTokens = maxTokens;
  embedLogger.info(
    "embedder_initialized",
    `Embedding service initialized with ${modelName} (${dims}d, maxTokens=${maxTokens}, pooling=${meta.pooling}${meta.queryPrefix ? ", queryPrefix set" : ""})`
  );
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
 *
 * @param {string} text - Text to embed
 * @param {{ isQuery?: boolean }} [opts] - isQuery=true applies the model's
 *   query-side prefix (asymmetric-retrieval models need different treatment for
 *   queries vs documents — audit 06 V1). Defaults to document-side.
 * @returns {Promise<Float32Array>}
 */
export async function embedText(text, opts = {}) {
  if (!currentModel) {
    throw new Error("Embedding service not initialized — semantic features are disabled. Load a model to enable them.");
  }
  const meta = currentModel.meta;
  const prefix = opts.isQuery ? (meta?.queryPrefix ?? "") : (meta?.documentPrefix ?? "");
  const prepared = prefix && text ? prefix + text : text;
  try {
    return await currentModel.manager.embed(
      currentModel.session,
      currentModel.tokenizer,
      prepared,
      currentModel.dims,
      currentModel.maxTokens,
      meta,
    );
  } catch (err) {
    embedLogger.warn("embed_failed", "Real embedder failed", extractErrorInfo(err));
    throw err;
  }
}

/** Metadata of the loaded encoder, or null. */
export function getEmbedderMeta() {
  return currentModel ? { name: currentModel.name, quant: currentModel.quant, ...currentModel.meta } : null;
}
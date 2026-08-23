/**
 * Model manager for Loom embedding models.
 * Handles loading ONNX models and running inference.
 */

import { join } from "path";
import { homedir } from "os";
import { createRequire } from "module";
import { readFile, readdir, access } from "fs/promises";
import { createReadStream } from "fs";
import { createHash } from "crypto";
import { Logger, extractErrorInfo } from "../logger.js";

const modelLogger = new Logger();

function getConfigDir() {
  return process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode");
}

const MODEL_DIR = join(getConfigDir(), "loom", "models");

function getDepsDirs() {
  const base = getConfigDir();
  return [
    join(base, "plugins", "deps"),
    join(base, "loom", "deps"),
  ];
}

let cachedOrt = null;
let cachedTokenizer = null;

/**
 * Resolve an optional native dependency (onnxruntime-node, @huggingface/tokenizers)
 * from the runtime deps dir installed by scripts/install.mjs, probing both
 * `plugins/deps` and `loom/deps` for compatibility (mirrors database/connection.js
 * vec probing). Falls back to a bare import so local/dev resolution from project
 * node_modules keeps working.
 */
async function resolveDep(dep) {
  const spec = `"${dep}"`;
  for (const dir of getDepsDirs()) {
    try {
      const req = createRequire(join(dir, ".pkg.js"));
      return req(dep);
    } catch {}
    try {
      const req2 = createRequire(join(dir, "package.json"));
      return req2(dep);
    } catch {}
  }
  try {
    return await import(dep);
  } catch (importErr) {
    // Try explicit node_modules fallback for the two known layouts
    for (const dir of getDepsDirs()) {
      try {
        const abs = join(dir, "node_modules", dep);
        return await import(abs);
      } catch {}
    }
    throw new Error(
      `Cannot load native dependency ${spec}. Install the Loom runtime deps with: npm run install:plugin (details: ${importErr.message})`
    );
  }
}

async function resolveOnnx() {
  if (!cachedOrt) cachedOrt = await resolveDep("onnxruntime-node");
  return cachedOrt;
}

async function resolveTokenizer() {
  if (!cachedTokenizer) {
    const module = await resolveDep("@huggingface/tokenizers");
    cachedTokenizer = module.Tokenizer;
  }
  return cachedTokenizer;
}

export const DEFAULT_EMBEDDING_MODEL = "Snowflake/snowflake-arctic-embed-xs";
export const DEFAULT_EMBEDDING_QUANT = "onnx/model_int8.onnx";

/** Streamed SHA-256 of a file — used for model integrity verification (audit 12 SEC4). */
async function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

/**
 * Manages embedding models stored in ~/.config/opencode/loom/models/
 */
export class ModelManager {
  #modelDir;

  constructor(projectRoot) {
    this.#modelDir = MODEL_DIR;
  }

  /**
   * Get model directory path.
   */
  getModelDir(name) {
    return join(this.#modelDir, name);
  }

  /**
   * Read model.json metadata for a specific model.
   */
  async readModelJson(name) {
    try {
      const path = join(this.#modelDir, name, "model.json");
      const data = await readFile(path, "utf-8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Check if a specific quantization is downloaded.
   */
  async isDownloaded(name, quant = "onnx/model_int8.onnx") {
    const modelJson = await this.readModelJson(name);
    if (!modelJson) return false;

    // Check if the quant matches
    if (modelJson.quant !== quant) return false;

    // Verify file exists
    const modelDir = this.getModelDir(name);
    const quantFile = quant.replace("onnx/", "");
    try {
      await access(join(modelDir, quantFile));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all downloaded models by reading model.json files.
   */
  async listDownloadedModels() {
    try {
      const entries = await readdir(this.#modelDir, { withFileTypes: true });
      const models = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const modelJson = await this.readModelJson(entry.name);
          if (modelJson) {
            models.push(modelJson);
          }
        }
      }

      return models;
    } catch {
      return [];
    }
  }

  /**
   * Load a model for inference.
   * @param {string} name - Model name (e.g., "Snowflake/snowflake-arctic-embed-xs")
   * @param {string} quant - Quantization path (e.g., "onnx/model_int8.onnx")
   * @returns {Promise<{session: InferenceSession, tokenizer: Tokenizer, dims: number, maxTokens: number, meta: Object}>}
   */
  async loadModel(name, quant = "onnx/model_int8.onnx") {
    const modelDir = this.getModelDir(name);
    const modelJson = await this.readModelJson(name);

    if (!modelJson) {
      throw new Error(`Model ${name} not found. Download it first with: npm run model:download`);
    }

    if (modelJson.quant !== quant) {
      throw new Error(
        `Model ${name} quantization mismatch: expected ${modelJson.quant}, got ${quant}`
      );
    }

    // Load ONNX session
    const quantFile = quant.replace("onnx/", "");
    const modelPath = join(modelDir, quantFile);
    const tokenizerPath = join(modelDir, "tokenizer.json");
    const tokenizerConfigPath = join(modelDir, "tokenizer_config.json");

    // Integrity verification (audit 12 SEC4): fail loudly on checksum mismatch —
    // a hijacked model file must never reach onnxruntime.
    if (modelJson.sha256) {
      const actual = await sha256File(modelPath);
      if (actual !== modelJson.sha256) {
        throw new Error(
          `Integrity check FAILED for ${name}: SHA-256 mismatch (expected ${modelJson.sha256.slice(0, 16)}…, got ${actual.slice(0, 16)}…). ` +
          `Re-download with: npm run model:download -- --model=${name}`
        );
      }
    }

    // Dynamic imports for optional dependencies
    let ort, Tokenizer;
    ort = await resolveOnnx();
    Tokenizer = await resolveTokenizer();

    modelLogger.info("model_loading", `Loading model ${name} from ${modelPath}`);

    const session = await ort.InferenceSession.create(modelPath);

    // Load tokenizer using Bun-native file reading
    const tokenizerData = await Bun.file(tokenizerPath).json();
    let tokenizerConfig = {};
    try {
      tokenizerConfig = await Bun.file(tokenizerConfigPath).json();
    } catch {
      // tokenizer_config.json is optional
    }
    const tokenizer = new Tokenizer(tokenizerData, tokenizerConfig);

    // Encoder metadata (audit 06 V1): pooling strategy, prefixes, tensor names.
    // Missing fields fall back to legacy behavior with a warning so old model.json
    // files keep working.
    const meta = normalizeModelMeta(modelJson, name);

    return {
      session,
      tokenizer,
      dims: modelJson.dims,
      maxTokens: modelJson.maxTokens,
      meta,
    };
  }

  /**
   * Embed text using a loaded model.
   * @param {InferenceSession} session - ONNX Runtime session
   * @param {Tokenizer} tokenizer - Hugging Face tokenizer
   * @param {string} text - Text to embed (query/document prefix NOT yet applied)
   * @param {number} dims - Expected embedding dimension
   * @param {number} maxTokens - Maximum token limit
   * @param {Object} [meta] - Normalized encoder metadata from loadModel()
   * @returns {Promise<Float32Array>} Pooled (+ optionally normalized) embedding vector
   */
  async embed(session, tokenizer, text, dims, maxTokens, meta = DEFAULT_MODEL_META) {
    // Tokenize
    const encoded = await tokenizer.encode(text);
    let ids = encoded.ids;

    // Truncate to maxTokens
    if (ids.length > maxTokens) {
      ids = ids.slice(0, maxTokens);
    }
    const seqLen = ids.length;
    if (seqLen === 0) {
      return new Float32Array(dims);
    }

    // Build only the input tensors this encoder expects (audit 06 V1):
    // decoder-based models may not accept token_type_ids.
    const inputIds = BigInt64Array.from(ids.map(BigInt));
    const ort = await resolveOnnx();

    const feed = {};
    for (const tensorName of meta.inputTensorNames) {
      if (tensorName === "input_ids") {
        feed[tensorName] = new ort.Tensor("int64", inputIds, [1, seqLen]);
      } else if (tensorName === "attention_mask") {
        // Single unpadded sequence — every position is a real token
        feed[tensorName] = new ort.Tensor("int64", BigInt64Array.from({ length: seqLen }, () => 1n), [1, seqLen]);
      } else if (tensorName === "token_type_ids") {
        feed[tensorName] = new ort.Tensor("int64", new BigInt64Array(seqLen), [1, seqLen]);
      } else {
        modelLogger.warn("unknown_input_tensor", `Model metadata requests unknown tensor "${tensorName}" — skipped`);
      }
    }

    // Run inference
    const results = await session.run(feed);

    // Output tensor selection: prefer metadata, then the common fallbacks
    const embeddings = results[meta.outputTensorName] || results.last_hidden_state || results.token_embeddings;
    if (!embeddings) {
      throw new Error("Model output not found. Check model format.");
    }

    const embeddingData = embeddings.data;

    // Pooling dispatch (audit 06 V1) — per-model strategy from model.json
    const pooled = poolEmbeddings(embeddingData, dims, seqLen, meta.pooling);

    // L2 normalize unless the model says otherwise
    if (meta.normalize) {
      let norm = 0;
      for (let i = 0; i < dims; i++) {
        norm += pooled[i] * pooled[i];
      }
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < dims; i++) {
          pooled[i] /= norm;
        }
      }
    }

    return pooled;
  }
}

/** Legacy default: mean pooling over all tokens, standard BERT tensors. */
export const DEFAULT_MODEL_META = Object.freeze({
  pooling: "mean",
  queryPrefix: "",
  documentPrefix: "",
  inputTensorNames: ["input_ids", "attention_mask", "token_type_ids"],
  outputTensorName: "last_hidden_state",
  paddingSide: "right",
  normalize: true,
});

const VALID_POOLING = new Set(["cls", "mean", "max", "mean_sqrt_len", "weightedmean", "lasttoken"]);

/**
 * Normalize raw model.json into validated encoder metadata, warning on legacy files.
 */
function normalizeModelMeta(raw, modelName) {
  const meta = { ...DEFAULT_MODEL_META };
  if (!raw.pooling) {
    modelLogger.warn("model_meta_missing_pooling", `model.json for ${modelName} has no "pooling" field — assuming mean (legacy file). Re-download or add metadata.`);
  } else if (VALID_POOLING.has(raw.pooling)) {
    meta.pooling = raw.pooling;
  } else {
    modelLogger.warn("model_meta_invalid_pooling", `Unknown pooling "${raw.pooling}" for ${modelName} — falling back to mean`);
  }
  if (typeof raw.queryPrefix === "string") meta.queryPrefix = raw.queryPrefix;
  if (typeof raw.documentPrefix === "string") meta.documentPrefix = raw.documentPrefix;
  if (Array.isArray(raw.inputTensorNames) && raw.inputTensorNames.every((t) => typeof t === "string")) {
    meta.inputTensorNames = [...raw.inputTensorNames];
  }
  if (typeof raw.outputTensorName === "string") meta.outputTensorName = raw.outputTensorName;
  if (raw.paddingSide === "left" || raw.paddingSide === "right") meta.paddingSide = raw.paddingSide;
  if (raw.normalize === false) meta.normalize = false;
  return meta;
}

/**
 * Pool token embeddings into a single vector using the model's declared strategy.
 * All strategies are mask-aware; sequences here are unpadded so the mask is implicit.
 */
function poolEmbeddings(data, dims, seqLen, pooling) {
  const pooled = new Float32Array(dims);

  switch (pooling) {
    case "cls": {
      // First token's hidden state
      for (let i = 0; i < dims; i++) pooled[i] = Number(data[i]);
      break;
    }
    case "max": {
      for (let i = 0; i < dims; i++) pooled[i] = -Infinity;
      for (let j = 0; j < seqLen; j++) {
        const base = j * dims;
        for (let i = 0; i < dims; i++) {
          const v = Number(data[base + i]);
          if (v > pooled[i]) pooled[i] = v;
        }
      }
      break;
    }
    case "weightedmean": {
      // Position-weighted mean (SGPT-style): weight_j = j+1
      let weightSum = 0;
      for (let j = 0; j < seqLen; j++) {
        const w = j + 1;
        weightSum += w;
        const base = j * dims;
        for (let i = 0; i < dims; i++) pooled[i] += w * Number(data[base + i]);
      }
      if (weightSum > 0) for (let i = 0; i < dims; i++) pooled[i] /= weightSum;
      break;
    }
    case "mean_sqrt_len": {
      for (let j = 0; j < seqLen; j++) {
        const base = j * dims;
        for (let i = 0; i < dims; i++) pooled[i] += Number(data[base + i]);
      }
      const denom = Math.sqrt(seqLen) || 1;
      for (let i = 0; i < dims; i++) pooled[i] /= denom;
      break;
    }
    case "lasttoken": {
      // Last real token (unpadded sequence → index seqLen-1)
      const base = (seqLen - 1) * dims;
      for (let i = 0; i < dims; i++) pooled[i] = Number(data[base + i]);
      break;
    }
    case "mean":
    default: {
      for (let j = 0; j < seqLen; j++) {
        const base = j * dims;
        for (let i = 0; i < dims; i++) pooled[i] += Number(data[base + i]);
      }
      for (let i = 0; i < dims; i++) pooled[i] /= seqLen;
      break;
    }
  }
  return pooled;
}

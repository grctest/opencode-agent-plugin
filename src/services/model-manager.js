/**
 * Model manager for Loom embedding models.
 * Handles loading ONNX models and running inference.
 */

import { join } from "path";
import { homedir } from "os";
import { createRequire } from "module";
import { readFile, readdir, access } from "fs/promises";
import { Logger, extractErrorInfo } from "../logger.js";

const modelLogger = new Logger();

function getConfigDir() {
  return process.env.OPENCODE_CONFIG_DIR ?? join(homedir(), ".config", "opencode");
}

const MODEL_DIR = join(getConfigDir(), "loom", "models");
const DEPS_DIR = join(getConfigDir(), "loom", "deps");
const DEP_REQS = createRequire(join(DEPS_DIR, ".pkg.js"));

let cachedOrt = null;
let cachedTokenizer = null;

/**
 * Resolve an optional native dependency (onnxruntime-node, @huggingface/tokenizers)
 * from the runtime deps dir installed by scripts/install.mjs, falling back to a
 * bare import so local/dev resolution from project node_modules keeps working.
 */
async function resolveDep(dep) {
  const spec = `"${dep}"`;
  try {
    return DEP_REQS(dep);
  } catch (depErr) {
    try {
      return await import(dep);
    } catch (importErr) {
      throw new Error(
        `Cannot load native dependency ${spec}. Install the Loom runtime deps with: npm run install:plugin (details: ${(depErr || importErr).message})`
      );
    }
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
   * @returns {Promise<{session: InferenceSession, tokenizer: Tokenizer, dims: number, maxTokens: number}>}
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

    return {
      session,
      tokenizer,
      dims: modelJson.dims,
      maxTokens: modelJson.maxTokens,
    };
  }

  /**
   * Embed text using a loaded model.
   * @param {InferenceSession} session - ONNX Runtime session
   * @param {Tokenizer} tokenizer - Hugging Face tokenizer
   * @param {string} text - Text to embed
   * @param {number} dims - Expected embedding dimension
   * @param {number} maxTokens - Maximum token limit
   * @returns {Promise<Float32Array>} Normalized embedding vector
   */
  async embed(session, tokenizer, text, dims, maxTokens) {
    // Tokenize
    const encoded = await tokenizer.encode(text);
    let ids = encoded.ids;

    // Truncate to maxTokens
    if (ids.length > maxTokens) {
      ids = ids.slice(0, maxTokens);
    }

    // Create input tensor [1, seq_len]
    const inputIds = BigInt64Array.from(ids.map(BigInt));
    const attentionMask = BigInt64Array.from(ids.map(() => 1n));
    const tokenTypeIds = new BigInt64Array(ids.length);

    const ort = await resolveOnnx();

    const inputTensor = new ort.Tensor("int64", inputIds, [1, ids.length]);
    const maskTensor = new ort.Tensor("int64", attentionMask, [1, ids.length]);
    const typeTensor = new ort.Tensor("int64", tokenTypeIds, [1, ids.length]);

    // Run inference
    const results = await session.run({
      input_ids: inputTensor,
      attention_mask: maskTensor,
      token_type_ids: typeTensor,
    });

    // Get token embeddings (last_hidden_state)
    const embeddings = results.last_hidden_state || results.token_embeddings;
    if (!embeddings) {
      throw new Error("Model output not found. Check model format.");
    }

    const embeddingData = embeddings.data;
    const seqLen = ids.length;

    // Mean pooling: average all token embeddings
    const pooled = new Float32Array(dims);
    for (let i = 0; i < dims; i++) {
      let sum = 0;
      for (let j = 0; j < seqLen; j++) {
        sum += Number(embeddingData[j * dims + i]);
      }
      pooled[i] = sum / seqLen;
    }

    // L2 normalize
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

    return pooled;
  }
}

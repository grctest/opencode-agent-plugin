#!/usr/bin/env node

/**
 * Model download script for Loom embedding models.
 * Downloads ONNX models from Hugging Face Hub with auto-detection of dims and maxTokens.
 *
 * Usage:
 *   node scripts/model.mjs download [--model=name] [--quant=path]
 *
 * Defaults:
 *   --model=snowflake-arctic-embed-xs
 *   --quant=onnx/model_int8.onnx
 */

import { mkdir, writeFile, readFile, access, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { logInfo, logError, logWarn } from "./utils.mjs";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_QUANT } from "../src/services/model-manager.js";

const MODEL_DIR = join(homedir(), ".config", "opencode", "loom", "models");

const DEFAULT_MODEL = DEFAULT_EMBEDDING_MODEL;
const DEFAULT_QUANT = DEFAULT_EMBEDDING_QUANT;

const HUGGINGFACE_BASE = "https://huggingface.co";

// ─── Argument parsing ────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { command: null, model: DEFAULT_MODEL, quant: DEFAULT_QUANT };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "download") {
      parsed.command = "download";
    } else if (arg.startsWith("--model=")) {
      parsed.model = arg.split("=")[1];
    } else if (arg.startsWith("--quant=")) {
      parsed.quant = arg.split("=")[1];
    }
  }

  if (!parsed.command) {
    parsed.command = "download";
  }

  return parsed;
}

// ─── File size formatting ────────────────────────────────────────────────────

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── Progress bar ────────────────────────────────────────────────────────────

function printProgress(label, loaded, total) {
  const percent = Math.round((loaded / total) * 100);
  const filled = Math.round(percent / 5);
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);
  const loadedStr = formatSize(loaded);
  const totalStr = formatSize(total);
  process.stdout.write(`\r  ${label.padEnd(22)} ${bar} ${String(percent).padStart(3)}% (${loadedStr}/${totalStr})`);
}

// ─── Download with progress ──────────────────────────────────────────────────

async function downloadWithProgress(url, destPath, label) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  const hash = createHash("sha256");
  // Resolved commit SHA for revision pinning (audit 12 SEC4): the redirect chain
  // lands on a URL containing the commit that served this exact file.
  const finalUrl = response.url || url;
  const revMatch = finalUrl.match(/\/resolve\/([0-9a-f]{40})\//i);
  const revision = revMatch ? revMatch[1] : null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    hash.update(value);
    loaded += value.length;
    if (contentLength > 0) {
      printProgress(label, loaded, contentLength);
    }
  }

  if (contentLength > 0) {
    process.stdout.write("\n");
  }

  // Validate file size
  if (contentLength > 0 && loaded !== contentLength) {
    throw new Error(`Size mismatch: expected ${contentLength} bytes, got ${loaded} bytes`);
  }

  // Write file
  const buffer = Buffer.concat(chunks);
  await writeFile(destPath, buffer);
  return { bytes: loaded, sha256: hash.digest("hex"), revision };
}

// ─── Download small JSON file ────────────────────────────────────────────────

async function downloadJson(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    logError(`Failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`);
    return null;
  }
  return response.json();
}

/** Fetch a JSON file that may legitimately not exist (404 → null, no error spam). */
async function fetchJsonOptional(url) {
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// ─── Extract model metadata from config.json ─────────────────────────────────

/**
 * Known query prefixes per model family (audit 06 V1). Auto-detection reads
 * 1_Pooling/config.json when present; this table covers families whose prompts
 * live in model cards rather than machine-readable config.
 */
const KNOWN_QUERY_PREFIXES = [
  { match: /snowflake-arctic-embed-m-v2|arctic.*v2/i, prefix: "query: " },
  { match: /snowflake-arctic-embed/i, prefix: "Represent this sentence for searching relevant passages: " },
  { match: /mxbai-embed/i, prefix: "Represent this sentence for searching relevant passages: " },
  { match: /bge-|bge\b/i, prefix: "Represent this sentence for searching relevant passages: " },
  { match: /e5[-_]/i, prefix: "query: " },
  { match: /nomic-embed/i, prefix: "search_query: " },
];

function detectQueryPrefix(modelName, poolingConfig) {
  // sentence-transformers ships prompt dicts in some configs; prefer explicit metadata
  if (typeof poolingConfig?.query_prompt === "string") return poolingConfig.query_prompt;
  for (const entry of KNOWN_QUERY_PREFIXES) {
    if (entry.match.test(modelName)) return entry.prefix;
  }
  return "";
}

function extractMetadata(configJson, tokenizerConfigJson, poolingConfig = null, modelName = "") {
  const dims = configJson?.hidden_size;
  let maxTokens = tokenizerConfigJson?.model_max_length;

  // Validate maxTokens (some models use placeholder values)
  if (!maxTokens || maxTokens > 100000) {
    maxTokens = configJson?.max_position_embeddings;
  }

  // Fallback defaults
  if (!dims) {
    logError("Could not detect embedding dimension from config.json");
    process.exit(1);
  }
  if (!maxTokens) {
    logWarn("Could not detect max tokens, defaulting to 512");
    maxTokens = 512;
  }

  const modelType = configJson?.model_type || "unknown";

  // Pooling strategy (audit 06 V1): prefer the shipped sentence-transformers
  // pooling config; otherwise infer from architecture.
  let pooling = null;
  const modes = poolingConfig;
  if (modes) {
    if (modes.pooling_mode_cls_token) pooling = "cls";
    else if (modes.pooling_mode_lasttoken) pooling = "lasttoken";
    else if (modes.pooling_mode_max_tokens) pooling = "max";
    else if (modes.pooling_mode_weightedmean_tokens) pooling = "weightedmean";
    else if (modes.pooling_mode_mean_sqrt_len_tokens) pooling = "mean_sqrt_len";
    else if (modes.pooling_mode_mean_tokens) pooling = "mean";
  }
  if (!pooling) {
    // Architecture defaults: decoder embedders use lasttoken, everything else mean
    pooling = /qwen|mistral|llama|gpt2|gemma/i.test(modelType) ? "lasttoken" : "mean";
  }

  const paddingSide = tokenizerConfigJson?.padding_side === "left" ? "left" : "right";
  const needsTokenTypeIds = (configJson?.type_vocab_size ?? 0) > 0;
  const queryPrefix = detectQueryPrefix(modelName, poolingConfig);
  const documentPrefix = typeof poolingConfig?.document_prompt === "string"
    ? poolingConfig.document_prompt
    : (/nomic-embed/i.test(modelName) ? "search_document: " : "");

  return {
    dims,
    maxTokens,
    modelType,
    pooling,
    queryPrefix,
    documentPrefix,
    inputTensorNames: needsTokenTypeIds
      ? ["input_ids", "attention_mask", "token_type_ids"]
      : ["input_ids", "attention_mask"],
    outputTensorName: "last_hidden_state",
    paddingSide,
    normalize: true,
  };
}

// ─── Check if model already downloaded ───────────────────────────────────────

async function isAlreadyDownloaded(modelDir, modelJsonPath, quant) {
  try {
    await access(modelJsonPath);
    const existing = JSON.parse(await readFile(modelJsonPath, "utf-8"));
    if (existing.quant === quant) {
      return true;
    }
  } catch {
    // Not downloaded yet
  }
  return false;
}

// ─── Main download command ───────────────────────────────────────────────────

async function cmdDownload(modelName, quant) {
  const modelDir = join(MODEL_DIR, modelName);
  const modelJsonPath = join(modelDir, "model.json");
  const quantFile = quant.replace("onnx/", "");

  logInfo(`Model: ${modelName}`);
  logInfo(`Quant: ${quant}`);

  // Check if already downloaded — this is success, not failure (audit 13 SC1)
  if (await isAlreadyDownloaded(modelDir, modelJsonPath, quant)) {
    logInfo(`✓ Model ${modelName} (${quant}) already present at ${modelDir}/${quantFile} — nothing to do.`);
    process.exit(0);
  }

  // Create model directory
  await mkdir(modelDir, { recursive: true });

  const baseUrl = `${HUGGINGFACE_BASE}/${modelName}/resolve/main`;

  try {
    // Download config files (small, fast)
    logInfo("Fetching model config...");
    const configJson = await downloadJson(`${baseUrl}/config.json`);
    if (!configJson) {
      logError("Failed to download config.json");
      process.exit(1);
    }

    logInfo("Fetching tokenizer config...");
    const tokenizerConfigJson = await downloadJson(`${baseUrl}/tokenizer_config.json`);

    // Fetch sentence-transformers pooling config when shipped (audit 06 V1)
    logInfo("Fetching pooling config (if present)...");
    const poolingConfig = await fetchJsonOptional(`${baseUrl}/1_Pooling/config.json`);

    // Extract metadata
    const encoderMeta = extractMetadata(configJson, tokenizerConfigJson, poolingConfig, modelName);
    const { dims, maxTokens, modelType } = encoderMeta;
    logInfo(`Detected: dims=${dims}, maxTokens=${maxTokens}, modelType=${modelType}, pooling=${encoderMeta.pooling}${encoderMeta.queryPrefix ? `, queryPrefix="${encoderMeta.queryPrefix.trim()}"` : ""}`);

    // Download tokenizer.json
    logInfo("Downloading tokenizer.json...");
    const tokenizerDownload = await downloadWithProgress(
      `${baseUrl}/tokenizer.json`,
      join(modelDir, "tokenizer.json"),
      "tokenizer.json"
    );

    // Download ONNX model
    const modelDownload = await downloadWithProgress(
      `${baseUrl}/${quant}`,
      join(modelDir, quantFile),
      quantFile
    );

    // Generate model.json — includes integrity pins + encoder metadata
    const modelJson = {
      name: modelName,
      dims,
      maxTokens,
      modelType,
      ...encoderMeta,
      quant,
      size: modelDownload.bytes,
      sha256: modelDownload.sha256,
      tokenizerSha256: tokenizerDownload.sha256,
      revision: modelDownload.revision ?? tokenizerDownload.revision ?? null,
      downloadedAt: new Date().toISOString(),
    };

    await writeFile(modelJsonPath, JSON.stringify(modelJson, null, 2) + "\n");
    logInfo(`Metadata saved to ${modelJsonPath}`);
    if (!modelJson.revision) {
      logWarn("Could not resolve HF commit SHA — revision pinning unavailable for this model");
    }

    logInfo(`✓ Model ${modelName} (${quant}) downloaded successfully.`);
    logInfo(`  Location: ${modelDir}`);
    logInfo(`  Size: ${formatSize(modelDownload.bytes)}`);
    logInfo(`  SHA-256: ${modelDownload.sha256.slice(0, 16)}…`);

  } catch (err) {
    // Clean up on failure
    logError(`Download failed: ${err.message}`);
    try {
      await unlink(join(modelDir, quantFile)).catch(() => {});
      await unlink(join(modelDir, "tokenizer.json")).catch(() => {});
      await unlink(modelJsonPath).catch(() => {});
    } catch {
      // Ignore cleanup errors
    }
    process.exit(1);
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const { command, model, quant } = parseArgs();

  switch (command) {
    case "download":
      await cmdDownload(model, quant);
      break;
    default:
      logError(`Unknown command: ${command}`);
      logInfo("Usage: node scripts/model.mjs download [--model=name] [--quant=path]");
      process.exit(1);
  }
}

main().catch((err) => {
  logError(err.message);
  process.exit(1);
});

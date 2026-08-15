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
import { homedir } from "node:os";
import { join } from "node:path";
import { logInfo, logError } from "./utils.mjs";
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
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
  return loaded;
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

// ─── Extract model metadata from config.json ─────────────────────────────────

function extractMetadata(configJson, tokenizerConfigJson) {
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

  return { dims, maxTokens, modelType: configJson?.model_type || "unknown" };
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

  // Check if already downloaded
  if (await isAlreadyDownloaded(modelDir, modelJsonPath, quant)) {
    logError(`Model ${modelName} (${quant}) already downloaded.`);
    logError(`Location: ${modelDir}/${quantFile}`);
    process.exit(1);
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

    // Extract metadata
    const { dims, maxTokens, modelType } = extractMetadata(configJson, tokenizerConfigJson);
    logInfo(`Detected: dims=${dims}, maxTokens=${maxTokens}, modelType=${modelType}`);

    // Download tokenizer.json
    logInfo("Downloading tokenizer.json...");
    const tokenizerSize = await downloadWithProgress(
      `${baseUrl}/tokenizer.json`,
      join(modelDir, "tokenizer.json"),
      "tokenizer.json"
    );

    // Download ONNX model
    const modelSize = await downloadWithProgress(
      `${baseUrl}/${quant}`,
      join(modelDir, quantFile),
      quantFile
    );

    // Generate model.json
    const modelJson = {
      name: modelName,
      dims,
      maxTokens,
      modelType,
      quant,
      size: modelSize,
      downloadedAt: new Date().toISOString(),
    };

    await writeFile(modelJsonPath, JSON.stringify(modelJson, null, 2) + "\n");
    logInfo(`Metadata saved to ${modelJsonPath}`);

    logInfo(`✓ Model ${modelName} (${quant}) downloaded successfully.`);
    logInfo(`  Location: ${modelDir}`);
    logInfo(`  Size: ${formatSize(modelSize)}`);

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

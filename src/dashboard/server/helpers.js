import { join, resolve, sep } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { getMetricsSnapshot } from "../../metrics.js";
import { getRecentLogs } from "../../logger.js";
import { getConfig } from "../../config.js";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_QUANT } from "../../services/model-manager.js";

export const embeddingStatus = {
  state: "idle",
  model: null,
  dims: null,
  maxTokens: null,
  message: null,
  initializedAt: null,
};

export async function initEmbeddingModel() {
  if (embeddingStatus.state === "initializing") return;
  embeddingStatus.state = "initializing";
  embeddingStatus.message = null;
  const started = Date.now();
  try {
    const { initializeEmbedder, getEmbeddingDim, getEmbeddingMaxTokens } = await import("../../services/embedding-service.js");
    await initializeEmbedder(DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_QUANT);
    embeddingStatus.state = "ready";
    embeddingStatus.model = DEFAULT_EMBEDDING_MODEL;
    embeddingStatus.dims = getEmbeddingDim();
    embeddingStatus.maxTokens = getEmbeddingMaxTokens();
    embeddingStatus.initializedAt = new Date().toISOString();
    console.log(`[Loom dashboard] Embedding model ${DEFAULT_EMBEDDING_MODEL} ready (${embeddingStatus.dims}d) in ${Date.now() - started}ms`);
  } catch (err) {
    embeddingStatus.state = "error";
    embeddingStatus.message = err instanceof Error ? err.message : String(err);
    console.warn(`[Loom dashboard] Embedding model init failed: ${embeddingStatus.message}`);
  }
}

export function getPackageVersion() {
  try {
    const pkgPath = resolve(import.meta.dir, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function findAssetsDir() {
  const candidates = [
    resolve(import.meta.dir, "."),
    resolve(import.meta.dir, "loom", "dashboard"),
    resolve(import.meta.dir, "../../dist/dashboard"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "app.js"))) return dir;
  }
  throw new Error(`[Loom dashboard] Assets not found — searched: ${candidates.join(", ")}`);
}

export const MIME_TYPES = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

export function isAssetPathSafe(assetPath, assetsDir) {
  // Normalize fullwidth％ (audit 10 S2) — attacker uses ％2e instead of %2e
  const normalized = assetPath.replace(/\uFF05/g, "%").normalize("NFC");
  let decoded = normalized;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch { break; }
  }
  if (decoded.includes("..") || decoded.includes("\0") || decoded.includes("%00")) return false;
  if (normalized.includes("\0")) return false;
  const lastDot = decoded.lastIndexOf(".");
  if (lastDot <= 0) return false;
  const ext = decoded.slice(lastDot);
  if (!MIME_TYPES[ext]) return false;
  const resolved = resolve(assetsDir, decoded);
  if (!resolved.startsWith(assetsDir + sep)) return false;
  try {
    return realpathSync(resolved).startsWith(realpathSync(assetsDir) + sep);
  } catch {
    return false;
  }
}

export function sendSSE(controller, event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  controller.enqueue(new TextEncoder().encode(data));
}

export function clampLimit(raw, fallback = 100, max = 500) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 0), max);
}

export function clampOffset(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export const HTML_SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Loom Dashboard</title>
  <script>
    (function() {
      var t = localStorage.getItem("loom-theme") || "system";
      if (t !== "system") document.documentElement.setAttribute("data-theme", t);
    })();
  </script>
  <link rel="stylesheet" href="/assets/styles.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/assets/app.js"></script>
</body>
</html>`;

export const PACKAGE_VERSION = getPackageVersion();

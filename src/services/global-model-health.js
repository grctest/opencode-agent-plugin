/**
 * Global model health registry — cross-meeting unhealthy tracking.
 * Models that trip the circuit breaker are promoted to a global set that
 * persists until explicitly re-enabled via /enable_knit_models or /reset_knit_models.
 * This prevents " Ling 3.0 died, next agent falls back to Ling again " loops.
 *
 * Storage: .opencode/loom/global-unhealthy.json  (per-workspace base dir) +
 *          memory singleton for cross-meeting propagation within same process.
 */
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync, closeSync, fsyncSync, renameSync } from "node:fs";
import { resolveLoomBaseDir } from "../paths.js";
import { Logger } from "../logger.js";
import { markGlobalUnhealthyKey, clearGlobalUnhealthyKey, clearAllGlobalUnhealthyKeys, getGlobalUnhealthyKeys, isGlobalUnhealthyKey } from "../utils/retry.js";

const logger = new Logger();
let loadedForDir = null;
// memorySet is the global set in retry.js — use helpers above instead of local Set

function getGlobalUnhealthyPath(directory) {
  const base = resolveLoomBaseDir(directory);
  return join(base, "global-unhealthy.json");
}

function readFileSafe(path) {
  try {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (Array.isArray(data.unhealthyModels)) return new Set(data.unhealthyModels);
    if (Array.isArray(data.unhealthy)) return new Set(data.unhealthy);
    return null;
  } catch (err) {
    logger.warn("global_unhealthy_load_failed", `Failed to load global unhealthy from ${path}`, { error: err.message });
    return null;
  }
}

function writeFileSafe(path, set) {
  try {
    mkdirSync(resolveLoomBaseDir(path.replace(/\/[^/]+$/, "")), { recursive: true });
    // Ensure parent dir exists
    const dir = path.substring(0, path.lastIndexOf("/"));
    try { mkdirSync(dir, { recursive: true }); } catch {}
    if (!set || set.size === 0) {
      try { if (existsSync(path)) unlinkSync(path); } catch {}
      return;
    }
    const tmp = `${path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ unhealthyModels: [...set], updatedAt: new Date().toISOString() }, null, 2));
    try { const fd = openSync(tmp, "r"); fsyncSync(fd); closeSync(fd); } catch {}
    renameSync(tmp, path);
  } catch (err) {
    logger.warn("global_unhealthy_persist_failed", `Failed to persist global unhealthy to ${path}`, { error: err.message });
  }
}

/**
 * Load persisted global unhealthy into memory. Called at startup and on-demand.
 * Merges workspace-specific and homedir-global files.
 */
export function loadGlobalHealth(directory) {
  try {
    const wsPath = getGlobalUnhealthyPath(directory);
    const wsSet = readFileSafe(wsPath);
    if (wsSet) for (const k of wsSet) markGlobalUnhealthyKey(k);
    // Also load homedir global as fallback (covers sessions started without directory)
    if (directory) {
      const homePath = getGlobalUnhealthyPath(null);
      if (homePath !== wsPath) {
        const homeSet = readFileSafe(homePath);
        if (homeSet) for (const k of homeSet) markGlobalUnhealthyKey(k);
      }
    }
    loadedForDir = directory ?? "__global__";
  } catch {}
  return getGlobalUnhealthyKeys();
}

export function getGlobalUnhealthySet() {
  return getGlobalUnhealthyKeys();
}

export function isGlobalUnhealthy(modelOrKey) {
  const key = typeof modelOrKey === "string" ? modelOrKey : `${modelOrKey.providerID}/${modelOrKey.modelID}`;
  return isGlobalUnhealthyKey(key);
}

export function markGlobalUnhealthy(modelOrKey, directory = null) {
  const key = typeof modelOrKey === "string" ? modelOrKey : `${modelOrKey.providerID}/${modelOrKey.modelID}`;
  if (isGlobalUnhealthyKey(key)) return false;
  markGlobalUnhealthyKey(key);
  // Best-effort persist to both workspace and homedir so future sessions see it
  try {
    const paths = new Set();
    paths.add(getGlobalUnhealthyPath(directory));
    paths.add(getGlobalUnhealthyPath(null));
    for (const p of paths) {
      const existing = readFileSafe(p) ?? new Set();
      existing.add(key);
      writeFileSafe(p, existing);
    }
  } catch {}
  logger.warn("global_unhealthy_marked", `Model ${key} marked globally unhealthy (requires /enable_knit_models to restore)`);
  return true;
}

export function clearGlobalUnhealthy(modelOrKey, directory = null) {
  const key = typeof modelOrKey === "string" ? modelOrKey : `${modelOrKey.providerID}/${modelOrKey.modelID}`;
  const had = isGlobalUnhealthyKey(key);
  clearGlobalUnhealthyKey(key);
  try {
    const paths = [getGlobalUnhealthyPath(directory), getGlobalUnhealthyPath(null)];
    for (const p of paths) {
      const existing = readFileSafe(p);
      if (existing && existing.has(key)) {
        existing.delete(key);
        writeFileSafe(p, existing);
      }
    }
  } catch {}
  if (had) logger.info("global_unhealthy_cleared", `Model ${key} cleared from global unhealthy`);
  return had;
}

export function clearAllGlobalUnhealthy(directory = null) {
  const keys = getGlobalUnhealthyKeys();
  const size = keys.size;
  clearAllGlobalUnhealthyKeys();
  try {
    for (const p of [getGlobalUnhealthyPath(directory), getGlobalUnhealthyPath(null)]) {
      writeFileSafe(p, new Set());
    }
  } catch {}
  if (size > 0) logger.info("global_unhealthy_reset", `Cleared ${size} globally unhealthy model(s)`);
  return size;
}

// For testing / internal CircuitBreaker sync
export function _getMemorySet() { return getGlobalUnhealthyKeys(); }
export function _resetMemory() { clearAllGlobalUnhealthyKeys(); loadedForDir = null; }

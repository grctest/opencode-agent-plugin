/**
 * Dashboard-scoped model filter persistence + meetings-dir writability probe.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync, closeSync, fsyncSync, renameSync } from "node:fs";
import { join } from "node:path";
import { resolveLoomBaseDir } from "../../../paths.js";
import { extractErrorInfo } from "../../../logger.js";
import { logger, getDirectory } from "./runtime.js";

export function getGlobalFilterPath() {
  return join(resolveLoomBaseDir(getDirectory()), "models-filter.json");
}

export function loadGlobalFilter() {
  try {
    const p = getGlobalFilterPath();
    if (!existsSync(p)) return null;
    const data = JSON.parse(readFileSync(p, "utf-8"));
    if (Array.isArray(data.disabledModels)) return new Set(data.disabledModels);
    if (Array.isArray(data.enabledModels)) return { __allowList: new Set(data.enabledModels) };
  } catch (err) {
    logger.warn("dashboard_filter_load_failed", "Failed to load dashboard model filter", extractErrorInfo(err));
  }
  return null;
}

export function persistGlobalFilter(disabledSet) {
  try {
    const p = getGlobalFilterPath();
    mkdirSync(resolveLoomBaseDir(getDirectory()), { recursive: true });
    if (!disabledSet || disabledSet.size === 0) {
      try { if (existsSync(p)) unlinkSync(p); } catch {}
      return;
    }
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ disabledModels: [...disabledSet] }, null, 2));
    try { const fd = openSync(tmp, "r"); fsyncSync(fd); closeSync(fd); } catch {}
    renameSync(tmp, p);
  } catch (err) {
    logger.warn("dashboard_filter_persist_failed", "Failed to persist dashboard model filter", extractErrorInfo(err));
  }
}

export function migrateAllowList(persisted, allKeys) {
  if (persisted && persisted.__allowList) {
    const enabled = persisted.__allowList;
    return new Set([...allKeys].filter((k) => !enabled.has(k)));
  }
  return persisted;
}

/**
 * Writability probe for the meetings directory. SQLite reports permission
 * problems as generic open failures, so probe first to tell "can't write
 * here" apart from genuine DB corruption.
 */
export function probeMeetingsDir() {
  const dir = join(resolveLoomBaseDir(getDirectory()), "meetings");
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.writetest-${process.pid}`);
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    return { ok: true, dir };
  } catch (err) {
    return { ok: false, dir, error: extractErrorInfo(err).message };
  }
}

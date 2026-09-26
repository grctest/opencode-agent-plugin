import { Logger, extractErrorInfo } from "../logger.js";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveLoomBaseDir } from "../paths.js";

const dbLogger = new Logger();

export function ensureMetaTable(db) {
  try {
    db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  } catch { /* best effort */ }
}

export function maintenanceDue(db) {
  ensureMetaTable(db);
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'last_maintenance_at'").get();
    if (!row) return true;
    return Date.now() - Number(row.value) > 86400000;
  } catch {
    return true;
  }
}

export function markMaintained(db) {
  ensureMetaTable(db);
  try {
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('last_maintenance_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(String(Date.now()));
  } catch { /* best effort */ }
}

export function initPersonaVectorTable(db, dim = 384) {
  const safeDim = Number(dim);
  if (!Number.isFinite(safeDim) || safeDim < 64 || safeDim > 2048 || Math.floor(safeDim) !== safeDim) {
    dbLogger.warn("persona_vec_table_invalid_dim", `Invalid persona embedding dimension ${dim}`, { dim });
    return;
  }
  try {
    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_persona_embeddings_${safeDim} USING vec0(
          embedding float[${safeDim}],
          tier text
        )
      `);
  } catch (err) {
    dbLogger.warn("persona_vec_table_init_failed", "Could not create persona vector table — sqlite-vec may not be loaded", extractErrorInfo(err));
  }
}

export function checkIntegrity(db) {
  try {
    const rows = db.prepare("PRAGMA integrity_check").all();
    const bad = rows.filter(r => r.integrity_check !== "ok");
    if (bad.length > 0) {
      dbLogger.warn("integrity_check_failed", "Database integrity check failed", { result: bad.map(r=>r.integrity_check).join("; ") });
    }
  } catch (err) {
    dbLogger.debug("integrity_check_error", "Integrity check could not run", extractErrorInfo(err));
  }
}

export function checkpointWal(db) {
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
}

export function vacuumIfNeeded(db) {
  try {
    const pageCount = db.prepare("PRAGMA page_count").get()?.page_count ?? 0;
    const freelist = db.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0;
    if (pageCount > 0 && freelist / pageCount > 0.3) {
      db.exec("VACUUM");
      dbLogger.info("vacuum_completed", `Vacuum completed: ${freelist}/${pageCount} pages freed`);
    }
  } catch (err) {
    dbLogger.debug("vacuum_failed", "Vacuum check failed", extractErrorInfo(err));
  }
}

export function cleanupOldErrors(db) {
  try {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    db.prepare("DELETE FROM agent_errors WHERE created_at < ?").run(cutoff);
    db.prepare("DELETE FROM error_log WHERE created_at < ?").run(cutoff);
  } catch (err) {
    dbLogger.warn("old_errors_cleanup_failed", "Failed to clean up old error rows", extractErrorInfo(err));
  }
}

export function cleanupOldVectors(db) {
  // Fabric vector cleanup removed with VectorIndex — persona vectors are small and per-meeting; no pruning needed.
}

/**
 * Sweep crash litter: temp/rename files a SIGKILL can orphan (no finally runs).
 * - meetings/*.tmp.* (report rename tmps), loom *.tmp.* (filter/health persists)
 * - tmpdir()/loom-preview-* (killed room previews) and tmpdir()/loom-ro/ro-*
 *   (readonly-copy fallback files, never unlinked after serving)
 * Age-gated so a concurrently-live writer's fresh tmp is never touched.
 * Never touches meetings (the deliberation record) or lock files.
 * Returns the number of files removed.
 */
export function sweepRecoveryLitter(directory) {
  let swept = 0;
  const rm = (p) => { try { unlinkSync(p); swept++; } catch {} };
  const rmOlderThan = (p, maxAgeMs) => {
    try {
      if (Date.now() - statSync(p).mtimeMs > maxAgeMs) rm(p);
    } catch {}
  };
  const HOUR = 3600000;
  try {
    const base = resolveLoomBaseDir(directory);
    for (const name of safeReaddir(base)) {
      if (name.includes(".tmp.") || name.endsWith(".tmp")) rmOlderThan(join(base, name), HOUR);
    }
    const meetings = join(base, "meetings");
    for (const name of safeReaddir(meetings)) {
      if (name.includes(".tmp.") || name.endsWith(".tmp")) rmOlderThan(join(meetings, name), HOUR);
    }
  } catch {}
  try {
    const tmp = tmpdir();
    for (const name of safeReaddir(tmp)) {
      if (name.startsWith("loom-preview-")) rmOlderThan(join(tmp, name), HOUR);
    }
    try {
      const roDir = join(tmp, "loom-ro");
      for (const name of safeReaddir(roDir)) {
        if (name.startsWith("ro-") && name.endsWith(".db")) rmOlderThan(join(roDir, name), 24 * HOUR);
      }
    } catch {}
  } catch {}
  if (swept > 0) {
    try { dbLogger.info("recovery_litter_swept", `Removed ${swept} orphaned temp file(s) left by a previous crash`); } catch {}
  }
  return swept;
}

function safeReaddir(dir) {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir);
  } catch {
    return [];
  }
}

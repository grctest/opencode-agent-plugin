import { Logger, extractErrorInfo } from "../logger.js";

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

export function initVectorTable(db, dim = 384) {
  const safeDim = Number(dim);
  if (!Number.isFinite(safeDim) || safeDim < 64 || safeDim > 2048 || Math.floor(safeDim) !== safeDim) {
    dbLogger.warn("vec_table_invalid_dim", `Invalid embedding dimension ${dim} — expected integer 64..2048`, { dim });
    return;
  }
  try {
    db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vec_fabric_chunks_${safeDim} USING vec0(
          embedding float[${safeDim}]
        )
      `);
  } catch (err) {
    dbLogger.warn("vec_table_init_failed", "Could not create vector table — sqlite-vec may not be loaded", extractErrorInfo(err));
  }
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
    const result = db.prepare("PRAGMA integrity_check").get();
    if (result.integrity_check !== "ok") {
      dbLogger.warn("integrity_check_failed", "Database integrity check failed", { result: result.integrity_check });
    }
  } catch (err) {
    dbLogger.debug("integrity_check_error", "Integrity check could not run", extractErrorInfo(err));
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

import { Logger, extractErrorInfo } from "../logger.js";
import { initPersonaVectorTable } from "./maintenance.js";
import { isoNow } from "./connection.js";

const dbLogger = new Logger();

export function sanitizeDim(dim) {
  const n = Number(dim);
  if (!Number.isFinite(n) || n < 64 || n > 2048 || Math.floor(n) !== n) throw new Error(`Invalid dim ${dim}`);
  return n;
}
export function vecTableName(prefix, dim) {
  return `vec_${prefix}_${sanitizeDim(dim)}`;
}

export function storePersonaEmbedding(db, meetingId, personaName, tier, tags, embeddingText, embedding, dim = 384) {
  const safeDim = Number(dim);
  if (!Number.isFinite(safeDim) || safeDim < 64 || safeDim > 2048 || Math.floor(safeDim) !== safeDim) {
    dbLogger.warn("store_persona_invalid_dim", `Invalid dim ${dim} for storePersonaEmbedding`, { dim });
    return null;
  }
  try {
    initPersonaVectorTable(db, safeDim);
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = db.prepare(
        `INSERT INTO persona_embeddings (meeting_id, persona_name, tier, tags, embedding_text, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(meetingId, personaName, tier, JSON.stringify(tags), embeddingText, isoNow());
      const rowId = result.lastInsertRowid;
      db.prepare(
        `INSERT INTO ${vecTableName("persona_embeddings", safeDim)}(rowid, embedding, tier) VALUES (?, vec_f32(?), ?)`
      ).run(rowId, embedding, tier);
      db.exec("COMMIT");
      return rowId;
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch {}
      throw err;
    }
  } catch (err) {
    dbLogger.debug("store_persona_embedding_failed", "Failed to store persona embedding", extractErrorInfo(err));
    return null;
  }
}

export function searchPersonaEmbeddings(db, meetingId, queryEmbedding, tier, topK = 5, dim = 384) {
  const safeDim = Number(dim);
  if (!Number.isFinite(safeDim) || safeDim < 64 || safeDim > 2048 || Math.floor(safeDim) !== safeDim) {
    dbLogger.warn("search_persona_invalid_dim", `Invalid dim ${dim} for searchPersonaEmbeddings`, { dim });
    return [];
  }
    let success = false;
    try {
      initPersonaVectorTable(db, safeDim);
      const limit = Math.max(1, Math.floor(Number(topK) || 5));
      try {
        const rowsTiered = db.prepare(`
        SELECT v.rowid, v.distance, p.persona_name, p.tier, p.tags, p.embedding_text
        FROM ${vecTableName("persona_embeddings", safeDim)} v
        JOIN persona_embeddings p ON p.id = v.rowid AND p.meeting_id = ?
        WHERE v.embedding MATCH ? AND k = ? AND v.tier = ?
        ORDER BY v.distance
      `).all(meetingId, queryEmbedding, limit, tier);
        if (rowsTiered.length > 0) { success = true; try { db.prepare("UPDATE meetings SET semantic_degraded = 0, updated_at = ? WHERE id = ?").run(isoNow(), meetingId); } catch {} return rowsTiered.slice(0, limit); }
      } catch {}
      const fetchK = Math.max(limit * 10, 50);
      const rows = db.prepare(`
        SELECT v.rowid, v.distance, p.persona_name, p.tier, p.tags, p.embedding_text
        FROM ${vecTableName("persona_embeddings", safeDim)} v
        JOIN persona_embeddings p ON p.id = v.rowid AND p.meeting_id = ?
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance
      `).all(meetingId, queryEmbedding, fetchK);
      const filtered = rows.filter((r) => r.tier === tier).slice(0, limit);
      if (filtered.length > 0) success = true;
      if (success) { try { db.prepare("UPDATE meetings SET semantic_degraded = 0, updated_at = ? WHERE id = ?").run(isoNow(), meetingId); } catch {} }
      else if (rows.length === 0) { /* no usable tier-matched results — keep degraded as-is */ }
      return filtered;
    } catch (err) {
      dbLogger.warnThrottled(
        "search_persona_embeddings_failed",
        "Persona vector search",
        "Persona vector search failed — composition degrades to tag matching",
        extractErrorInfo(err)
      );
      try { db.prepare("UPDATE meetings SET semantic_degraded = 1, updated_at = ? WHERE id = ?").run(isoNow(), meetingId); } catch {}
      return [];
    }
}

export function countPersonaEmbeddings(db, meetingId) {
  try {
    const row = db.prepare(`SELECT COUNT(*) as count FROM persona_embeddings WHERE meeting_id = ?`).get(meetingId);
    return row?.count ?? 0;
  } catch { /* table may not exist yet */ }
  return 0;
}

export function countPersonaVecEmbeddings(db, meetingId, dim = 384) {
  // Back-compat: when called as countPersonaVecEmbeddings(db, dim) the second arg may be dim
  let actualMeetingId = meetingId;
  let actualDim = dim;
  if (typeof meetingId === "number" && dim === 384) {
    // legacy call countPersonaVecEmbeddings(db, 384) — treat as global count, but warn
    actualDim = meetingId;
    actualMeetingId = null;
  }
  const safeDim = Number(actualDim);
  if (!Number.isFinite(safeDim) || safeDim < 64 || safeDim > 2048 || Math.floor(safeDim) !== safeDim) return 0;
  try {
    if (actualMeetingId) {
      const row = db.prepare(
        `SELECT COUNT(*) as count FROM ${vecTableName("persona_embeddings", safeDim)} WHERE rowid IN (SELECT id FROM persona_embeddings WHERE meeting_id = ?)`
      ).get(actualMeetingId);
      return row?.count ?? 0;
    }
    const row = db.prepare(`SELECT COUNT(*) as count FROM ${vecTableName("persona_embeddings", safeDim)}`).get();
    return row?.count ?? 0;
  } catch { /* table may not exist yet */ }
  return 0;
}

export function clearPersonaEmbeddings(db, meetingId) {
  let dims = [];
  try {
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vec_persona_embeddings_%'`).all();
    for (const r of rows) { const m = r.name.match(/vec_persona_embeddings_(\d+)$/); if (m) dims.push(Number(m[1])); }
  } catch {}
  if (dims.length === 0) dims = [384];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const d of dims) {
      try {
        const safeDim = Math.floor(Number(d));
        if (!Number.isFinite(safeDim) || safeDim < 64 || safeDim > 2048) continue;
        db.prepare(`DELETE FROM ${vecTableName("persona_embeddings", safeDim)} WHERE rowid IN (SELECT id FROM persona_embeddings WHERE meeting_id = ?)`).run(meetingId);
      } catch {}
    }
    try {
      db.prepare(`DELETE FROM persona_embeddings WHERE meeting_id = ?`).run(meetingId);
    } catch { /* table may not exist yet */ }
    db.exec("COMMIT");
  } catch {
    try { db.exec("ROLLBACK"); } catch {}
    // Fallback: best-effort without transaction
    try { db.prepare(`DELETE FROM persona_embeddings WHERE meeting_id = ?`).run(meetingId); } catch {}
  }
}

export function getPersonaEmbeddingByName(db, meetingId, personaName, dim = 384) {
  const safeDim = Number(dim);
  if (!Number.isFinite(safeDim) || safeDim < 64 || safeDim > 2048 || Math.floor(safeDim) !== safeDim) return null;
  try {
    initPersonaVectorTable(db, safeDim);
    const row = db.prepare(`
        SELECT v.embedding
        FROM ${vecTableName("persona_embeddings", safeDim)} v
        JOIN persona_embeddings p ON p.id = v.rowid AND p.meeting_id = ?
        WHERE p.persona_name = ?
      `).get(meetingId, personaName);
    return row?.embedding ?? null;
  } catch {
    return null;
  }
}

export function getPersonaEmbeddingsByNames(db, meetingId, personaNames, dim = 384) {
  if (!personaNames || personaNames.length === 0) return new Map();
  const safeDim = Number(dim);
  if (!Number.isFinite(safeDim) || safeDim < 64 || safeDim > 2048 || Math.floor(safeDim) !== safeDim) return new Map();
  try {
    initPersonaVectorTable(db, safeDim);
    const placeholders = personaNames.map(() => '?').join(',');
    const rows = db.prepare(`
        SELECT p.persona_name, v.embedding
        FROM ${vecTableName("persona_embeddings", safeDim)} v
        JOIN persona_embeddings p ON p.id = v.rowid AND p.meeting_id = ?
        WHERE p.persona_name IN (${placeholders})
      `).all(meetingId, ...personaNames);
    const map = new Map();
    for (const row of rows) {
      map.set(row.persona_name, row.embedding);
    }
    return map;
  } catch {
    return new Map();
  }
}

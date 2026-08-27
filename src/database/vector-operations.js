import { Logger, extractErrorInfo } from "../logger.js";
import { initVectorTable, initPersonaVectorTable } from "./maintenance.js";
import { isoNow } from "./connection.js";

const dbLogger = new Logger();

export function storeFabricEmbedding(db, chunkId, embedding, dim = 384) {
  const safeDim = Number(dim);
  if (!Number.isFinite(safeDim) || safeDim < 64 || safeDim > 2048 || Math.floor(safeDim) !== safeDim) {
    dbLogger.warn("store_embedding_invalid_dim", `Invalid dim ${dim} for storeFabricEmbedding`, { dim });
    return;
  }
  try {
    initVectorTable(db, safeDim);
    db.prepare(
      `INSERT INTO vec_fabric_chunks_${safeDim}(rowid, embedding) VALUES (?, vec_f32(?))`
    ).run(chunkId, embedding);
  } catch (err) {
    dbLogger.debug("store_embedding_failed", "Failed to store fabric embedding", extractErrorInfo(err));
  }
}

export function storeFabricChunk(db, meetingId, content, round, source = "round_summary", vector = null) {
  try {
    const insertChunk = (rawDb) => {
      const nextIdx = rawDb.prepare(`SELECT COALESCE(MAX(chunk_index), -1) + 1 as n FROM fabric_chunks WHERE meeting_id = ?`).get(meetingId)?.n ?? 0;
      const result = rawDb.prepare(
        `INSERT INTO fabric_chunks (meeting_id, round, chunk_index, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(meetingId, round, nextIdx, content, source, isoNow());
      return result.lastInsertRowid;
    };

    if (vector?.embedding) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const chunkId = insertChunk(db);
        storeFabricEmbedding(db, chunkId, vector.embedding, vector.dim ?? 384);
        db.exec("COMMIT");
        return chunkId;
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch {}
        throw err;
      }
    }

    return insertChunk(db);
  } catch (err) {
    dbLogger.debug("store_chunk_failed", "Failed to store fabric chunk", extractErrorInfo(err));
    return null;
  }
}

export function getFabricChunks(db, meetingId) {
  try {
    return db.prepare(
      `SELECT id, round, chunk_index, content, source FROM fabric_chunks WHERE meeting_id = ? ORDER BY round ASC, chunk_index ASC`
    ).all(meetingId);
  } catch {
    return [];
  }
}

export function searchFabricVectors(db, meetingId, queryEmbedding, topK = 5, dim = 384, excludeRound = -1) {
  const safeDim = Number(dim);
  if (!Number.isFinite(safeDim) || safeDim < 64 || safeDim > 2048 || Math.floor(safeDim) !== safeDim) {
    dbLogger.warn("search_invalid_dim", `Invalid dim ${dim} for searchFabricVectors`, { dim });
    return [];
  }
  try {
    const limit = Math.max(1, Math.floor(Number(topK) || 5));
    const hasExclude = excludeRound != null && excludeRound !== -1;
    if (hasExclude) {
      return db.prepare(`
        SELECT v.rowid, v.distance, f.content, f.round, f.source
        FROM vec_fabric_chunks_${safeDim} v
        JOIN fabric_chunks f ON f.id = v.rowid AND f.meeting_id = ?
        WHERE v.embedding MATCH ? AND k = ? AND f.round != ?
        ORDER BY v.distance
      `).all(meetingId, queryEmbedding, limit, excludeRound);
    }
    return db.prepare(`
        SELECT v.rowid, v.distance, f.content, f.round, f.source
        FROM vec_fabric_chunks_${safeDim} v
        JOIN fabric_chunks f ON f.id = v.rowid AND f.meeting_id = ?
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance
      `).all(meetingId, queryEmbedding, limit);
  } catch {
    return [];
  }
}

export function storePersonaEmbedding(db, meetingId, personaName, tier, tags, embeddingText, embedding, dim = 384) {
  const safeDim = Number(dim);
  if (!Number.isFinite(safeDim) || safeDim < 64 || safeDim > 2048 || Math.floor(safeDim) !== safeDim) {
    dbLogger.warn("store_persona_invalid_dim", `Invalid dim ${dim} for storePersonaEmbedding`, { dim });
    return null;
  }
  try {
    initPersonaVectorTable(db, safeDim);
    const result = db.prepare(
      `INSERT INTO persona_embeddings (meeting_id, persona_name, tier, tags, embedding_text, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(meetingId, personaName, tier, JSON.stringify(tags), embeddingText, isoNow());
    const rowId = result.lastInsertRowid;
    db.prepare(
      `INSERT INTO vec_persona_embeddings_${safeDim}(rowid, embedding, tier) VALUES (?, vec_f32(?), ?)`
    ).run(rowId, embedding, tier);
    return rowId;
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
  try {
    initPersonaVectorTable(db, safeDim);
    const limit = Math.max(1, Math.floor(Number(topK) || 5));
    const fetchK = Math.max(limit * 10, 50);
    const rows = db.prepare(`
        SELECT v.rowid, v.distance, p.persona_name, p.tier, p.tags, p.embedding_text
        FROM vec_persona_embeddings_${safeDim} v
        JOIN persona_embeddings p ON p.id = v.rowid AND p.meeting_id = ?
        WHERE v.embedding MATCH ? AND k = ?
        ORDER BY v.distance
      `).all(meetingId, queryEmbedding, fetchK);
    return rows.filter((r) => r.tier === tier).slice(0, limit);
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

export function countPersonaVecEmbeddings(db, dim = 384) {
  const safeDim = Number(dim);
  if (!Number.isFinite(safeDim) || safeDim < 64 || safeDim > 2048 || Math.floor(safeDim) !== safeDim) return 0;
  try {
    const row = db.prepare(`SELECT COUNT(*) as count FROM vec_persona_embeddings_${safeDim}`).get();
    return row?.count ?? 0;
  } catch { /* table may not exist yet */ }
  return 0;
}

export function clearPersonaEmbeddings(db, meetingId) {
  // Enumerate vec persona tables so vec rows don't orphan when dim changes
  let dims = [];
  try {
    const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vec_persona_embeddings_%'`).all();
    for (const r of rows) { const m = r.name.match(/vec_persona_embeddings_(\d+)$/); if (m) dims.push(Number(m[1])); }
  } catch {}
  if (dims.length === 0) dims = [384];
  for (const d of dims) {
    try {
      const safeDim = Math.floor(Number(d));
      if (!Number.isFinite(safeDim) || safeDim < 64 || safeDim > 2048) continue;
      db.prepare(`DELETE FROM vec_persona_embeddings_${safeDim} WHERE rowid IN (SELECT id FROM persona_embeddings WHERE meeting_id = ?)`).run(meetingId);
    } catch {}
  }
  try {
    db.prepare(`DELETE FROM persona_embeddings WHERE meeting_id = ?`).run(meetingId);
  } catch { /* table may not exist yet */ }
}

export function getPersonaEmbeddingByName(db, meetingId, personaName, dim = 384) {
  const safeDim = Number(dim);
  if (!Number.isFinite(safeDim) || safeDim < 64 || safeDim > 2048 || Math.floor(safeDim) !== safeDim) return null;
  try {
    initPersonaVectorTable(db, safeDim);
    const row = db.prepare(`
        SELECT v.embedding
        FROM vec_persona_embeddings_${safeDim} v
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
        FROM vec_persona_embeddings_${safeDim} v
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

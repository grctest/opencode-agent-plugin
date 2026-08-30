import { Logger, extractErrorInfo } from "../logger.js";
import { initSchema, runMigrations } from "./schema.js";
import { isoNow, safeParseJsonArray } from "./connection.js";
import { indexMeeting as _indexMeeting } from "./session-index.js";

const dbLogger = new Logger();

export function initializeMeeting(db, meetingId, input) {
  try {
    const embCount = db.prepare(`SELECT COUNT(*) as c FROM persona_embeddings WHERE meeting_id = ?`).get(meetingId)?.c ?? 0;
    if (embCount > 0) {
      dbLogger.warn("initialize_after_embeddings", "initializeMeeting called after persona embeddings indexed — use upsertMeeting to avoid CASCADE wipe", { meetingId, embCount });
      return upsertMeeting(db, meetingId, input);
    }
  } catch {}
  const now = isoNow();
  const insertMeeting = db.prepare(
    `INSERT INTO meetings (id, question, context, status, round, fabric, max_rounds, convergence, tags, parent_session_id, opencode_session_id, embedding_model, embedding_dim, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         question=excluded.question,
         context=excluded.context,
         status=excluded.status,
         round=excluded.round,
         fabric=excluded.fabric,
         max_rounds=excluded.max_rounds,
         convergence=excluded.convergence,
         tags=excluded.tags,
         parent_session_id=excluded.parent_session_id,
         opencode_session_id=excluded.opencode_session_id,
         embedding_model=excluded.embedding_model,
         embedding_dim=excluded.embedding_dim,
         updated_at=excluded.updated_at`,
  );
  const insertParticipant = db.prepare(
    `INSERT INTO participants (id, meeting_id, name, persona, agenda, tier, provider_id, model_id, session_id, known_biases, communication_style, preferred_contribution_types, tags, expertise)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    insertMeeting.run(
      meetingId,
      input.question,
      input.context ?? "",
      "initializing",
      input.fabric ?? input.context ?? "",
      input.maxRounds,
      input.convergence ?? "moderator_forces",
      JSON.stringify(input.tags ?? []),
      input.parentSessionId,
      input.opencodeSessionId,
      input.embedding_model ?? null,
      input.embedding_dim ?? null,
      now,
      now,
    );

    for (const p of input.participants) {
      insertParticipant.run(
        p.id,
        meetingId,
        p.name,
        p.persona,
        p.agenda,
        p.tier,
        p.model?.providerID ?? null,
        p.model?.modelID ?? null,
        null,
        p.known_biases ? JSON.stringify(p.known_biases) : null,
        p.communication_style ?? null,
        p.preferred_contribution_types ? JSON.stringify(p.preferred_contribution_types) : null,
        p.tags ? JSON.stringify(p.tags) : null,
        p.expertise ? JSON.stringify(p.expertise) : null,
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }

  const dbPath = db.filename ?? db.name ?? "unknown";
  try {
    // dbPath from filename may be incorrect for in-memory; caller handles indexing
    const actualPath = db.filename ?? db.name;
    if (actualPath && actualPath !== "unknown") {
      _indexMeeting(actualPath, meetingId, input.opencodeSessionId);
    }
  } catch {}
}

export function upsertMeeting(db, meetingId, input) {
  const now = isoNow();
  const existing = db.prepare(`SELECT id FROM meetings WHERE id = ?`).get(meetingId);
  if (existing) {
    db.prepare(`
        UPDATE meetings SET question = ?, context = ?, max_rounds = ?, convergence = ?,
          tags = ?, parent_session_id = ?, opencode_session_id = ?, embedding_model = ?, embedding_dim = ?, updated_at = ?
        WHERE id = ?
      `).run(
      input.question, input.context ?? "", input.maxRounds, input.convergence ?? "moderator_forces",
      JSON.stringify(input.tags ?? []),
      input.parentSessionId, input.opencodeSessionId,
      input.embedding_model ?? null, input.embedding_dim ?? null, now, meetingId,
    );
  } else {
    initializeMeeting(db, meetingId, input);
  }
}

export function insertParticipants(db, meetingId, participants) {
  const insertParticipant = db.prepare(
    `INSERT INTO participants (id, meeting_id, name, persona, agenda, tier, provider_id, model_id, session_id, known_biases, communication_style, preferred_contribution_types, tags, expertise)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const p of participants) {
      insertParticipant.run(
        p.id,
        meetingId,
        p.name,
        p.persona,
        p.agenda,
        p.tier,
        p.model?.providerID ?? null,
        p.model?.modelID ?? null,
        null,
        p.known_biases ? JSON.stringify(p.known_biases) : null,
        p.communication_style ?? null,
        p.preferred_contribution_types ? JSON.stringify(p.preferred_contribution_types) : null,
        p.tags ? JSON.stringify(p.tags) : null,
        p.expertise ? JSON.stringify(p.expertise) : null,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

export function logError(db, meetingId, context, message, details = null, severity = 'error') {
  try {
    db
      .prepare(
        `INSERT INTO error_log (meeting_id, severity, context, message, details, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(meetingId, severity, context, message, details ? JSON.stringify(details) : null, isoNow());
  } catch (err) {
    dbLogger.error("error_log_write_failed", "Failed to write error_log", { meetingId, error: err.message });
  }
}

export function getErrorLog(db, meetingId) {
  return db
    .prepare(
      `SELECT id, severity, context, message, details, created_at
         FROM error_log WHERE meeting_id = ? ORDER BY id ASC`,
    )
    .all(meetingId)
    .map((r) => {
      let details = null;
      if (r.details) { try { details = JSON.parse(r.details); } catch { details = { raw: r.details }; } }
      return {
        id: r.id,
        severity: r.severity,
        context: r.context,
        message: r.message,
        details,
        created_at: r.created_at,
      };
    });
}

export function getFabric(db, meetingId) {
  try {
    const row = db
      .prepare("SELECT fabric FROM meetings WHERE id = ?")
      .get(meetingId);
    return row?.fabric ?? "";
  } catch (err) {
    const info = extractErrorInfo(err);
    dbLogger.error("get_fabric_failed", `Failed to get fabric for meeting ${meetingId}`, info);
    return "";
  }
}

export function setFabric(db, meetingId, fabric) {
  db
    .prepare("UPDATE meetings SET fabric = ?, updated_at = ? WHERE id = ?")
    .run(fabric, isoNow(), meetingId);
}

export function getStateOfPlay(db, meetingId) {
  try {
    const row = db
      .prepare("SELECT state_of_play FROM meetings WHERE id = ?")
      .get(meetingId);
    return row?.state_of_play ?? "";
  } catch {
    return "";
  }
}

export function setStateOfPlay(db, meetingId, stateOfPlay) {
  db
    .prepare("UPDATE meetings SET state_of_play = ?, updated_at = ? WHERE id = ?")
    .run(stateOfPlay, isoNow(), meetingId);
}

export function setSemanticDegraded(db, meetingId, flag = true) {
  try {
    db
      .prepare("UPDATE meetings SET semantic_degraded = ?, updated_at = ? WHERE id = ?")
      .run(flag ? 1 : 0, isoNow(), meetingId);
  } catch (err) {
    dbLogger.error("degradation_flag_failed", "Could not persist semantic_degraded flag", extractErrorInfo(err));
  }
}

export function setPersistenceDegraded(db, meetingId, flag = true) {
  try {
    db
      .prepare("UPDATE meetings SET persistence_degraded = ?, updated_at = ? WHERE id = ?")
      .run(flag ? 1 : 0, isoNow(), meetingId);
  } catch (err) {
    dbLogger.error("degradation_flag_failed", "Could not persist persistence_degraded flag", extractErrorInfo(err));
  }
}

export function updateMeetingTags(db, meetingId, tags) {
  db
    .prepare("UPDATE meetings SET tags = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(tags), isoNow(), meetingId);
}

export function addOrchestratorMessage(db, meetingId, msgType, role, content, round = null) {
  const roundValue = (typeof round === "object" && round !== null)
    ? (round.number ?? null)
    : round;
  const safeContent = (content ?? "").toString();
  db
    .prepare(
      `INSERT INTO orchestrator_messages (meeting_id, msg_type, role, content, round, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(meetingId, msgType, role, safeContent, roundValue, isoNow());
}

export function getOrchestratorMessages(db, meetingId) {
  return db
    .prepare(
      `SELECT id, msg_type, role, content, round, created_at
         FROM orchestrator_messages WHERE meeting_id = ? ORDER BY id ASC`,
    )
    .all(meetingId)
    .map((r) => ({
      id: r.id,
      type: r.msg_type,
      role: r.role,
      content: r.content,
      round: r.round,
      created_at: r.created_at,
    }));
}

export function getMaxOrchestratorMessageId(db, meetingId) {
  const row = db
    .prepare(`SELECT MAX(id) as maxId FROM orchestrator_messages WHERE meeting_id = ?`)
    .get(meetingId);
  return row.maxId ?? 0;
}

export function getRound(db, meetingId) {
  try {
    const row = db
      .prepare("SELECT round FROM meetings WHERE id = ?")
      .get(meetingId);
    return row?.round ?? 0;
  } catch (err) {
    const info = extractErrorInfo(err);
    dbLogger.error("get_round_failed", `Failed to get round for meeting ${meetingId}`, info);
    return 0;
  }
}

export function setRound(db, meetingId, round) {
  db
    .prepare("UPDATE meetings SET round = ?, updated_at = ? WHERE id = ?")
    .run(round, isoNow(), meetingId);
}

export function setMaxRounds(db, meetingId, maxRounds) {
  db
    .prepare("UPDATE meetings SET max_rounds = ?, updated_at = ? WHERE id = ?")
    .run(maxRounds, isoNow(), meetingId);
}

export function getStatus(db, meetingId) {
  try {
    const row = db
      .prepare("SELECT status FROM meetings WHERE id = ?")
      .get(meetingId);
    return row ? row.status : "initializing";
  } catch (err) {
    const info = extractErrorInfo(err);
    dbLogger.error("get_status_failed", `Failed to get status for meeting ${meetingId}`, info);
    return "initializing";
  }
}

export function setStatus(db, meetingId, status) {
  db
    .prepare("UPDATE meetings SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, isoNow(), meetingId);
}

export function setReflectingParticipants(db, meetingId, participantIds) {
  const value = participantIds && participantIds.length > 0 ? JSON.stringify(participantIds) : null;
  db
    .prepare("UPDATE meetings SET reflecting_participants = ?, updated_at = ? WHERE id = ?")
    .run(value, isoNow(), meetingId);
}

export function setQueryingParticipants(db, meetingId, participantIds) {
  const value = participantIds && participantIds.length > 0 ? JSON.stringify(participantIds) : null;
  db
    .prepare("UPDATE meetings SET querying_participants = ?, updated_at = ? WHERE id = ?")
    .run(value, isoNow(), meetingId);
}

export function setEvidenceParticipants(db, meetingId, participantIds) {
  const value = participantIds && participantIds.length > 0 ? JSON.stringify(participantIds) : null;
  db
    .prepare("UPDATE meetings SET evidence_participants = ?, updated_at = ? WHERE id = ?")
    .run(value, isoNow(), meetingId);
}

export function setSummoningParticipants(db, meetingId, participantIds) {
  const value = participantIds && participantIds.length > 0 ? JSON.stringify(participantIds) : null;
  db
    .prepare("UPDATE meetings SET summoning_participants = ?, updated_at = ? WHERE id = ?")
    .run(value, isoNow(), meetingId);
}

export function getMeeting(db, meetingId) {
  const row = db
    .prepare(
      `SELECT id, question, context, status, round, fabric, max_rounds, convergence, tags, parent_session_id, opencode_session_id, next_speaker_id, state_of_play, stats, embedding_model, embedding_dim, created_at
         FROM meetings WHERE id = ?`,
    )
    .get(meetingId);
  return row ?? null;
}

export function setNextSpeaker(db, meetingId, nextSpeakerId) {
  db
    .prepare("UPDATE meetings SET next_speaker_id = ? WHERE id = ?")
    .run(nextSpeakerId ?? null, meetingId);
}

export function setStats(db, meetingId, statsJson) {
  db
    .prepare("UPDATE meetings SET stats = ? WHERE id = ?")
    .run(statsJson ?? null, meetingId);
}

export function getOpencodeSessionId(db, meetingId) {
  try {
    const row = db
      .prepare("SELECT opencode_session_id FROM meetings WHERE id = ?")
      .get(meetingId);
    return row?.opencode_session_id ?? null;
  } catch {
    return null;
  }
}

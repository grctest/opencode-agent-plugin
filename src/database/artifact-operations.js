import { Logger, extractErrorInfo } from "../logger.js";
import { isoNow } from "./connection.js";

const dbLogger = new Logger();

export function saveArtifact(db, meetingId, artifact) {
  db
    .prepare(
      `INSERT INTO artifacts (meeting_id, content, decisions, action_items, dissent, open_questions, confidence, refusals, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(meeting_id) DO UPDATE SET
           content = excluded.content,
           decisions = excluded.decisions,
           action_items = excluded.action_items,
           dissent = excluded.dissent,
           open_questions = excluded.open_questions,
           confidence = excluded.confidence,
           refusals = excluded.refusals,
           created_at = excluded.created_at`,
    )
    .run(
      meetingId,
      artifact.content,
      artifact.decisions ? JSON.stringify(artifact.decisions) : null,
      artifact.action_items ? JSON.stringify(artifact.action_items) : null,
      artifact.dissent ? JSON.stringify(artifact.dissent) : null,
      artifact.open_questions ? JSON.stringify(artifact.open_questions) : null,
      artifact.confidence ?? null,
      artifact.refusals ? JSON.stringify(artifact.refusals) : null,
      isoNow(),
    );
}

export function getArtifact(db, meetingId) {
  const row = db
    .prepare(
      `SELECT content, decisions, action_items, dissent, open_questions, confidence, refusals, created_at
         FROM artifacts WHERE meeting_id = ?`,
    )
    .get(meetingId);
  if (!row) return null;
  const parse = (json) => {
    if (!json) return [];
    try {
      const parsed = JSON.parse(json);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  return {
    content: row.content,
    decisions: parse(row.decisions),
    action_items: parse(row.action_items),
    dissent: parse(row.dissent),
    open_questions: parse(row.open_questions),
    refusals: parse(row.refusals),
    confidence: row.confidence,
    created_at: row.created_at,
  };
}

export function recordAgentError(db, meetingId, participantId, round, errorType, errorMessage, attempts) {
  db
    .prepare(
      `INSERT INTO agent_errors (meeting_id, participant_id, round, error_type, error_message, attempts, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(meetingId, participantId, round, errorType, errorMessage ?? null, attempts, isoNow());
}

export function getAgentErrors(db, meetingId) {
  return db
    .prepare(
      `SELECT participant_id, round, error_type, error_message, attempts, created_at
         FROM agent_errors WHERE meeting_id = ? ORDER BY id ASC`,
    )
    .all(meetingId)
    .map((r) => ({
      participant_id: r.participant_id,
      round: r.round,
      error_type: r.error_type,
      error_message: r.error_message,
      attempts: r.attempts,
      created_at: r.created_at,
    }));
}

export function getTranscriptData(db, meetingId, getRoundSummariesFn) {
  const meeting = db
    .prepare("SELECT question, fabric FROM meetings WHERE id = ?")
    .get(meetingId);

  const contributions = db
    .prepare(
      `SELECT id, participant_id, round, type, content, target_which, batch_id, tool_calls, created_at
         FROM contributions WHERE meeting_id = ? ORDER BY round ASC, id ASC`,
    )
    .all(meetingId);

  const turnRequests = db
    .prepare(
      `SELECT id, participant_id, target_participant_id, round, content as reason, priority, created_at
         FROM turn_requests WHERE meeting_id = ? ORDER BY id ASC`,
    )
    .all(meetingId);

  const summaries = getRoundSummariesFn(meetingId);

  const roundMap = new Map();
  for (const c of contributions) {
    if (!roundMap.has(c.round)) {
      roundMap.set(c.round, { number: c.round, contributions: [], turn_requests: [], summary: summaries[c.round] ?? "" });
    }
    roundMap.get(c.round).contributions.push({
      id: c.id,
      participant_id: c.participant_id,
      content: c.content,
      type: c.type,
      round: c.round,
      targets_which: c.target_which != null ? Number(c.target_which) : null,
      batch_id: c.batch_id ?? null,
      tool_calls: c.tool_calls ? JSON.parse(c.tool_calls) : null,
      created_at: c.created_at,
    });
  }

  for (const tr of turnRequests) {
    const roundNum = tr.round ?? 1;
    if (!roundMap.has(roundNum)) {
      roundMap.set(roundNum, { number: roundNum, contributions: [], turn_requests: [], summary: summaries[roundNum] ?? "" });
    }
    roundMap.get(roundNum).turn_requests.push({
      participant_id: tr.participant_id,
      target: tr.target_participant_id ?? "",
      priority: tr.priority,
      reason: tr.reason,
    });
  }

  const rounds = Array.from(roundMap.values()).sort((a, b) => a.number - b.number);

  return {
    question: meeting?.question ?? "",
    fabric: meeting?.fabric ?? "",
    rounds,
  };
}

export function getParticipantModel(db, meetingId, participantId) {
  const row = db
    .prepare(`SELECT provider_id, model_id FROM participants WHERE id = ? AND meeting_id = ?`)
    .get(participantId, meetingId);
  if (!row || !row.provider_id || !row.model_id) return null;
  return { providerID: row.provider_id, modelID: row.model_id };
}

export function saveMeetingMetrics(db, meetingId, metrics) {
  try {
    db.prepare(
      `INSERT OR REPLACE INTO meeting_metrics
         (meeting_id, counters, latencies, input_tokens, output_tokens, duration_ms, rounds, contributions, turn_requests, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      meetingId,
      JSON.stringify(metrics.counters ?? {}),
      JSON.stringify(metrics.latencies ?? {}),
      metrics.input_tokens ?? 0,
      metrics.output_tokens ?? 0,
      metrics.duration_ms ?? 0,
      metrics.rounds ?? 0,
      metrics.contributions ?? 0,
      metrics.turn_requests ?? 0,
      isoNow(),
    );
  } catch (err) {
    dbLogger.debug("save_metrics_failed", "Failed to save meeting metrics", extractErrorInfo(err));
  }
}

export function getRecentMeetingMetrics(db, limit = 20) {
  try {
    return db.prepare(
      `SELECT * FROM meeting_metrics ORDER BY created_at DESC LIMIT ?`
    ).all(limit);
  } catch {
    return [];
  }
}


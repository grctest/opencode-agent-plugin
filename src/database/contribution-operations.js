import { Logger, extractErrorInfo } from "../logger.js";
import { isoNow, safeParseJsonArray } from "./connection.js";

const dbLogger = new Logger();

export function addContribution(db, meetingId, contribution, getRoundFn) {
  db
    .prepare(
      `INSERT INTO contributions (meeting_id, participant_id, round, type, content, target_which, batch_id, tool_calls, prompt_context, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      meetingId,
      contribution.participant_id,
      contribution.round ?? getRoundFn(),
      contribution.type,
      contribution.content,
      contribution.targets_which ?? null,
      contribution.batch_id ?? null,
      contribution.tool_calls ? JSON.stringify(contribution.tool_calls) : null,
      contribution.prompt_context ? JSON.stringify(contribution.prompt_context) : null,
      contribution.created_at ?? isoNow(),
    );
}

function safeJsonParse(val, fallback = null) {
  if (!val) return fallback;
  try { return JSON.parse(val); } catch (err) {
    dbLogger.warn("json_parse_failed", `Failed to parse JSON field — returning ${fallback === null ? "null" : "fallback"}`, { message: err.message });
    return fallback;
  }
}

export function getContributions(db, meetingId) {
  const rows = db
    .prepare(
      `SELECT id, participant_id, round, type, content, target_which, batch_id, tool_calls, prompt_context, created_at
         FROM contributions WHERE meeting_id = ? ORDER BY id ASC`,
    )
    .all(meetingId);
  return rows.map((r) => ({
    id: r.id,
    participant_id: r.participant_id,
    round: r.round,
    content: r.content,
    type: r.type,
    targets_which: r.target_which != null ? Number(r.target_which) : null,
    batch_id: r.batch_id ?? null,
    tool_calls: safeJsonParse(r.tool_calls, null),
    prompt_context: safeJsonParse(r.prompt_context, null),
    created_at: r.created_at,
  }));
}

export function getRecentContributions(db, meetingId, count) {
  const rows = db
    .prepare(
      `SELECT id, participant_id, round, type, content, target_which, batch_id, tool_calls, prompt_context, created_at
         FROM contributions WHERE meeting_id = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(meetingId, count);
  return rows.reverse().map((r) => ({
    id: r.id,
    participant_id: r.participant_id,
    round: r.round,
    content: r.content,
    type: r.type,
    targets_which: r.target_which != null ? Number(r.target_which) : null,
    batch_id: r.batch_id ?? null,
    tool_calls: safeJsonParse(r.tool_calls, null),
    prompt_context: safeJsonParse(r.prompt_context, null),
    created_at: r.created_at,
  }));
}

export function getContributionContext(db, contributionId) {
  const row = db
    .prepare(`SELECT prompt_context FROM contributions WHERE id = ?`)
    .get(contributionId);
  return safeJsonParse(row?.prompt_context, null);
}

export function addTurnRequest(db, meetingId, turnRequest) {
  db
    .prepare(
      `INSERT INTO turn_requests (meeting_id, participant_id, target_participant_id, round, content, priority, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      meetingId,
      turnRequest.participant_id,
      turnRequest.target_participant_id ?? null,
      turnRequest.round ?? null,
      turnRequest.reason,
      turnRequest.priority,
      isoNow(),
    );
}

export function ensureParticipantRow(db, meetingId, participantId, name = participantId, tier = "mid") {
  try {
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO participants (id, meeting_id, name, persona, agenda, tier, status)
           VALUES (?, ?, ?, ?, ?, ?, 'summoned')`,
      )
      .run(participantId, meetingId, name, "Summoned guest expert", "", tier);
    return Number(result?.changes ?? 0) > 0;
  } catch (err) {
    dbLogger.warn("ensure_participant_row_failed", `Failed to ensure participant row ${participantId}`, extractErrorInfo(err));
    return false;
  }
}

export function addContributionWithTurnRequest(db, meetingId, contribution, turnRequest, getRoundFn) {
  try {
    const exists = db.prepare(`SELECT 1 FROM participants WHERE id = ? AND meeting_id = ?`).get(contribution.participant_id, meetingId);
    if (!exists) {
      dbLogger.warn("orphan_contribution", `Contribution participant_id ${contribution.participant_id} not in participants for meeting ${meetingId}`);
    }
  } catch {}
  db.exec('BEGIN IMMEDIATE');

  try {
    db
      .prepare(
        `INSERT INTO contributions (meeting_id, participant_id, round, type, content, target_which, batch_id, tool_calls, prompt_context, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        meetingId,
        contribution.participant_id,
        contribution.round ?? getRoundFn(),
        contribution.type,
        contribution.content,
        contribution.targets_which ?? null,
        contribution.batch_id ?? null,
        contribution.tool_calls ? JSON.stringify(contribution.tool_calls) : null,
        contribution.prompt_context ? JSON.stringify(contribution.prompt_context) : null,
        contribution.created_at ?? isoNow(),
      );

    if (turnRequest) {
      db
        .prepare(
          `INSERT INTO turn_requests (meeting_id, participant_id, target_participant_id, round, content, priority, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          meetingId,
          turnRequest.participant_id,
          turnRequest.target_participant_id ?? null,
          turnRequest.round ?? null,
          turnRequest.reason,
          turnRequest.priority,
          isoNow(),
        );
    }

    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    throw err;
  }
}

export function getTurnRequests(db, meetingId) {
  const rows = db
    .prepare(
      `SELECT id, participant_id, target_participant_id, round, content as reason, priority, created_at
         FROM turn_requests WHERE meeting_id = ? ORDER BY id ASC`,
    )
    .all(meetingId);
  return rows.map((r) => ({
    id: r.id,
    participant_id: r.participant_id,
    target_participant_id: r.target_participant_id,
    round: r.round,
    priority: r.priority,
    content: r.reason,
    reason: r.reason,
    created_at: r.created_at,
  }));
}

export function getMaxContributionId(db, meetingId) {
  const row = db
    .prepare(`SELECT MAX(id) as maxId FROM contributions WHERE meeting_id = ?`)
    .get(meetingId);
  return row.maxId ?? 0;
}

export function setParticipantSessionId(db, meetingId, participantId, sessionId) {
  db
    .prepare("UPDATE participants SET session_id = ?, session_version = session_version + 1 WHERE id = ? AND meeting_id = ?")
    .run(sessionId, participantId, meetingId);
}

export function setParticipantStatus(db, meetingId, participantId, status) {
  db
    .prepare("UPDATE participants SET status = ? WHERE id = ? AND meeting_id = ?")
    .run(status, participantId, meetingId);
}

export function setParticipantReflection(db, meetingId, participantId, reflection) {
  db
    .prepare("UPDATE participants SET reflection = ? WHERE id = ? AND meeting_id = ?")
    .run(reflection, participantId, meetingId);
}

export function getParticipantStatus(db, meetingId, participantId) {
  const row = db
    .prepare("SELECT status FROM participants WHERE id = ? AND meeting_id = ?")
    .get(participantId, meetingId);
  return row?.status ?? "listening";
}

export function getAllParticipantsWithStatus(db, meetingId) {
  return db
    .prepare(
      `SELECT id, name, persona, agenda, tier, provider_id, model_id, session_id, session_version, status, reflection, known_biases, communication_style, preferred_contribution_types
         FROM participants WHERE meeting_id = ?`,
    )
    .all(meetingId)
     .map((r) => ({
      id: r.id,
      name: r.name,
      persona: r.persona,
      agenda: r.agenda,
      tier: r.tier,
      provider_id: r.provider_id,
      model_id: r.model_id,
      session_id: r.session_id,
      session_version: r.session_version ?? 0,
      status: r.status,
      reflection: r.reflection,
      known_biases: safeParseJsonArray(r.known_biases),
      communication_style: r.communication_style ?? null,
      preferred_contribution_types: safeParseJsonArray(r.preferred_contribution_types),
    }));
}

export function setRoundSummary(db, meetingId, round, summary) {
  db
    .prepare(
      `INSERT INTO rounds (meeting_id, round, summary, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(meeting_id, round) DO UPDATE SET summary = excluded.summary, created_at = excluded.created_at`,
    )
    .run(meetingId, round, summary ?? "", isoNow());
}

export function getRoundSummaries(db, meetingId) {
  const rows = db
    .prepare(
      `SELECT round, summary FROM rounds WHERE meeting_id = ? ORDER BY round ASC`,
    )
    .all(meetingId);
  const map = {};
  for (const r of rows) map[r.round] = r.summary;
  return map;
}

// Artifact and metrics operations moved to artifact-operations.js
export * from "./artifact-operations.js";

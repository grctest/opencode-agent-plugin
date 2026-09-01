import { isoNow } from "./connection.js";

function qq(db, sql) { return db.query ? db.query(sql) : db.prepare(sql); }

export function addToolAudit(db, meetingId, { participantId, round, batchId, tool, input, output, status = "completed", title = null }) {
  const now = isoNow();
  const inputStr = input != null ? (typeof input === "string" ? input : JSON.stringify(input)) : null;
  const outputStr = output != null ? (typeof output === "string" ? output : JSON.stringify(output)) : null;
  return qq(db,
    `INSERT INTO tool_audit (meeting_id, participant_id, round, batch_id, tool, input, output, status, title, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(meetingId, participantId, round, batchId ?? null, tool, inputStr, outputStr, status, title, now);
}

export function getToolAudits(db, meetingId) {
  return qq(db,
    `SELECT id, participant_id, round, batch_id, tool, input, output, status, title, created_at
     FROM tool_audit WHERE meeting_id = ? ORDER BY id ASC`,
  ).all(meetingId);
}

export function getToolAuditsForParticipant(db, meetingId, participantId, round = null) {
  if (round != null) {
    return qq(db,
      `SELECT id, participant_id, round, batch_id, tool, input, output, status, title, created_at
       FROM tool_audit WHERE meeting_id = ? AND participant_id = ? AND round = ? ORDER BY id ASC`,
    ).all(meetingId, participantId, round);
  }
  return qq(db,
    `SELECT id, participant_id, round, batch_id, tool, input, output, status, title, created_at
     FROM tool_audit WHERE meeting_id = ? AND participant_id = ? ORDER BY id ASC`,
  ).all(meetingId, participantId);
}

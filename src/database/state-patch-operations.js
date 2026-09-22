import { Logger, extractErrorInfo } from "../logger.js";
import { isoNow } from "./connection.js";

const dbLogger = new Logger();

const SEED_JSON = '{"stance":"","established":[],"contested":[],"open":[],"facts":[],"files":[],"version":0,"updated_round":0,"updated_contribution_id":null}';

function qq(db, sql) { return db.query ? db.query(sql) : db.prepare(sql); }

function hasStateColumns(db) {
  try {
    const cols = new Set(
      qq(db, "PRAGMA table_info(participants)").all().map((c) => c.name),
    );
    if (!cols.has("state_json")) return false;
    const tables = new Set(
      qq(db, "SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
    );
    return tables.has("state_patches");
  } catch {
    return false;
  }
}

function parseState(json) {
  try {
    const s = typeof json === "string" ? JSON.parse(json) : json;
    return {
      stance: typeof s?.stance === "string" ? s.stance : "",
      established: Array.isArray(s?.established) ? s.established : [],
      contested: Array.isArray(s?.contested) ? s.contested : [],
      open: Array.isArray(s?.open) ? s.open : [],
      facts: Array.isArray(s?.facts) ? s.facts : [],
      files: Array.isArray(s?.files) ? s.files : [],
      version: Number.isFinite(s?.version) ? s.version : 0,
      updated_round: Number.isFinite(s?.updated_round) ? s.updated_round : 0,
      updated_contribution_id: s?.updated_contribution_id ?? null,
    };
  } catch {
    return JSON.parse(SEED_JSON);
  }
}

export function getParticipantState(db, meetingId, participantId) {
  try {
    if (!hasStateColumns(db)) return JSON.parse(SEED_JSON);
    const row = qq(db, `SELECT state_json FROM participants WHERE id = ? AND meeting_id = ?`).get(participantId, meetingId);
    if (!row?.state_json) return JSON.parse(SEED_JSON);
    return parseState(row.state_json);
  } catch (err) {
    dbLogger.warn("get_participant_state_failed", `Failed to get state for ${participantId}`, extractErrorInfo(err));
    return JSON.parse(SEED_JSON);
  }
}

export function setParticipantState(db, meetingId, participantId, state) {
  try {
    if (!hasStateColumns(db)) return;
    qq(db, `UPDATE participants SET state_json = ? WHERE id = ? AND meeting_id = ?`)
      .run(JSON.stringify(state), participantId, meetingId);
  } catch (err) {
    dbLogger.warn("set_participant_state_failed", `Failed to set state for ${participantId}`, extractErrorInfo(err));
  }
}

export function getAllParticipantStates(db, meetingId) {
  try {
    if (!hasStateColumns(db)) return [];
    const rows = qq(db, `SELECT id, state_json FROM participants WHERE meeting_id = ?`).all(meetingId);
    return rows.map((r) => ({ participant_id: r.id, state: parseState(r.state_json) }));
  } catch (err) {
    dbLogger.warn("get_all_participant_states_failed", "Failed to list participant states", extractErrorInfo(err));
    return [];
  }
}

export function addStatePatch(db, meetingId, { participantId, round, contributionId = null, version, patchJson, appliedJson }) {
  try {
    if (!hasStateColumns(db)) return null;
    const res = qq(db,
      `INSERT INTO state_patches (meeting_id, participant_id, round, contribution_id, version, patch_json, applied_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(meeting_id, participant_id, version) DO NOTHING`,
    ).run(
      meetingId, participantId, round, contributionId, version,
      typeof patchJson === "string" ? patchJson : JSON.stringify(patchJson ?? {}),
      typeof appliedJson === "string" ? appliedJson : JSON.stringify(appliedJson ?? {}),
      isoNow(),
    );
    return Number(res?.changes ?? res?.rowsAffected ?? 0) > 0;
  } catch (err) {
    dbLogger.warn("add_state_patch_failed", "Failed to record state patch", extractErrorInfo(err));
    return null;
  }
}

export function listStatePatches(db, meetingId, participantId = null) {
  try {
    if (!hasStateColumns(db)) return [];
    const rows = participantId
      ? qq(db, `SELECT id, participant_id, round, contribution_id, version, patch_json, applied_json, created_at FROM state_patches WHERE meeting_id = ? AND participant_id = ? ORDER BY id ASC`).all(meetingId, participantId)
      : qq(db, `SELECT id, participant_id, round, contribution_id, version, patch_json, applied_json, created_at FROM state_patches WHERE meeting_id = ? ORDER BY id ASC`).all(meetingId);
    return rows.map((r) => {
      let patch = null;
      let applied = null;
      try { patch = JSON.parse(r.patch_json); } catch { patch = { raw: r.patch_json }; }
      try { applied = JSON.parse(r.applied_json); } catch { applied = { raw: r.applied_json }; }
      return {
        id: r.id, participant_id: r.participant_id, round: r.round,
        contribution_id: r.contribution_id, version: r.version,
        patch, applied, created_at: r.created_at,
      };
    });
  } catch (err) {
    dbLogger.warn("list_state_patches_failed", "Failed to list state patches", extractErrorInfo(err));
    return [];
  }
}

export function getStatePatchCoverage(db, meetingId) {
  try {
    const patches = listStatePatches(db, meetingId);
    return patches.length;
  } catch {
    return 0;
  }
}

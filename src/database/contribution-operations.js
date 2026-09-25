import { Logger, extractErrorInfo } from "../logger.js";
import { isoNow, safeParseJsonArray } from "./connection.js";

const dbLogger = new Logger();

function qq(db, sql) { return db.query ? db.query(sql) : db.prepare(sql); }

/**
 * Bound tool-call payloads for storage (audit X6): in-memory tool results stay
 * lossless for same-turn synthesis, but persisted rows cap string outputs at
 * 4 kB with a truncated flag — a single webfetch dump must not make a row
 * arbitrarily large. Shape-preserving: readers see the same array structure.
 */
export const STORED_TOOL_OUTPUT_MAX = 4000;
export function boundToolCallsForStorage(toolCalls) {
  if (!Array.isArray(toolCalls)) return toolCalls;
  return toolCalls.map((t) => {
    if (!t || typeof t !== "object") return t;
    const out = t.output;
    if (typeof out !== "string" || out.length <= STORED_TOOL_OUTPUT_MAX) return t;
    return {
      ...t,
      output: `${out.slice(0, STORED_TOOL_OUTPUT_MAX)}\n…[output truncated for storage — full text in session audit log]`,
      metadata: { ...(t.metadata ?? {}), truncated: true },
    };
  });
}

function serializeToolCalls(toolCalls) {
  if (!toolCalls) return null;
  return JSON.stringify(boundToolCallsForStorage(toolCalls));
}

export function addContribution(db, meetingId, contribution, getRoundFn) {
  qq(db,
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
      serializeToolCalls(contribution.tool_calls),
      contribution.prompt_context ? JSON.stringify(contribution.prompt_context) : null,
      contribution.created_at ?? isoNow(),
    );
}

function safeJsonParse(val, fallback = null) {
  if (!val) return fallback;
  if (typeof val !== "string") return val;
  try {
    const first = JSON.parse(val);
    if (typeof first === "string" && first.length > 0 && (first[0] === "[" || first[0] === "{" || first[0] === '"')) {
      try { return JSON.parse(first); } catch { return first; }
    }
    return first;
  } catch (err) {
    dbLogger.warn("json_parse_failed", `Failed to parse JSON field — returning ${fallback === null ? "null" : "fallback"}`, { message: err.message });
    return fallback;
  }
}

function normalizeToolCalls(val, fallback = null) {
  const parsed = safeJsonParse(val, fallback);
  if (Array.isArray(parsed)) return parsed;
  if (parsed == null) return fallback;
  if (typeof parsed === "object") return [parsed];
  return fallback;
}

export function getContributions(db, meetingId) {
  const rows = qq(db,
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
    tool_calls: normalizeToolCalls(r.tool_calls, null),
    prompt_context: safeJsonParse(r.prompt_context, null),
    created_at: r.created_at,
  }));
}

export function getRecentContributions(db, meetingId, count) {
  const rows = qq(db,
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
    tool_calls: normalizeToolCalls(r.tool_calls, null),
    prompt_context: safeJsonParse(r.prompt_context, null),
    created_at: r.created_at,
  }));
}

export function getContributionContext(db, contributionId) {
  const row = qq(db,`SELECT prompt_context FROM contributions WHERE id = ?`)
    .get(contributionId);
  return safeJsonParse(row?.prompt_context, null);
}

export function addTurnRequest(db, meetingId, turnRequest) {
  qq(db,
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
    const result = qq(db,
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

export function addContributionWithTurnRequest(db, meetingId, contribution, turnRequest, getRoundFn, statePatch = null) {
  db.exec('BEGIN IMMEDIATE');

  try {
    const exists = qq(db,`SELECT 1 FROM participants WHERE id = ? AND meeting_id = ?`).get(contribution.participant_id, meetingId);
    if (!exists) {
      dbLogger.warn("orphan_contribution", `Contribution participant_id ${contribution.participant_id} not in participants for meeting ${meetingId}`);
    }
    if (turnRequest?.target_participant_id) {
      const targetExists = qq(db,`SELECT 1 FROM participants WHERE id = ? AND meeting_id = ?`).get(turnRequest.target_participant_id, meetingId);
      if (!targetExists) {
        dbLogger.warn("orphan_turn_request", `Turn request target ${turnRequest.target_participant_id} not in participants for meeting ${meetingId}`);
      }
    }

    const insertResult = qq(db,
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
        serializeToolCalls(contribution.tool_calls),
        contribution.prompt_context ? JSON.stringify(contribution.prompt_context) : null,
        contribution.created_at ?? isoNow(),
      );

    if (statePatch?.state) {
      const contributionId = Number(insertResult?.lastInsertRowid ?? contribution.id ?? 0);
      if (!Number.isInteger(contributionId) || contributionId < 1) {
        throw new Error("state patch commit could not resolve contribution id");
      }
      const state = { ...statePatch.state, updated_contribution_id: contributionId };
      const updateResult = qq(db, `UPDATE participants SET state_json = ? WHERE id = ? AND meeting_id = ?`)
        .run(JSON.stringify(state), statePatch.participantId ?? contribution.participant_id, meetingId);
      if (Number(updateResult?.changes ?? updateResult?.rowsAffected ?? 0) < 1) {
        throw new Error("state patch commit could not update participant state");
      }
      qq(db,
        `INSERT INTO state_patches (meeting_id, participant_id, round, contribution_id, version, patch_json, applied_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(meeting_id, participant_id, version) DO NOTHING`,
      ).run(
        meetingId,
        statePatch.participantId ?? contribution.participant_id,
        statePatch.round ?? contribution.round ?? getRoundFn(),
        contributionId,
        statePatch.version ?? state.version,
        typeof statePatch.patchJson === "string" ? statePatch.patchJson : JSON.stringify(statePatch.patchJson ?? {}),
        typeof statePatch.appliedJson === "string" ? statePatch.appliedJson : JSON.stringify(statePatch.appliedJson ?? {}),
        isoNow(),
      );
    }

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
      `SELECT id, name, persona, agenda, tier, provider_id, model_id, session_id, session_version, status, reflection, known_biases, communication_style, preferred_contribution_types, anti_patterns, tier_guidance, reflection_guidance, tags, expertise
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
       anti_patterns: safeParseJsonArray(r.anti_patterns),
       tier_guidance: r.tier_guidance ?? "",
       reflection_guidance: r.reflection_guidance ?? "",
       tags: safeParseJsonArray(r.tags),
      expertise: safeParseJsonArray(r.expertise),
    }));
}

export function setRoundSummary(db, meetingId, round, summary, orchestratorConfig = null) {
  db
    .prepare(
      `INSERT INTO rounds (meeting_id, round, summary, orchestrator_config_json, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(meeting_id, round) DO UPDATE SET summary = excluded.summary, orchestrator_config_json = excluded.orchestrator_config_json, created_at = excluded.created_at`,
    )
    .run(
      meetingId,
      round,
      summary ?? "",
      orchestratorConfig ? JSON.stringify(orchestratorConfig) : null,
      isoNow(),
    );
}

export function getRoundSummaryConfigs(db, meetingId) {
  const rows = db
    .prepare(
      `SELECT round, orchestrator_config_json FROM rounds WHERE meeting_id = ? ORDER BY round ASC`,
    )
    .all(meetingId);
  const map = {};
  for (const r of rows) {
    if (!r.orchestrator_config_json) continue;
    try {
      map[r.round] = JSON.parse(r.orchestrator_config_json);
    } catch {}
  }
  return map;
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

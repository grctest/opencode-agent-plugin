import { parseReflections, safeParseJson } from "../../utils/db-parsing.js";

export function getState() {
    const row = this._db
      .prepare(
        `SELECT id as meeting_id, question, context, status, round, max_rounds, convergence, fabric, stats, reflecting_participants, querying_participants, evidence_participants, summoning_participants, state_of_play, semantic_degraded, persistence_degraded, created_at
         FROM meetings LIMIT 1`,
      )
      .get();
    if (!row) return null;
    if (row.stats) {
      try {
        row.stats = JSON.parse(row.stats);
      } catch {
        row.stats = {};
      }
    }
    // Degradation flags may be missing on pre-migration DBs (audit 07 EH2)
    if (row.semantic_degraded === undefined) row.semantic_degraded = 0;
    if (row.persistence_degraded === undefined) row.persistence_degraded = 0;
    if (row.reflecting_participants) {
      try {
        row.reflecting_participants = JSON.parse(row.reflecting_participants);
      } catch {
        row.reflecting_participants = [];
      }
    } else {
      row.reflecting_participants = [];
    }
    if (row.querying_participants) {
      try {
        row.querying_participants = JSON.parse(row.querying_participants);
      } catch {
        row.querying_participants = [];
      }
    } else {
      row.querying_participants = [];
    }
    if (row.evidence_participants) {
      try {
        row.evidence_participants = JSON.parse(row.evidence_participants);
      } catch {
        row.evidence_participants = [];
      }
    } else {
      row.evidence_participants = [];
    }
    if (row.summoning_participants) {
      try {
        row.summoning_participants = JSON.parse(row.summoning_participants);
      } catch {
        row.summoning_participants = [];
      }
    } else {
      row.summoning_participants = [];
    }
    return row;
  }

export function getStateWithStats() {
    return this.getState();
  }

export function getArtifact() {
    const row = this._db
      .prepare(
        `SELECT content, decisions, action_items, dissent, open_questions, confidence, refusals, created_at
         FROM artifacts LIMIT 1`,
      )
      .get();
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
      refusals: parse(row.refusals),
      open_questions: parse(row.open_questions),
      confidence: row.confidence,
      created_at: row.created_at,
    };
  }

export function getParticipants() {
    const rows = this._db
      .prepare(
        `SELECT id, name, persona, agenda, tier, provider_id, model_id, session_id, status, reflection
         FROM participants ORDER BY tier ASC`,
      )
      .all();
    return rows.map((r) => ({
      ...r,
      reflection: parseReflections(r.reflection),
    }));
  }

export function getAgentErrors() {
    return this._db
      .prepare(
        `SELECT id, participant_id, round, error_type, error_message, attempts, created_at
         FROM agent_errors ORDER BY id ASC`,
      )
      .all();
  }

export function getAgentErrorsAfter(afterId) {
    return this._db
      .prepare(
        `SELECT id, participant_id, round, error_type, error_message, attempts, created_at
         FROM agent_errors WHERE id > ? ORDER BY id ASC`,
      )
      .all(afterId);
  }

export function getMaxOrchestratorMessageId() {
    const row = this._db.prepare(`SELECT MAX(id) as max_id FROM orchestrator_messages`).get();
    return row?.max_id ?? 0;
  }

export function getContributions(limit = 100, offset = 0) {
    return this._db
      .prepare(
        `SELECT id, participant_id, round, type, content, target_which, batch_id, tool_calls, prompt_context, created_at
         FROM contributions ORDER BY round ASC, id ASC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset)
      .map((r) => ({
        id: r.id,
        participant_id: r.participant_id,
        round: r.round,
        type: r.type,
        content: r.content,
        targets_which: r.target_which != null ? Number(r.target_which) : null,
        batch_id: r.batch_id ?? null,
        tool_calls: safeParseJson(r.tool_calls),
        prompt_context: safeParseJson(r.prompt_context),
        created_at: r.created_at,
      }));
}

export function getContributionsAfter(afterId, limit = 100) {
    return this._db
      .prepare(
        `SELECT id, participant_id, round, type, content, target_which, batch_id, tool_calls, prompt_context, created_at
         FROM contributions WHERE id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(afterId, limit)
      .map((r) => ({
        id: r.id,
        participant_id: r.participant_id,
        round: r.round,
        type: r.type,
        content: r.content,
        targets_which: r.target_which != null ? Number(r.target_which) : null,
        batch_id: r.batch_id ?? null,
        tool_calls: safeParseJson(r.tool_calls),
        prompt_context: safeParseJson(r.prompt_context),
        created_at: r.created_at,
      }));
}

export function getContributionsCount() {
    const row = this._db.prepare(`SELECT COUNT(*) as count FROM contributions`).get();
    return row?.count ?? 0;
  }

export function getContributionsSince(sinceId) {
    return this._db
      .prepare(
        `SELECT id, participant_id, round, type, content, target_which, batch_id, tool_calls, prompt_context, created_at
         FROM contributions WHERE id > ? ORDER BY id ASC`,
      )
      .all(sinceId)
      .map((r) => ({
        id: r.id,
        participant_id: r.participant_id,
        round: r.round,
        type: r.type,
        content: r.content,
        targets_which: r.target_which != null ? Number(r.target_which) : null,
        batch_id: r.batch_id ?? null,
        tool_calls: safeParseJson(r.tool_calls),
        prompt_context: safeParseJson(r.prompt_context),
        created_at: r.created_at,
      }));
  }


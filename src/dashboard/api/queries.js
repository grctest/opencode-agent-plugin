import { parseReflections, safeParseJson, normalizeToolCalls } from "../../utils/db-parsing.js";

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

function mapContributionRow(r) {
  const rawCalls = r.tool_calls;
  const parsed = normalizeToolCalls(rawCalls, null);
  // Ensure tool_calls is either array or null (never string) so frontend length/map works
  const toolCalls = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : null);
  return {
    id: r.id,
    participant_id: r.participant_id,
    round: r.round,
    type: r.type,
    content: r.content,
    targets_which: r.target_which != null ? Number(r.target_which) : null,
    batch_id: r.batch_id ?? null,
    tool_calls: toolCalls,
    prompt_context: safeParseJson(r.prompt_context),
    created_at: r.created_at,
  };
}

function fetchToolAudits() {
  try {
    // tool_audit may not exist on pre-migration DBs — treat as empty
    const rows = this._db.prepare(
      `SELECT id, participant_id, round, batch_id, tool, input, output, status, title, created_at FROM tool_audit ORDER BY id ASC`
    ).all();
    return rows;
  } catch { return []; }
}

function auditRowToToolCall(r) {
  const isError = r.status === "error";
  return {
    tool: r.tool,
    callID: `audit-${r.id}`,
    status: r.status ?? "completed",
    attempted_tool: null,
    title: r.title ?? null,
    input: r.input ?? null,
    output: isError ? null : (r.output ?? null),
    error: isError ? (r.output ?? null) : null,
    metadata: null,
    // Preserve audit ordering tie-breaker
    _auditId: r.id,
    _batchId: r.batch_id,
    _participantId: r.participant_id,
    _round: r.round,
  };
}

function mergeAuditsIntoContributions(contributions) {
  const audits = fetchToolAudits.call(this);
  if (!audits || audits.length === 0) return contributions;
  const auditCalls = audits.map(auditRowToToolCall);
  const assigned = new Set();
  // Index contributions by participant+round for fallback
  const contribByParticipantRound = new Map();
  for (const c of contributions) {
    const k = `${c.participant_id}:${c.round}`;
    if (!contribByParticipantRound.has(k)) contribByParticipantRound.set(k, []);
    contribByParticipantRound.get(k).push(c);
  }
  for (const ac of auditCalls) {
    if (assigned.has(ac.callID)) continue;
    // Prefer exact batch match
    let target = null;
    if (ac._batchId) {
      target = contributions.find(c => c.participant_id === ac._participantId && c.round === ac._round && c.batch_id === ac._batchId);
    }
    if (!target) {
      const list = contribByParticipantRound.get(`${ac._participantId}:${ac._round}`) ?? [];
      target = list[0] ?? null;
      if (!target) continue;
    }
    if (!target) continue;
    // Deduplicate: if contribution already has same tool+input via LLM ToolPart, skip audit to avoid double entry (solid fallback, not duplicate)
    const alreadyHas = (target.tool_calls ?? []).some(t => t.tool === ac.tool && String(t.input ?? "") === String(ac.input ?? ""));
    if (alreadyHas) { assigned.add(ac.callID); continue; }
    target.tool_calls = [...(target.tool_calls ?? []), ac];
    assigned.add(ac.callID);
  }
  // Cleanup transient keys and sort per contribution by audit id (preserve order)
  for (const c of contributions) {
    if (c.tool_calls) {
      c.tool_calls.sort((a, b) => {
        const aid = a.callID?.startsWith("audit-") ? Number(a.callID.slice(6)) : 0;
        const bid = b.callID?.startsWith("audit-") ? Number(b.callID.slice(6)) : 0;
        if (aid && bid) return aid - bid;
        if (aid) return 1;
        if (bid) return -1;
        return 0;
      });
      for (const t of c.tool_calls) { delete t._auditId; delete t._batchId; delete t._participantId; delete t._round; }
    }
  }
  return contributions;
}

export function getContributions(limit = 100, offset = 0) {
    const rows = this._db
      .prepare(
        `SELECT id, participant_id, round, type, content, target_which, batch_id, tool_calls, prompt_context, created_at
         FROM contributions ORDER BY round ASC, id ASC LIMIT ? OFFSET ?`,
      )
      .all(limit, offset)
      .map(mapContributionRow);
    return mergeAuditsIntoContributions.call(this, rows);
}

export function getContributionsAfter(afterId, limit = 100) {
    const rows = this._db
      .prepare(
        `SELECT id, participant_id, round, type, content, target_which, batch_id, tool_calls, prompt_context, created_at
         FROM contributions WHERE id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(afterId, limit)
      .map(mapContributionRow);
    return mergeAuditsIntoContributions.call(this, rows);
}

export function getContributionsCount() {
    const row = this._db.prepare(`SELECT COUNT(*) as count FROM contributions`).get();
    return row?.count ?? 0;
  }

export function getContributionsSince(sinceId, limit = 500) {
    const n = Math.min(Math.max(limit ?? 500, 0), 500);
    const rows = this._db
      .prepare(
        `SELECT id, participant_id, round, type, content, target_which, batch_id, tool_calls, prompt_context, created_at
         FROM contributions WHERE id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(sinceId, n)
      .map(mapContributionRow);
    return mergeAuditsIntoContributions.call(this, rows);
}

export function getForumTopics(tag) {
    let rows;
    if (tag) {
      rows = this._db
        .prepare(
          `SELECT id, title, tags, author_id, created_at
           FROM forum_topics
           WHERE tags IS NOT NULL AND tags LIKE ?
           ORDER BY created_at DESC`,
        )
        .all(`%${tag}%`);
    } else {
      rows = this._db
        .prepare(
          `SELECT id, title, tags, author_id, created_at
           FROM forum_topics
           ORDER BY created_at DESC`,
        )
        .all();
    }
    return rows.map((r) => {
      const countRow = this._db
        .prepare(`SELECT COUNT(*) as cnt FROM forum_comments WHERE topic_id = ?`)
        .get(r.id);
      let tags = [];
      try { tags = JSON.parse(r.tags); } catch {}
      return {
        id: r.id,
        title: r.title,
        tags,
        author_id: r.author_id,
        comment_count: countRow?.cnt ?? 0,
        created_at: r.created_at,
      };
    });
  }

export function getForumTopic(topicId) {
    const topic = this._db
      .prepare(
        `SELECT id, title, body, tags, author_id, created_at, updated_at
         FROM forum_topics WHERE id = ?`,
      )
      .get(topicId);
    if (!topic) return null;

    const comments = this._db
      .prepare(
        `SELECT id, author_id, body, created_at
         FROM forum_comments WHERE topic_id = ?
         ORDER BY created_at ASC`,
      )
      .all(topicId);

    let tags = [];
    try { tags = JSON.parse(topic.tags); } catch {}

    return {
      id: topic.id,
      title: topic.title,
      body: topic.body,
      tags,
      author_id: topic.author_id,
      created_at: topic.created_at,
      updated_at: topic.updated_at,
      comments: comments.map((c) => ({
        id: c.id,
        author_id: c.author_id,
        body: c.body,
        created_at: c.created_at,
      })),
    };
  }

export function getMaxForumTopicId() {
    const row = this._db.prepare(`SELECT MAX(id) as max_id FROM forum_topics`).get();
    return row?.max_id ?? 0;
  }

export function getMaxForumCommentId() {
    const row = this._db.prepare(`SELECT MAX(id) as max_id FROM forum_comments`).get();
    return row?.max_id ?? 0;
  }


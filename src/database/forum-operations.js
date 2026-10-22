import { Logger } from "../logger.js";
import { isoNow, safeParseJsonArray } from "./connection.js";

const forumLogger = new Logger();

function qq(db, sql) { return db.query ? db.query(sql) : db.prepare(sql); }

function safeJsonParse(val, fallback = null) {
  if (!val) return fallback;
  try { return JSON.parse(val); } catch {
    return fallback;
  }
}

export function createTopic(db, meetingId, { title, body, tags, authorId }) {
  const now = isoNow();
  const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : null;
  const result = qq(db,
    `INSERT INTO forum_topics (meeting_id, title, body, tags, author_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(meetingId, title, body, tagsJson, authorId, now, now);
  return { id: Number(result.lastInsertRowid), created_at: now };
}

export function listTopics(db, meetingId, { tag } = {}) {
  let rows;
  if (tag) {
    rows = qq(db,
      `SELECT id, title, tags, author_id, created_at
         FROM forum_topics WHERE meeting_id = ?
         AND tags IS NOT NULL AND tags LIKE ?
         ORDER BY created_at DESC`,
    ).all(meetingId, `%${tag}%`);
  } else {
    rows = qq(db,
      `SELECT id, title, tags, author_id, created_at
         FROM forum_topics WHERE meeting_id = ?
         ORDER BY created_at DESC`,
    ).all(meetingId);
  }

  const topics = [];
  for (const r of rows) {
    const tags = safeJsonParse(r.tags, []);
    const countRow = qq(db,
      `SELECT COUNT(*) as cnt FROM forum_comments WHERE topic_id = ?`,
    ).get(r.id);
    topics.push({
      id: r.id,
      title: r.title,
      tags,
      author_id: r.author_id,
      comment_count: countRow?.cnt ?? 0,
      created_at: r.created_at,
    });
  }
  return topics;
}

export function getTopic(db, meetingId, topicId) {
  const topic = qq(db,
    `SELECT id, title, body, tags, author_id, created_at, updated_at
       FROM forum_topics WHERE id = ? AND meeting_id = ?`,
  ).get(topicId, meetingId);
  if (!topic) return null;

  const comments = qq(db,
    `SELECT id, author_id, body, created_at
       FROM forum_comments WHERE topic_id = ?
       ORDER BY created_at ASC`,
  ).all(topicId);

  return {
    id: topic.id,
    title: topic.title,
    body: topic.body,
    tags: safeJsonParse(topic.tags, []),
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

/**
 * Cold-start seed (post-mortem 7811b8db §8, cause 1): `optional` forums stayed
 * at 0 uses because no one wants to be the first to populate an empty forum
 * when the live transcript already carries shared memory, and the single
 * `loom_forum_list_topics` probe returned empty → "nothing to see, move on".
 * The orchestrator opens one designated side-channel topic at init so the
 * forum starts with a job (park sub-problems / data asides) and a reader (the
 * State-of-Play forum digest). Idempotent — call only creates when the forum
 * has no topics yet, so resume paths reuse the existing seed.
 *
 * Accepts either the high-level MeetingDatabase facade (as wired in
 * orchestrator/init.js) or a raw database handle; existence checks and
 * creation route to whichever layer is present.
 */
export function seedSubProblemsTopic(db, meetingId, question = "", { authorId = null } = {}) {
  let existing;
  try {
    if (typeof db?.listForumTopics === "function") existing = db.listForumTopics({}) ?? [];
    else existing = listTopics(db, meetingId, {});
  } catch {
    return null;
  }
  if (existing.length > 0) return null;
  const clean = String(question ?? "").replace(/\s+/g, " ").trim();
  const title = clean
    ? `Sub-problems & data needs — ${clean.slice(0, 64)}${clean.length > 64 ? "…" : ""}`
    : "Sub-problems & data needs";
  const body = [
    "The room's async side-channel — a designated place for anything that deserves its own space:",
    "a sub-problem someone opened that never got an answer, a data need (missing figure, source check, scope test),",
    "or a deep dive too large for a main contribution.",
    "",
    "To use it:",
    "- Comment on THIS topic (loom_forum_add_comment with topic_id) for general side-notes; cite threads in your prose as [#T{id}].",
    "- Open a NEW topic per sub-problem (loom_forum_create_topic) so each keeps its own record.",
    "- Threads (ids + latest comments) digest into the State of Play each round and reach the final synthesis — writing here is writing to the room.",
  ].join("\n");
  // The author must be a REAL seat: forum_topics.author_id REFERENCES
  // participants(id).
  //
  // The orchestrator is NOT a participant. It has its own area, it is called
  // last, and it must never be injected into the participants table. An
  // earlier version of this seed tried to satisfy the foreign key by creating
  // a participant row for the synthetic author "orchestrator" — which put a
  // phantom "Orchestrator" seat into the participants table, and the
  // dashboard's participant list (unlike the read-only meeting snapshot) did
  // not filter the 'summoned' status, so the orchestrator appeared in the
  // active participant list the moment a meeting started.
  //
  // So the seed is authored by a real seat, and when no seat row exists it
  // declines to seed rather than inventing one. The topic keeps its "seed"
  // tag, and its body already frames it as the room's side-channel.
  if (!authorId || !participantRowExists(db, meetingId, authorId)) return null;
  const input = { title, body, tags: ["seed"], authorId };
  if (typeof db?.createForumTopic === "function") return db.createForumTopic(input);
  return createTopic(db, meetingId, input);
}

/**
 * Does a REAL seat row exist for this author? The 'summoned' status is
 * reserved for rows that are not seats (summoned guest experts), so it is
 * excluded here as well.
 */
function participantRowExists(db, meetingId, participantId) {
  try {
    if (typeof db?.getAllParticipantsWithStatus === "function") {
      return (db.getAllParticipantsWithStatus() ?? []).some((p) => p?.id === participantId && p?.status !== "summoned");
    }
    return !!qq(db, "SELECT 1 FROM participants WHERE id = ? AND meeting_id = ? AND status != 'summoned'").get(participantId, meetingId);
  } catch {
    // A handle that cannot answer the question is not evidence AGAINST the
    // author — let the insert decide. The foreign key is the real guarantee
    // that a non-seat author can never be written: the seed no longer creates
    // participant rows at all, so a missing author simply means no topic.
    return true;
  }
}

export function addComment(db, meetingId, topicId, { body, authorId }) {
  const topic = qq(db,
    `SELECT id FROM forum_topics WHERE id = ? AND meeting_id = ?`,
  ).get(topicId, meetingId);
  if (!topic) return null;

  const now = isoNow();
  const result = qq(db,
    `INSERT INTO forum_comments (topic_id, author_id, body, created_at)
       VALUES (?, ?, ?, ?)`,
  ).run(topicId, authorId, body, now);
  return { id: Number(result.lastInsertRowid), created_at: now };
}

/**
 * For prompt injection: top 10 topics sorted by last activity
 * (max(created_at, latest comment created_at) DESC) so new threads
 * bubble with recently commented ones. Returns title, id, comment count,
 * and latest_commenter name (— if none).
 */
export function listTopicsForPrompt(db, meetingId, limit = 10) {
  const lim = Math.max(1, Math.min(20, Math.floor(Number(limit) || 10)));
  try {
    const rows = qq(db, `
      SELECT t.id, t.title, t.created_at,
             SUBSTR(t.body, 1, 200) AS preview,
             (SELECT COUNT(*) FROM forum_comments WHERE topic_id = t.id) AS comment_count,
             (SELECT MAX(created_at) FROM forum_comments WHERE topic_id = t.id) AS last_comment_at,
             COALESCE((SELECT MAX(created_at) FROM forum_comments WHERE topic_id = t.id), t.created_at) AS last_activity,
             (SELECT author_id FROM forum_comments WHERE topic_id = t.id ORDER BY created_at DESC, id DESC LIMIT 1) AS latest_commenter_id,
             (SELECT SUBSTR(body, 1, 200) FROM forum_comments WHERE topic_id = t.id ORDER BY created_at DESC, id DESC LIMIT 1) AS latest_preview
      FROM forum_topics t
      WHERE t.meeting_id = ?
      ORDER BY last_activity DESC, t.created_at DESC
      LIMIT ?
    `).all(meetingId, lim);
    if (rows.length === 0) return [];
    const ids = rows.map(r => r.latest_commenter_id).filter(Boolean);
    const nameMap = new Map();
    if (ids.length > 0) {
      try {
        const uniq = [...new Set(ids)];
        const placeholders = uniq.map(() => '?').join(',');
        const nameRows = qq(db, `SELECT id, name FROM participants WHERE meeting_id = ? AND id IN (${placeholders})`).all(meetingId, ...uniq);
        for (const nr of nameRows) nameMap.set(nr.id, nr.name);
      } catch {}
    }
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      // 200-char previews so prompt consumers can judge relevance without a
      // blind loom_forum_read_topic call per topic (audit A13).
      preview: r.preview ?? null,
      latest_preview: r.latest_preview ?? null,
      comment_count: Number(r.comment_count ?? 0),
      latest_commenter_id: r.latest_commenter_id || null,
      latest_commenter_name: r.latest_commenter_id ? (nameMap.get(r.latest_commenter_id) ?? r.latest_commenter_id) : null,
      last_activity: r.last_activity,
      created_at: r.created_at,
    }));
  } catch {
    return [];
  }
}

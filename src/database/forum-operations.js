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
             (SELECT COUNT(*) FROM forum_comments WHERE topic_id = t.id) AS comment_count,
             (SELECT MAX(created_at) FROM forum_comments WHERE topic_id = t.id) AS last_comment_at,
             COALESCE((SELECT MAX(created_at) FROM forum_comments WHERE topic_id = t.id), t.created_at) AS last_activity,
             (SELECT author_id FROM forum_comments WHERE topic_id = t.id ORDER BY created_at DESC, id DESC LIMIT 1) AS latest_commenter_id
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

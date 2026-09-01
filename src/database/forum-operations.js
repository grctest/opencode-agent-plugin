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

import { tool } from "@opencode-ai/plugin";
import { MeetingDatabase } from "../../database.js";
import { resolveCaller } from "./shared.js";

export function createForumTools({ config, resolveMeeting, activeLooms }) {
  function checkEnabled() {
    const cfg = config.getValue("agentTools");
    if (!cfg?.enabled || !cfg?.loom?.loom_forum) return false;
    return true;
  }

  function getEngineAndDb(meetingInfo, sessionID) {
    const engine = activeLooms.get(meetingInfo.meetingId);
    if (!engine) return { error: "Could not resolve active loom for this session" };
    const stateManager = engine.getStateManager?.();
    const db = engine.getDatabase?.();
    if (!stateManager || !db) return { error: "Loom state not ready" };
    return { engine, stateManager, db };
  }

  return {
    loom_forum_create_topic: tool({
      description:
        "Create a forum topic for async sub-discussion. Other participants can comment on it later. " +
        "Use for proposing a sub-problem, requesting input on a specific sub-topic, or flagging an issue for group attention.",
      args: {
        title: tool.schema.string().min(1).max(200).describe("Topic title (1-200 chars)"),
        body: tool.schema.string().min(1).max(4000).describe("Topic body — your full question or proposal (1-4000 chars)"),
        tags: tool.schema.array(tool.schema.string()).optional().describe("Optional tags for categorization, e.g. ['api-design','backend']"),
      },
      async execute(args, context) {
        if (!checkEnabled()) {
          return { output: JSON.stringify({ error: "Forum tools not enabled in configuration" }), metadata: { error: true }, title: "loom_forum_create_topic error" };
        }
        if (!context?.sessionID) {
          return { output: JSON.stringify({ error: "loom_forum_create_topic: session context unavailable" }), metadata: { error: true }, title: "loom_forum_create_topic error" };
        }
        const meetingInfo = await resolveMeeting(context.sessionID);
        if (!meetingInfo) {
          return { output: JSON.stringify({ error: "Could not resolve meeting for this session" }), metadata: { error: true }, title: "loom_forum_create_topic error" };
        }
        const { stateManager, db, error } = getEngineAndDb(meetingInfo, context.sessionID);
        if (error) {
          return { output: JSON.stringify({ error }), metadata: { error: true }, title: "loom_forum_create_topic error" };
        }
        const participants = stateManager.getParticipants?.() ?? [];
        const caller = resolveCaller(participants, stateManager.getWeave?.() ?? [], context.sessionID);
        if (!caller) {
          return { output: JSON.stringify({ error: "Could not identify caller" }), metadata: { error: true }, title: "loom_forum_create_topic error" };
        }
        try {
          const authorId = caller.config?.id ?? caller.id;
          const result = db.createForumTopic({
            title: args.title.trim(),
            body: args.body.trim(),
            tags: args.tags ?? [],
            authorId,
          });
          const payload = { topic_id: result.id, title: args.title.trim(), created_at: result.created_at };
          return { output: JSON.stringify(payload), metadata: { topic_id: result.id }, title: `loom_forum_create_topic: #${result.id}` };
        } catch (e) {
          return { output: JSON.stringify({ error: `Failed to create topic: ${e.message}` }), metadata: { error: true }, title: "loom_forum_create_topic error" };
        }
      },
    }),

    loom_forum_list_topics: tool({
      description:
        "List forum topic titles — browse what sub-discussions exist before deciding which to read. " +
        "Returns titles, tags, author, and comment count for each topic.",
      args: {
        tag: tool.schema.string().optional().describe("Optional tag to filter topics by"),
      },
      async execute(args, context) {
        if (!checkEnabled()) {
          return { output: JSON.stringify({ error: "Forum tools not enabled in configuration" }), metadata: { error: true }, title: "loom_forum_list_topics error" };
        }
        if (!context?.sessionID) {
          return { output: JSON.stringify({ error: "loom_forum_list_topics: session context unavailable" }), metadata: { error: true }, title: "loom_forum_list_topics error" };
        }
        const meetingInfo = await resolveMeeting(context.sessionID);
        if (!meetingInfo) {
          return { output: JSON.stringify({ error: "Could not resolve meeting for this session" }), metadata: { error: true }, title: "loom_forum_list_topics error" };
        }
        const { stateManager, db, error } = getEngineAndDb(meetingInfo, context.sessionID);
        if (error) {
          return { output: JSON.stringify({ error }), metadata: { error: true }, title: "loom_forum_list_topics error" };
        }
        try {
          const topics = db.listForumTopics({ tag: args.tag ?? undefined });
          const payload = { topics, count: topics.length };
          return { output: JSON.stringify(payload), metadata: { count: topics.length }, title: `loom_forum_list_topics: ${topics.length} topics` };
        } catch (e) {
          return { output: JSON.stringify({ error: `Failed to list topics: ${e.message}` }), metadata: { error: true }, title: "loom_forum_list_topics error" };
        }
      },
    }),

    loom_forum_read_topic: tool({
      description:
        "Read a forum topic and all its comments — the full sub-discussion content. " +
        "Use after listing topics to dive into a specific one.",
      args: {
        topic_id: tool.schema.number().int().describe("Topic ID to read"),
      },
      async execute(args, context) {
        if (!checkEnabled()) {
          return { output: JSON.stringify({ error: "Forum tools not enabled in configuration" }), metadata: { error: true }, title: "loom_forum_read_topic error" };
        }
        if (!context?.sessionID) {
          return { output: JSON.stringify({ error: "loom_forum_read_topic: session context unavailable" }), metadata: { error: true }, title: "loom_forum_read_topic error" };
        }
        const meetingInfo = await resolveMeeting(context.sessionID);
        if (!meetingInfo) {
          return { output: JSON.stringify({ error: "Could not resolve meeting for this session" }), metadata: { error: true }, title: "loom_forum_read_topic error" };
        }
        const { stateManager, db, error } = getEngineAndDb(meetingInfo, context.sessionID);
        if (error) {
          return { output: JSON.stringify({ error }), metadata: { error: true }, title: "loom_forum_read_topic error" };
        }
        try {
          const topic = db.getForumTopic(args.topic_id);
          if (!topic) {
            return { output: JSON.stringify({ error: `Topic #${args.topic_id} not found` }), metadata: { error: true }, title: "loom_forum_read_topic error" };
          }
          return { output: JSON.stringify(topic), metadata: { topic_id: topic.id, comment_count: topic.comments.length }, title: `loom_forum_read_topic: #${topic.id}` };
        } catch (e) {
          return { output: JSON.stringify({ error: `Failed to read topic: ${e.message}` }), metadata: { error: true }, title: "loom_forum_read_topic error" };
        }
      },
    }),

    loom_forum_add_comment: tool({
      description:
        "Add a comment to an existing forum topic — contribute to the sub-discussion. " +
        "Use to answer a question, provide evidence, or push back on a proposal.",
      args: {
        topic_id: tool.schema.number().int().describe("Topic ID to comment on"),
        body: tool.schema.string().min(1).max(4000).describe("Your comment (1-4000 chars)"),
      },
      async execute(args, context) {
        if (!checkEnabled()) {
          return { output: JSON.stringify({ error: "Forum tools not enabled in configuration" }), metadata: { error: true }, title: "loom_forum_add_comment error" };
        }
        if (!context?.sessionID) {
          return { output: JSON.stringify({ error: "loom_forum_add_comment: session context unavailable" }), metadata: { error: true }, title: "loom_forum_add_comment error" };
        }
        const meetingInfo = await resolveMeeting(context.sessionID);
        if (!meetingInfo) {
          return { output: JSON.stringify({ error: "Could not resolve meeting for this session" }), metadata: { error: true }, title: "loom_forum_add_comment error" };
        }
        const { stateManager, db, error } = getEngineAndDb(meetingInfo, context.sessionID);
        if (error) {
          return { output: JSON.stringify({ error }), metadata: { error: true }, title: "loom_forum_add_comment error" };
        }
        const participants = stateManager.getParticipants?.() ?? [];
        const caller = resolveCaller(participants, stateManager.getWeave?.() ?? [], context.sessionID);
        if (!caller) {
          return { output: JSON.stringify({ error: "Could not identify caller" }), metadata: { error: true }, title: "loom_forum_add_comment error" };
        }
        try {
          const authorId = caller.config?.id ?? caller.id;
          const result = db.addForumComment(args.topic_id, {
            body: args.body.trim(),
            authorId,
          });
          if (!result) {
            return { output: JSON.stringify({ error: `Topic #${args.topic_id} not found` }), metadata: { error: true }, title: "loom_forum_add_comment error" };
          }
          const payload = { comment_id: result.id, topic_id: args.topic_id, created_at: result.created_at };
          return { output: JSON.stringify(payload), metadata: { comment_id: result.id, topic_id: args.topic_id }, title: `loom_forum_add_comment: #${result.id} on #${args.topic_id}` };
        } catch (e) {
          return { output: JSON.stringify({ error: `Failed to add comment: ${e.message}` }), metadata: { error: true }, title: "loom_forum_add_comment error" };
        }
      },
    }),
  };
}

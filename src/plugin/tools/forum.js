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

  function auditForumTool({ db, stateManager, caller, meetingId, tool, input, output, status = "completed", title = null }) {
    try {
      const participantId = caller?.config?.id ?? caller?.id ?? "unknown";
      const round = stateManager.getCurrentRound?.() ?? stateManager.getState?.()?.round ?? 0;
      const batchId = caller?.currentBatchId ?? null;
      // Durable audit — survives even if ToolPart extraction fails (solid, not response-parsing fallback)
      // Stored in tool_audit table and merged into contributions.tool_calls on fetch.
      db.addToolAudit({
        participantId,
        round,
        batchId,
        tool,
        input,
        output,
        status,
        title,
      });
    } catch {}
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
          const outputStr = JSON.stringify(payload);
          auditForumTool({ db, stateManager, caller, meetingId: meetingInfo.meetingId, tool: "loom_forum_create_topic", input: args, output: outputStr, status: "completed", title: `loom_forum_create_topic: #${result.id}` });
          return { output: outputStr, metadata: { topic_id: result.id }, title: `loom_forum_create_topic: #${result.id}` };
        } catch (e) {
          const errPayload = JSON.stringify({ error: `Failed to create topic: ${e.message}` });
          auditForumTool({ db, stateManager, caller, meetingId: meetingInfo.meetingId, tool: "loom_forum_create_topic", input: args, output: errPayload, status: "error", title: "loom_forum_create_topic error" });
          return { output: errPayload, metadata: { error: true }, title: "loom_forum_create_topic error" };
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
          const outputStr = JSON.stringify(payload);
          // Audit list — use caller if resolvable, else fallback to unknown participant for durability
          const listParticipants = stateManager.getParticipants?.() ?? [];
          const listCaller = resolveCaller(listParticipants, stateManager.getWeave?.() ?? [], context.sessionID);
          auditForumTool({ db, stateManager, caller: listCaller ?? { id: "unknown", config: { id: "unknown" } }, meetingId: meetingInfo.meetingId, tool: "loom_forum_list_topics", input: args, output: outputStr, status: "completed", title: `loom_forum_list_topics: ${topics.length} topics` });
          return { output: outputStr, metadata: { count: topics.length }, title: `loom_forum_list_topics: ${topics.length} topics` };
        } catch (e) {
          const errPayload = JSON.stringify({ error: `Failed to list topics: ${e.message}` });
          const listParticipants = stateManager.getParticipants?.() ?? [];
          const listCaller = resolveCaller(listParticipants, stateManager.getWeave?.() ?? [], context.sessionID);
          auditForumTool({ db, stateManager, caller: listCaller ?? { id: "unknown", config: { id: "unknown" } }, meetingId: meetingInfo.meetingId, tool: "loom_forum_list_topics", input: args, output: errPayload, status: "error", title: "loom_forum_list_topics error" });
          return { output: errPayload, metadata: { error: true }, title: "loom_forum_list_topics error" };
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
            const errPayload = JSON.stringify({ error: `Topic #${args.topic_id} not found` });
            const readParticipants = stateManager.getParticipants?.() ?? [];
            const readCaller = resolveCaller(readParticipants, stateManager.getWeave?.() ?? [], context.sessionID);
            auditForumTool({ db, stateManager, caller: readCaller ?? { id: "unknown", config: { id: "unknown" } }, meetingId: meetingInfo.meetingId, tool: "loom_forum_read_topic", input: args, output: errPayload, status: "error", title: "loom_forum_read_topic error" });
            return { output: errPayload, metadata: { error: true }, title: "loom_forum_read_topic error" };
          }
          const outputStr = JSON.stringify(topic);
          const readParticipants = stateManager.getParticipants?.() ?? [];
          const readCaller = resolveCaller(readParticipants, stateManager.getWeave?.() ?? [], context.sessionID);
          auditForumTool({ db, stateManager, caller: readCaller ?? { id: "unknown", config: { id: "unknown" } }, meetingId: meetingInfo.meetingId, tool: "loom_forum_read_topic", input: args, output: outputStr, status: "completed", title: `loom_forum_read_topic: #${topic.id}` });
          return { output: outputStr, metadata: { topic_id: topic.id, comment_count: topic.comments.length }, title: `loom_forum_read_topic: #${topic.id}` };
        } catch (e) {
          const errPayload = JSON.stringify({ error: `Failed to read topic: ${e.message}` });
          const readParticipants = stateManager.getParticipants?.() ?? [];
          const readCaller = resolveCaller(readParticipants, stateManager.getWeave?.() ?? [], context.sessionID);
          auditForumTool({ db, stateManager, caller: readCaller ?? { id: "unknown", config: { id: "unknown" } }, meetingId: meetingInfo.meetingId, tool: "loom_forum_read_topic", input: args, output: errPayload, status: "error", title: "loom_forum_read_topic error" });
          return { output: errPayload, metadata: { error: true }, title: "loom_forum_read_topic error" };
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
            const errPayload = JSON.stringify({ error: `Topic #${args.topic_id} not found` });
            auditForumTool({ db, stateManager, caller, meetingId: meetingInfo.meetingId, tool: "loom_forum_add_comment", input: args, output: errPayload, status: "error", title: "loom_forum_add_comment error" });
            return { output: errPayload, metadata: { error: true }, title: "loom_forum_add_comment error" };
          }
          const payload = { comment_id: result.id, topic_id: args.topic_id, created_at: result.created_at };
          const outputStr = JSON.stringify(payload);
          auditForumTool({ db, stateManager, caller, meetingId: meetingInfo.meetingId, tool: "loom_forum_add_comment", input: args, output: outputStr, status: "completed", title: `loom_forum_add_comment: #${result.id} on #${args.topic_id}` });
          return { output: outputStr, metadata: { comment_id: result.id, topic_id: args.topic_id }, title: `loom_forum_add_comment: #${result.id} on #${args.topic_id}` };
        } catch (e) {
          const errPayload = JSON.stringify({ error: `Failed to add comment: ${e.message}` });
          auditForumTool({ db, stateManager, caller, meetingId: meetingInfo.meetingId, tool: "loom_forum_add_comment", input: args, output: errPayload, status: "error", title: "loom_forum_add_comment error" });
          return { output: errPayload, metadata: { error: true }, title: "loom_forum_add_comment error" };
        }
      },
    }),
  };
}

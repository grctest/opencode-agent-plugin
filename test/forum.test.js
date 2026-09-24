import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";
import { StateManager } from "../src/services/state-manager.js";
import { createForumTools } from "../src/plugin/tools/forum.js";
import { buildAgentSystemPrompt, buildAgentUserPrompt } from "../src/prompts/agent.js";
import { buildToolsMap, buildToolsMapWithoutLoom } from "../src/round-executor/tools.js";

function makeParticipant() {
  return {
    config: {
      id: "forum-agent",
      name: "Forum Agent",
      tier: "mid",
      persona: "Explores asynchronous sub-problems.",
      agenda: "Identify useful follow-up work.",
      known_biases: [],
      preferred_contribution_types: [],
      anti_patterns: [],
      model: { providerID: "test", modelID: "test-model" },
    },
    tier_config: {},
    status: "speaking",
    session_id: "forum-session",
    contributions_count: 0,
  };
}

function makeForumDb() {
  let nextTopicId = 1;
  let nextCommentId = 1;
  const topics = [];
  const comments = new Map();
  return {
    topics,
    createForumTopic({ title, body, tags, authorId }) {
      const now = new Date().toISOString();
      const topic = { id: nextTopicId++, title, body, tags, author_id: authorId, created_at: now, updated_at: now };
      topics.push(topic);
      comments.set(topic.id, []);
      return topic;
    },
    listForumTopics({ tag } = {}) {
      return topics
        .filter((topic) => !tag || topic.tags.includes(tag))
        .map((topic) => ({
          id: topic.id,
          title: topic.title,
          tags: topic.tags,
          author_id: topic.author_id,
          comment_count: comments.get(topic.id)?.length ?? 0,
          created_at: topic.created_at,
        }))
        .reverse();
    },
    getForumTopic(topicId) {
      const topic = topics.find((entry) => entry.id === topicId);
      return topic ? { ...topic, comments: comments.get(topicId) ?? [] } : null;
    },
    addForumComment(topicId, { body, authorId }) {
      if (!topics.some((topic) => topic.id === topicId)) return null;
      const comment = { id: nextCommentId++, author_id: authorId, body, created_at: new Date().toISOString() };
      comments.get(topicId).push(comment);
      return comment;
    },
    addToolAudit() {},
  };
}

test("forum tools are consistently advertised in primary and synthesis tool maps", () => {
  const participant = makeParticipant();
  const agentTools = structuredClone(DEFAULT_CONFIG.agentTools);
  const primary = buildToolsMap({ agentTools }, { activeCount: 3 });
  const synthesis = buildToolsMapWithoutLoom({ agentTools }, { activeCount: 3 });
  const system = buildAgentSystemPrompt(participant, { activeCount: 3, agentTools });
  const withForum = buildAgentUserPrompt(participant, "", [], 1, "Question", [], "", [], [], null, true);
  const withoutForum = buildAgentUserPrompt(participant, "", [], 1, "Question", [], "", [], [], null, false);
  const names = [
    "loom_forum_create_topic",
    "loom_forum_list_topics",
    "loom_forum_read_topic",
    "loom_forum_add_comment",
  ];

  for (const name of names) {
    assert.equal(primary[name], true);
    assert.equal(synthesis[name], true);
    assert.match(system, new RegExp(name));
  }
  assert.match(withForum, /## Forum — Open Threads/);
  assert.doesNotMatch(withoutForum, /## Forum — Open Threads/);
});

test("mandatory capability modes are reflected in turn prompts", () => {
  const participant = makeParticipant();
  const agentTools = structuredClone(DEFAULT_CONFIG.agentTools);
  agentTools.mandatory = { forums: true, skillState: true, agentQueries: true, localSearch: true, onlineResearch: true };
  const system = buildAgentSystemPrompt(participant, { activeCount: 3, agentTools });
  const user = buildAgentUserPrompt(participant, "", [], 1, "Question", [], "", [], [{ id: "peer", name: "Peer", tier: "senior", status: "listening" }], null, true, true, agentTools.mandatory);
  assert.match(system, /must make at least one forum tool call/i);
  assert.match(system, /must make at least one local search tool call/i);
  assert.match(system, /must make at least one online research tool call/i);
  assert.match(system, /required once per non-pass turn/i);
  assert.match(user, /requires one forum tool call/i);
  assert.match(user, /eligible peer interaction tool/i);
  const optionalSystem = buildAgentSystemPrompt(participant, { activeCount: 3, agentTools: DEFAULT_CONFIG.agentTools });
  assert.doesNotMatch(optionalSystem, /required once per non-pass turn/i);
});

test("all forum commands use the active meeting override and persist through the round session", async () => {
  const participant = makeParticipant();
  const stateManager = new StateManager({
    id: "forum-meeting",
    participants: [participant],
    weave: [],
    rounds: [],
    current_round: 1,
    max_rounds: 3,
    next_contribution_id: 0,
    status: "weaving",
    state_of_play: "",
  });
  const db = makeForumDb();
  const meetingAgentTools = structuredClone(DEFAULT_CONFIG.agentTools);
  const engine = {
    getStateManager: () => stateManager,
    getDatabase: () => db,
    getMeetingId: () => "forum-meeting",
    getRoundExecutor: () => ({ getEffectiveAgentTools: () => meetingAgentTools }),
  };
  let resolveMeetingCalls = 0;
  const forum = createForumTools({
    config: { getValue: () => ({ ...DEFAULT_CONFIG.agentTools, enabled: false }) },
    resolveMeeting: async () => {
      resolveMeetingCalls++;
      throw new Error("persistent meeting resolution should not be required for an active round session");
    },
    activeLooms: new Map([["forum-meeting", engine]]),
  });
  const context = { sessionID: "forum-session" };

  const created = JSON.parse((await forum.loom_forum_create_topic.execute({
    title: "Async architecture thread",
    body: "Explore this sub-problem separately.",
    tags: ["architecture"],
  }, context)).output);
  assert.equal(created.topic_id, 1);
  assert.equal(db.topics.length, 1);
  assert.equal(resolveMeetingCalls, 0);

  const duplicate = JSON.parse((await forum.loom_forum_create_topic.execute({
    title: " async architecture THREAD ",
    body: "A duplicate should reuse the existing thread.",
  }, context)).output);
  assert.equal(duplicate.topic_id, 1);
  assert.equal(duplicate.reused, true);
  assert.equal(db.topics.length, 1);

  const listed = JSON.parse((await forum.loom_forum_list_topics.execute({ tag: "architecture" }, context)).output);
  assert.equal(listed.count, 1);
  assert.equal(listed.topics[0].title, "Async architecture thread");

  const read = JSON.parse((await forum.loom_forum_read_topic.execute({ topic_id: 1 }, context)).output);
  assert.equal(read.body, "Explore this sub-problem separately.");

  const commented = JSON.parse((await forum.loom_forum_add_comment.execute({
    topic_id: 1,
    body: "Follow-up comment.",
  }, context)).output);
  assert.equal(commented.comment_id, 1);
  assert.equal(db.getForumTopic(1).comments.length, 1);
});

test("forum tools reject a meeting-specific disable even when global config enables them", async () => {
  const participant = makeParticipant();
  const stateManager = new StateManager({
    id: "forum-disabled",
    participants: [participant],
    weave: [],
    rounds: [],
    current_round: 1,
    max_rounds: 2,
    next_contribution_id: 0,
    status: "weaving",
    state_of_play: "",
  });
  const db = makeForumDb();
  const disabled = structuredClone(DEFAULT_CONFIG.agentTools);
  disabled.loom.loom_forum = false;
  const engine = {
    getStateManager: () => stateManager,
    getDatabase: () => db,
    getMeetingId: () => "forum-disabled",
    getRoundExecutor: () => ({ getEffectiveAgentTools: () => disabled }),
  };
  const forum = createForumTools({
    config: { getValue: () => DEFAULT_CONFIG.agentTools },
    resolveMeeting: async () => ({ meetingId: "forum-disabled" }),
    activeLooms: new Map([["forum-disabled", engine]]),
  });

  const result = await forum.loom_forum_create_topic.execute({ title: "Blocked", body: "Blocked" }, { sessionID: "forum-session" });
  assert.equal(result.metadata.error, true);
  assert.equal(db.topics.length, 0);
});

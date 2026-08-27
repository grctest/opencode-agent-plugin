import { tool } from "@opencode-ai/plugin";
import { MeetingDatabase } from "../../database.js";
import { VectorIndex } from "../../services/vector-index.js";

export function createVectorSearchTool({ config, resolveMeeting }) {
  return tool({
    description:
      "Semantic search against prior deliberation context. " +
      "Find exact wording of earlier disagreements, review a specific participant's past contributions, or dig into a sub-topic.",
    args: {
      query: tool.schema
        .string()
        .describe("Search query text for vector similarity search"),
      top_k: tool.schema
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Maximum results (default 5, max 20)"),
      exclude_round: tool.schema
        .number()
        .int()
        .optional()
        .describe("Exclude chunks from this round"),
    },
    async execute(args, context) {
      const agentToolsConfig = config.getValue("agentTools");
      if (!agentToolsConfig?.enabled || !agentToolsConfig?.loom?.loom_vector_search) {
        return { output: JSON.stringify({ error: "Vector search is not enabled in configuration" }), metadata: { error: true }, title: "loom_vector_search error" };
      }
      if (!context?.sessionID) return { output: JSON.stringify({ error: "loom_vector_search: session context unavailable" }), metadata: { error: true }, title: "loom_vector_search error" };

      const meetingInfo = await resolveMeeting(context.sessionID);
      if (!meetingInfo) {
        return { output: JSON.stringify({ error: "Could not resolve meeting for this session" }), metadata: { error: true }, title: "loom_vector_search error" };
      }

      const db = await MeetingDatabase.create(meetingInfo.dbPath, meetingInfo.meetingId);
      const vectorIndex = new VectorIndex(db);

      try {
        const topK = Math.min(args.top_k || 5, 20);
        const results = await vectorIndex.retrieveRelevant(args.query, topK, args.exclude_round);

        const formattedResults = results.map((r) => ({
          round: r.round,
          source: r.source,
          distance: r.distance,
          content: r.content,
          participation_tags: [],
        }));

        const payload = { results: formattedResults, truncated: false };
        return { output: JSON.stringify(payload), metadata: { count: formattedResults.length, truncated: false }, title: `loom_vector_search:${formattedResults.length} results` };
      } finally {
        db.close();
      }
    },
  });
}

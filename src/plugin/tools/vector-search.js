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
        return { error: "Vector search is not enabled in configuration" };
      }
      if (!context?.sessionID) return { error: "loom_vector_search: session context unavailable" };

      const meetingInfo = await resolveMeeting(context.sessionID);
      if (!meetingInfo) {
        return { error: "Could not resolve meeting for this session" };
      }

      const db = await MeetingDatabase.create(meetingInfo.dbPath, meetingInfo.meetingId);
      const vectorIndex = new VectorIndex(db);

      try {
        const topK = Math.min(args.top_k || 5, 10);
        const results = await vectorIndex.retrieveRelevant(args.query, topK, args.exclude_round);

        const formattedResults = results.map((r) => ({
          round: r.round,
          source: r.source,
          distance: r.distance,
          content: r.content,
          participation_tags: [],
        }));

        return { results: formattedResults, truncated: false };
      } finally {
        db.close();
      }
    },
  });
}

import { getDatabasesBySessionId, deleteMeetingFiles, deleteMeetingsBySessionId } from "../database.js";

export const PROGRESS_PATTERN =
  /^\[(?:info|warn|error)\] (?:🎬|⚠️|ℹ️|📋|🔄|⏭️|✅|🛑|⏱️|💰|🧵|.*is thinking\.\.\.|Round \d+|Synthesizing|Completed|Error:)/;

const TOOL_REQUIRED_OVERRIDES = {
  loom_viz: [],
  loom_debug: ["loom_id"],
  loom_forum_create_topic: ["title", "body"],
  loom_forum_list_topics: [],
  loom_forum_read_topic: ["topic_id"],
  loom_forum_add_comment: ["topic_id", "body"],
  loom_state_patch: [], // all fields optional; at-least-one enforced by Zod refine at execute time
  // loom_query, loom_evidence, loom_vote, loom_summon, loom_request_next, loom_status, loom_cancel etc. already correct
};

export function createEventHandlers({ directory, activeLooms = null }) {
  return {
    "tool.definition": async (input, output) => {
      const override = TOOL_REQUIRED_OVERRIDES[input.toolID];
      if (override !== undefined && output.jsonSchema && typeof output.jsonSchema === "object") {
        // Ensure required is exactly the override (optional fields not required)
        // Create new object to ensure registry detects change
        output.jsonSchema = { ...output.jsonSchema, required: override };
      }
    },
event: async ({ event }) => {
      if (event.type === "session.deleted") {
        const deletedId = event.properties?.info?.id;
        if (deletedId) {
           const entries = getDatabasesBySessionId(deletedId);
            if (activeLooms) {
              const matching = [...activeLooms.entries()].filter(([meetingId, engine]) => engine && entries.some((entry) => entry.meetingId === meetingId));
              await Promise.all(matching.map(async ([, engine]) => {
                try { engine.cancel(); } catch {}
                try { await engine.close?.(); } catch {}
              }));
            }
           for (const { dbPath } of entries) {
            deleteMeetingFiles(dbPath);
          }
          await deleteMeetingsBySessionId(directory, deletedId);
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      // Dashboard-first: deliberation output stays in the dashboard (Timeline /
      // Output tabs) and the per-meeting .md report file. Nothing is relayed
      // to chat.
      return;
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      output.messages = output.messages.filter((msg) => {
        if (msg.info.role !== "user") return true;
        const text = msg.parts
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("");
        return !PROGRESS_PATTERN.test(text);
      });
    },
  };
}

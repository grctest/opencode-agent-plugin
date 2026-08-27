import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDatabasesBySessionId, deleteMeetingFiles, deleteMeetingsBySessionId } from "../database.js";
import { resolveLoomBaseDir } from "../paths.js";

export const PROGRESS_PATTERN =
  /^🎬|^⚠️|^ℹ️|is thinking\.\.\.|— synthesize:|— critique:|Round \d+ (complete|starting)|Synthesizing final output|✅ Completed|❌ Error:/;

const TOOL_REQUIRED_OVERRIDES = {
  knit: ["question"],
  loom_viz: [],
  loom_debug: ["loom_id"],
  loom_vector_search: ["query"],
  // loom_query, loom_evidence, loom_vote, loom_summon, loom_request_next, loom_status, loom_cancel etc. already correct
};

export function createEventHandlers({ directory }) {
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
          for (const { dbPath } of entries) {
            deleteMeetingFiles(dbPath);
          }
          await deleteMeetingsBySessionId(directory, deletedId);
        }
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool !== "knit") return;

      const meetingId = output.metadata?.meeting_id;
      if (!meetingId) return;

      if (output.metadata?.loom_status === "error") return;

      try {
        const baseDir = resolveLoomBaseDir(directory);
        const filePath = join(baseDir, "meetings", `${meetingId}.md`);
        const fullReport = readFileSync(filePath, "utf-8");

        output.output =
          "Relay the following deliberation output to the user exactly as written. " +
          "Do not summarize, abbreviate, or reformat it. " +
          "Output the full content below as your response.\n\n" +
          fullReport;
      } catch (err) {
        // If file read fails, leave the original output unchanged
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      output.system.push(
        "When a loom/knit tool completes, its output contains the full deliberation report. " +
        "Relay the complete output to the user as your response. " +
        "Do not summarize, reformat, or abbreviate the tool output — present it as-is.",
      );
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

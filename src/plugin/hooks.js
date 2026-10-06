import { getDatabasesBySessionId, deleteMeetingFiles, deleteMeetingsBySessionId } from "../database.js";
import { auditLoomTool } from "./tools/audit.js";
import { resolveCaller } from "./tools/shared.js";

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
  // loom_query, loom_evidence, loom_vote, loom_summon, loom_status, loom_cancel etc. already correct
};

export function createEventHandlers({ directory, activeLooms = null, resolveMeeting = null }) {
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
      // Intercept tool executions in Loom sessions and record them in tool_audit.
      // This is the execution-layer safety net for built-in tools (websearch,
      // webfetch, read, glob, grep, bash, write, edit, patch, lsp): their ToolParts
      // are captured by extractAgentResponse, but a partial/failed provider response
      // can drop them. The audit row survives regardless and is merged into the
      // Tool use tab by mergeAuditsIntoContributions (queries.js), which dedups
      // against ToolPart-captured calls so each call appears exactly once.
      // loom_* tools are skipped — their execute functions already audit via
      // auditLoomTool with richer context.
      try {
        if (!resolveMeeting || !input?.sessionID || !input?.tool) return;
        const toolName = input.tool;
        if (toolName.startsWith("loom_")) return;
        const meeting = await resolveMeeting(input.sessionID);
        if (!meeting) return;
        const engine = activeLooms?.get(meeting.meetingId);
        if (!engine) return;
        const stateManager = engine.getStateManager?.();
        const db = engine.getDatabase?.();
        if (!stateManager || !db) return;
        const participants = stateManager.getParticipants?.() ?? [];
        const weave = stateManager.getWeave?.() ?? [];
        const caller = resolveCaller(participants, weave, input.sessionID);
        if (!caller) return;
        const outputStr = typeof output?.output === "string"
          ? output.output
          : (output?.output != null ? JSON.stringify(output.output) : "");
        auditLoomTool({
          db,
          stateManager,
          caller,
          meetingId: meeting.meetingId,
          tool: toolName,
          input: input.args,
          output: outputStr,
          status: "completed",
          title: output?.title ?? null,
        });
      } catch (err) {
        try { console.warn(`[loom] tool.execute.after audit failed for ${input?.tool}: ${err?.message ?? err}`); } catch {}
      }
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

import { tool } from "@opencode-ai/plugin";
import { MeetingOrchestrator } from "./orchestrator.js";
import { composeRoom, formatRoomPreview } from "./composer.js";
import { isAgentSessionClient } from "./client-types.js";
import { deleteMeetingFiles, findMeetingBySessionId, getDbPathForMeeting } from "./database.js";
import { startDashboard } from "./dashboard/server.js";
import { createKnitHandler } from "./handlers/knit-handler.js";
import { join } from "node:path";

export const Loom = async (input) => {
  const { client, directory } = input;

  if (!isAgentSessionClient(client)) {
    throw new Error("Loom plugin requires a compatible opencode client with session.create, session.prompt, session.message, and provider API access.");
  }

  const activeLooms = new Map();
  const sessionDatabases = new Map();
  let activeDashboard = null;

  const { handleKnit, handleKnitModels } = createKnitHandler(client, directory);

  return {
    tool: {
      knit: tool({
        description:
          "Start a multi-agent deliberation session (a 'Loom'). " +
          "ONLY invoke when the user explicitly types /knit followed by a question. " +
          "Do NOT invoke for general questions, discussions, or information requests.",
        args: {
          question: tool.schema
            .string()
            .describe("The question or task for the agents to deliberate on"),
          context: tool.schema
            .string()
            .optional()
            .describe(
              "Additional context, background files, or constraints the agents should consider",
            ),
          participants: tool.schema
            .array(
              tool.schema.object({
                name: tool.schema.string().describe("Display name for this participant"),
                persona: tool.schema
                  .string()
                  .describe("Who this agent is — their role and personality"),
                agenda: tool.schema
                  .string()
                  .describe(
                    "What this agent wants to achieve in the deliberation",
                  ),
                tier: tool.schema
                  .string()
                  .describe(
                    "Role name (e.g. junior, mid, senior, principal). Determines behavior and rights.",
                  ),
              }),
            )
            .optional()
            .describe(
              "Custom participant list. If omitted, auto-composed from the question.",
            ),
          max_rounds: tool.schema
            .number()
            .int()
            .min(1)
            .max(10)
            .optional()
            .describe(
              "Maximum deliberation rounds (default: 3)",
            ),
          dry_run: tool.schema
            .boolean()
            .optional()
            .describe(
              "If true, return the composed room without running deliberation",
            ),
          convergence: tool.schema
            .enum(["consensus", "majority", "moderator_forces"])
            .optional()
            .describe(
              "How the deliberation decides to end. Default: moderator_forces",
            ),
          models: tool.schema
            .array(
              tool.schema.object({
                tier: tool.schema.enum(["junior", "mid", "senior", "principal"]),
                provider_id: tool.schema.string().describe("Provider ID for this tier"),
                model_id: tool.schema.string().describe("Model ID for this tier"),
              }),
            )
            .optional()
            .describe(
              "Model assignments per tier. Use knit_models to discover available options.",
            ),
          allow_interjections: tool.schema
            .boolean()
            .optional()
            .describe("Allow agents to interject during others' turns. Default: true"),
          meeting_timeout: tool.schema
            .number()
            .int()
            .min(60000)
            .max(1800000)
            .optional()
            .describe("Maximum meeting duration in ms. Default: 900000 (15 min)"),
        },
        execute: handleKnit,
      }),

      loom_status: tool({
        description:
          "Check the status of a running Loom deliberation session. " +
          "Internal tool for agents to monitor progress. Not a user command.",
        args: {
          loom_id: tool.schema.string().describe("The ID of the Loom session to check"),
        },
        execute: async (args, _context) => {
          const engine = activeLooms.get(args.loom_id);
          if (!engine) {
            return "No active Loom found with that ID.";
          }
          const state = engine.getState();
          return `**Loom Status:** ${state.status}\n**Round:** ${state.current_round}/${state.max_rounds}\n**Contributions:** ${state.weft.length}\n**Meeting ID:** ${engine.getMeetingId()}`;
        },
      }),

      loom_cancel: tool({
        description: "Cancel a running Loom deliberation session.",
        args: {
          loom_id: tool.schema.string().describe("The ID of the Loom session to cancel"),
        },
        execute: async (args, _context) => {
          const engine = activeLooms.get(args.loom_id);
          if (!engine) {
            return "No active Loom found with that ID.";
          }
          engine.cancel();
          return "Loom cancellation requested. The current round will complete, then synthesis will run.";
        },
      }),

      loom_viz: tool({
        description:
          "Start the Loom deliberation dashboard server. " +
          "Provides a web UI to visualize deliberation progress in real-time. " +
          "The dashboard watches for new meetings and auto-switches to the most recent one.",
        args: {
          port: tool
            .schema
            .number()
            .int()
            .min(1024)
            .max(65535)
            .optional()
            .describe("Port number for the dashboard server. Default: 3210"),
        },
        execute: async (args, context) => {
          const port = args.port ?? 3210;

          if (activeDashboard) {
            return [
              "Dashboard already running!",
              `Open: http://localhost:${activeDashboard.port}`,
              "Run /loom_stop to stop the current dashboard first.",
            ].join("\n");
          }

          try {
            const dashboard = startDashboard(directory, port);
            activeDashboard = dashboard;
            return [
              "Dashboard started!",
              "",
              "Open in browser:",
              `http://localhost:${dashboard.port}`,
              "",
              "The dashboard auto-detects new meetings and refreshes in real-time.",
              "Run /loom_stop when done to free the port.",
            ].join("\n");
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `Failed to start dashboard: ${message}`;
          }
        },
      }),

      loom_stop: tool({
        description: "Stop the running Loom dashboard server and free the port.",
        args: {},
        execute: async () => {
          if (!activeDashboard) {
            return "No dashboard is currently running.";
          }
          const port = activeDashboard.port;
          activeDashboard.stop();
          activeDashboard = null;
          return `Dashboard stopped (was running on port ${port}).`;
        },
      }),

      knit_models: tool({
        description: "Discover available models in your opencode session and propose tier assignments.",
        args: {},
        execute: async () => {
          return handleKnitModels();
        },
      }),
    },
    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        const deletedId = event.properties?.info?.id;
        if (deletedId && sessionDatabases.has(deletedId)) {
          const dbPaths = sessionDatabases.get(deletedId);
          for (const dbPath of dbPaths) {
            deleteMeetingFiles(dbPath);
          }
          sessionDatabases.delete(deletedId);
        }
      }
    },
  };
};

export { MeetingOrchestrator } from "./orchestrator.js";
export { composeRoom, formatRoomPreview } from "./composer.js";
export {
  getTierConfig,
  splitModel,
  can,
  getPromptForTier,
  getRightsForTier,
} from "./tiers.js";

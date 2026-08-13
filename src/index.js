import { tool } from "@opencode-ai/plugin";
import { isAgentSessionClient } from "./client-types.js";
import { deleteMeetingFiles, deleteMeetingsBySessionId, findMeetingBySessionId, getDbPathForMeeting, getDatabasesBySessionId, loadSessionIndex } from "./database.js";
import { startDashboard } from "./dashboard/server.js";
import { createKnitHandler } from "./handlers/knit-handler.js";
import { createConfig, getConfigSource } from "./config.js";
import { Logger } from "./logger.js";
import { setDefaultConfigDirectory } from "./config.js";

export const Loom = async (input) => {
  const { client, directory } = input;

  if (!isAgentSessionClient(client)) {
    throw new Error("Loom plugin requires a compatible opencode client with session.create, session.prompt, session.message, and provider API access.");
  }

  setDefaultConfigDirectory(directory);
  const config = createConfig(directory);
  loadSessionIndex(directory);
  const logger = new Logger();

  const configSource = getConfigSource();
  logger.info(
    "config",
    configSource
      ? `Loom config loaded from ${configSource}`
      : "No Loom config file found — using defaults",
  );

  const warnings = config.getWarnings();
  for (const warning of warnings) {
    logger.warn("config_validation", warning);
  }

  const activeLooms = new Map();
  let activeDashboard = null;

  const { handleKnit, handleKnitModels } = createKnitHandler(client, directory, activeLooms);

  return {
    tool: {
      knit: tool({
        description:
          "Start a multi-agent deliberation session (a 'Loom'). " +
          "ONLY invoke when the user explicitly types /knit followed by a question. " +
          "Do NOT invoke for general questions, discussions, or information requests. " +
          "Run the deliberation directly — do NOT call with dry_run first unless the user explicitly asks for a preview.",
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
              "Only set true if the user explicitly asked to preview the room before deliberating. Default: false — run directly.",
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
          seed: tool.schema
            .number()
            .int()
            .optional()
            .describe("Random seed for room composition. Use the same seed to reproduce a room, or omit for variety."),
          fresh: tool.schema
            .boolean()
            .optional()
            .describe("Force a fresh loom even if a previous meeting exists. Default: false"),
          turn_mode: tool.schema
            .string()
            .optional()
            .describe("Turn mode for agent coordination: sequential (default), staged (2-at-a-time batched), or parallel (all concurrently)."),
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

      loom_debug: tool({
        description: "Inspect internal state of a running or completed loom for debugging.",
        args: {
          loom_id: tool.schema.string().describe("The ID of the Loom session to inspect"),
          include: tool.schema
            .array(tool.schema.enum(['state', 'participants', 'contributions', 'rounds', 'warp', 'orchestratorMessages']))
            .optional()
            .describe("Which parts of the loom state to include (default: all)"),
        },
        execute: async (args, _context) => {
          const engine = activeLooms.get(args.loom_id);
          if (!engine) {
            return "No active Loom found with that ID. For completed looms, use the dashboard export feature.";
          }
          
          const state = engine.getState();
          const include = args.include || ['state', 'participants', 'contributions', 'rounds', 'warp', 'orchestratorMessages'];
          
          const result = {};
          if (include.includes('state')) {
            result.status = state.status;
            result.round = state.current_round;
            result.maxRounds = state.max_rounds;
            result.convergenceMode = state.convergence_mode;
            result.domain = state.domain;
            result.question = state.question;
            result.context = state.context;
          }
          if (include.includes('participants')) {
            result.participants = state.participants.map(p => ({
              id: p.config.id,
              name: p.config.name,
              tier: p.config.tier,
              status: p.status,
              contributions: p.contributions_count,
              reflections: p.reflections?.length ?? 0,
              model: p.config.model ? `${p.config.model.providerID}/${p.config.model.modelID}` : 'unassigned',
            }));
          }
          if (include.includes('contributions')) {
            result.contributions = state.weft.map(c => ({
              id: c.id,
              round: c.round,
              participantId: c.participant_id,
              type: c.type,
              contentPreview: c.content.slice(0, 200),
              timestamp: new Date(c.timestamp).toISOString(),
            }));
          }
          if (include.includes('rounds')) {
            result.rounds = state.rounds.map(r => ({
              number: r.number,
              contributionCount: r.contributions.length,
              interjectionCount: r.interjections.length,
              summary: r.summary,
            }));
          }
          if (include.includes('warp')) {
            result.warp = state.warp;
          }
          if (include.includes('orchestratorMessages')) {
            result.orchestratorMessages = engine.getOrchestratorMessages().map(m => ({
              type: m.type,
              role: m.role,
              contentPreview: m.content.slice(0, 500),
              timestamp: new Date(m.timestamp).toISOString(),
            }));
          }
          
          return JSON.stringify(result, null, 2);
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
        if (deletedId) {
          const entries = getDatabasesBySessionId(deletedId);
          for (const { dbPath } of entries) {
            deleteMeetingFiles(dbPath);
          }
          await deleteMeetingsBySessionId(directory, deletedId);
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
} from "./shared.js";

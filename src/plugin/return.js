import { tool } from "@opencode-ai/plugin";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getMeetingDbPath } from "../paths.js";
import { DashboardApi } from "../dashboard/api.js";
import { getDatabasesBySessionId, deleteMeetingFiles, deleteMeetingsBySessionId, findMeetingBySessionId } from "../database.js";
import { resolveLoomBaseDir } from "../paths.js";
import { createConfig } from "../config.js";
import { startDashboard } from "../dashboard/server.js";
import { createEventHandlers } from "./hooks.js";

const PROGRESS_PATTERN =
  /^🎬|^⚠️|^ℹ️|is thinking\.\.\.|— synthesize:|— critique:|Round \d+ (complete|starting)|Synthesizing final output|✅ Completed|❌ Error:/;

export function createPluginReturn({ activeLooms, activeDashboardRef, directory, config, handleKnit, handleListKnitModels, handleEnableKnitModels, handleDisableKnitModels, handleResetKnitModels, agentTools }) {
  return {
    tool: {
      ...agentTools,
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
              "Model assignments per tier. Use list_knit_models to discover available options.",
            ),
          meeting_timeout: tool.schema
            .number()
            .int()
            .min(60000)
            .max(1800000)
            .optional()
            .describe("Maximum meeting duration in ms. Default: 900000 (15 min)"),
          fresh: tool.schema
            .boolean()
            .optional()
            .describe("Force a fresh loom even if a previous meeting exists. Default: false"),
        },
        execute: handleKnit,
      }),

      loom_status: tool({
        description:
          "Check the status of a running Loom deliberation session. " +
          "Internal tool for agents to monitor progress. Not a user command.",
        args: {
          loom_id: tool.schema.string().describe("The ID of the Loom session to check (loom_id or meeting_id, both work)"),
        },
        execute: async (args, _context) => {
          const engine = activeLooms.get(args.loom_id);
          if (engine) {
            const state = engine.getState();
            return `**Loom Status:** ${state.status}\n**Round:** ${state.current_round}/${state.max_rounds}\n**Contributions:** ${state.weave.length}\n**Meeting ID:** ${engine.getMeetingId()}`;
          }
          // Fallback: completed loom — try DB by meetingId
          try {
                        const dbPath = getMeetingDbPath(directory, args.loom_id);
            if (dbPath && existsSync(dbPath)) {
                            const api = DashboardApi.get(dbPath);
              const state = api.getState();
              if (state) {
                return `**Loom Status (completed):** ${state.status}\n**Round:** ${state.round}/${state.max_rounds}\n**Meeting ID:** ${args.loom_id} (from DB)`;
              }
            }
          } catch {}
          return "No active Loom found with that ID.";
        },
      }),

      loom_cancel: tool({
        description: "Cancel a running Loom deliberation session.",
        args: {
          loom_id: tool.schema.string().describe("The ID of the Loom session to cancel (loom_id or meeting_id)"),
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

          // Resolve current session's meeting so the dashboard opens to the right place
          let initialMeetingId = null;
          const sessionId = context?.sessionID;
          if (sessionId) {
            try {
              const current = await findMeetingBySessionId(directory, sessionId);
              if (current) initialMeetingId = current.meetingId;
            } catch {}
          }

          const buildUrl = (base) => {
            if (initialMeetingId) return `${base}?meeting=${initialMeetingId}`;
            if (sessionId) return `${base}?session=${sessionId}`;
            return base;
          };

          if (activeDashboardRef.current) {
            const base = `http://localhost:${activeDashboardRef.current.port}`;
            const url = buildUrl(base);
            return [
              "Dashboard already running!",
              `Open: ${url}`,
              "Run /loom_stop to stop the current dashboard first.",
            ].join("\n");
          }

          try {
            const dashboard = startDashboard(directory, port);
            activeDashboardRef.current = dashboard;
            const base = `http://localhost:${dashboard.port}`;
            const url = buildUrl(base);
            return [
              "Dashboard started!",
              "",
              "Open in browser:",
              url,
              "",
              initialMeetingId
                ? "Showing your current session's deliberation."
                : sessionId
                  ? "No deliberation yet for this session — run /knit to start one."
                  : "Dashboard will show the most recent meeting if available.",
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
          if (!activeDashboardRef.current) {
            return "No dashboard is currently running.";
          }
          const port = activeDashboardRef.current.port;
          activeDashboardRef.current.stop();
          activeDashboardRef.current = null;
          return `Dashboard stopped (was running on port ${port}).`;
        },
      }),

      loom_debug: tool({
        description: "Inspect internal state of a running or completed loom for debugging.",
        args: {
          loom_id: tool.schema.string().describe("The ID of the Loom session to inspect (loom_id or meeting_id)"),
          include: tool.schema
            .array(tool.schema.enum(['state', 'participants', 'contributions', 'rounds', 'fabric', 'orchestratorMessages', 'config']))
            .optional()
            .describe("Which parts of the loom state to include (default: all — include 'config' for resolved config + warnings)"),
        },
        execute: async (args, _context) => {
          const include = args.include || ['state', 'participants', 'contributions', 'rounds', 'fabric', 'orchestratorMessages'];
          const engine = activeLooms.get(args.loom_id);
          if (engine) {
            const state = engine.getState();
            const result = {};
            if (include.includes('state')) {
              result.status = state.status;
              result.round = state.current_round;
              result.maxRounds = state.max_rounds;
              result.tags = state.tags;
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
                has_reflection: !!p.reflection,
                model: p.config.model ? `${p.config.model.providerID}/${p.config.model.modelID}` : 'unassigned',
              }));
            }
            if (include.includes('contributions')) {
              result.contributions = state.weave.map(c => ({
                id: c.id,
                round: c.round,
                participantId: c.participant_id,
                type: c.type,
                contentPreview: c.content.slice(0, 2000),
                tool_calls: c.tool_calls ?? null,
                prompt_context_hash: c.prompt_context ? String(JSON.stringify(c.prompt_context).length) : null,
                timestamp: new Date(c.created_at ?? c.timestamp).toISOString(),
              }));
            }
            if (include.includes('rounds')) {
              result.rounds = state.rounds.map(r => ({
                number: r.number,
                contributionCount: r.contributions.length,
                turnRequestCount: r.turn_requests.length,
                summary: r.summary,
              }));
            }
            if (include.includes('fabric')) {
              result.fabric = state.fabric;
            }
            if (include.includes('orchestratorMessages')) {
              result.orchestratorMessages = engine.getOrchestratorMessages().map(m => ({
                type: m.type,
                role: m.role,
                contentPreview: m.content.slice(0, 2000),
                timestamp: new Date(m.timestamp).toISOString(),
              }));
            }
            if (include.includes('config')) {
              try {
                const cfg = config.get();
                const warnings = config.getWarnings();
                const source = config.getSource();
                result.config = { values: cfg, warnings, source, dormantNote: "maxTurnRequestsPerRound was removed from the schema (never enforced — ordering is planTurnOrder)" };
              } catch {}
            }
            return JSON.stringify(result, null, 2);
          }
          // Fallback: completed loom — load from DB via DashboardApi
          try {
                        const dbPath = getMeetingDbPath(directory, args.loom_id);
            if (dbPath && existsSync(dbPath)) {
                            const api = DashboardApi.get(dbPath);
              const state = api.getState();
              const participants = api.getParticipants();
              const contributions = api.getContributions(500, 0);
              const rounds = state ? [{ number: state.round, contributions, turn_requests: api.getTurnRequests(), summary: "" }] : [];
              const orchestratorMessages = api.getOrchestratorMessages(args.loom_id);
              const result = {};
              if (include.includes('state') && state) {
                result.status = state.status;
                result.round = state.round;
                result.maxRounds = state.max_rounds;
                result.question = state.question;
                result.context = state.context;
              }
              if (include.includes('participants')) {
                result.participants = participants.map(p => ({
                  id: p.id,
                  name: p.name,
                  tier: p.tier,
                  status: p.status,
                  contributions: 0,
                  has_reflection: !!p.reflection,
                  model: p.provider_id && p.model_id ? `${p.provider_id}/${p.model_id}` : 'unassigned',
                }));
              }
              if (include.includes('contributions')) {
                result.contributions = contributions.map(c => ({
                  id: c.id,
                  round: c.round,
                  participantId: c.participant_id,
                  type: c.type,
                  contentPreview: c.content.slice(0, 2000),
                  tool_calls: c.tool_calls ?? null,
                  prompt_context_hash: c.prompt_context ? String(JSON.stringify(c.prompt_context).length) : null,
                  created_at: c.created_at,
                }));
              }
              if (include.includes('rounds')) {
                result.rounds = rounds;
              }
              if (include.includes('fabric') && state) {
                result.fabric = state.fabric;
              }
              if (include.includes('orchestratorMessages')) {
                result.orchestratorMessages = orchestratorMessages.map(m => ({
                  type: m.type,
                  role: m.role,
                  contentPreview: m.content.slice(0, 2000),
                  timestamp: new Date(m.created_at).toISOString(),
                }));
              }
              if (include.includes('config')) {
                try {
                                    const cfgInst = createConfig(directory);
                  result.config = { values: cfgInst.get(), warnings: cfgInst.getWarnings(), source: cfgInst.getSource(), dormantNote: "maxTurnRequestsPerRound was removed from the schema (never enforced — ordering is planTurnOrder)" };
                } catch {}
              }
              result._source = "db-fallback";
              return JSON.stringify(result, null, 2);
            }
          } catch (e) {
            return `No active Loom found with that ID. DB fallback failed: ${e.message}`;
          }
          return "No active Loom found with that ID. For completed looms, use the dashboard export feature.";
        },
      }),

      list_knit_models: tool({
        description: "List all discovered models with their exact identifiers, cost, context window, reasoning capability, current enabled/disabled status, and proposed tier assignments.",
        args: {},
        execute: async () => {
          return handleListKnitModels();
        },
      }),

      enable_knit_models: tool({
        description: "Enable specific models for Loom agents. Provide exact 'provider/model' identifiers as shown in list_knit_models output.",
        args: {
          models: tool.schema
            .array(tool.schema.string())
            .describe("Exact 'provider/model' identifiers to enable (e.g. 'openai/gpt-4.1')"),
        },
        execute: async (args) => {
          return handleEnableKnitModels(args);
        },
      }),

      disable_knit_models: tool({
        description: "Disable specific models for Loom agents. Provide exact 'provider/model' identifiers as shown in list_knit_models output.",
        args: {
          models: tool.schema
            .array(tool.schema.string())
            .describe("Exact 'provider/model' identifiers to disable (e.g. 'openai/gpt-4.1')"),
        },
        execute: async (args) => {
          return handleDisableKnitModels(args);
        },
      }),

      reset_knit_models: tool({
        description: "Reset the model filter to default — all discovered models become available for Loom agents.",
        args: {},
        execute: async () => {
          return handleResetKnitModels();
        },
      }),


    },
    ...createEventHandlers({ directory }),
  };
}

export { PROGRESS_PATTERN };

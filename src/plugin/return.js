import { tool } from "@opencode-ai/plugin";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getMeetingDbPath } from "../paths.js";
import { DashboardApi } from "../dashboard/api.js";
import { getDatabasesBySessionId, deleteMeetingFiles, deleteMeetingsBySessionId, findMeetingBySessionId } from "../database.js";
import { resolveLoomBaseDir } from "../paths.js";
import { isBashCommandAllowed, getBashCommand } from "../utils/sanitize.js";
import { createConfig } from "../config.js";
import { startDashboard } from "../dashboard/server.js";
import { createEventHandlers, PROGRESS_PATTERN } from "./hooks.js";
export { PROGRESS_PATTERN };

export function createPluginReturn({ activeLooms, activeDashboardRef, directory, config, agentToolRegistry, client = null, resolveMeeting = null }) {
  return {
    dispose: async () => {
      const engines = [...activeLooms.values()];
      await Promise.all(engines.map(async (engine) => {
        try { engine.cancel(); } catch {}
        try { await engine.close?.(); } catch {}
      }));
      try { activeDashboardRef.current?.stop(); } catch {}
      activeDashboardRef.current = null;
    },
    "tool.execute.before": async (input, output) => {
      if (!resolveMeeting || !input?.sessionID) return;
      let meeting = null;
      try { meeting = await resolveMeeting(input.sessionID); } catch { return; }
      if (!meeting) return;
      const engine = activeLooms.get(meeting.meetingId);
      const stateManager = engine?.getStateManager?.();
      const activeTurn = stateManager?.getActiveTurn?.();
      const effectiveAgentTools = engine?.getRoundExecutor?.()?.getEffectiveAgentTools?.() ?? config.getValue("agentTools");
      if (activeTurn) {
        const maxCalls = Math.max(1, Number(effectiveAgentTools?.maxToolCallsPerTurn) || 12);
        if (stateManager.getTurnToolCount() >= maxCalls) {
          throw new Error(`Loom tool-call limit reached (${maxCalls})`);
        }
        stateManager.recordTurnTool();
      }
      if (input.tool !== "bash") return;
      const cfg = effectiveAgentTools;
      const bash = cfg?.builtIn?.bash;
      if (!bash?.enabled) throw new Error("Bash is disabled for Loom deliberations");
      const command = getBashCommand(output?.args);
      if (!isBashCommandAllowed(command, bash.allowlist)) {
        throw new Error(`Bash command blocked by Loom policy: ${String(command ?? "missing command").slice(0, 160)}`);
      }
    },
    tool: {
      ...agentToolRegistry,
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
          "The dashboard is the sole control plane: compose and approve the room, " +
          "select models, start/cancel/extend deliberations, and read the final output. " +
          "Nothing is returned to chat — everything happens in the dashboard.",
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
          // Defensive casing: opencode versions differ on sessionID vs sessionId/session_id
          let initialMeetingId = null;
          const sessionId = context?.sessionID ?? context?.sessionId ?? context?.session_id ?? null;
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
            const dashboard = startDashboard(directory, port, {
              client,
              directory,
              activeLooms,
              ownerSessionId: sessionId,
            });
            activeDashboardRef.current = dashboard;
            const base = `http://localhost:${dashboard.port}`;
            const url = buildUrl(base);
            return [
              "Dashboard started!",
              "",
              "Open in browser:",
              url,
              "",
              "Use the Setup tab to preview the room, approve personas and models, then start the deliberation.",
              "All output stays in the dashboard (Timeline / Output tabs).",
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
          const dashboard = activeDashboardRef.current;
          const port = dashboard.port;
          try {
            dashboard.stop();
            return `Dashboard stopped (was running on port ${port}). Active deliberations were not cancelled.`;
          } catch (err) {
            return `Dashboard stop failed: ${err instanceof Error ? err.message : String(err)}`;
          } finally {
            activeDashboardRef.current = null;
          }
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
                timestamp: c.created_at ? new Date(c.created_at).toISOString() : (c.timestamp ? new Date(c.timestamp).toISOString() : new Date().toISOString()),
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
                timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString(),
              }));
            }
            if (include.includes('config')) {
              try {
                const cfg = config.get();
                const warnings = config.getWarnings();
                const source = config.getSource();
                result.config = { values: cfg, warnings, source, dormantNote: "maxTurnRequestsPerRound/maxTurnRequestWords/turnRequestThresholds.autoGrant/agentTools.loom.loom_evidence/agentTools.loom.loom_type removed — ordering is planTurnOrder, primary turns are untyped, loom_query mode evidence covers evidence" };
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
                  result.config = { values: cfgInst.get(), warnings: cfgInst.getWarnings(), source: cfgInst.getSource(), dormantNote: "maxTurnRequestsPerRound/maxTurnRequestWords/turnRequestThresholds.autoGrant/agentTools.loom.loom_evidence/agentTools.loom.loom_type removed — ordering is planTurnOrder, primary turns are untyped" };
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

    },
    ...createEventHandlers({ directory, activeLooms }),
  };
}

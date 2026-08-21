import { tool } from "@opencode-ai/plugin";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { isAgentSessionClient } from "./client-types.js";
import { deleteMeetingFiles, deleteMeetingsBySessionId, findMeetingBySessionId, getDbPathForMeeting, getDatabasesBySessionId, loadSessionIndex, MeetingDatabase } from "./database.js";
import { startDashboard } from "./dashboard/server.js";
import { createKnitHandler } from "./handlers/knit-handler.js";
import { createConfig, getConfigSource, setDefaultConfigDirectory } from "./config.js";
import { Logger } from "./logger.js";
import { VectorIndex } from "./services/vector-index.js";
import { resolveLoomBaseDir } from "./paths.js";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_QUANT } from "./services/model-manager.js";

const PROGRESS_PATTERN =
  /^🎬|^⚠️|^ℹ️|is thinking\.\.\.|— synthesize:|— critique:|Round \d+ (complete|starting)|Synthesizing final output|✅ Completed|❌ Error:/;

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

  // Initialize the real embedding model in the plugin process so every
  // semantic feature (vector search, reflection targeting, room composition)
  // uses real embeddings rather than placeholder noise. This mirrors the
  // dashboard's initEmbeddingModel(), which previously was the only place the
  // model got loaded. Failures are non-fatal: semantic features degrade visibly.
  const { ensureEmbedderInitialized, getEmbeddingDim } = await import("./services/embedding-service.js");
  ensureEmbedderInitialized(DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_QUANT)
    .then(() => {
      logger.info("embedder_initialized", `Embedding model loaded: ${DEFAULT_EMBEDDING_MODEL} (${getEmbeddingDim()}d)`);
    })
    .catch((err) => {
      logger.warn(
        "embedder_init_failed",
        `Failed to initialize embedding model — semantic features (vector search, reflection targeting, room composition) will be unavailable: ${err.message}`,
      );
    });

  const activeLooms = new Map();
  let activeDashboard = null;
  const meetingResolveCache = new Map(); // sessionID -> { meeting, at }
  const RESOLVE_CACHE_TTL_MS = 30000;
  const RESOLVE_CACHE_MAX = 100;

  /**
   * Resolves an ephemeral session ID to its Loom meeting database path.
   * Used by agent tools to find which meeting the current session belongs to.
   * Cached to avoid readdirSync scan per tool call.
   */
  async function resolveMeeting(sessionID) {
    const cached = meetingResolveCache.get(sessionID);
    if (cached && (Date.now() - cached.at) < RESOLVE_CACHE_TTL_MS) {
      return cached.meeting;
    }
    // Rate-limit: if same sessionID requested >10 times/sec, return cached even if expired
    // (simple: if cached exists within 1s, reuse)
    if (cached && (Date.now() - cached.at) < 1000) {
      return cached.meeting;
    }
    // 1. Direct session → meeting lookup via DB index
    const meeting = await findMeetingBySessionId(directory, sessionID);
    if (meeting) {
      if (meetingResolveCache.size >= RESOLVE_CACHE_MAX) {
        const oldest = meetingResolveCache.keys().next().value;
        meetingResolveCache.delete(oldest);
      }
      meetingResolveCache.set(sessionID, { meeting, at: Date.now() });
      return meeting;
    }

    // 2. Fallback: walk up to parent session
    try {
      const sessionResult = await client.session.get({
        path: { id: sessionID },
        query: { directory },
      });
      const parentID = sessionResult?.data?.parentID;
      if (parentID && parentID !== sessionID) {
        const parentMeeting = await findMeetingBySessionId(directory, parentID);
        if (parentMeeting) {
          if (meetingResolveCache.size >= RESOLVE_CACHE_MAX) {
            const oldest = meetingResolveCache.keys().next().value;
            meetingResolveCache.delete(oldest);
          }
          meetingResolveCache.set(sessionID, { meeting: parentMeeting, at: Date.now() });
          return parentMeeting;
        }
      }
    } catch {
      // Session may not exist or API may not support .get()
    }
    return null;
  }

  // Agent tools that are available to deliberation agents during rounds
  const agentTools = {
    loom_vector_search: tool({
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

        // 1. Resolve session → meeting
        const meetingInfo = await resolveMeeting(context.sessionID);
        if (!meetingInfo) {
          return { error: "Could not resolve meeting for this session" };
        }

        // 2. Open DB and vector index
        const db = await MeetingDatabase.create(meetingInfo.dbPath, meetingInfo.meetingId);
        const vectorIndex = new VectorIndex(db);

        try {
          // 3. Execute search
          const topK = Math.min(args.top_k || 5, 10);
          const results = await vectorIndex.retrieveRelevant(args.query, topK, args.exclude_round);

          // Format results with participation tags
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
    }),
    loom_query: tool({
      description:
        "Ask 1-2 peers a focused question. Their answers will be recorded as query_response contributions and visible to the room. Use for clarifying assumptions or asking 'what was said'.",
      args: {
        targets: tool.schema.array(tool.schema.string()).min(1).max(2).describe("Participant IDs to query (max 2, e.g. ['junior_0'])"),
        question: tool.schema.string().min(1).max(500).describe("Your question (1-500 chars)"),
      },
      async execute(args, context) {
        const cfg = config.getValue("agentTools");
        if (!cfg?.enabled || !cfg?.loom?.loom_query) return { error: "loom_query not enabled" };
        if (!args.targets || args.targets.length === 0) return { error: "targets required" };
        // Validation only — actual fan-out is handled by RoundExecutor post-store (or same-turn synthesis).
        // Returning here makes the call auditable in tool_calls; the orchestrator will create the query_response rows.
        return { queued: true, targets: args.targets, question: args.question, note: "Query dispatched — responses will appear as query_response contributions in this round." };
      },
    }),
    loom_evidence: tool({
      description:
        "Request evidence from 1-2 peers. They MUST use a research tool (websearch/webfetch/read/loom_vector_search) and report Finding + Source + Strength.",
      args: {
        targets: tool.schema.array(tool.schema.string()).min(1).max(2).describe("Participant IDs to request evidence from (max 2)"),
        question: tool.schema.string().min(1).max(500).describe("Evidence question (1-500 chars)"),
      },
      async execute(args, context) {
        const cfg = config.getValue("agentTools");
        if (!cfg?.enabled || !cfg?.loom?.loom_evidence) return { error: "loom_evidence not enabled" };
        return { queued: true, targets: args.targets, question: args.question, note: "Evidence request dispatched — responses will be evidence_response contributions with mandatory tool use." };
      },
    }),
    loom_vote: tool({
      description: "Call a vote with a lettered question (e.g. 'A) ... B) ...'). All other active participants will vote.",
      args: {
        question: tool.schema.string().min(1).max(500).describe("Vote question with lettered options, e.g. 'A) yes B) no'"),
      },
      async execute(args, context) {
        const cfg = config.getValue("agentTools");
        if (!cfg?.enabled || !cfg?.loom?.loom_vote) return { error: "loom_vote not enabled" };
        return { queued: true, question: args.question, note: "Vote dispatched — voters will produce vote_response and a tally." };
      },
    }),
    loom_summon: tool({
      description: "Summon a guest expert persona for one additive contribution.",
      args: {
        persona_name: tool.schema.string().min(1).max(100).describe("Persona name to summon (e.g. 'Risk Officer')"),
        issue: tool.schema.string().min(1).max(500).describe("Issue to address (1-500 chars)"),
      },
      async execute(args, context) {
        const cfg = config.getValue("agentTools");
        if (!cfg?.enabled || !cfg?.loom?.loom_summon) return { error: "loom_summon not enabled" };
        return { queued: true, persona_name: args.persona_name, issue: args.issue, note: "Summon dispatched — guest will produce a summoned_response." };
      },
    }),
    loom_request_next: tool({
      description: "Request to speak next round with priority and reason.",
      args: {
        priority: tool.schema.number().int().min(1).max(10).describe("Priority 1-10 (capped by tier)"),
        reason: tool.schema.string().min(1).max(200).describe("Reason for turn request (quoted)"),
      },
      async execute(args, context) {
        const cfg = config.getValue("agentTools");
        if (!cfg?.enabled || !cfg?.loom?.loom_request_next) return { error: "loom_request_next not enabled" };
        return { queued: true, priority: Math.min(10, Math.max(1, args.priority)), reason: args.reason };
      },
    }),
  };

  const markActiveMeetingsAborted = () => {
    for (const [id, engine] of activeLooms) {
      try {
        const state = engine.getState();
        if (state.status !== "converged" && state.status !== "cancelled" &&
            state.status !== "timeout" && state.status !== "max_rounds_reached" &&
            state.status !== "aborted" && state.status !== "deadlocked") {
          engine.cancel();
          logger.warn("process_exit", `Marking meeting ${id} as aborted due to process exit`);
        }
      } catch { /* best effort */ }
    }
  };

  const originalExit = process.exit.bind(process);
  const wrappedExit = (code) => {
    markActiveMeetingsAborted();
    return originalExit(code);
  };

  process.on("exit", () => markActiveMeetingsAborted());
  process.on("SIGINT", () => { markActiveMeetingsAborted(); process.exit(130); });
  process.on("SIGTERM", () => { markActiveMeetingsAborted(); process.exit(143); });
  process.on("uncaughtException", (err) => {
    logger.error("uncaught_exception", "Uncaught exception — aborting active meetings", { message: err.message, stack: err.stack });
    markActiveMeetingsAborted();
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled_rejection", "Unhandled rejection — aborting active meetings", { reason: String(reason) });
    markActiveMeetingsAborted();
    process.exit(1);
  });

  const { handleKnit, handleListKnitModels, handleEnableKnitModels, handleDisableKnitModels, handleResetKnitModels } = createKnitHandler(client, directory, activeLooms, agentTools);

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
            const { getMeetingDbPath } = await import("./paths.js");
            const dbPath = getMeetingDbPath(directory, args.loom_id);
            if (dbPath && existsSync(dbPath)) {
              const { DashboardApi } = await import("./dashboard/api.js");
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
                result.config = { values: cfg, warnings, source, dormantNote: "turnRequestThresholds.autoGrant, maxTurnRequestsPerRound, maxTurnRequestWords are dormant — ordering is planTurnOrder" };
              } catch {}
            }
            return JSON.stringify(result, null, 2);
          }
          // Fallback: completed loom — load from DB via DashboardApi
          try {
            const { getMeetingDbPath } = await import("./paths.js");
            const dbPath = getMeetingDbPath(directory, args.loom_id);
            if (dbPath && existsSync(dbPath)) {
              const { DashboardApi } = await import("./dashboard/api.js");
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
                  const { createConfig } = await import("./config.js");
                  const cfgInst = createConfig(directory);
                  result.config = { values: cfgInst.get(), warnings: cfgInst.getWarnings(), source: cfgInst.getSource(), dormantNote: "turnRequestThresholds.autoGrant, maxTurnRequestsPerRound, maxTurnRequestWords are dormant — ordering is planTurnOrder" };
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
};

export { MeetingOrchestrator } from "./orchestrator.js";
export { formatRoomPreview } from "./composer.js";
export {
  getTierConfig,
  splitModel,
  getPromptForTier,
  getRightsForTier,
} from "./shared.js";

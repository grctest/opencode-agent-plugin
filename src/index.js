import { tool } from "@opencode-ai/plugin";
import { LoomEngine } from "./loom-engine.js";
import { composeRoom, formatRoomPreview } from "./composer.js";
import { isAgentSessionClient } from "./client-types.js";
import { createModelPlan, formatModelPlan } from "./model-discovery.js";
import { deleteMeetingFiles, findMeetingBySessionId, getDbPathForMeeting } from "./database.js";
import { startDashboard } from "./dashboard/server.js";

export const Loom = async (input) => {
  const { client, directory } = input;

  if (!isAgentSessionClient(client)) {
    throw new Error("Loom plugin requires a compatible opencode client with session.create, session.prompt, session.message, and provider API access.");
  }

  const activeLooms = new Map();
  const sessionDatabases = new Map();
  let activeDashboard = null;
  let pendingModels = null;

  async function discoverModels(sessionID) {
    const available = [];
    let sessionModel = null;

    try {
      const sessionResult = await client.session.get({
        path: { id: sessionID },
        query: { directory },
      });
      const sessionData = sessionResult?.data ?? sessionResult;
      if (sessionData?.model) {
        sessionModel = {
          providerID: sessionData.model.providerID,
          modelID: sessionData.model.modelID,
        };
      }
    } catch {
    }

    try {
      const fn = client.provider?.providers ?? client.provider?.list;
      if (typeof fn !== "function") return { available, sessionModel };

      const result = await fn.call(client.provider, { query: { directory } });
      const data = result?.data ?? result ?? {};
      const providers = data.providers ?? data.all ?? [];
      const connected = data.connected ?? [];

      for (const provider of providers) {
        const isConnected = connected.length === 0 || connected.includes(provider.id);
        if (!isConnected) continue;

        const models = provider.models || {};
        for (const [key, model] of Object.entries(models)) {
          const m = model;
          if (m.status === "deprecated") continue;
          available.push({
            providerID: provider.id,
            modelID: m.id || key,
            name: m.name || key,
            status: m.status || "active",
            cost: m.cost || { input: 0, output: 0 },
            limit: m.limit || { context: 128000, output: 4096 },
            reasoning: m.capabilities?.reasoning || m.reasoning || false,
            temperature: m.capabilities?.temperature || m.temperature || false,
          });
        }
      }
    } catch {
    }

    if (available.length === 0 && sessionModel) {
      available.push({
        providerID: sessionModel.providerID,
        modelID: sessionModel.modelID,
        name: "Session Model",
        status: "active",
        cost: { input: 0, output: 0 },
        limit: { context: 128000, output: 4096 },
        reasoning: false,
        temperature: true,
      });
    }

    return { available, sessionModel };
  }

  function assignModelsToParticipants(participants, available, sessionModel) {
    if (available.length === 0) return participants;

    const tiers = [...new Set(participants.map((p) => p.tier))];
    const priorityOrder = ["principal", "senior", "mid", "junior"];
    const sortedTiers = [...tiers].sort(
      (a, b) => priorityOrder.indexOf(a) - priorityOrder.indexOf(b),
    );

    let assignments;
    if (available.length === 1 || !sessionModel) {
      assignments = sortedTiers.map((tier) => {
        const m = available[0];
        return { tier, providerID: m.providerID, modelID: m.modelID, modelName: m.name };
      });
    } else {
      const sessionIdx = available.findIndex(
        (m) => m.providerID === sessionModel.providerID && m.modelID === sessionModel.modelID,
      );
      const topModel = sessionIdx >= 0 ? available[sessionIdx] : available[0];
      const lowerModels = available.filter((_, i) => i !== sessionIdx);

      assignments = sortedTiers.map((tier, i) => {
        if (tier === "principal" || tier === "senior") {
          return { tier, providerID: topModel.providerID, modelID: topModel.modelID, modelName: topModel.name };
        }
        const lowerIdx = Math.min(i, lowerModels.length - 1);
        const m = lowerModels.length > 0 ? lowerModels[Math.max(0, lowerIdx)] : topModel;
        return { tier, providerID: m.providerID, modelID: m.modelID, modelName: m.name };
      });
    }

    const modelMap = new Map();
    for (const a of assignments) {
      modelMap.set(a.tier, { providerID: a.providerID, modelID: a.modelID });
    }

    return participants.map((p) => ({
      ...p,
      model: modelMap.get(p.tier) || undefined,
    }));
  }

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
                    "Role name (e.g. junior, mid, senior, principal, security-engineer). Determines behavior and rights.",
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
              "Maximum deliberation rounds (default: number of participants)",
            ),
          auto_compose: tool.schema
            .boolean()
            .optional()
            .describe(
              "Auto-select participants based on topic analysis (default: true if no participants given)",
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
        },
        execute: async (args, context) => {
          const sessionID = context.sessionID;
          const loomId = crypto.randomUUID();

          const { available, sessionModel } = await discoverModels(sessionID);

          const existingMeeting = await findMeetingBySessionId(directory, sessionID);

          if (existingMeeting && args.extend !== false) {
            const extDbPath = getDbPathForMeeting(directory, existingMeeting.meetingId);
            if (extDbPath) {
              const { Database: DBClass } = await import("bun:sqlite");
              const dbConn = new DBClass(extDbPath);
              try {
                const existingParts = dbConn.prepare(
                  `SELECT id, name, persona, agenda, tier, provider_id, model_id FROM participants ORDER BY tier ASC`
                ).all();
                dbConn.close();
                const extEngine = new LoomEngine(
                  client, directory, context.metadata,
                  {
                    question: existingMeeting.question,
                    context: args.context ?? "No additional context provided.",
                    parentSessionId: sessionID,
                    opencodeSessionId: sessionID,
                    participants: existingParts.map((p) => ({
                      id: p.id, name: p.name, persona: p.persona, agenda: p.agenda, tier: p.tier,
                      model: { providerID: p.provider_id, modelID: p.model_id },
                    })),
                    maxRounds: existingMeeting.max_rounds,
                    convergence: args.convergence ?? "moderator_forces",
                    onContribution: (name, round, type) => {
                      context.metadata({ title: `Loom R${round}: ${name} (${type})`, metadata: { loom_last_contributor: name, loom_last_type: type, loom_round: round } });
                    },
                    onRoundComplete: (round, summary) => {
                      context.metadata({ title: `Loom: Round ${round} complete`, metadata: { loom_round: round, loom_round_summary: summary.slice(0, 200) } });
                    },
                    onSynthesisStart: () => {
                      context.metadata({ title: "Loom: Synthesizing final output...", metadata: { loom_status: "synthesizing" } });
                    },
                    onSynthesisComplete: (output) => {
                      context.metadata({ title: "Loom: Synthesis complete", metadata: { loom_status: "synthesis_complete", loom_output_preview: output.slice(0, 200) } });
                    },
                  },
                );
                activeLooms.set(loomId, extEngine);
                const extDbPathFull = join(directory, ".opencode", "loom", "meetings", `${existingMeeting.meetingId}.db`);
                if (!sessionDatabases.has(sessionID)) {
                  sessionDatabases.set(sessionID, new Set());
                }
                sessionDatabases.get(sessionID).add(extDbPathFull);
                try {
                  await extEngine.initialize();
                  const artifact = await extEngine.extendMeeting(args.question);
                  activeLooms.delete(loomId);
                  const extState = extEngine.getState();
                  return {
                    title: `Loom Extended — ${extState.current_round} rounds`,
                    output: `# Loom Deliberation (Extended)\n\n**Original Question:** ${existingMeeting.question}\n\n**New Input:** ${args.question}\n\n**Participants:** ${existingParts.map((p) => `${p.name} (${p.tier})`).join(", ")}\n\n**Total Rounds:** ${extState.current_round}\n\n**Meeting ID:** ${extEngine.getMeetingId()}\n\n---\n\n${artifact}`,
                    metadata: { loom_id: loomId, meeting_id: extEngine.getMeetingId(), loom_status: extState.status, loom_rounds: extState.current_round, loom_extended: true, loom_participants: existingParts.map((p) => `${p.name} (${p.tier})`).join(", ") },
                  };
                } catch (extErr) {
                  activeLooms.delete(loomId);
                  throw extErr;
                }
              } catch (extErr) {
                const extMsg = extErr instanceof Error ? extErr.message : String(extErr);
                return { title: "Loom Extension Error", output: `Could not extend the existing loom: ${extMsg}\n\nTry starting a fresh loom with a new chat session.`, metadata: { loom_id: loomId, loom_status: "error" } };
              }
            }
          }

          let participants;

          const modelMap = new Map();
          const explicitModels = args.models ?? pendingModels;
          if (explicitModels && explicitModels.length > 0) {
            for (const m of explicitModels) {
              const tier = m.tier;
              const providerId = "provider_id" in m ? m.provider_id : m.providerID;
              const modelId = "model_id" in m ? m.model_id : m.modelID;
              modelMap.set(tier, { providerID: providerId, modelID: modelId });
            }
            pendingModels = null;
          }

          if (args.participants && args.participants.length > 0) {
             const invalid = args.participants.findIndex((p, i) => {
               if (!p.name || !p.persona || !p.agenda || !p.tier) {
                 return true;
               }
               return false;
             });
             if (invalid >= 0) {
               return {
                 title: "Loom Error",
                 output: `Participant #${invalid + 1} is missing required fields (name, persona, agenda, tier).`,
               };
             }
             participants = args.participants.map((p, i) => ({
               id: p.name.toLowerCase().replace(/\s+/g, "_") + "_" + i,
               name: p.name,
               persona: p.persona,
               agenda: p.agenda,
               tier: p.tier,
               model: modelMap.get(p.tier),
             }));
           } else if (args.auto_compose !== false) {
            const recommendation = composeRoom(args.question);
            participants = recommendation.participants;
          } else {
            return {
              title: "Loom Error",
              output: "No participants specified and auto_compose is disabled.",
            };
          }

          if (modelMap.size === 0 && available.length > 0) {
            participants = assignModelsToParticipants(participants, available, sessionModel);
          }

          if (args.dry_run) {
            const room = {
              participants,
              estimated_rounds: args.max_rounds ?? participants.length,
              reasoning: args.participants
                ? "Custom room"
                : composeRoom(args.question).reasoning,
            };
            return {
              title: "Loom Room Preview",
              output: formatRoomPreview(room),
              metadata: {
                loom_id: loomId,
                loom_preview: true,
                loom_participants: participants.length,
              },
            };
          }

          const maxRounds = args.max_rounds ?? 3;

          const engine = new LoomEngine(
            client,
            directory,
            context.metadata,
            {
              question: args.question,
              context: args.context ?? "No additional context provided.",
              parentSessionId: sessionID,
              opencodeSessionId: sessionID,
              participants,
              maxRounds,
              convergence: args.convergence ?? "moderator_forces",
              onContribution: (name, round, type) => {
                context.metadata({
                  title: `Loom R${round}: ${name} (${type})`,
                  metadata: {
                    loom_last_contributor: name,
                    loom_last_type: type,
                    loom_round: round,
                  },
                });
              },
              onRoundComplete: (round, summary) => {
                context.metadata({
                  title: `Loom: Round ${round} complete`,
                  metadata: {
                    loom_round: round,
                    loom_round_summary: summary.slice(0, 200),
                  },
                });
              },
              onSynthesisStart: () => {
                context.metadata({
                  title: "Loom: Synthesizing final output...",
                  metadata: { loom_status: "synthesizing" },
                });
              },
              onSynthesisComplete: (output) => {
                context.metadata({
                  title: "Loom: Synthesis complete",
                  metadata: {
                    loom_status: "synthesis_complete",
                    loom_output_preview: output.slice(0, 200),
                  },
                });
              },
            },
          );

          activeLooms.set(loomId, engine);

          const dbPath = join(directory, ".opencode", "loom", "meetings", `${loomId}.db`);
          if (!sessionDatabases.has(sessionID)) {
            sessionDatabases.set(sessionID, new Set());
          }
          sessionDatabases.get(sessionID).add(dbPath);

          try {
            await engine.initialize();

            const artifact = await engine.runMeeting();

            activeLooms.delete(loomId);

            const state = engine.getState();
            return {
              title: `Loom Complete — ${state.current_round} rounds`,
              output: `# Loom Deliberation Output\n\n**Question:** ${args.question}\n\n**Participants:** ${participants.map((p) => `${p.name} (${p.tier})`).join(", ")}\n\n**Rounds:** ${state.current_round}\n\n**Meeting ID:** ${engine.getMeetingId()}\n\n---\n\n${artifact}`,
              metadata: {
                loom_id: loomId,
                meeting_id: engine.getMeetingId(),
                loom_status: state.status,
                loom_rounds: state.current_round,
                loom_participants: participants
                  .map((p) => `${p.name} (${p.tier})`)
                  .join(", "),
              },
            };
          } catch (err) {
            activeLooms.delete(loomId);
            const message =
              err instanceof Error ? err.message : String(err);
            return {
              title: "Loom Error",
              output: `The Loom encountered an error: ${message}\n\nYou can try again with different participants or a simpler question.`,
              metadata: {
                loom_id: loomId,
                loom_status: "error",
                error: message,
              },
            };
          }
        },
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
              "The dashboard auto-detects new meetings and refreshes every 2 seconds.",
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
        execute: async (_args, ctx) => {
          try {
            const sessionID = ctx.sessionID;
            const { available, sessionModel } = await discoverModels(sessionID);

            if (available.length === 0) {
              return "No active models found. Connect a provider (e.g. run `opencode auth login`).";
            }

            const plan = createModelPlan(available);
            pendingModels = plan.participants;

            let output = formatModelPlan(plan);
            if (sessionModel) {
              output += `\n\n**Session model:** ${sessionModel.providerID}/${sessionModel.modelID} (used as default for top tiers)`;
            }
            return output;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `Model discovery failed: ${message}`;
          }
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

export { LoomEngine } from "./loom-engine.js";
export { composeRoom, formatRoomPreview } from "./composer.js";
export {
  getTierConfig,
  splitModel,
  can,
  getPromptForTier,
  getRightsForTier,
} from "./tiers.js";

import { join } from "node:path";

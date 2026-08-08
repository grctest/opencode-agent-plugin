import { tool } from "@opencode-ai/plugin";
import type { PluginInput } from "@opencode-ai/plugin";
import { z } from "zod";
import { LoomEngine } from "./loom-engine.js";
import { composeRoom, formatRoomPreview } from "./composer.js";
import type { AgentSessionClient } from "./client-types.js";
import type { ParticipantConfig, Tier } from "./types.js";
import { createModelPlan, formatModelPlan, getStoredModelPlan, storeModelPlan } from "./model-discovery.js";
import type { AvailableModel, ModelAssignment } from "./model-discovery.js";

export default function loomPlugin(input: PluginInput) {
  const { client, directory } = input;
  const activeLooms = new Map<string, LoomEngine>();
  let pendingModels: ModelAssignment[] | null = null;

  return {
    tool: {
      knit: tool({
        description:
          "Start a multi-agent deliberation session (a 'Loom') where multiple AI agents with different expertise and seniority levels collaborate to produce a complex output. Use when the task benefits from multiple perspectives, has no obvious single answer, or requires structured deliberation.",
        args: {
          question: z
            .string()
            .describe("The question or task for the agents to deliberate on"),
          context: z
            .string()
            .optional()
            .describe(
              "Additional context, background files, or constraints the agents should consider",
            ),
          participants: z
            .array(
              z.object({
                name: z.string().describe("Display name for this participant"),
                persona: z
                  .string()
                  .describe("Who this agent is — their role and personality"),
                agenda: z
                  .string()
                  .describe(
                    "What this agent wants to achieve in the deliberation",
                  ),
                tier: z
                  .enum(["junior", "mid", "senior", "principal"])
                  .describe(
                    "Seniority level — determines model, behavior, and rights",
                  ),
              }),
            )
            .optional()
            .describe(
              "Custom participant list. If omitted, auto-composed from the question.",
            ),
          max_rounds: z
            .number()
            .int()
            .min(1)
            .max(10)
            .optional()
            .describe(
              "Maximum deliberation rounds (default: number of participants)",
            ),
          auto_compose: z
            .boolean()
            .optional()
            .describe(
              "Auto-select participants based on topic analysis (default: true if no participants given)",
            ),
          dry_run: z
            .boolean()
            .optional()
            .describe(
              "If true, return the composed room without running deliberation",
            ),
          convergence: z
            .enum(["consensus", "majority", "moderator_forces"])
            .optional()
            .describe(
              "How the deliberation decides to end. Default: moderator_forces",
            ),
          models: z
            .array(
              z.object({
                tier: z.enum(["junior", "mid", "senior", "principal"]),
                provider_id: z.string().describe("Provider ID for this tier"),
                model_id: z.string().describe("Model ID for this tier"),
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

          let participants: ParticipantConfig[];

          const modelMap = new Map<string, { providerID: string; modelID: string }>();
          const modelsToUse = args.models ?? pendingModels;
          if (modelsToUse) {
            for (const m of modelsToUse) {
              const tier = m.tier;
              const providerId = "provider_id" in m ? m.provider_id : (m as any).providerID;
              const modelId = "model_id" in m ? m.model_id : (m as any).modelID;
              modelMap.set(tier, { providerID: providerId, modelID: modelId });
            }
            pendingModels = null;
          }

          if (args.participants && args.participants.length > 0) {
            participants = args.participants.map((p, i) => ({
              id: p.name.toLowerCase().replace(/\s+/g, "_") + "_" + i,
              name: p.name,
              persona: p.persona,
              agenda: p.agenda,
              tier: p.tier as Tier,
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

          const maxRounds = args.max_rounds ?? participants.length;

          const engine = new LoomEngine(
            client as unknown as AgentSessionClient,
            directory,
            context.metadata,
            {
              question: args.question,
              context: args.context ?? "No additional context provided.",
              parentSessionId: sessionID,
              participants,
              maxRounds,
              convergence: args.convergence ?? "moderator_forces",
            },
          );

          activeLooms.set(loomId, engine);

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
          } catch (err: unknown) {
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
        description: "Check the status of a running Loom deliberation session",
        args: {
          loom_id: z.string().describe("The ID of the Loom session to check"),
        },
        execute: async (args, _context): Promise<string> => {
          const engine = activeLooms.get(args.loom_id);
          if (!engine) {
            return "No active Loom found with that ID.";
          }
          const state = engine.getState();
          return `**Loom Status:** ${state.status}\n**Round:** ${state.current_round}/${state.max_rounds}\n**Contributions:** ${state.weft.length}\n**Meeting ID:** ${engine.getMeetingId()}`;
        },
      }),

      knit_models: tool({
        description: "Discover available models and propose assignments for the Loom's knitting needles",
        args: {},
        execute: async (_args, _ctx): Promise<string> => {
          try {
            const client = (_ctx as any).client ?? (_ctx as any).input?.client;
            if (!client?.provider?.list) {
              return "Model discovery not available. Ensure providers are configured.";
            }

            const result = await client.provider.list({ query: { directory: (_ctx as any).directory ?? "" } });
            if (!result?.all && !result?.data?.all) {
              return "No providers found. Configure at least one API provider.";
            }

            const providers = result.all || result.data.all;
            const connected = result.connected || result.data.connected || [];
            const available: AvailableModel[] = [];

            for (const provider of providers) {
              const isConnected = connected.includes(provider.id);
              if (!isConnected) continue;

              for (const [key, model] of Object.entries(provider.models || {})) {
                const m = model as any;
                if (m.status === "deprecated") continue;
                available.push({
                  providerID: provider.id,
                  modelID: m.id || key,
                  name: m.name || key,
                  status: m.status || "active",
                  cost: m.cost || { input: 0, output: 0 },
                  limit: m.limit || { context: 128000, output: 4096 },
                  reasoning: m.reasoning || false,
                  temperature: m.temperature || false,
                });
              }
            }

            if (available.length === 0) {
              return "No active models found. Connect a provider (e.g. run `opencode auth login`).";
            }

             const plan = createModelPlan(available);
             pendingModels = plan.participants;
             return formatModelPlan(plan);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            return `Model discovery failed: ${message}`;
          }
        },
      }),
    },
  };
}

export { LoomEngine } from "./loom-engine.js";
export { composeRoom, formatRoomPreview } from "./composer.js";
export {
  getTierConfig,
  splitModel,
  can,
  DEFAULT_TIER_MODELS,
  DEFAULT_TIER_PROMPTS,
  DEFAULT_TIER_RIGHTS,
} from "./tiers.js";
export type {
  Tier,
  TierConfig,
  ParticipantConfig,
  LoomState,
} from "./types.js";

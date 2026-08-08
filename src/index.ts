import { tool } from "@opencode-ai/plugin";
import type { PluginInput } from "@opencode-ai/plugin";
import { z } from "zod";
import { LoomEngine } from "./loom-engine.js";
import { composeRoom, formatRoomPreview } from "./composer.js";
import type { ParticipantConfig, Tier } from "./types.js";

export default function loomPlugin(input: PluginInput) {
  const { client, directory } = input;
  const activeLooms = new Map<string, LoomEngine>();

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
        },
        execute: async (args, context) => {
          const sessionID = context.sessionID;
          const loomId = crypto.randomUUID();

          let participants: ParticipantConfig[];

          if (args.participants && args.participants.length > 0) {
            participants = args.participants.map((p, i) => ({
              id: p.name.toLowerCase().replace(/\s+/g, "_") + "_" + i,
              name: p.name,
              persona: p.persona,
              agenda: p.agenda,
              tier: p.tier as Tier,
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
            client,
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

          if (context.abort) {
            engine.setSignal(context.abort);
          }

          activeLooms.set(loomId, engine);

          try {
            await engine.initialize();

            let continueDeliberation = true;
            while (continueDeliberation) {
              continueDeliberation = await engine.runRound();
            }

            const artifact = await engine.generateArtifact();

            activeLooms.delete(loomId);

            return {
              title: `Loom Complete — ${engine.getState().current_round} rounds`,
              output: `# Loom Deliberation Output\n\n**Question:** ${args.question}\n\n**Participants:** ${participants.map((p) => `${p.name} (${p.tier})`).join(", ")}\n\n**Rounds:** ${engine.getState().current_round}\n\n---\n\n${artifact}`,
              metadata: {
                loom_id: loomId,
                loom_status: engine.getState().status,
                loom_rounds: engine.getState().current_round,
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
          const speaker =
            state.participants[state.current_speaker_idx]?.config.name ?? "none";
          return `**Loom Status:** ${state.status}\n**Round:** ${state.current_round}/${state.max_rounds}\n**Contributions:** ${state.weft.length}\n**Current speaker:** ${speaker}`;
        },
      }),

      loom_abort: tool({
        description: "Abort a running Loom deliberation session",
        args: {
          loom_id: z.string().describe("The ID of the Loom session to abort"),
        },
        execute: async (args, _context): Promise<string> => {
          const engine = activeLooms.get(args.loom_id);
          if (!engine) {
            return "No active Loom found with that ID.";
          }
          engine.abort();
          activeLooms.delete(args.loom_id);
          return "Loom aborted successfully.";
        },
      }),

      loom_veto: tool({
        description:
          "Veto a conclusion or direction in the deliberation. Only available to senior and principal tiers.",
        args: {
          loom_id: z.string().describe("The ID of the Loom session"),
          participant_id: z
            .string()
            .describe("The participant ID of the vetoing agent"),
          reason: z.string().describe("Why this veto is being issued"),
        },
        execute: async (args, _context): Promise<string> => {
          const engine = activeLooms.get(args.loom_id);
          if (!engine) return "No active Loom found with that ID.";
          const result = engine.veto(args.participant_id, args.reason);
          return result.ok
            ? `Veto recorded: ${args.reason}`
            : `Veto denied: ${result.error}`;
        },
      }),

      loom_force_end: tool({
        description:
          "Force the deliberation to end and produce a final synthesis. Only available to principal tier.",
        args: {
          loom_id: z.string().describe("The ID of the Loom session"),
          participant_id: z
            .string()
            .describe("The participant ID of the agent forcing end"),
        },
        execute: async (args, _context): Promise<string> => {
          const engine = activeLooms.get(args.loom_id);
          if (!engine) return "No active Loom found with that ID.";
          const result = engine.forceEnd(args.participant_id);
          return result.ok
            ? "Deliberation ended by force."
            : `Force-end denied: ${result.error}`;
        },
      }),

      loom_vote: tool({
        description:
          "Call a vote on whether to conclude the deliberation. Available to mid, senior, and principal tiers. Requires majority of active participants to be ready.",
        args: {
          loom_id: z.string().describe("The ID of the Loom session"),
          participant_id: z
            .string()
            .describe("The participant ID of the agent calling the vote"),
        },
        execute: async (args, _context): Promise<string> => {
          const engine = activeLooms.get(args.loom_id);
          if (!engine) return "No active Loom found with that ID.";
          const result = engine.callVote(args.participant_id);
          if (!result.ok) return `Vote denied: ${result.error}`;
          return result.result ?? "Vote recorded.";
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

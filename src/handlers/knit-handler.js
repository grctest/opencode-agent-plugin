import { MeetingOrchestrator } from "../orchestrator.js";
import { composeRoomWithDomains, formatRoomPreview, detectDomainsWithLLM, detectDomainsFallback } from "../composer.js";
import { createModelPlan, formatModelPlan } from "../model-discovery.js";
import { deleteMeetingFiles, findMeetingBySessionId, getDbPathForMeeting } from "../database.js";
import {
  discoverModels,
  assignModelsToParticipants,
  getHighestTierModel,
  promptParent,
} from "../services/model-service.js";
import { join } from "node:path";

export function createKnitHandler(client, directory) {
  let pendingModels = null;

  async function handleKnit(args, context) {
    const sessionID = context.sessionID;
    const loomId = crypto.randomUUID();

    const { available, sessionModel } = await discoverModels(client, directory, sessionID);

    const existingMeeting = await findMeetingBySessionId(directory, sessionID);

    if (existingMeeting && args.extend !== false) {
      return handleExtend(existingMeeting, args, context, loomId, sessionID);
    }

    let participants;
    let detectedDomains = [];

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
      const invalid = args.participants.findIndex((p) => {
        return !p.name || !p.persona || !p.agenda || !p.tier;
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
        domain: "general",
        domains: ["general"],
      }));
    } else {
      try {
        const highestModel = getHighestTierModel([]);
        const modelForDetection = highestModel ?? (available.length > 0 ? { providerID: available[0].providerID, modelID: available[0].modelID } : null);

        if (modelForDetection) {
          detectedDomains = await detectDomainsWithLLM(
            args.question,
            async (system, model, message) => promptParent(client, directory, sessionID, system, model, message),
            () => modelForDetection,
          );
        } else {
          detectedDomains = detectDomainsFallback(args.question);
        }
      } catch {
        detectedDomains = detectDomainsFallback(args.question);
      }

      const recommendation = composeRoomWithDomains(args.question, undefined, detectedDomains);
      participants = recommendation.participants;
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
          : composeRoomWithDomains(args.question).reasoning,
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

    const engine = new MeetingOrchestrator({
      client,
      directory,
      question: args.question,
      context: args.context ?? "No additional context provided.",
      parentSessionId: sessionID,
      opencodeSessionId: sessionID,
      participants,
      maxRounds,
      convergence: args.convergence ?? "moderator_forces",
      allowInterjections: args.allow_interjections !== false,
      meetingTimeoutMs: args.meeting_timeout,
      waitForUserInput: async () => "continue",
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
        context.metadata({ title: "Loom: Synthesizing final output...", metadata: { loom_status: "synthesizing" } });
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
    });

    try {
      await engine.initialize();
      const artifact = await engine.runMeeting();

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
      const message = err instanceof Error ? err.message : String(err);
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
  }

  async function handleExtend(existingMeeting, args, context, loomId, sessionID) {
    const extDbPath = getDbPathForMeeting(directory, existingMeeting.meetingId);
    if (!extDbPath) {
      return {
        title: "Loom Extension Error",
        output: "Could not find the existing loom database.\n\nTry starting a fresh loom with a new chat session.",
        metadata: { loom_id: loomId, loom_status: "error" },
      };
    }

    const { Database: DBClass } = await import("bun:sqlite");
    const dbConn = new DBClass(extDbPath);
    try {
      const existingParts = dbConn.prepare(
        `SELECT id, name, persona, agenda, tier, provider_id, model_id FROM participants ORDER BY tier ASC`
      ).all();

      const highestModel = getHighestTierModel(existingParts.map((p) => ({
        tier: p.tier,
        model: p.provider_id ? { providerID: p.provider_id, modelID: p.model_id } : null,
      })));

      const extEngine = new MeetingOrchestrator({
        client,
        directory,
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
        allowInterjections: args.allow_interjections !== false,
        meetingTimeoutMs: args.meeting_timeout,
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
      });

      try {
        await extEngine.initialize();
        const artifact = await extEngine.extendMeeting(args.question);
        const extState = extEngine.getState();
        return {
          title: `Loom Extended — ${extState.current_round} rounds`,
          output: `# Loom Deliberation (Extended)\n\n**Original Question:** ${existingMeeting.question}\n\n**New Input:** ${args.question}\n\n**Participants:** ${existingParts.map((p) => `${p.name} (${p.tier})`).join(", ")}\n\n**Total Rounds:** ${extState.current_round}\n\n**Meeting ID:** ${extEngine.getMeetingId()}\n\n---\n\n${artifact}`,
          metadata: { loom_id: loomId, meeting_id: extEngine.getMeetingId(), loom_status: extState.status, loom_rounds: extState.current_round, loom_extended: true, loom_participants: existingParts.map((p) => `${p.name} (${p.tier})`).join(", ") },
        };
      } catch (extErr) {
        throw extErr;
      }
    } catch (extErr) {
      const extMsg = extErr instanceof Error ? extErr.message : String(extErr);
      return { title: "Loom Extension Error", output: `Could not extend the existing loom: ${extMsg}\n\nTry starting a fresh loom with a new chat session.`, metadata: { loom_id: loomId, loom_status: "error" } };
    } finally {
      dbConn.close();
    }
  }

  async function handleKnitModels() {
    try {
      const { available } = await discoverModels(client, directory, "");

      if (available.length === 0) {
        return "No active models found. Connect a provider (e.g. run `opencode auth login`).";
      }

      const plan = createModelPlan(available);
      pendingModels = plan.participants;

      let output = formatModelPlan(plan);
      return output;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Model discovery failed: ${message}`;
    }
  }

  return { handleKnit, handleKnitModels };
}

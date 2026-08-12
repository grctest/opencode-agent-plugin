import { MeetingOrchestrator } from "../orchestrator.js";
import { composeRoomWithDomains, formatRoomPreview, detectDomainsFallback } from "../composer.js";
import { createModelPlan, formatModelPlan } from "../model-discovery.js";
import { deleteMeetingFiles, findMeetingBySessionId, getDbPathForMeeting, MeetingDatabase } from "../database.js";
import {
  discoverModels,
  assignModelsToParticipants,
  getHighestTierModel,
} from "../services/model-service.js";
import { Logger, extractErrorInfo } from "../logger.js";
import { getConfig } from "../config.js";

function createMeetingCallbacks(context, logger) {
  return {
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
    onUpdate: (state) => {
      logger.debug("state_update", `Status: ${state.status}, Round: ${state.current_round}`, {
        activeParticipants: state.participants.filter((p) => p.status === "speaking").length,
      });
    },
  };
}

export function createKnitHandler(client, directory, activeLooms) {
  let pendingModels = null;
  const logger = new Logger();

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
      detectedDomains = detectDomainsFallback(args.question);

      const seed = args.seed ?? Date.now();
      const recommendation = composeRoomWithDomains(args.question, undefined, detectedDomains, seed);
      participants = recommendation.participants;
      detectedDomains = recommendation.domains;
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

    const maxRounds = args.max_rounds ?? getConfig().defaultMaxRounds;

    const meetingCallbacks = createMeetingCallbacks(context, logger);

    const primaryDomain = detectedDomains.length > 0 ? detectedDomains[0] : null;

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
      domain: primaryDomain,
      detectDomains: true,
      ...meetingCallbacks,
    });

    activeLooms.set(loomId, engine);

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
      const info = extractErrorInfo(err);
      logger.error("loom_failed", "Loom deliberation failed", info);
      return {
        title: "Loom Error",
        output: `The Loom encountered an error: ${info.message}\n\nYou can try again with different participants or a simpler question.`,
        metadata: {
          loom_id: loomId,
          loom_status: "error",
          error: info.message,
        },
      };
    } finally {
      activeLooms.delete(loomId);
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

    try {
      const existingParts = await MeetingDatabase.readParticipants(extDbPath);
      if (existingParts.length === 0) {
        return {
          title: "Loom Extension Error",
          output: "Could not find participants in the existing loom database.\n\nTry starting a fresh loom with a new chat session.",
          metadata: { loom_id: loomId, loom_status: "error" },
        };
      }

      const highestModel = getHighestTierModel(existingParts.map((p) => ({
        tier: p.tier,
        model: p.provider_id ? { providerID: p.provider_id, modelID: p.model_id } : null,
      })));

      const meetingCallbacks = createMeetingCallbacks(context, logger);

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
        ...meetingCallbacks,
      });

      activeLooms.set(loomId, extEngine);

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
      } finally {
        activeLooms.delete(loomId);
      }
    } catch (extErr) {
      const extInfo = extractErrorInfo(extErr);
      logger.error("loom_extension_failed", "Loom extension failed", extInfo);
      return { title: "Loom Extension Error", output: `Could not extend the existing loom: ${extInfo.message}\n\nTry starting a fresh loom with a new chat session.`, metadata: { loom_id: loomId, loom_status: "error" } };
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
      const info = extractErrorInfo(err);
      logger.error("model_discovery_failed", "Model discovery failed", info);
      return `Model discovery failed: ${info.message}`;
    }
  }

  return { handleKnit, handleKnitModels };
}

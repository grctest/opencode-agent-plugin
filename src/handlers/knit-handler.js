import { MeetingOrchestrator } from "../orchestrator.js";
import { composeRoomWithSimilarity, formatRoomPreview } from "../composer.js";
import { createModelPlan, formatModelPlan } from "../model-discovery.js";
import { findMeetingBySessionId, getDbPathForMeeting, MeetingDatabase } from "../database.js";
import {
  discoverModels,
  assignModelsToParticipants,
} from "../services/model-service.js";
import { Logger, extractErrorInfo } from "../logger.js";
import { getConfig } from "../config.js";
import { resolveLoomBaseDir, getMeetingDbPath } from "../paths.js";
import { unlinkSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { sanitizeForPrompt } from "../utils/sanitize.js";

/**
 * Extracts a short one-line decision summary from a markdown artifact,
 * preferring the first non-empty line under `## Decision`.
 * @param {string} artifact
 * @returns {string|null}
 */
function extractDecisionSummary(artifact) {
  if (!artifact || typeof artifact !== "string") return null;
  const match = artifact.match(/##\s*Decision\b([\s\S]*?)(?=\n##\s|\n*$)/i);
  const section = match ? match[1] : artifact;
  const firstLine = section
    .split("\n")
    .map((l) => l.replace(/^[-*#>\s]+/, "").trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}

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

/**
 * Filters the full list of discovered models by the enabled-models set.
 * When enabledModels is null, all models are allowed (no filter).
 * @param {Array} allAvailable - Full list of discovered models
 * @param {Set<string>|null} enabledModels - Set of "provider/model" identifiers, or null for all
 * @returns {Array} Filtered list of models
 */
function applyModelFilter(allAvailable, enabledModels) {
  if (!enabledModels || enabledModels.size === 0) return allAvailable;
  return allAvailable.filter((m) => {
    const key = `${m.providerID}/${m.modelID}`;
    return enabledModels.has(key);
  });
}

export function createKnitHandler(client, directory, activeLooms, agentTools = null) {
  let pendingModels = null;
  let enabledModels = null;
  const logger = new Logger();

  /**
   * Writes the full deliberation report to a persistent documentation file in the
   * meeting directory, so the chat response can stay concise.
   * @param {string} meetingId
   * @param {string} report - Full markdown report
   * @returns {string|null} Absolute path to the written file
   */
  function writeReportFile(meetingId, report) {
    try {
      const baseDir = resolveLoomBaseDir(directory);
      const dir = join(baseDir, "meetings");
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, `${meetingId}.md`);
      writeFileSync(filePath, report, "utf-8");
      return filePath;
    } catch (err) {
      const info = extractErrorInfo(err);
      logger.warn("report_write_failed", "Failed to write deliberation report file", info);
      return null;
    }
  }

  /**
   * Builds a concise chat summary from a completed deliberation, deferring the full
   * report to the written documentation file and the dashboard.
   * @param {Object} state - Final meeting state
   * @param {string} question
   * @param {Array} participants
   * @param {string} meetingId
   * @param {string|null} reportPath
   * @param {string} [artifact] - Full artifact text (first Decision section used for summary)
   * @returns {string} Concise summary for the chat
   */
  function buildSummary(state, question, participants, meetingId, reportPath, artifact = "") {
    const decision = extractDecisionSummary(artifact);
    const lines = [
      `**Loom complete** — ${state.current_round} round${state.current_round !== 1 ? "s" : ""} (${state.status})`,
      `**Question:** ${question}`,
      `**Participants:** ${participants.length}`,
    ];
    if (decision) lines.push(`**Decision:** ${decision}`);
    lines.push(`**Meeting ID:** ${meetingId}`);
    if (reportPath) {
      lines.push("");
      lines.push(`Full report saved to \`${reportPath}\`.`);
    }
    lines.push("Run `/loom_viz` for the interactive dashboard.");
    return lines.join("\n");
  }

  async function handleKnit(args, context) {
    const sessionID = context.sessionID;
    const loomId = crypto.randomUUID();

    const { available: allAvailable, sessionModel } = await discoverModels(client, directory, sessionID);

    const available = applyModelFilter(allAvailable, enabledModels);

    if (args.fresh === true) {
      const existingMeeting = await findMeetingBySessionId(directory, sessionID);
      if (existingMeeting) {
        const extDbPath = getDbPathForMeeting(directory, existingMeeting.meetingId);
        if (extDbPath) {
          try { unlinkSync(extDbPath); } catch (err) {
            if (err?.code !== 'ENOENT') {
              logger.debug("fresh_delete_failed", "Failed to delete existing loom database", { error: err.message });
            }
          }
          logger.info("loom_fresh", "Cleared existing loom database for fresh start", { meetingId: existingMeeting.meetingId });
        }
      }
    }

    const existingMeeting = await findMeetingBySessionId(directory, sessionID);

    if (existingMeeting && args.fresh !== true && !args.dry_run) {
      return handleExtend(existingMeeting, args, context, loomId, sessionID, available);
    }

    let participants;
    let composedRoom = null;
    let meetingId = null;
    let meetingDb = null;

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
        tags: p.tags || p.expertise || ["general"],
        expertise: p.expertise || [],
        known_biases: p.known_biases,
        communication_style: p.communication_style,
        preferred_contribution_types: p.preferred_contribution_types,
      }));
    } else {
      const seed = args.seed ?? Date.now();
      meetingId = crypto.randomUUID();
      const dbPath = getMeetingDbPath(directory, meetingId);
      try {
        meetingDb = await MeetingDatabase.create(dbPath, meetingId);

        // Insert a meeting row BEFORE composition so the FK constraint on
        // persona_embeddings(meeting_id -> meetings(id)) is satisfied when
        // PersonaIndex stores embeddings during similarity search.
        const question = args.question ? sanitizeForPrompt(args.question, 5000) : '';
        const sanitizedContext = args.context ? sanitizeForPrompt(args.context, 8000) : 'No additional context provided.';
        const maxRounds = args.max_rounds ?? getConfig().defaultMaxRounds;
        meetingDb.initializeMeeting({
          question,
          context: sanitizedContext,
          maxRounds,
          tags: [],
          parentSessionId: sessionID,
          opencodeSessionId: sessionID,
          embedding_model: null,
          embedding_dim: null,
          participants: [],
        });

        composedRoom = await composeRoomWithSimilarity(args.question, seed, meetingDb);
        participants = composedRoom.participants;

        // Apply the tier plan (from args.models / pendingModels) to composed
        // participants, mirroring the custom-participants branch, then fill any
        // remaining gaps from the available pool. This keeps persisted
        // provider_id/model_id populated even when a model plan is present.
        participants = participants.map((p) =>
          p.model ? p : { ...p, model: modelMap.get(p.tier) ?? undefined }
        );
        if (available.length > 0) {
          participants = assignModelsToParticipants(participants, available, sessionModel);
        }

        meetingDb.insertParticipants(participants);
      } catch (err) {
        logger.warn("similarity_composition_failed", "Similarity-based composition failed — using fallback", extractErrorInfo(err));
        composedRoom = { participants: [], tags: [], estimated_rounds: 2, reasoning: "Fallback composition" };
        participants = [];
      } finally {
        if (meetingDb) {
          try { meetingDb.close(); } catch { /* cleanup */ }
        }
      }
    }

    if (available.length > 0 && participants.length > 0 && participants.some((p) => !p.model)) {
      participants = assignModelsToParticipants(participants, available, sessionModel);
    }

    if (args.dry_run) {
      const room = {
        participants,
        estimated_rounds: args.max_rounds ?? composedRoom?.estimated_rounds ?? participants.length,
        reasoning: args.participants
          ? "Custom room"
          : composedRoom?.reasoning ?? "Custom room",
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

    const question = args.question ? sanitizeForPrompt(args.question, 5000) : '';
    const sanitizedContext = args.context ? sanitizeForPrompt(args.context, 8000) : 'No additional context provided.';

    const derivedTags = composedRoom?.tags ?? [];

    const engine = new MeetingOrchestrator({
      client,
      directory,
      meetingId,
      question,
      context: sanitizedContext,
      parentSessionId: sessionID,
      opencodeSessionId: sessionID,
      participants,
      maxRounds,
      meetingTimeoutMs: args.meeting_timeout,
      tags: derivedTags,
      agentTools,
      availableModels: available,
      ...meetingCallbacks,
    });

    activeLooms.set(loomId, engine);

    try {
      await engine.initialize();
      const artifact = await engine.runMeeting();

      const state = engine.getState();
      const fullReport = `# Loom Deliberation Output\n\n**Question:** ${args.question}\n\n**Participants:** ${participants.map((p) => `${p.name} (${p.tier})`).join(", ")}\n\n**Rounds:** ${state.current_round}\n\n**Meeting ID:** ${engine.getMeetingId()}\n\n---\n\n${artifact}`;
      const reportPath = writeReportFile(engine.getMeetingId(), fullReport);

      return {
        title: `Loom Complete — ${state.current_round} rounds`,
        output: buildSummary(state, args.question, participants, engine.getMeetingId(), reportPath, artifact),
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
      await engine.close();
    }
  }

  async function handleExtend(existingMeeting, args, context, loomId, sessionID, available = []) {
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

      const allowedModelKeys = new Set(available.map((m) => `${m.providerID}/${m.modelID}`));

      const meetingCallbacks = createMeetingCallbacks(context, logger);

      const extEngine = new MeetingOrchestrator({
        client,
        directory,
        meetingId: existingMeeting.meetingId,
        resume: true,
        question: existingMeeting.question,
        context: args.context ? sanitizeForPrompt(args.context, 8000) : "No additional context provided.",
        parentSessionId: sessionID,
        opencodeSessionId: sessionID,
        participants: existingParts.map((p) => {
          const modelKey = p.provider_id && p.model_id ? `${p.provider_id}/${p.model_id}` : null;
          const modelAllowed = modelKey && allowedModelKeys.has(modelKey);
          return {
            id: p.id, name: p.name, persona: p.persona, agenda: p.agenda, tier: p.tier,
            model: modelAllowed ? { providerID: p.provider_id, modelID: p.model_id } : undefined,
          };
        }),
        maxRounds: existingMeeting.max_rounds,
        meetingTimeoutMs: args.meeting_timeout,
        agentTools,
        availableModels: available,
        ...meetingCallbacks,
      });

      activeLooms.set(loomId, extEngine);

      try {
        await extEngine.initialize();
        const artifact = await extEngine.extendMeeting(args.question);
        const extState = extEngine.getState();
        const fullReport = `# Loom Deliberation (Extended)\n\n**Original Question:** ${existingMeeting.question}\n\n**New Input:** ${args.question}\n\n**Participants:** ${existingParts.map((p) => `${p.name} (${p.tier})`).join(", ")}\n\n**Total Rounds:** ${extState.current_round}\n\n**Meeting ID:** ${extEngine.getMeetingId()}\n\n---\n\n${artifact}`;
        const reportPath = writeReportFile(extEngine.getMeetingId(), fullReport);
        const summary = [
          `**Loom extended** — ${extState.current_round} round${extState.current_round !== 1 ? "s" : ""} total (${extState.status})`,
          `**Original question:** ${existingMeeting.question}`,
          `**New input:** ${args.question}`,
          `**Participants:** ${existingParts.length}`,
          `**Meeting ID:** ${extEngine.getMeetingId()}`,
        ];
        if (reportPath) {
          summary.push("");
          summary.push(`Full report saved to \`${reportPath}\`.`);
        }
        summary.push("Run `/loom_viz` for the interactive dashboard.");
        return {
          title: `Loom Extended — ${extState.current_round} rounds`,
          output: summary.join("\n"),
          metadata: { loom_id: loomId, meeting_id: extEngine.getMeetingId(), loom_status: extState.status, loom_rounds: extState.current_round, loom_extended: true, loom_participants: existingParts.map((p) => `${p.name} (${p.tier})`).join(", ") },
        };
      } catch (extErr) {
        throw extErr;
      } finally {
        activeLooms.delete(loomId);
        await extEngine.close();
      }
    } catch (extErr) {
      const extInfo = extractErrorInfo(extErr);
      logger.error("loom_extension_failed", "Loom extension failed", extInfo);
      return { title: "Loom Extension Error", output: `Could not extend the existing loom: ${extInfo.message}\n\nTry starting a fresh loom with a new chat session.`, metadata: { loom_id: loomId, loom_status: "error" } };
    }
  }

  async function handleListKnitModels() {
    let available;
    try {
      const result = await discoverModels(client, directory, "");
      available = result.available;
    } catch (err) {
      const info = extractErrorInfo(err);
      logger.error("model_discovery_failed", "Model discovery failed", info);
      return `Model discovery failed: ${info.message}`;
    }

    if (available.length === 0) {
      return "No active models found. Connect a provider (e.g. run `opencode auth login`).";
    }

    const modelKey = (m) => `${m.providerID}/${m.modelID}`;

    const { sessionModel } = await discoverModels(client, directory, "");
    const plan = createModelPlan(available, undefined, sessionModel);
    pendingModels = plan.participants;

    const lines = [
      "## Available Models",
      "",
      "| Identifier | Provider | Cost | Context | Reasoning | Status |",
      "|------------|----------|------|---------|-----------|--------|",
    ];

    for (const m of available) {
      const key = modelKey(m);
      const isEnabled = enabledModels ? enabledModels.has(key) : true;
      const status = isEnabled ? "enabled" : "disabled";
      const cost = m.cost.input === 0 && m.cost.output === 0
        ? "free"
        : `$${m.cost.input}/$${m.cost.output}`;
      const ctx = `${Math.round((m.limit?.context ?? 128000) / 1000)}k`;
      const reason = m.reasoning ? "yes" : "—";
      lines.push(`| ${key} | ${m.providerID} | ${cost} | ${ctx} | ${reason} | ${status} |`);
    }

    lines.push("");
    lines.push(`**Total:** ${available.length} model(s)`);
    if (enabledModels) {
      lines.push(`**Enabled:** ${enabledModels.size} model(s)`);
      lines.push(`**Disabled:** ${available.length - enabledModels.size} model(s)`);
    } else {
      lines.push("**All models enabled** (no filter set)");
    }
    lines.push("");
    lines.push("Copy the exact `provider/model` identifier to enable or disable a model:");
    lines.push("- `/enable_knit_models openai/gpt-4.1`");
    lines.push("- `/disable_knit_models openai/o1`");
    lines.push("- `/reset_knit_models`");
    lines.push("");
    lines.push(formatModelPlan(plan));

    return lines.join("\n");
  }

  async function handleEnableKnitModels(args) {
    const requested = args?.models ?? [];
    if (requested.length === 0) {
      return {
        title: "Model Filter Error",
        output: `Please specify model identifiers to enable.\n\nRun \`/list_knit_models\` to see available models with their exact identifiers.`,
      };
    }

    let available;
    try {
      const result = await discoverModels(client, directory, "");
      available = result.available;
    } catch (err) {
      const info = extractErrorInfo(err);
      logger.error("model_discovery_failed", "Model discovery failed", info);
      return `Model discovery failed: ${info.message}`;
    }

    if (available.length === 0) {
      return "No active models found. Connect a provider (e.g. run `opencode auth login`).";
    }

    const modelKey = (m) => `${m.providerID}/${m.modelID}`;
    const allKeys = new Set(available.map(modelKey));

    const invalid = requested.filter((id) => !allKeys.has(id));
    if (invalid.length > 0) {
      const suggestions = [...allKeys].join("\n");
      return {
        title: "Model Filter Error",
        output: `The following identifiers were not found:\n\n${invalid.map((i) => `- ${i}`).join("\n")}\n\nValid identifiers:\n${suggestions}\n\nRun \`/list_knit_models\` to see the full list.`,
      };
    }

    if (!enabledModels) enabledModels = new Set(allKeys);
    for (const id of requested) enabledModels.add(id);
    return {
      title: "Models Enabled",
      output: `Enabled ${requested.length} model(s):\n${requested.map((m) => `- ${m}`).join("\n")}\n\n${enabledModels.size} model(s) are now available for Loom agents.`,
    };
  }

  async function handleDisableKnitModels(args) {
    const requested = args?.models ?? [];
    if (requested.length === 0) {
      return {
        title: "Model Filter Error",
        output: `Please specify model identifiers to disable.\n\nRun \`/list_knit_models\` to see available models with their exact identifiers.`,
      };
    }

    let available;
    try {
      const result = await discoverModels(client, directory, "");
      available = result.available;
    } catch (err) {
      const info = extractErrorInfo(err);
      logger.error("model_discovery_failed", "Model discovery failed", info);
      return `Model discovery failed: ${info.message}`;
    }

    if (available.length === 0) {
      return "No active models found. Connect a provider (e.g. run `opencode auth login`).";
    }

    const modelKey = (m) => `${m.providerID}/${m.modelID}`;
    const allKeys = new Set(available.map(modelKey));

    const invalid = requested.filter((id) => !allKeys.has(id));
    if (invalid.length > 0) {
      const suggestions = [...allKeys].join("\n");
      return {
        title: "Model Filter Error",
        output: `The following identifiers were not found:\n\n${invalid.map((i) => `- ${i}`).join("\n")}\n\nValid identifiers:\n${suggestions}\n\nRun \`/list_knit_models\` to see the full list.`,
      };
    }

    if (!enabledModels) enabledModels = new Set(allKeys);
    const removed = requested.filter((id) => enabledModels.has(id));
    for (const id of requested) enabledModels.delete(id);
    if (removed.length > 0) pendingModels = null;
    return {
      title: "Models Disabled",
      output: `Disabled ${removed.length} model(s):\n${removed.map((m) => `- ${m}`).join("\n")}\n\n${enabledModels.size} model(s) remain available for Loom agents.`,
    };
  }

  async function handleResetKnitModels() {
    const prevCount = enabledModels?.size ?? 0;
    enabledModels = null;
    pendingModels = null;
    return {
      title: "Model Filter Reset",
      output: `Model filter cleared. All discovered models are now available for Loom agents (${prevCount} models were previously restricted).`,
    };
  }

  return { handleKnit, handleListKnitModels, handleEnableKnitModels, handleDisableKnitModels, handleResetKnitModels };
}

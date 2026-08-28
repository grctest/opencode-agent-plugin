import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MeetingOrchestrator } from "../orchestrator.js";
import { composeRoomWithSimilarity, formatRoomPreview } from "../composer.js";
import { findMeetingBySessionId, getDbPathForMeeting, deleteMeetingFiles, MeetingDatabase } from "../database.js";
import { discoverModels, assignModelsToParticipants } from "../services/model-service.js";
import { Logger, extractErrorInfo } from "../logger.js";
import { getConfig } from "../config.js";
import { getMeetingDbPath, resolveLoomBaseDir } from "../paths.js";
import { sanitizeForPrompt, sanitizeForDisplay } from "../utils/sanitize.js";
import { applyModelFilter } from "./knit/utils.js";
import { createMeetingCallbacks, buildSummary } from "./knit/callbacks.js";
import { writeReportFile as writeReportFileHelper, createSessionLock } from "./knit/file-ops.js";
import { createModelHandlers } from "./knit/model-handlers.js";

export function createKnitHandler(client, directory, activeLooms, agentTools = null) {
  const logger = new Logger();
  const withSessionLock = createSessionLock();
  const state = { pendingModelsBySession: new Map(), disabledModelsBySession: new Map() };

  const { handleListKnitModels, handleEnableKnitModels, handleDisableKnitModels, handleResetKnitModels } = createModelHandlers({ client, directory, logger, state });

  function writeReportFile(meetingId, report) {
    return writeReportFileHelper(directory, meetingId, report, logger);
  }

  async function handleKnit(args, context) {
    const sessionID = context.sessionID;
    const providedMeetingId = args.meetingId ?? args.meeting_id ?? null;
    const loomId = providedMeetingId ?? crypto.randomUUID();
    return withSessionLock(sessionID, async () => {

    const { available: allAvailable, sessionModel } = await discoverModels(client, directory, sessionID);
    // Per-session deny-list: reload latest persisted filter for this session (handles external edits / multi-process)
    let disabledForSession = null;
    try {
      const p = join(resolveLoomBaseDir(directory), `models-filter-${sessionID}.json`);
      if (existsSync(p)) {
        const data = JSON.parse(readFileSync(p, "utf-8"));
        if (Array.isArray(data.disabledModels)) disabledForSession = new Set(data.disabledModels);
      }
      if (disabledForSession) {
        state.disabledModelsBySession.set(sessionID, disabledForSession);
      } else if (state.disabledModelsBySession.has(sessionID)) {
        disabledForSession = state.disabledModelsBySession.get(sessionID);
      }
    } catch (err) {
      logger.warn("model_filter_reload_failed", "Failed to reload per-session model filter", extractErrorInfo(err));
    }
    const disabledSet = disabledForSession ?? state.disabledModelsBySession.get(sessionID) ?? null;
    const available = applyModelFilter(allAvailable, disabledSet);

    let existingMeeting = null;
    if (args.fresh === true) {
      existingMeeting = await findMeetingBySessionId(directory, sessionID);
      if (existingMeeting) {
        const extDbPath = getDbPathForMeeting(directory, existingMeeting.meetingId);
        if (extDbPath) {
          deleteMeetingFiles(extDbPath);
          logger.info("loom_fresh", "Cleared existing loom database for fresh start", { meetingId: existingMeeting.meetingId });
        }
        existingMeeting = null;
      }
    } else {
      existingMeeting = await findMeetingBySessionId(directory, sessionID);
    }

    if (existingMeeting && args.fresh !== true && !args.dry_run) {
      return handleExtend(existingMeeting, args, context, loomId, sessionID, available);
    }

    let participants;
    let composedRoom = null;
    let meetingId = null;
    let meetingDb = null;

    const modelMap = new Map();
    const pendingForSession = state.pendingModelsBySession.get(sessionID) ?? null;
    const explicitModels = args.models ?? pendingForSession;
    if (explicitModels && explicitModels.length > 0) {
      // Validate explicit models against filtered available (deny-list) — don't inject disabled models
      const allowedKeys = new Set(available.map(m => `${m.providerID}/${m.modelID}`));
      const filteredExplicit = [];
      for (const m of explicitModels) {
        const providerId = "provider_id" in m ? m.provider_id : m.providerID;
        const modelId = "model_id" in m ? m.model_id : m.modelID;
        const key = `${providerId}/${modelId}`;
        if (disabledSet && disabledSet.has(key)) {
          logger.warn("explicit_model_disabled", `Explicit model ${key} for tier ${m.tier} is disabled for this session — ignoring`);
          continue;
        }
        if (!allowedKeys.has(key) && available.length > 0) {
          // Model not in current available (maybe stale pending from list with different discovery) — skip
          logger.warn("explicit_model_not_available", `Explicit model ${key} not in current available — ignoring`);
          continue;
        }
        filteredExplicit.push(m);
      }
      for (const m of filteredExplicit) {
        const tier = m.tier;
        if (modelMap.has(tier)) {
          logger.warn("duplicate_tier", `Duplicate tier "${tier}" in model map — last wins`);
        }
        const providerId = "provider_id" in m ? m.provider_id : m.providerID;
        const modelId = "model_id" in m ? m.model_id : m.modelID;
        modelMap.set(tier, { providerID: providerId, modelID: modelId });
      }
      state.pendingModelsBySession.delete(sessionID);
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
      const ALLOWED_TIERS = new Set(["junior", "mid", "senior", "principal", "civilian"]);
      const badTier = args.participants.findIndex((p) => !ALLOWED_TIERS.has(p.tier));
      if (badTier >= 0) {
        return {
          title: "Loom Error",
          output: `Participant #${badTier + 1} has invalid tier "${args.participants[badTier].tier}" — must be one of ${[...ALLOWED_TIERS].join(", ")}.`,
        };
      }
      if (args.participants.length < 2 || args.participants.length > 7) {
        return {
          title: "Loom Error",
          output: `Custom participant count must be 2-7 (got ${args.participants.length}). Auto-compose uses 2-7; custom rooms must match.`,
        };
      }
      const seenIds = new Set();
      let dedupCounter = 0;
      participants = args.participants.map((p, i) => {
        const rawTags = p.tags ?? p.expertise ?? ["general"];
        const tags = Array.isArray(rawTags) ? rawTags : typeof rawTags === "string" ? [rawTags] : ["general"];
        const slug = p.name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
        let baseId = `${slug}_${i}`;
        let id = baseId;
        if (seenIds.has(id)) {
          id = `${baseId}_${++dedupCounter}`;
        }
        seenIds.add(id);
        return {
          id,
          name: p.name,
          persona: p.persona,
          agenda: p.agenda,
          tier: p.tier,
          model: modelMap.get(p.tier),
          tags,
          expertise: p.expertise || [],
          known_biases: p.known_biases,
          communication_style: p.communication_style,
          preferred_contribution_types: p.preferred_contribution_types,
        };
      });
    } else {
      const sanitizedQuestion = args.question ? sanitizeForPrompt(args.question, 5000) : '';
      if (!sanitizedQuestion || sanitizedQuestion.trim().length < 3) {
        return {
          title: "Loom Error",
          output: "Question too short — please provide at least 3 characters of meaningful question text. The loom was not started.",
          metadata: { loom_id: loomId, loom_status: "error", error: "question too short" },
        };
      }
      // Dry run must not touch DB — compose without side effects
      if (args.dry_run) {
        try {
          composedRoom = await composeRoomWithSimilarity(sanitizedQuestion, null);
        } catch {
          composedRoom = { participants: [], tags: [], estimated_rounds: 2, reasoning: "Dry-run composition" };
        }
        participants = composedRoom.participants ?? [];
        participants = participants.map((p) => p.model ? p : { ...p, model: modelMap.get(p.tier) ?? undefined });
        if (available.length > 0 && participants.length > 0) {
          participants = assignModelsToParticipants(participants, available, sessionModel);
        }
      } else {
        meetingId = crypto.randomUUID();
        const dbPath = getMeetingDbPath(directory, meetingId);
        const sanitizedContext = args.context ? sanitizeForPrompt(args.context, 8000) : 'No additional context provided.';
        const maxRounds = args.max_rounds ?? getConfig().defaultMaxRounds;
        const db = await MeetingDatabase.create(dbPath, meetingId);
        let composeSucceeded = false;
        try {
          db.initializeMeeting({
            question: sanitizedQuestion,
            context: sanitizedContext,
            maxRounds,
            tags: [],
            parentSessionId: sessionID,
            opencodeSessionId: sessionID,
            embedding_model: null,
            embedding_dim: null,
            participants: [],
          });
          composedRoom = await composeRoomWithSimilarity(sanitizedQuestion, db);
          participants = composedRoom.participants;
          if (!participants || participants.length === 0) {
            composedRoom = { participants: [], tags: [], estimated_rounds: 2, reasoning: "No relevant personas — fallback to empty room" };
            participants = [];
            logger.warn("empty_room", "No personas matched sanitized question — returning empty room preview");
          }
          try {
            const { isEmbedderInitialized, getEmbeddingDim } = await import("../services/embedding-service.js");
            const cfg = getConfig();
            const resolvedModel = cfg.embeddingModel ?? (await import("../services/model-manager.js")).DEFAULT_EMBEDDING_MODEL;
            if (isEmbedderInitialized()) {
              const dim = getEmbeddingDim();
              db.upsertMeeting({
                question: sanitizedQuestion,
                context: sanitizedContext,
                maxRounds,
                tags: composedRoom.tags ?? [],
                parentSessionId: sessionID,
                opencodeSessionId: sessionID,
                embedding_model: resolvedModel,
                embedding_dim: dim,
                participants: [],
              });
            }
          } catch {}
          participants = participants.map((p) => p.model ? p : { ...p, model: modelMap.get(p.tier) ?? undefined });
          if (available.length > 0) {
            participants = assignModelsToParticipants(participants, available, sessionModel);
          }
          if (participants.length > 0) {
            db.insertParticipants(participants);
          }
          composeSucceeded = true;
        } catch (err) {
          logger.warn("similarity_composition_failed", "Similarity-based composition failed — using fallback", extractErrorInfo(err));
          composedRoom = { participants: [], tags: [], estimated_rounds: 2, reasoning: "Fallback composition" };
          participants = [];
        } finally {
          try { db.close(); } catch {}
        }
        if (!composeSucceeded && !composedRoom) {
          composedRoom = { participants: [], tags: [], estimated_rounds: 2, reasoning: "Fallback composition" };
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
      let preview = formatRoomPreview(room);
      if (available.length === 0) {
        preview += "\n\n> ⚠️ No models available — loom would fail at runtime. Enable a provider model via /list_knit_models.";
      }
      return {
        title: "Loom Room Preview",
        output: preview,
        metadata: {
          loom_id: loomId,
          loom_preview: true,
          loom_participants: participants.length,
        },
      };
    }

    if (available.length === 0) {
      return {
        title: "Loom Error",
        output: "No models available — enable at least one provider model via /list_knit_models before starting a deliberation.",
        metadata: { loom_id: loomId, loom_status: "error", error: "no models available" },
      };
    }

    let maxRounds = args.max_rounds ?? getConfig().defaultMaxRounds;
    if (!Number.isFinite(maxRounds) || maxRounds < 1) maxRounds = getConfig().defaultMaxRounds;
    if (maxRounds > 10) maxRounds = 10;

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

    const meetingIdKey = engine.getMeetingId();
    activeLooms.set(loomId, engine);
    if (meetingIdKey && meetingIdKey !== loomId) activeLooms.set(meetingIdKey, engine);

    try {
      await engine.initialize();
      const artifact = await engine.runMeeting();

      const state = engine.getState();
      const safeQuestion = sanitizeForDisplay(args.question ?? "", 5000);
      const fullReport = `# Loom Deliberation Output\n\n**Question:** ${safeQuestion}\n\n**Participants:** ${participants.map((p) => `${p.name} (${p.tier})`).join(", ")}\n\n**Rounds:** ${state.current_round}\n\n**Meeting ID:** ${engine.getMeetingId()}\n\n---\n\n${artifact}`;
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
      const mid = engine.getMeetingId();
      if (mid) activeLooms.delete(mid);
      await engine.close();
    }
    });
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
        allowExtend: true,
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

      const existingMeetingId = existingMeeting.meetingId;
      activeLooms.set(loomId, extEngine);
      if (existingMeetingId && existingMeetingId !== loomId) activeLooms.set(existingMeetingId, extEngine);

      try {
        await extEngine.initialize();
        const artifact = await extEngine.extendMeeting(args.question);
        const extState = extEngine.getState();
        const safeOrigQ = sanitizeForDisplay(existingMeeting.question ?? "", 5000);
        const safeNewInput = sanitizeForDisplay(args.question ?? "", 5000);
        const fullReport = `# Loom Deliberation (Extended)\n\n**Original Question:** ${safeOrigQ}\n\n**New Input:** ${safeNewInput}\n\n**Participants:** ${existingParts.map((p) => `${p.name} (${p.tier})`).join(", ")}\n\n**Total Rounds:** ${extState.current_round}\n\n**Meeting ID:** ${extEngine.getMeetingId()}\n\n---\n\n${artifact}`;
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
        const mid = extEngine.getMeetingId() || existingMeeting.meetingId;
        if (mid) activeLooms.delete(mid);
        await extEngine.close();
      }
    } catch (extErr) {
      const extInfo = extractErrorInfo(extErr);
      logger.error("loom_extension_failed", "Loom extension failed", extInfo);
      return { title: "Loom Extension Error", output: `Could not extend the existing loom: ${extInfo.message}\n\nTry starting a fresh loom with a new chat session.`, metadata: { loom_id: loomId, loom_status: "error" } };
    }
  }

  return { handleKnit, handleListKnitModels, handleEnableKnitModels, handleDisableKnitModels, handleResetKnitModels };
}

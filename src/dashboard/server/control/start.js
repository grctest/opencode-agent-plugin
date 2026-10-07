/**
 * POST /api/meetings/start — validate the approved room, persist the meeting
 * row, and launch the orchestrator as a detached background job.
 */
import { MeetingOrchestrator } from "../../../orchestrator.js";
import { validateOrchestratorConfig } from "../../../orchestrator/models.js";
import { assignModelsToParticipants } from "../../../services/model-service.js";
import { MeetingDatabase } from "../../../database.js";
import { getMeetingDbPath } from "../../../paths.js";
import { invalidateMeetingsCache } from "../../api/free.js";
import { getConfig } from "../../../config.js";
import { extractErrorInfo } from "../../../logger.js";
import { sanitizeForPrompt, sanitizeForDisplay } from "../../../utils/sanitize.js";
import { writeReportFile as writeReportFileHelper } from "../../../handlers/knit/file-ops.js";
import { isControlReady, logger, runtime, jobs, serverState, getDirectory, readJsonBody } from "./runtime.js";
import { probeMeetingsDir } from "./filters.js";
import { discoverFiltered, discoverRaw } from "./discovery.js";
import { validateParticipants, normalizeFeatures, buildMeetingAgentTools, dashboardCallbacks } from "./forms.js";

export async function handleStartMeeting(req) {
  if (serverState.runningMeetingId || serverState.startInFlight) {
    return Response.json({ error: "a deliberation is already running", meeting_id: serverState.runningMeetingId }, { status: 409 });
  }
  serverState.startInFlight = true;
  try {
    return await handleStartMeetingInternal(req);
  } finally {
    serverState.startInFlight = false;
  }
}

async function handleStartMeetingInternal(req) {
  if (!isControlReady()) {
    return Response.json({ error: "dashboard control plane not ready (plugin client unavailable)" }, { status: 503 });
  }
  if (serverState.runningMeetingId) {
    return Response.json({ error: "a deliberation is already running", meeting_id: serverState.runningMeetingId }, { status: 409 });
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  const question = sanitizeForPrompt(String(body?.question ?? ""), 5000);
  if (!question || question.trim().length < 3) {
    return Response.json({ error: "question required (≥3 chars)" }, { status: 400 });
  }
  if (body?.approved !== true) {
    return Response.json({ error: "explicit approval required — confirm personas and models (approved:true) before starting" }, { status: 400 });
  }
  const participantError = validateParticipants(body?.participants);
  if (participantError) {
    return Response.json({ error: participantError }, { status: 400 });
  }
  const requestedFeatures = body?.features && typeof body.features === "object" ? body.features : {};
  const features = normalizeFeatures(requestedFeatures);
  const requestedOrchestrator = body?.orchestrator && typeof body.orchestrator === "object" ? body.orchestrator : {};
  const { config: orchestratorConfig, rejected: rejectedOrchestrator } = validateOrchestratorConfig(requestedOrchestrator);
  if (rejectedOrchestrator.length > 0) {
    logger.warn("dashboard_orchestrator_rejected", `Ignoring invalid orchestrator option(s), using defaults: ${rejectedOrchestrator.map((r) => `${r.field}='${r.value}'`).join(", ")}`);
  }
  let maxRounds = body?.max_rounds ?? getConfig().defaultMaxRounds;
  if (!Number.isFinite(maxRounds) || maxRounds < 1) maxRounds = getConfig().defaultMaxRounds;
  maxRounds = Math.min(10, Math.max(1, Math.floor(maxRounds)));
  const context = body?.context ? sanitizeForPrompt(String(body.context), 8000) : "No additional context provided.";

  let available;
  let disabledSet = null;
  let globalUnhealthy = new Set();
  try {
    const discovered = await discoverFiltered();
    available = discovered.available;
    disabledSet = discovered.disabledSet;
    globalUnhealthy = discovered.globalUnhealthy;
  } catch (err) {
    return Response.json({ error: `model discovery failed: ${extractErrorInfo(err).message}` }, { status: 500 });
  }
  if (available.length === 0) {
    return Response.json({ error: "no models available — enable at least one provider model first" }, { status: 400 });
  }

  if (Array.isArray(body?.models) && body.models.length > 0) {
    logger.warn("dashboard_legacy_models_ignored", "Per-tier `models[]` are no longer supported — seats use per-seat models or random assignment");
  }
  const allowedKeys = new Set(available.map((m) => `${m.providerID}/${m.modelID}`));
  const variantsByKey = new Map(available.map((m) => [`${m.providerID}/${m.modelID}`, Array.isArray(m.variants) ? m.variants : []]));
  const readVariant = (raw) => (raw && typeof raw.variant === "string" && raw.variant ? raw.variant : null);
  const rawOrchestrator = body?.orchestrator_model ?? (orchestratorConfig.model ? {
    provider_id: orchestratorConfig.model.split("/")[0],
    model_id: orchestratorConfig.model.split("/").slice(1).join("/"),
  } : null);
  const orchestratorProvider = rawOrchestrator?.provider_id ?? rawOrchestrator?.providerID;
  const orchestratorModel = rawOrchestrator?.model_id ?? rawOrchestrator?.modelID;
  const orchestratorKey = orchestratorProvider && orchestratorModel ? `${orchestratorProvider}/${orchestratorModel}` : null;
  if (!orchestratorKey || !allowedKeys.has(orchestratorKey) || (disabledSet instanceof Set && disabledSet.has(orchestratorKey)) || globalUnhealthy.has(orchestratorKey)) {
    return Response.json({ error: "orchestrator_model must be an enabled, healthy model" }, { status: 400 });
  }
  const orchestratorVariant = readVariant(rawOrchestrator);
  if (orchestratorVariant && !(variantsByKey.get(orchestratorKey) ?? []).includes(orchestratorVariant)) {
    return Response.json({ error: `unknown variant "${orchestratorVariant}" for model ${orchestratorKey}` }, { status: 400 });
  }
  const resolvedOrchestratorConfig = { ...orchestratorConfig, model: orchestratorKey };

  const seenIds = new Set();
  let dedup = 0;
  let participants = body.participants.map((p, i) => {
    const rawTags = p.tags ?? p.expertise ?? ["general"];
    const tags = Array.isArray(rawTags) ? rawTags : typeof rawTags === "string" ? [rawTags] : ["general"];
    const slug = String(p.name).toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    let id = `${slug}_${i}`;
    if (seenIds.has(id)) id = `${id}_${++dedup}`;
    seenIds.add(id);
    let seatModel = null;
    const rawModel = p.model;
    if (rawModel && typeof rawModel === "object") {
      const providerId = rawModel.provider_id ?? rawModel.providerID;
      const modelId = rawModel.model_id ?? rawModel.modelID;
      if (providerId && modelId) {
        seatModel = { providerID: providerId, modelID: modelId };
        const v = readVariant(rawModel);
        if (v) seatModel.variant = v;
      }
    }
    if (seatModel) {
      const seatKey = `${seatModel.providerID}/${seatModel.modelID}`;
      const blocked = (disabledSet instanceof Set && disabledSet.has(seatKey)) || globalUnhealthy.has(seatKey);
      if (!allowedKeys.has(seatKey) || blocked) {
        logger.warn("dashboard_seat_model_blocked", `Per-seat model ${seatKey} for ${p.name} is disabled/unhealthy/unknown — falling back to random assignment`);
        seatModel = null;
      } else if (seatModel.variant && !(variantsByKey.get(seatKey) ?? []).includes(seatModel.variant)) {
        logger.warn("dashboard_seat_variant_unknown", `Variant "${seatModel.variant}" for ${p.name} is not offered by ${seatKey} — using the server default`);
        delete seatModel.variant;
      }
    }
    return {
      id,
      name: p.name,
      persona: sanitizeForPrompt(String(p.persona), 4000),
      agenda: sanitizeForPrompt(String(p.agenda), 2000),
      category: p.category ?? p.tier,
      model: seatModel,
      tags,
      expertise: Array.isArray(p.expertise) ? p.expertise : [],
      known_biases: Array.isArray(p.known_biases) ? p.known_biases : [],
      communication_style: sanitizeForPrompt(String(p.communication_style ?? ""), 800),
      preferred_contribution_types: Array.isArray(p.preferred_contribution_types) ? p.preferred_contribution_types : [],
      anti_patterns: Array.isArray(p.anti_patterns) ? p.anti_patterns : [],
      category_guidance: sanitizeForPrompt(String(p.category_guidance ?? p.tier_guidance ?? ""), 1600),
      reflection_guidance: sanitizeForPrompt(String(p.reflection_guidance ?? ""), 1600),
    };
  });
  try {
    const { sessionModel } = await discoverRaw();
    participants = assignModelsToParticipants(participants, available, sessionModel);
  } catch (err) {
    logger.warn("dashboard_assign_models_failed", "Model assignment failed — proceeding without assignment", extractErrorInfo(err));
  }
  if (participants.some((p) => !p.model)) {
    return Response.json({ error: "model assignment failed — no model for every seat" }, { status: 500 });
  }

  const resolvedOrchestrator = { providerID: orchestratorProvider, modelID: orchestratorModel };
  if (orchestratorVariant) resolvedOrchestrator.variant = orchestratorVariant;
  const meetingId = crypto.randomUUID();
  const sessionID = runtime.ownerSessionId || `dashboard-${meetingId.slice(0, 8)}`;
  const probe = probeMeetingsDir();
  if (!probe.ok) {
    logger.error("dashboard_meetings_dir_not_writable", `Meetings directory is not writable: ${probe.dir}`, { error: probe.error });
    return Response.json({
      error: `Cannot write to meetings directory ${probe.dir} (${probe.error}) — check ownership/permissions. [db_dir_not_writable]`,
      code: "db_dir_not_writable",
      detail: probe.error,
    }, { status: 500 });
  }
  let dbPath;
  try {
    dbPath = getMeetingDbPath(getDirectory(), meetingId);
    if (!dbPath) throw new Error("could not resolve meeting db path");
    const db = await MeetingDatabase.create(dbPath, meetingId);
    try {
      db.initializeMeeting({
        question,
        context,
        maxRounds,
        tags: [],
        parentSessionId: sessionID,
        opencodeSessionId: sessionID,
        embedding_model: null,
        embedding_dim: null,
        orchestrator: resolvedOrchestrator,
        orchestratorConfig: resolvedOrchestratorConfig,
        features,
        participants: [],
      });
      db.insertParticipants(participants);
    } finally {
      try { db.close(); } catch {}
    }
    try { invalidateMeetingsCache(getDirectory()); } catch {}
    logger.info("meeting_created", `Meeting DB ready at ${dbPath}`, { meetingId, dbPath, sessionID, directory: getDirectory() });
  } catch (err) {
    const info = extractErrorInfo(err);
    logger.error("dashboard_meeting_setup_failed", "Meeting DB setup failed", { ...info, dbPath });
    return Response.json({
      error: `Could not create the meeting database ${dbPath ? `at ${dbPath} ` : ""}(${info.message}). [db_open_failed]`,
      code: "db_open_failed",
      detail: info.message,
    }, { status: 500 });
  }

  const engine = new MeetingOrchestrator({
    client: runtime.client,
    directory: getDirectory(),
    meetingId,
    question,
    context,
    parentSessionId: sessionID,
    opencodeSessionId: sessionID,
    participants,
    maxRounds,
    tags: [],
    orchestratorModel: resolvedOrchestrator,
    orchestratorConfig: resolvedOrchestratorConfig,
    agentTools: buildMeetingAgentTools(features),
    availableModels: available,
    ...dashboardCallbacks(),
  });

  runtime.activeLooms.set(meetingId, engine);
  serverState.runningMeetingId = meetingId;
  jobs.set(meetingId, { phase: "running", startedAt: new Date().toISOString(), extended: false });

  (async () => {
    try {
      await engine.initialize();
      const artifact = await engine.runMeeting();
      const state = engine.getState();
      const safeQuestion = sanitizeForDisplay(question, 5000);
      const fullReport = `# Loom Deliberation Output\n\n**Question:** ${safeQuestion}\n\n**Participants:** ${participants.map((p) => `${p.name} (${p.category ?? p.tier})`).join(", ")}\n\n**Rounds:** ${state.current_round}\n\n**Meeting ID:** ${engine.getMeetingId()}\n\n---\n\n${artifact}`;
      writeReportFileHelper(getDirectory(), engine.getMeetingId(), fullReport, logger);
      jobs.set(meetingId, { phase: "done", startedAt: jobs.get(meetingId)?.startedAt ?? null, finishedAt: new Date().toISOString() });
    } catch (err) {
      logger.error("dashboard_meeting_failed", "Dashboard deliberation failed", extractErrorInfo(err));
      jobs.set(meetingId, { phase: "error", error: extractErrorInfo(err).message, startedAt: jobs.get(meetingId)?.startedAt ?? null });
    } finally {
      runtime.activeLooms.delete(meetingId);
      try { await engine.close(); } catch {}
      if (serverState.runningMeetingId === meetingId) serverState.runningMeetingId = null;
    }
  })();

  return Response.json({ ok: true, meeting_id: meetingId, ...(rejectedOrchestrator.length > 0 ? { orchestrator_warnings: rejectedOrchestrator } : {}) }, { status: 202 });
}

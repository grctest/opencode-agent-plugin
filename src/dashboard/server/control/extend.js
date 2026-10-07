/**
 * POST /api/meetings/extend — continue a finished meeting with new input.
 */
import { MeetingOrchestrator } from "../../../orchestrator.js";
import { normalizeOrchestratorConfig } from "../../../orchestrator/models.js";
import { MeetingDatabase, getDbPathForMeeting } from "../../../database.js";
import { invalidateMeetingsCache } from "../../api/free.js";
import { getConfig } from "../../../config.js";
import { extractErrorInfo } from "../../../logger.js";
import { sanitizeForPrompt, sanitizeForDisplay } from "../../../utils/sanitize.js";
import { writeReportFile as writeReportFileHelper } from "../../../handlers/knit/file-ops.js";
import { isControlReady, logger, runtime, jobs, serverState, getDirectory, readJsonBody } from "./runtime.js";
import { discoverFiltered } from "./discovery.js";
import { storedVariantFor, normalizeFeatures, buildMeetingAgentTools, dashboardCallbacks } from "./forms.js";

export async function handleExtendMeeting(req) {
  if (serverState.runningMeetingId || serverState.startInFlight) {
    return Response.json({ error: "a deliberation is already running", meeting_id: serverState.runningMeetingId }, { status: 409 });
  }
  serverState.startInFlight = true;
  try {
    return await handleExtendMeetingInternal(req);
  } finally {
    serverState.startInFlight = false;
  }
}

async function handleExtendMeetingInternal(req) {
  if (!isControlReady()) {
    return Response.json({ error: "dashboard control plane not ready" }, { status: 503 });
  }
  if (serverState.runningMeetingId) {
    return Response.json({ error: "a deliberation is already running", meeting_id: serverState.runningMeetingId }, { status: 409 });
  }
  let body;
  try {
    body = await readJsonBody(req, 64 * 1024);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  const meetingId = body?.meeting_id ?? body?.meetingId ?? body?.meeting;
  const question = sanitizeForPrompt(String(body?.question ?? ""), 5000);
  if (!meetingId || typeof meetingId !== "string") {
    return Response.json({ error: "meeting_id required" }, { status: 400 });
  }
  if (!question || question.trim().length < 3) {
    return Response.json({ error: "question required (≥3 chars)" }, { status: 400 });
  }
  const extDbPath = getDbPathForMeeting(getDirectory(), meetingId);
  if (!extDbPath) {
    return Response.json({ error: "meeting database not found" }, { status: 404 });
  }
  let existingParts;
  let existingMeeting;
  try {
    existingParts = await MeetingDatabase.readParticipants(extDbPath);
    existingMeeting = await MeetingDatabase.readMeeting(extDbPath);
  } catch (err) {
    return Response.json({ error: `could not read meeting: ${extractErrorInfo(err).message}` }, { status: 500 });
  }
  if (existingParts.length === 0) {
    return Response.json({ error: "no participants in existing meeting" }, { status: 400 });
  }
  let available = [];
  try {
    available = (await discoverFiltered()).available;
  } catch {}
  const allowedKeys = new Set(available.map((m) => `${m.providerID}/${m.modelID}`));
  const variantsByKey = new Map(available.map((m) => [`${m.providerID}/${m.modelID}`, Array.isArray(m.variants) ? m.variants : []]));
  let storedFeatures = {};
  try { storedFeatures = existingMeeting?.feature_toggles_json ? JSON.parse(existingMeeting.feature_toggles_json) : {}; } catch {}
  const extensionFeatures = normalizeFeatures(storedFeatures);
  let storedOrchestrator = {};
  try { storedOrchestrator = existingMeeting?.orchestrator_config_json ? JSON.parse(existingMeeting.orchestrator_config_json) : {}; } catch {}
  const extensionOrchestratorConfig = normalizeOrchestratorConfig(storedOrchestrator);
  const extensionOrchestratorKey = existingMeeting?.orchestrator_provider_id && existingMeeting?.orchestrator_model_id
    ? `${existingMeeting.orchestrator_provider_id}/${existingMeeting.orchestrator_model_id}`
    : null;
  const extensionOrchestrator = extensionOrchestratorKey && allowedKeys.has(extensionOrchestratorKey)
    ? {
      providerID: existingMeeting.orchestrator_provider_id,
      modelID: existingMeeting.orchestrator_model_id,
      ...(storedVariantFor(extensionOrchestratorKey, existingMeeting?.orchestrator_model_variant, variantsByKey)
        ? { variant: existingMeeting.orchestrator_model_variant }
        : {}),
    }
    : null;
  const resolvedExtensionOrchestratorConfig = {
    ...extensionOrchestratorConfig,
    model: extensionOrchestrator ? `${extensionOrchestrator.providerID}/${extensionOrchestrator.modelID}` : extensionOrchestratorConfig.model,
  };
  const sessionID = runtime.ownerSessionId || `dashboard-${meetingId.slice(0, 8)}`;
  const context = body?.context ? sanitizeForPrompt(String(body.context), 8000) : "No additional context provided.";

  let additionalRounds;
  if (body?.additional_rounds !== undefined && body?.additional_rounds !== null) {
    const n = Math.floor(Number(body.additional_rounds));
    if (Number.isFinite(n) && n >= 1) additionalRounds = Math.min(10, n);
  }

  const extEngine = new MeetingOrchestrator({
    client: runtime.client,
    directory: getDirectory(),
    meetingId,
    resume: true,
    allowExtend: true,
    question,
    context,
    parentSessionId: sessionID,
    opencodeSessionId: sessionID,
    participants: existingParts.map((p) => {
      const modelKey = p.provider_id && p.model_id ? `${p.provider_id}/${p.model_id}` : null;
      const variant = modelKey ? storedVariantFor(modelKey, p.model_variant, variantsByKey) : null;
      return {
        id: p.id,
        name: p.name,
        persona: p.persona,
        agenda: p.agenda,
        category: p.category ?? p.tier,
        model: modelKey && allowedKeys.has(modelKey)
          ? { providerID: p.provider_id, modelID: p.model_id, ...(variant ? { variant } : {}) }
          : undefined,
        tags: Array.isArray(p.tags) ? p.tags : [],
        expertise: Array.isArray(p.expertise) ? p.expertise : [],
        known_biases: Array.isArray(p.known_biases) ? p.known_biases : [],
        communication_style: p.communication_style ?? "",
        preferred_contribution_types: Array.isArray(p.preferred_contribution_types) ? p.preferred_contribution_types : [],
        anti_patterns: Array.isArray(p.anti_patterns) ? p.anti_patterns : [],
        category_guidance: p.category_guidance ?? p.tier_guidance ?? "",
        reflection_guidance: p.reflection_guidance ?? "",
      };
    }),
    maxRounds: Math.min(10, Math.max(1, Math.floor(Number(getConfig().defaultMaxRounds) || 4))),
    orchestratorModel: extensionOrchestrator,
    orchestratorConfig: resolvedExtensionOrchestratorConfig,
    agentTools: buildMeetingAgentTools(extensionFeatures),
    availableModels: available,
    ...dashboardCallbacks(),
  });

  runtime.activeLooms.set(meetingId, extEngine);
  serverState.runningMeetingId = meetingId;
  jobs.set(meetingId, { phase: "running", startedAt: new Date().toISOString(), extended: true });
  try { invalidateMeetingsCache(getDirectory()); } catch {}

  (async () => {
    try {
      await extEngine.initialize();
      const artifact = await extEngine.extendMeeting(question, additionalRounds);
      const extState = extEngine.getState();
      const fullReport = `# Loom Deliberation (Extended)\n\n**New Input:** ${sanitizeForDisplay(question, 5000)}\n\n**Participants:** ${existingParts.map((p) => `${p.name} (${p.category ?? p.tier})`).join(", ")}\n\n**Total Rounds:** ${extState.current_round}\n\n**Meeting ID:** ${extEngine.getMeetingId()}\n\n---\n\n${artifact}`;
      writeReportFileHelper(getDirectory(), extEngine.getMeetingId(), fullReport, logger);
      jobs.set(meetingId, { phase: "done", startedAt: jobs.get(meetingId)?.startedAt ?? null, finishedAt: new Date().toISOString(), extended: true });
    } catch (err) {
      logger.error("dashboard_extend_failed", "Dashboard extension failed", extractErrorInfo(err));
      jobs.set(meetingId, { phase: "error", error: extractErrorInfo(err).message, startedAt: jobs.get(meetingId)?.startedAt ?? null });
    } finally {
      runtime.activeLooms.delete(meetingId);
      try { await extEngine.close(); } catch {}
      if (serverState.runningMeetingId === meetingId) serverState.runningMeetingId = null;
    }
  })();

  return Response.json({ ok: true, meeting_id: meetingId }, { status: 202 });
}

/**
 * Crash recovery: shared readonly loader, resume, finish, cancel, job status.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { MeetingOrchestrator } from "../../../orchestrator.js";
import { normalizeOrchestratorConfig } from "../../../orchestrator/models.js";
import { MeetingDatabase, getDbPathForMeeting } from "../../../database.js";
import { DashboardApi } from "../../api.js";
import { resolveLoomBaseDir } from "../../../paths.js";
import { invalidateMeetingsCache } from "../../api/free.js";
import { getConfig } from "../../../config.js";
import { extractErrorInfo } from "../../../logger.js";
import { sanitizeForDisplay } from "../../../utils/sanitize.js";
import { writeReportFile as writeReportFileHelper } from "../../../handlers/knit/file-ops.js";
import { repairDatabase } from "../../../database/connection.js";
import { TERMINAL_STATUSES } from "../../../constants.js";
import { resetPollCursorsForMeeting } from "../poll-cursors.js";
import { isControlReady, logger, runtime, jobs, serverState, getDirectory, readJsonBody } from "./runtime.js";
import { discoverFiltered } from "./discovery.js";
import { storedVariantFor, normalizeFeatures, buildMeetingAgentTools, dashboardCallbacks } from "./forms.js";

export function handleJobStatus(url) {
  const meetingId = url.searchParams.get("meeting");
  if (meetingId) {
    const job = jobs.get(meetingId);
    return Response.json({ meeting_id: meetingId, job: job ?? null, running: serverState.runningMeetingId });
  }
  return Response.json({ running: serverState.runningMeetingId, jobs: Object.fromEntries(jobs) });
}

export async function handleCancelMeeting(req) {
  if (!isControlReady()) {
    return Response.json({ error: "dashboard control plane not ready" }, { status: 503 });
  }
  let body;
  try {
    body = await readJsonBody(req, 16 * 1024);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  const meetingId = body?.meeting_id ?? body?.meetingId ?? body?.meeting;
  if (!meetingId || typeof meetingId !== "string") {
    return Response.json({ error: "meeting_id required" }, { status: 400 });
  }
  const engine = runtime.activeLooms.get(meetingId);
  if (!engine) {
    return Response.json({ error: "no active deliberation with that ID" }, { status: 404 });
  }
  try {
    engine.cancel();
    return Response.json({ ok: true, meeting_id: meetingId });
  } catch (err) {
    return Response.json({ error: extractErrorInfo(err).message }, { status: 500 });
  }
}

async function loadRecoveryContext(meetingId) {
  const dbPath = getDbPathForMeeting(getDirectory(), meetingId);
  if (!dbPath) return { failed: Response.json({ error: "meeting database not found", code: "meeting_not_found", meeting_id: meetingId, resumable: false }, { status: 404 }) };
  let recovered = false;
  try {
    const hot = existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`) || existsSync(`${dbPath}-journal`);
    if (hot) recovered = repairDatabase(dbPath);
  } catch {}
  let existingParts;
  let existingMeeting;
  try {
    existingParts = await MeetingDatabase.readParticipants(dbPath);
    existingMeeting = await MeetingDatabase.readMeeting(dbPath);
  } catch (err) {
    try { if (repairDatabase(dbPath)) recovered = true; } catch {}
    try {
      existingParts = await MeetingDatabase.readParticipants(dbPath);
      existingMeeting = await MeetingDatabase.readMeeting(dbPath);
    } catch (err2) {
      return { failed: Response.json({ error: `could not read meeting: ${extractErrorInfo(err2).message}`, code: "db_read_failed", meeting_id: meetingId, resumable: false }, { status: 500 }) };
    }
  }
  let degraded = false;
  try {
    degraded = statSync(`${dbPath}-wal`).size > 0;
  } catch {}
  if (!existingMeeting) {
    return { failed: Response.json({ error: "meeting row not found in database", code: "meeting_not_found", meeting_id: meetingId, resumable: false }, { status: 404 }) };
  }
  if (degraded) {
    return { failed: Response.json({
      error: "This database could not be fully recovered — its write-ahead log is on a volume where checkpointing fails (read-only or locked). You can view everything recorded so far; resuming stays blocked until write access is restored.",
      code: "db_degraded_readonly",
      meeting_id: meetingId,
      resumable: false,
    }, { status: 500 }) };
  }
  let available = [];
  try {
    available = (await discoverFiltered()).available;
  } catch {}
  const allowedKeys = new Set(available.map((m) => `${m.providerID}/${m.modelID}`));
  const variantsByKey = new Map(available.map((m) => [`${m.providerID}/${m.modelID}`, Array.isArray(m.variants) ? m.variants : []]));
  let storedFeatures = {};
  try { storedFeatures = existingMeeting?.feature_toggles_json ? JSON.parse(existingMeeting.feature_toggles_json) : {}; } catch {}
  const features = normalizeFeatures(storedFeatures);
  let storedOrchestrator = {};
  try { storedOrchestrator = existingMeeting?.orchestrator_config_json ? JSON.parse(existingMeeting.orchestrator_config_json) : {}; } catch {}
  const orchestratorConfigBase = normalizeOrchestratorConfig(storedOrchestrator);
  const warnings = [];
  const storedOrchKey = existingMeeting?.orchestrator_provider_id && existingMeeting?.orchestrator_model_id
    ? `${existingMeeting.orchestrator_provider_id}/${existingMeeting.orchestrator_model_id}`
    : null;
  let orchestrator = null;
  if (storedOrchKey) {
    if (allowedKeys.has(storedOrchKey)) {
      orchestrator = { providerID: existingMeeting.orchestrator_provider_id, modelID: existingMeeting.orchestrator_model_id };
      const storedVariant = storedVariantFor(storedOrchKey, existingMeeting?.orchestrator_model_variant, variantsByKey);
      if (storedVariant) {
        orchestrator.variant = storedVariant;
      } else if (typeof existingMeeting?.orchestrator_model_variant === "string" && existingMeeting.orchestrator_model_variant) {
        warnings.push({ type: "model_substituted", seat: "orchestrator", requested: `${storedOrchKey}#${existingMeeting.orchestrator_model_variant}`, detail: "stored orchestrator variant unavailable — server default applies" });
      }
    } else {
      warnings.push({ type: "model_substituted", seat: "orchestrator", requested: storedOrchKey, detail: "stored orchestrator model unavailable — fallback resolution applies at run time" });
    }
  }
  const orchestratorConfig = {
    ...orchestratorConfigBase,
    model: orchestrator ? `${orchestrator.providerID}/${orchestrator.modelID}` : orchestratorConfigBase.model,
  };
  const participants = existingParts.map((p) => {
    const modelKey = p.provider_id && p.model_id ? `${p.provider_id}/${p.model_id}` : null;
    if (modelKey && !allowedKeys.has(modelKey)) {
      warnings.push({ type: "model_substituted", seat: p.name, requested: modelKey, detail: "stored seat model unavailable — fallback resolution applies at run time" });
    }
    const ok = modelKey && allowedKeys.has(modelKey);
    const variant = ok ? storedVariantFor(modelKey, p.model_variant, variantsByKey) : null;
    if (ok && !variant && typeof p.model_variant === "string" && p.model_variant) {
      warnings.push({ type: "model_substituted", seat: p.name, requested: `${modelKey}#${p.model_variant}`, detail: "stored seat variant unavailable — server default applies" });
    }
    return {
      id: p.id,
      name: p.name,
      persona: p.persona,
      agenda: p.agenda,
      category: p.category ?? p.tier,
      model: ok ? { providerID: p.provider_id, modelID: p.model_id, ...(variant ? { variant } : {}) } : undefined,
      tags: Array.isArray(p.tags) ? p.tags : [],
      expertise: Array.isArray(p.expertise) ? p.expertise : [],
      known_biases: Array.isArray(p.known_biases) ? p.known_biases : [],
      communication_style: p.communication_style ?? "",
      preferred_contribution_types: Array.isArray(p.preferred_contribution_types) ? p.preferred_contribution_types : [],
      anti_patterns: Array.isArray(p.anti_patterns) ? p.anti_patterns : [],
      category_guidance: p.category_guidance ?? p.tier_guidance ?? "",
      reflection_guidance: p.reflection_guidance ?? "",
    };
  });
  return { ok: true, dbPath, existingParts, existingMeeting, available, allowedKeys, features, orchestrator, orchestratorConfig, participants, warnings, recovered, degraded };
}

async function resetStuckSpeaking(dbPath, meetingId) {
  try {
    await MeetingDatabase.withTransaction(dbPath, (db) => {
      db.prepare("UPDATE participants SET status = 'listening' WHERE meeting_id = ? AND status = 'speaking'").run(meetingId);
    });
  } catch (err) {
    logger.debug("resume_hygiene_failed", "Could not reset stuck speaking rows (best effort)", extractErrorInfo(err));
  }
}

function reportPathFor(directory, meetingId) {
  return join(resolveLoomBaseDir(directory), "meetings", `${meetingId}.md`);
}

function writeRecoveryReport(meetingId, question, parts, currentRound, artifact, tag) {
  const fullReport = `# Loom Deliberation Output (${tag})\n\n**Question:** ${sanitizeForDisplay(question, 5000)}\n\n**Participants:** ${parts.map((p) => `${p.name} (${p.category ?? p.tier})`).join(", ")}\n\n**Rounds:** ${currentRound}\n\n**Meeting ID:** ${meetingId}\n\n---\n\n${artifact}`;
  return writeReportFileHelper(getDirectory(), meetingId, fullReport, logger);
}

export async function handleResumeMeeting(req) {
  if (serverState.runningMeetingId || serverState.startInFlight) {
    return Response.json({ error: "a deliberation is already running", meeting_id: serverState.runningMeetingId }, { status: 409 });
  }
  serverState.startInFlight = true;
  try {
    return await handleResumeWithContext(req, "resume");
  } finally {
    serverState.startInFlight = false;
  }
}

async function handleResumeWithContext(req, _mode) {
  if (!isControlReady()) {
    return Response.json({ error: "dashboard control plane not ready" }, { status: 503 });
  }
  if (serverState.runningMeetingId) {
    return Response.json({ error: "a deliberation is already running", meeting_id: serverState.runningMeetingId }, { status: 409 });
  }
  let body;
  try {
    body = await readJsonBody(req, 16 * 1024);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  const meetingId = body?.meeting_id ?? body?.meetingId ?? body?.meeting;
  if (!meetingId || typeof meetingId !== "string") {
    return Response.json({ error: "meeting_id required" }, { status: 400 });
  }
  const ctx = await loadRecoveryContext(meetingId);
  if (ctx.failed) return ctx.failed;
  const { dbPath: resumeDbPath, existingParts, existingMeeting } = ctx;
  if (existingParts.length === 0) {
    return Response.json({ error: "meeting was interrupted before participants were saved — it cannot be resumed. Start a fresh deliberation from the dashboard Setup tab.", code: "no_participants", meeting_id: meetingId, resumable: false }, { status: 400 });
  }
  if (TERMINAL_STATUSES.has(existingMeeting.status)) {
    return Response.json({ error: `meeting is already ${existingMeeting.status} — start a fresh deliberation or extend it from the dashboard`, code: "meeting_terminal", meeting_id: meetingId, resumable: false, status: existingMeeting.status }, { status: 400 });
  }
  if (existingMeeting.status !== "weaving" && existingMeeting.status !== "initializing") {
    return Response.json({ error: `meeting status '${existingMeeting.status}' cannot be resumed`, code: "unresumable_status", meeting_id: meetingId, resumable: false, status: existingMeeting.status }, { status: 400 });
  }
  if (ctx.participants.length > 0 && ctx.participants.every((p) => !p.model) && ctx.available.length === 0) {
    return Response.json({ error: "no models available — enable at least one provider model first, then resume", code: "no_models", meeting_id: meetingId, resumable: false }, { status: 400 });
  }
  let resumeMaxRounds = Math.min(10, Math.max(1, Math.floor(Number(existingMeeting.max_rounds) || Number(getConfig().defaultMaxRounds) || 4)));
  const restoredRound = Number(existingMeeting.round ?? 0);
  if (restoredRound >= resumeMaxRounds) resumeMaxRounds = Math.min(10, resumeMaxRounds + 1);
  const resumeParentSessionId = typeof existingMeeting.parent_session_id === "string" && existingMeeting.parent_session_id
    ? existingMeeting.parent_session_id
    : (runtime.ownerSessionId || `dashboard-${meetingId.slice(0, 8)}`);
  const resumeOpencodeSessionId = typeof existingMeeting.opencode_session_id === "string" && existingMeeting.opencode_session_id
    ? existingMeeting.opencode_session_id
    : resumeParentSessionId;
  const resumeQuestion = typeof existingMeeting.question === "string" && existingMeeting.question.trim().length >= 3
    ? existingMeeting.question
    : "Resumed deliberation";
  const resumeContext = typeof existingMeeting.context === "string" ? existingMeeting.context : "No additional context provided.";

  const resumeEngine = new MeetingOrchestrator({
    client: runtime.client,
    directory: getDirectory(),
    meetingId,
    resume: true,
    question: resumeQuestion,
    context: resumeContext,
    parentSessionId: resumeParentSessionId,
    opencodeSessionId: resumeOpencodeSessionId,
    participants: ctx.participants,
    maxRounds: resumeMaxRounds,
    orchestratorModel: ctx.orchestrator,
    orchestratorConfig: ctx.orchestratorConfig,
    agentTools: buildMeetingAgentTools(ctx.features),
    availableModels: ctx.available,
    ...dashboardCallbacks(),
  });

  runtime.activeLooms.set(meetingId, resumeEngine);
  serverState.runningMeetingId = meetingId;
  jobs.set(meetingId, { phase: "running", startedAt: new Date().toISOString(), resumed: true });
  try { invalidateMeetingsCache(getDirectory()); } catch {}

  const resumeWarnings = ctx.warnings;
  (async () => {
    try {
      await resetStuckSpeaking(resumeDbPath, meetingId);
      try { resetPollCursorsForMeeting(meetingId); } catch {}
      await resumeEngine.initialize();
      const artifact = await resumeEngine.resumeMeeting();
      const resumeState = resumeEngine.getState();
      writeRecoveryReport(meetingId, resumeQuestion, existingParts, resumeState.current_round, artifact, "Resumed");
      jobs.set(meetingId, { phase: "done", startedAt: jobs.get(meetingId)?.startedAt ?? null, finishedAt: new Date().toISOString(), resumed: true });
    } catch (err) {
      logger.error("dashboard_resume_failed", "Dashboard resume failed", extractErrorInfo(err));
      jobs.set(meetingId, { phase: "error", error: extractErrorInfo(err).message, startedAt: jobs.get(meetingId)?.startedAt ?? null, resumed: true });
    } finally {
      runtime.activeLooms.delete(meetingId);
      try { await resumeEngine.close(); } catch {}
      if (serverState.runningMeetingId === meetingId) serverState.runningMeetingId = null;
    }
  })();

  return Response.json({ ok: true, meeting_id: meetingId, resumed: true, warnings: resumeWarnings, recovered: ctx.recovered, degraded: ctx.degraded }, { status: 202 });
}

export async function handleFinishMeeting(req) {
  if (serverState.runningMeetingId || serverState.startInFlight) {
    return Response.json({ error: "a deliberation is already running", meeting_id: serverState.runningMeetingId }, { status: 409 });
  }
  serverState.startInFlight = true;
  try {
    return await handleFinishMeetingInternal(req);
  } finally {
    serverState.startInFlight = false;
  }
}

async function handleFinishMeetingInternal(req) {
  if (!isControlReady()) {
    return Response.json({ error: "dashboard control plane not ready" }, { status: 503 });
  }
  if (serverState.runningMeetingId) {
    return Response.json({ error: "a deliberation is already running", meeting_id: serverState.runningMeetingId }, { status: 409 });
  }
  let body;
  try {
    body = await readJsonBody(req, 16 * 1024);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  const meetingId = body?.meeting_id ?? body?.meetingId ?? body?.meeting;
  if (!meetingId || typeof meetingId !== "string") {
    return Response.json({ error: "meeting_id required" }, { status: 400 });
  }
  const ctx = await loadRecoveryContext(meetingId);
  if (ctx.failed) return ctx.failed;
  const { existingParts, existingMeeting } = ctx;
  if (!TERMINAL_STATUSES.has(existingMeeting.status)) {
    return Response.json({ error: `meeting is still ${existingMeeting.status} — use Resume to continue it`, code: "not_terminal", meeting_id: meetingId, status: existingMeeting.status }, { status: 400 });
  }
  let artifact = null;
  try {
    artifact = DashboardApi.get(ctx.dbPath).getArtifact();
  } catch (err) {
    return Response.json({ error: `could not read artifact: ${extractErrorInfo(err).message}`, code: "db_read_failed", meeting_id: meetingId }, { status: 500 });
  }
  if (artifact?.content) {
    let regenerated = false;
    try {
      if (!existsSync(reportPathFor(getDirectory(), meetingId))) {
        const question = typeof existingMeeting.question === "string" ? existingMeeting.question : "";
        writeRecoveryReport(meetingId, question, existingParts, existingMeeting.round ?? 0, artifact.content, "Recovered");
        regenerated = true;
      }
    } catch {}
    return Response.json({ ok: true, meeting_id: meetingId, finished: true, artifact_present: true, report_regenerated: regenerated, recovered: ctx.recovered, degraded: ctx.degraded });
  }
  if (existingParts.length === 0) {
    return Response.json({ error: "meeting has no participants — synthesis cannot run", code: "no_participants", meeting_id: meetingId }, { status: 400 });
  }
  if (ctx.participants.length > 0 && ctx.participants.every((p) => !p.model) && ctx.available.length === 0) {
    return Response.json({ error: "no models available — enable at least one provider model first, then finish", code: "no_models", meeting_id: meetingId }, { status: 400 });
  }
  const finishParentSessionId = typeof existingMeeting.parent_session_id === "string" && existingMeeting.parent_session_id
    ? existingMeeting.parent_session_id
    : (runtime.ownerSessionId || `dashboard-${meetingId.slice(0, 8)}`);
  const finishOpencodeSessionId = typeof existingMeeting.opencode_session_id === "string" && existingMeeting.opencode_session_id
    ? existingMeeting.opencode_session_id
    : finishParentSessionId;
  const finishQuestion = typeof existingMeeting.question === "string" && existingMeeting.question.trim().length >= 3
    ? existingMeeting.question
    : "Finished deliberation";
  const finishContext = typeof existingMeeting.context === "string" ? existingMeeting.context : "No additional context provided.";
  const finishEngine = new MeetingOrchestrator({
    client: runtime.client,
    directory: getDirectory(),
    meetingId,
    resume: true,
    allowExtend: true,
    question: finishQuestion,
    context: finishContext,
    parentSessionId: finishParentSessionId,
    opencodeSessionId: finishOpencodeSessionId,
    participants: ctx.participants,
    maxRounds: Math.min(10, Math.max(1, Math.floor(Number(existingMeeting.max_rounds) || Number(getConfig().defaultMaxRounds) || 4))),
    orchestratorModel: ctx.orchestrator,
    orchestratorConfig: ctx.orchestratorConfig,
    agentTools: buildMeetingAgentTools(ctx.features),
    availableModels: ctx.available,
    ...dashboardCallbacks(),
  });

  runtime.activeLooms.set(meetingId, finishEngine);
  serverState.runningMeetingId = meetingId;
  jobs.set(meetingId, { phase: "running", startedAt: new Date().toISOString(), finishing: true });
  try { invalidateMeetingsCache(getDirectory()); } catch {}

  const finishWarnings = ctx.warnings;
  const originalStatus = existingMeeting.status;
  (async () => {
    try {
      await resetStuckSpeaking(ctx.dbPath, meetingId);
      await finishEngine.initialize();
      const output = await finishEngine.finishSynthesis(originalStatus);
      const finishState = finishEngine.getState();
      writeRecoveryReport(meetingId, finishQuestion, existingParts, finishState.current_round, output, "Finished");
      jobs.set(meetingId, { phase: "done", startedAt: jobs.get(meetingId)?.startedAt ?? null, finishedAt: new Date().toISOString(), finishing: true });
    } catch (err) {
      logger.error("dashboard_finish_failed", "Dashboard finish failed", extractErrorInfo(err));
      jobs.set(meetingId, { phase: "error", error: extractErrorInfo(err).message, startedAt: jobs.get(meetingId)?.startedAt ?? null, finishing: true });
    } finally {
      runtime.activeLooms.delete(meetingId);
      try { await finishEngine.close(); } catch {}
      if (serverState.runningMeetingId === meetingId) serverState.runningMeetingId = null;
    }
  })();

  return Response.json({ ok: true, meeting_id: meetingId, finishing: true, warnings: finishWarnings, recovered: ctx.recovered, degraded: ctx.degraded }, { status: 202 });
}

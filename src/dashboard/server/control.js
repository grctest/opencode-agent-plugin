/**
 * Dashboard control plane — dashboard-first Loom.
 *
 * The dashboard is the sole control plane for deliberations: room preview,
 * persona approval, model selection, start/cancel/extend. Chat commands
 * (/knit, /list/enable/disable/reset_knit_models) are removed; only
 * /loom_viz (start) and /loom_stop remain.
 *
 * Runtime (opencode client, directory, activeLooms) is injected
 * by the plugin host via setControlRuntime() because the dashboard server
 * module itself has no access to the opencode client otherwise.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, openSync, closeSync, fsyncSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MeetingOrchestrator } from "../../orchestrator.js";
import { normalizeOrchestratorConfig } from "../../orchestrator/models.js";
import { composeRoomWithSimilarity } from "../../composer.js";
import { getPersonas, getPersonaTags } from "../../composer/persona-loader.js";
import { discoverModels, assignModelsToParticipants } from "../../services/model-service.js";
import { createModelPlan } from "../../model-discovery.js";
import { MeetingDatabase, findMeetingBySessionId, getDbPathForMeeting } from "../../database.js";
import { getMeetingDbPath, resolveLoomBaseDir } from "../../paths.js";
import { getConfig } from "../../config.js";
import { Logger, extractErrorInfo } from "../../logger.js";
import { sanitizeForPrompt, sanitizeForDisplay } from "../../utils/sanitize.js";
import { applyModelFilter } from "../../handlers/knit/utils.js";
import { writeReportFile as writeReportFileHelper } from "../../handlers/knit/file-ops.js";
import { loadGlobalHealth, getGlobalUnhealthySet } from "../../services/global-model-health.js";
import { clearGlobalUnhealthy, clearAllGlobalUnhealthy } from "../../services/global-model-health.js";
import { clearGlobalUnhealthyKey, clearAllGlobalUnhealthyKeys } from "../../utils/retry.js";

const logger = new Logger();
const ALLOWED_TIERS = new Set(["junior", "mid", "senior", "principal", "civilian"]);

// Injected by the plugin host (src/plugin/return.js loom_viz execute).
const runtime = {
  client: null,
  directory: null,
  activeLooms: null,
  ownerSessionId: null,
};

export function setControlRuntime(rt) {
  if (rt.client !== undefined) runtime.client = rt.client;
  if (rt.directory !== undefined) runtime.directory = rt.directory;
  if (rt.activeLooms !== undefined) runtime.activeLooms = rt.activeLooms;
  if (rt.ownerSessionId !== undefined) runtime.ownerSessionId = rt.ownerSessionId;
}

export function isControlReady() {
  return !!(runtime.client && runtime.directory && runtime.activeLooms);
}

// meetingId -> { phase: "running"|"done"|"error", error?, startedAt, extended? }
const jobs = new Map();
let runningMeetingId = null;
let startInFlight = false;

function getDirectory() {
  return runtime.directory;
}

function readJsonBody(req, maxBytes = 512 * 1024) {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new Error("Content-Type must be application/json");
  }
  return req.text().then((text) => {
    if (!text) return null;
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("request body too large");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("invalid JSON body");
    }
  });
}

// --- Global model filter (dashboard scope; replaces per-session filter files) ---

function getGlobalFilterPath() {
  return join(resolveLoomBaseDir(getDirectory()), "models-filter.json");
}

function loadGlobalFilter() {
  try {
    const p = getGlobalFilterPath();
    if (!existsSync(p)) return null;
    const data = JSON.parse(readFileSync(p, "utf-8"));
    if (Array.isArray(data.disabledModels)) return new Set(data.disabledModels);
    if (Array.isArray(data.enabledModels)) return { __allowList: new Set(data.enabledModels) };
  } catch (err) {
    logger.warn("dashboard_filter_load_failed", "Failed to load dashboard model filter", extractErrorInfo(err));
  }
  return null;
}

function persistGlobalFilter(disabledSet) {
  try {
    const p = getGlobalFilterPath();
    mkdirSync(resolveLoomBaseDir(getDirectory()), { recursive: true });
    if (!disabledSet || disabledSet.size === 0) {
      try { if (existsSync(p)) unlinkSync(p); } catch {}
      return;
    }
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ disabledModels: [...disabledSet] }, null, 2));
    try { const fd = openSync(tmp, "r"); fsyncSync(fd); closeSync(fd); } catch {}
    renameSync(tmp, p);
  } catch (err) {
    logger.warn("dashboard_filter_persist_failed", "Failed to persist dashboard model filter", extractErrorInfo(err));
  }
}

function migrateAllowList(persisted, allKeys) {
  if (persisted && persisted.__allowList) {
    const enabled = persisted.__allowList;
    return new Set([...allKeys].filter((k) => !enabled.has(k)));
  }
  return persisted;
}

/**
 * Writability probe for the meetings directory. SQLite reports permission
 * problems as generic open failures, so probe first to tell "can't write
 * here" (ownership/permissions) apart from genuine DB corruption.
 */
function probeMeetingsDir() {
  const dir = join(resolveLoomBaseDir(getDirectory()), "meetings");
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.writetest-${process.pid}`);
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    return { ok: true, dir };
  } catch (err) {
    return { ok: false, dir, error: extractErrorInfo(err).message };
  }
}

// Raw provider discovery is expensive (session fetch + provider enumeration,
// often seconds) and changes rarely, so it is cached briefly. Only the raw
// discovery result is cached — the deny-list filter, global-unhealthy set, and
// assignment are recomputed from disk on every call, so filter toggles are
// instant and always correct. Pass force=true (via ?refresh=1) to rescan.
const DISCOVERY_TTL_MS = 60 * 1000;
let discoveryCache = { at: 0, key: null, result: null };

async function discoverRaw(force = false) {
  const key = `${getDirectory()}|${runtime.ownerSessionId || ""}`;
  const now = Date.now();
  if (!force && discoveryCache.result && discoveryCache.key === key && (now - discoveryCache.at) < DISCOVERY_TTL_MS) {
    return discoveryCache.result;
  }
  const result = await discoverModels(
    runtime.client,
    getDirectory(),
    runtime.ownerSessionId || "",
  );
  discoveryCache = { at: now, key, result };
  return result;
}

async function discoverFiltered(force = false) {
  const { available: allAvailable, sessionModel } = await discoverRaw(force);
  let disabledSet = loadGlobalFilter();
  if (disabledSet && disabledSet.__allowList) {
    const allKeys = new Set(allAvailable.map((m) => `${m.providerID}/${m.modelID}`));
    disabledSet = migrateAllowList(disabledSet, allKeys);
    persistGlobalFilter(disabledSet);
  }
  try {
    loadGlobalHealth(getDirectory());
  } catch {}
  const globalUnhealthy = getGlobalUnhealthySet();
  let available = applyModelFilter(allAvailable, disabledSet);
  available = applyModelFilter(available, globalUnhealthy);
  return { allAvailable, available, disabledSet, globalUnhealthy, sessionModel };
}

// --- Personas ---

function personaDto(p, tier) {
  return {
    name: p.name,
    persona: p.persona,
    agenda: p.agenda,
    tier,
    tags: getPersonaTags(p),
    expertise: Array.isArray(p.expertise) ? p.expertise : [],
    known_biases: Array.isArray(p.known_biases) ? p.known_biases : [],
    communication_style: p.communication_style ?? "",
    preferred_contribution_types: Array.isArray(p.preferred_contribution_types) ? p.preferred_contribution_types : [],
    anti_patterns: Array.isArray(p.anti_patterns) ? p.anti_patterns : [],
    tier_guidance: p.tier_guidance ?? "",
    reflection_guidance: p.reflection_guidance ?? "",
  };
}

export function handleListPersonas() {
  const grouped = getPersonas();
  const tiers = {};
  for (const [tier, arr] of Object.entries(grouped)) {
    tiers[tier] = (arr ?? []).map((p) => personaDto(p, tier));
  }
  return Response.json({ tiers });
}

// --- Room preview (real embedding path via a throwaway DB) ---

/**
 * Compose a preview room using the same embedding-based PersonaIndex path as a
 * real run. PersonaIndex needs a meeting DB (FK on persona_embeddings), so the
 * preview runs against a throwaway DB in the OS temp dir that is closed,
 * unindexed, and deleted afterwards — it never appears in the meetings list
 * or session index. Falls back to keyword composition when anything fails
 * (including an unavailable embedder, handled inside composeRoomWithSimilarity).
 */
async function composePreviewRoom(question, context = "") {
  const tempId = crypto.randomUUID();
  const tempPath = join(tmpdir(), `loom-preview-${tempId}.db`);
  let db = null;
  try {
    db = await MeetingDatabase.create(tempPath, tempId);
    db.initializeMeeting({
      question,
      context: "",
      maxRounds: 3,
      tags: [],
      parentSessionId: "preview",
      opencodeSessionId: "preview",
      embedding_model: null,
      embedding_dim: null,
      participants: [],
    }, { skipIndex: true });
    return await composeRoomWithSimilarity(question, db, context);
  } finally {
    try { db?.close(); } catch {}
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try { if (existsSync(tempPath + suffix)) unlinkSync(tempPath + suffix); } catch {}
    }
  }
}

export async function handleRoomPreview(req) {
  if (!isControlReady()) {
    return Response.json({ error: "dashboard control plane not ready (plugin client unavailable)" }, { status: 503 });
  }
  let body;
  try {
    body = await readJsonBody(req, 64 * 1024);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  const question = sanitizeForPrompt(String(body?.question ?? ""), 5000);
  if (!question || question.trim().length < 3) {
    return Response.json({ error: "question required (≥3 chars)" }, { status: 400 });
  }
  let room;
  try {
    room = await composePreviewRoom(question, String(body?.context ?? ""));
  } catch (err) {
    logger.warn("dashboard_preview_fallback", "Throwaway-DB preview failed — falling back to keyword composition", extractErrorInfo(err));
    try {
      room = await composeRoomWithSimilarity(question, null, String(body?.context ?? ""));
    } catch (err2) {
      const info = extractErrorInfo(err2);
      return Response.json({
        error: `Room preview failed (${info.message}). [preview_failed]`,
        code: "preview_failed",
        detail: info.message,
      }, { status: 500 });
    }
  }
  // Attach suggested per-tier models so the UI can pre-fill pickers.
  let suggestedModels = [];
  let suggestedOrchestrator = null;
  try {
    const { available, sessionModel } = await discoverFiltered();
    const pool = available.length > 0 ? available : [];
    if (pool.length > 0) {
      const plan = createModelPlan(pool, undefined, sessionModel);
       suggestedModels = (plan.participants ?? []).map((p) => ({
         tier: p.tier,
         provider_id: p.providerID ?? p.provider_id,
         model_id: p.modelID ?? p.model_id,
       }));
       const orchestrator = plan.orchestrator;
       if (orchestrator?.providerID && orchestrator?.modelID) {
         suggestedOrchestrator = {
           provider_id: orchestrator.providerID,
           model_id: orchestrator.modelID,
           key: `${orchestrator.providerID}/${orchestrator.modelID}`,
         };
       }
    }
  } catch {}
  return Response.json({
    participants: (room.participants ?? []).map((p) => personaDto(p, p.tier)),
    tags: room.tags ?? [],
    estimated_rounds: room.estimated_rounds ?? 3,
    reasoning: room.reasoning ?? "",
     complexity: room.complexity ?? null,
     suggested_models: suggestedModels,
     suggested_orchestrator: suggestedOrchestrator,
   });
}

// --- LLM models (filter + per-tier assignment parity with old chat commands) ---

export async function handleListLlmModels(url = null) {
  if (!isControlReady()) {
    return Response.json({ error: "dashboard control plane not ready (plugin client unavailable)" }, { status: 503 });
  }
  const force = url?.searchParams?.get("refresh") === "1";
  try {
    const { allAvailable, disabledSet, globalUnhealthy, sessionModel } = await discoverFiltered(force);
    if (allAvailable.length === 0) {
      return Response.json({ models: [], disabled: [], session_model: null, suggested: [] });
    }
    const models = allAvailable.map((m) => {
      const key = `${m.providerID}/${m.modelID}`;
      return {
        key,
        provider_id: m.providerID,
        model_id: m.modelID,
        name: m.name || m.modelID,
        cost: m.cost ?? { input: 0, output: 0 },
        context: m.limit?.context ?? 128000,
        reasoning: !!m.reasoning,
        enabled: !disabledSet || !disabledSet.has(key),
        unhealthy: globalUnhealthy.has(key),
      };
    });
    const enabledPool = allAvailable.filter((m) => {
      const key = `${m.providerID}/${m.modelID}`;
      return (!disabledSet || !disabledSet.has(key)) && !globalUnhealthy.has(key);
    });
    let suggested = [];
    let suggestedOrchestrator = null;
    try {
      const plan = createModelPlan(enabledPool.length > 0 ? enabledPool : allAvailable, undefined, sessionModel);
       suggested = (plan.participants ?? []).map((p) => ({
         tier: p.tier,
         provider_id: p.providerID ?? p.provider_id,
         model_id: p.modelID ?? p.model_id,
       }));
       if (plan.orchestrator?.providerID && plan.orchestrator?.modelID) {
         suggestedOrchestrator = {
           provider_id: plan.orchestrator.providerID,
           model_id: plan.orchestrator.modelID,
           key: `${plan.orchestrator.providerID}/${plan.orchestrator.modelID}`,
         };
       }
    } catch {}
    return Response.json({
      models,
      disabled: disabledSet instanceof Set ? [...disabledSet] : [],
       session_model: sessionModel ? `${sessionModel.providerID}/${sessionModel.modelID}` : null,
       suggested,
       suggested_orchestrator: suggestedOrchestrator,
     });
  } catch (err) {
    return Response.json({ error: `model discovery failed: ${extractErrorInfo(err).message}` }, { status: 500 });
  }
}

export async function handleModelFilter(req) {
  if (!isControlReady()) {
    return Response.json({ error: "dashboard control plane not ready (plugin client unavailable)" }, { status: 503 });
  }
  let body;
  try {
    body = await readJsonBody(req, 64 * 1024);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  const action = body?.action;
  const requested = Array.isArray(body?.models) ? body.models.map(String) : [];
  if (!["enable", "disable", "reset"].includes(action)) {
    return Response.json({ error: "action must be one of enable|disable|reset" }, { status: 400 });
  }
  try {
    const { allAvailable } = await discoverFiltered();
    const allKeys = new Set(allAvailable.map((m) => `${m.providerID}/${m.modelID}`));
    let disabledSet = loadGlobalFilter();
    if (disabledSet && disabledSet.__allowList) {
      disabledSet = migrateAllowList(disabledSet, allKeys);
    }
    if (!disabledSet || !(disabledSet instanceof Set)) disabledSet = new Set();

    if (action === "reset") {
      persistGlobalFilter(null);
      let cleared = 0;
      try { cleared = clearAllGlobalUnhealthy(getDirectory()); } catch {}
      try { clearAllGlobalUnhealthyKeys(); } catch {}
      return Response.json({ ok: true, disabled: [], cleared_unhealthy: cleared });
    }

    const invalid = requested.filter((id) => !allKeys.has(id));
    if (invalid.length > 0) {
      return Response.json({ error: `unknown model identifiers: ${invalid.join(", ")}`, valid: [...allKeys] }, { status: 400 });
    }
    if (action === "enable") {
      for (const id of requested) disabledSet.delete(id);
      let cleared = 0;
      for (const id of requested) {
        try { if (clearGlobalUnhealthy(id, getDirectory())) cleared++; } catch {}
        try { clearGlobalUnhealthyKey(id); } catch {}
      }
      persistGlobalFilter(disabledSet.size > 0 ? disabledSet : null);
      return Response.json({ ok: true, disabled: [...disabledSet], cleared_unhealthy: cleared });
    }
    // disable — never allow disabling every model
    for (const id of requested) disabledSet.add(id);
    let guardKept = null;
    if (disabledSet.size >= allKeys.size) {
      guardKept = [...allKeys].find((k) => requested.includes(k)) ?? [...allKeys][0];
      disabledSet.delete(guardKept);
    }
    persistGlobalFilter(disabledSet.size > 0 ? disabledSet : null);
    return Response.json({ ok: true, disabled: [...disabledSet], guard_kept: guardKept });
  } catch (err) {
    return Response.json({ error: `model filter failed: ${extractErrorInfo(err).message}` }, { status: 500 });
  }
}

// --- Meeting lifecycle ---

function validateParticipants(list) {
  if (!Array.isArray(list) || list.length < 2 || list.length > 7) {
    return "participants must be an array of 2-7 entries";
  }
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || typeof p !== "object") return `participant #${i + 1} must be an object`;
    if (!p.name || !p.persona || !p.agenda || !p.tier) {
      return `participant #${i + 1} is missing required fields (name, persona, agenda, tier)`;
    }
    if (p.approved !== true) {
      return `participant #${i + 1} must be explicitly approved`;
    }
    if (!ALLOWED_TIERS.has(p.tier)) {
      return `participant #${i + 1} has invalid tier "${p.tier}" — must be one of ${[...ALLOWED_TIERS].join(", ")}`;
    }
  }
  return null;
}

const FEATURE_MODES = new Set(["disabled", "optional", "mandatory"]);

function normalizeFeatureMode(value, fallback = "optional") {
  if (value === true) return "optional";
  if (value === false) return "disabled";
  return typeof value === "string" && FEATURE_MODES.has(value) ? value : fallback;
}

function normalizeFeatures(raw = {}) {
  raw = raw && typeof raw === "object" ? raw : {};
  const legacyAgentTools = raw.agentTools;
  const localFallback = normalizeFeatureMode(legacyAgentTools);
  const onlineFallback = normalizeFeatureMode(legacyAgentTools);
  return {
    forums: normalizeFeatureMode(raw.forums),
    skillState: normalizeFeatureMode(raw.skillState, "mandatory"),
    agentQueries: normalizeFeatureMode(raw.agentQueries),
    localSearch: normalizeFeatureMode(raw.localSearch, localFallback),
    onlineResearch: normalizeFeatureMode(raw.onlineResearch, onlineFallback),
    agentCommands: raw.agentCommands !== false,
  };
}

function buildMeetingAgentTools(features, base = getConfig().agentTools) {
  const tools = JSON.parse(JSON.stringify(base ?? {}));
  const localSearchEnabled = features.localSearch !== "disabled";
  const onlineResearchEnabled = features.onlineResearch !== "disabled";
  const agentQueriesEnabled = features.agentQueries !== "disabled";
  tools.enabled = true;
  tools.buildMode = false;
  tools.builtIn = {
    ...(tools.builtIn ?? {}),
    read: localSearchEnabled,
    glob: localSearchEnabled,
    grep: localSearchEnabled,
    webfetch: onlineResearchEnabled,
    web_search: onlineResearchEnabled,
    websearch: onlineResearchEnabled,
    web_fetch: onlineResearchEnabled,
    write: false,
    edit: false,
    lsp: false,
    bash: tools.builtIn?.bash && typeof tools.builtIn.bash === "object"
      ? { ...tools.builtIn.bash, enabled: features.agentCommands }
      : { enabled: features.agentCommands, allowlist: [] },
  };
  tools.loom = {
    ...(tools.loom ?? {}),
    loom_forum: features.forums !== "disabled",
    loom_state_patch: features.skillState !== "disabled",
    loom_query: agentQueriesEnabled,
    loom_vote: agentQueriesEnabled,
    loom_summon: agentQueriesEnabled,
    loom_request_next: agentQueriesEnabled,
    loom_pass: true,
  };
  tools.mandatory = {
    forums: features.forums === "mandatory",
    skillState: features.skillState === "mandatory",
    agentQueries: features.agentQueries === "mandatory",
    localSearch: features.localSearch === "mandatory",
    onlineResearch: features.onlineResearch === "mandatory",
  };
  tools.patchRetry = features.skillState === "mandatory";
  return tools;
}

function dashboardCallbacks() {
  // Dashboard-first: no chat posts. Orchestrator progress is visible via SSE/DB.
  return {
    onContribution: () => {},
    onRoundComplete: () => {},
    onSynthesisStart: () => {},
    onSynthesisComplete: () => {},
    onUpdate: (state) => {
      logger.debug("dashboard_state_update", `Status: ${state.status}, Round: ${state.current_round}`);
    },
  };
}

export async function handleStartMeeting(req) {
  if (runningMeetingId || startInFlight) {
    return Response.json({ error: "a deliberation is already running", meeting_id: runningMeetingId }, { status: 409 });
  }
  startInFlight = true;
  try {
    return await handleStartMeetingInternal(req);
  } finally {
    startInFlight = false;
  }
}

async function handleStartMeetingInternal(req) {
  if (!isControlReady()) {
    return Response.json({ error: "dashboard control plane not ready (plugin client unavailable)" }, { status: 503 });
  }
  if (runningMeetingId) {
    return Response.json({ error: "a deliberation is already running", meeting_id: runningMeetingId }, { status: 409 });
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
  const orchestratorConfig = normalizeOrchestratorConfig(requestedOrchestrator);
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

  // Explicit per-tier model assignments (validate against allowed pool).
  const modelMap = new Map();
  const explicitModels = Array.isArray(body?.models) ? body.models : [];
  const allowedKeys = new Set(available.map((m) => `${m.providerID}/${m.modelID}`));
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
  const resolvedOrchestratorConfig = { ...orchestratorConfig, model: orchestratorKey };
  for (const m of explicitModels) {
    if (!m || typeof m !== "object" || !m.tier) continue;
    const providerId = m.provider_id ?? m.providerID;
    const modelId = m.model_id ?? m.modelID;
    if (!providerId || !modelId) continue;
    const key = `${providerId}/${modelId}`;
    if ((disabledSet instanceof Set && disabledSet.has(key)) || globalUnhealthy.has(key)) {
      logger.warn("dashboard_explicit_model_blocked", `Explicit model ${key} for tier ${m.tier} is disabled/unhealthy — ignoring`);
      continue;
    }
    if (!allowedKeys.has(key)) {
      logger.warn("dashboard_explicit_model_unknown", `Explicit model ${key} not in current available — ignoring`);
      continue;
    }
    if (modelMap.has(m.tier)) logger.warn("dashboard_duplicate_tier", `Duplicate tier "${m.tier}" in model map — last wins`);
    modelMap.set(m.tier, { providerID: providerId, modelID: modelId });
  }

  const seenIds = new Set();
  let dedup = 0;
  let participants = body.participants.map((p, i) => {
    const rawTags = p.tags ?? p.expertise ?? ["general"];
    const tags = Array.isArray(rawTags) ? rawTags : typeof rawTags === "string" ? [rawTags] : ["general"];
    const slug = String(p.name).toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
    let id = `${slug}_${i}`;
    if (seenIds.has(id)) id = `${id}_${++dedup}`;
    seenIds.add(id);
    // Per-seat model wins when valid (dashboard assigns one per persona row);
    // otherwise the per-tier map applies; assignModelsToParticipants fills the rest.
    let seatModel = null;
    const rawModel = p.model;
    if (rawModel && typeof rawModel === "object") {
      const providerId = rawModel.provider_id ?? rawModel.providerID;
      const modelId = rawModel.model_id ?? rawModel.modelID;
      if (providerId && modelId) seatModel = { providerID: providerId, modelID: modelId };
    }
    if (seatModel) {
      const seatKey = `${seatModel.providerID}/${seatModel.modelID}`;
      const blocked = (disabledSet instanceof Set && disabledSet.has(seatKey)) || globalUnhealthy.has(seatKey);
      if (!allowedKeys.has(seatKey) || blocked) {
        logger.warn("dashboard_seat_model_blocked", `Per-seat model ${seatKey} for ${p.name} is disabled/unhealthy/unknown — falling back to tier assignment`);
        seatModel = null;
      }
    }
    return {
      id,
       name: p.name,
       persona: sanitizeForPrompt(String(p.persona), 4000),
       agenda: sanitizeForPrompt(String(p.agenda), 2000),
       tier: p.tier,
       model: seatModel ?? modelMap.get(p.tier),
       tags,
       expertise: Array.isArray(p.expertise) ? p.expertise : [],
       known_biases: Array.isArray(p.known_biases) ? p.known_biases : [],
       communication_style: sanitizeForPrompt(String(p.communication_style ?? ""), 800),
       preferred_contribution_types: Array.isArray(p.preferred_contribution_types) ? p.preferred_contribution_types : [],
       anti_patterns: Array.isArray(p.anti_patterns) ? p.anti_patterns : [],
       tier_guidance: sanitizeForPrompt(String(p.tier_guidance ?? ""), 1600),
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
        orchestrator: { providerID: orchestratorProvider, modelID: orchestratorModel },
        orchestratorConfig: resolvedOrchestratorConfig,
        features,
        participants: [],
      });
      db.insertParticipants(participants);
    } finally {
      try { db.close(); } catch {}
    }
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
     meetingTimeoutMs: getConfig().defaultMeetingTimeoutMs,
     tags: [],
     orchestratorModel: { providerID: orchestratorProvider, modelID: orchestratorModel },
     orchestratorConfig: resolvedOrchestratorConfig,
     agentTools: buildMeetingAgentTools(features),
     availableModels: available,
    ...dashboardCallbacks(),
  });

  runtime.activeLooms.set(meetingId, engine);
  runningMeetingId = meetingId;
  jobs.set(meetingId, { phase: "running", startedAt: new Date().toISOString(), extended: false });

  // Detached: HTTP returns immediately; progress streams via existing SSE/poll.
  (async () => {
    try {
      await engine.initialize();
      const artifact = await engine.runMeeting();
      const state = engine.getState();
      const safeQuestion = sanitizeForDisplay(question, 5000);
      const fullReport = `# Loom Deliberation Output\n\n**Question:** ${safeQuestion}\n\n**Participants:** ${participants.map((p) => `${p.name} (${p.tier})`).join(", ")}\n\n**Rounds:** ${state.current_round}\n\n**Meeting ID:** ${engine.getMeetingId()}\n\n---\n\n${artifact}`;
      writeReportFileHelper(getDirectory(), engine.getMeetingId(), fullReport, logger);
      jobs.set(meetingId, { phase: "done", startedAt: jobs.get(meetingId)?.startedAt ?? null, finishedAt: new Date().toISOString() });
    } catch (err) {
      logger.error("dashboard_meeting_failed", "Dashboard deliberation failed", extractErrorInfo(err));
      jobs.set(meetingId, { phase: "error", error: extractErrorInfo(err).message, startedAt: jobs.get(meetingId)?.startedAt ?? null });
    } finally {
      runtime.activeLooms.delete(meetingId);
      try { await engine.close(); } catch {}
      if (runningMeetingId === meetingId) runningMeetingId = null;
    }
  })();

  return Response.json({ ok: true, meeting_id: meetingId }, { status: 202 });
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

export async function handleExtendMeeting(req) {
  if (runningMeetingId || startInFlight) {
    return Response.json({ error: "a deliberation is already running", meeting_id: runningMeetingId }, { status: 409 });
  }
  startInFlight = true;
  try {
    return await handleExtendMeetingInternal(req);
  } finally {
    startInFlight = false;
  }
}

async function handleExtendMeetingInternal(req) {
  if (!isControlReady()) {
    return Response.json({ error: "dashboard control plane not ready" }, { status: 503 });
  }
  if (runningMeetingId) {
    return Response.json({ error: "a deliberation is already running", meeting_id: runningMeetingId }, { status: 409 });
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
  let storedFeatures = {};
  try { storedFeatures = existingMeeting?.feature_toggles_json ? JSON.parse(existingMeeting.feature_toggles_json) : {}; } catch {}
  const extensionFeatures = normalizeFeatures(storedFeatures);
  let storedOrchestrator = {};
  try { storedOrchestrator = existingMeeting?.orchestrator_config_json ? JSON.parse(existingMeeting.orchestrator_config_json) : {}; } catch {}
  const extensionOrchestratorConfig = normalizeOrchestratorConfig(storedOrchestrator);
  const extensionOrchestrator = existingMeeting?.orchestrator_provider_id && existingMeeting?.orchestrator_model_id
    && allowedKeys.has(`${existingMeeting.orchestrator_provider_id}/${existingMeeting.orchestrator_model_id}`)
    ? { providerID: existingMeeting.orchestrator_provider_id, modelID: existingMeeting.orchestrator_model_id }
    : null;
  const resolvedExtensionOrchestratorConfig = {
    ...extensionOrchestratorConfig,
    model: extensionOrchestrator ? `${extensionOrchestrator.providerID}/${extensionOrchestrator.modelID}` : extensionOrchestratorConfig.model,
  };
  const sessionID = runtime.ownerSessionId || `dashboard-${meetingId.slice(0, 8)}`;
  const context = body?.context ? sanitizeForPrompt(String(body.context), 8000) : "No additional context provided.";

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
      return {
        id: p.id,
        name: p.name,
        persona: p.persona,
        agenda: p.agenda,
        tier: p.tier,
        model: modelKey && allowedKeys.has(modelKey) ? { providerID: p.provider_id, modelID: p.model_id } : undefined,
        tags: Array.isArray(p.tags) ? p.tags : [],
        expertise: Array.isArray(p.expertise) ? p.expertise : [],
        known_biases: Array.isArray(p.known_biases) ? p.known_biases : [],
        communication_style: p.communication_style ?? "",
        preferred_contribution_types: Array.isArray(p.preferred_contribution_types) ? p.preferred_contribution_types : [],
        anti_patterns: Array.isArray(p.anti_patterns) ? p.anti_patterns : [],
        tier_guidance: p.tier_guidance ?? "",
        reflection_guidance: p.reflection_guidance ?? "",
      };
    }),
     maxRounds: Math.min(10, Math.max(1, Math.floor(Number(getConfig().defaultMaxRounds) || 4))),
     meetingTimeoutMs: getConfig().defaultMeetingTimeoutMs,
      orchestratorModel: extensionOrchestrator,
      orchestratorConfig: resolvedExtensionOrchestratorConfig,
      agentTools: buildMeetingAgentTools(extensionFeatures),
     availableModels: available,
    ...dashboardCallbacks(),
  });

  runtime.activeLooms.set(meetingId, extEngine);
  runningMeetingId = meetingId;
  jobs.set(meetingId, { phase: "running", startedAt: new Date().toISOString(), extended: true });

  (async () => {
    try {
      await extEngine.initialize();
      const artifact = await extEngine.extendMeeting(question);
      const extState = extEngine.getState();
      const fullReport = `# Loom Deliberation (Extended)\n\n**New Input:** ${sanitizeForDisplay(question, 5000)}\n\n**Participants:** ${existingParts.map((p) => `${p.name} (${p.tier})`).join(", ")}\n\n**Total Rounds:** ${extState.current_round}\n\n**Meeting ID:** ${extEngine.getMeetingId()}\n\n---\n\n${artifact}`;
      writeReportFileHelper(getDirectory(), extEngine.getMeetingId(), fullReport, logger);
      jobs.set(meetingId, { phase: "done", startedAt: jobs.get(meetingId)?.startedAt ?? null, finishedAt: new Date().toISOString(), extended: true });
    } catch (err) {
      logger.error("dashboard_extend_failed", "Dashboard extension failed", extractErrorInfo(err));
      jobs.set(meetingId, { phase: "error", error: extractErrorInfo(err).message, startedAt: jobs.get(meetingId)?.startedAt ?? null });
    } finally {
      runtime.activeLooms.delete(meetingId);
      try { await extEngine.close(); } catch {}
      if (runningMeetingId === meetingId) runningMeetingId = null;
    }
  })();

  return Response.json({ ok: true, meeting_id: meetingId }, { status: 202 });
}

export function handleJobStatus(url) {
  const meetingId = url.searchParams.get("meeting");
  if (meetingId) {
    const job = jobs.get(meetingId);
    return Response.json({ meeting_id: meetingId, job: job ?? null, running: runningMeetingId });
  }
  return Response.json({ running: runningMeetingId, jobs: Object.fromEntries(jobs) });
}


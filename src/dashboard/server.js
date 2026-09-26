import {
  DashboardApi,
  listMeetings,
} from "./api.js";
import { join, resolve, sep, extname } from "node:path";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { getMetricsSnapshot } from "../metrics.js";
import { getRecentLogs } from "../logger.js";
import { getConfig } from "../config.js";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_QUANT } from "../services/model-manager.js";
import {
  embeddingStatus,
  initEmbeddingModel,
  getPackageVersion,
  findAssetsDir,
  MIME_TYPES,
  isAssetPathSafe,
  sendSSE,
  clampLimit,
  clampOffset,
  SECURITY_HEADERS,
  getHtmlShell,
  PACKAGE_VERSION,
} from "./server/helpers.js";
import { isAllowedDashboardHost, hasDashboardCapability, isSameOriginRequest } from "./security.js";
import { createPollSystem } from "./server/poll.js";
import {
  setControlRuntime,
  handleListPersonas,
  handleRoomPreview,
  handleOrchestratorPreview,
  handleListLlmModels,
  handleModelFilter,
  handleStartMeeting,
  handleCancelMeeting,
  handleExtendMeeting,
  handleJobStatus,
} from "./server/control.js";
import { getMeetingDbPath, isValidMeetingId } from "./api/free.js";
import { resolveLoomBaseDir } from "../paths.js";
import { getDatabasesBySessionId } from "../database/session-index.js";
import { findMeetingBySessionId } from "../database/lookup.js";
import { ensureDb, repairDatabase, isReadonlyError } from "../database/connection.js";

/**
 * Best-effort startup repair: a force-closed server leaves WAL sidecars
 * requiring a writable checkpoint before any readonly open can read.
 * Checkpoint every meeting DB once at startup (bounded, failures ignored)
 * so last session's deliberation renders immediately after relaunch.
 */
function startupRepairMeetingDbs(directory) {
  (async () => {
    try { await ensureDb(); } catch { return; }
    let dir = null;
    try { dir = join(resolveLoomBaseDir(directory), "meetings"); } catch { return; }
    let files = [];
    try {
      const { readdirSync, statSync: st } = await import("node:fs");
      files = readdirSync(dir)
        .filter((f) => f.endsWith(".db"))
        .map((f) => {
          const p = join(dir, f);
          let m = 0;
          try { m = st(p).mtimeMs; } catch {}
          return { p, m };
        })
        .sort((a, b) => b.m - a.m)
        .slice(0, 100)
        .map((e) => e.p);
    } catch { return; }
    let repaired = 0;
    for (const p of files) {
      try { if (repairDatabase(p)) repaired++; } catch {}
    }
    if (repaired > 0) console.warn(`[Loom dashboard] startup repair checkpointed ${repaired}/${files.length} meeting DB(s)`);
  })().catch(() => {});
}

const ROUTE_MAP = new Map([
  ["/", ["GET"]],
  ["/index.html", ["GET"]],
  ["/api/meetings", ["GET"]],
  ["/api/session", ["GET"]],
  ["/api/meeting", ["GET"]],
  ["/api/artifact", ["GET"]],
  ["/api/contribution_context", ["GET"]],
  ["/api/orchestrator_messages", ["GET"]],
  ["/api/state", ["GET"]],
  ["/api/state_stats", ["GET"]],
  ["/api/health", ["GET"]],
  ["/api/models", ["GET"]],
  ["/api/models/select", ["POST"]],
  ["/api/personas", ["GET"]],
  ["/api/room/preview", ["POST"]],
  ["/api/orchestrator/preview", ["POST"]],
  ["/api/llm-models", ["GET"]],
  ["/api/llm-models/filter", ["POST"]],
  ["/api/meetings/start", ["POST"]],
  ["/api/meetings/cancel", ["POST"]],
  ["/api/meetings/extend", ["POST"]],
  ["/api/jobs", ["GET"]],
  ["/api/metrics", ["GET"]],
  ["/api/logs", ["GET"]],
  ["/api/participants", ["GET"]],
  ["/api/contributions", ["GET"]],
  ["/api/turn_requests", ["GET"]],
  ["/api/agent_errors", ["GET"]],
  ["/api/agent_contexts", ["GET"]],
  ["/api/agent_context", ["GET"]],
  ["/api/forum/topics", ["GET"]],
  ["/api/forum/topic", ["GET"]],
  ["/api/export", ["GET"]],
  ["/api/export/stream", ["GET"]],
  ["/api/repair", ["GET"]],
  ["/api/stream", ["GET"]],
]);
function methodGuard(pathname, method) {
  const allowed = ROUTE_MAP.get(pathname);
  if (!allowed) return null;
  if (allowed.includes(method)) return null;
  return Response.json({ error: "method not allowed" }, { status: 405, headers: { Allow: allowed.join(", ") } });
}

const ASSETS_DIR = findAssetsDir();

function getMeetingApi(url, directory) {
  const meetingId = url.searchParams.get("meeting");
  if (!meetingId || !isValidMeetingId(meetingId)) {
    return { error: Response.json({ error: "valid meeting id required", code: "invalid_meeting_id" }, { status: 400 }) };
  }
  let dbPath = null;
  try {
    dbPath = getMeetingDbPath(directory, meetingId);
  } catch (err) {
    console.warn(`[Loom dashboard] meeting path lookup threw for ${meetingId}:`, err instanceof Error ? err.message : String(err));
  }
  if (!dbPath) {
    // Distinguish "no such file" from other failures so the UI can tell a
    // still-initializing meeting apart from a bad id. The expected path is
    // logged with the serving directory to expose base-dir mismatches
    // (e.g. stale dashboard directory vs. writer directory on WSL mounts).
    const base = resolveLoomBaseDir(directory);
    console.warn(`[Loom dashboard] meeting not found: id=${meetingId} directory=${directory} base=${base} expected=${join(base, "meetings", `${meetingId}.db`)}`);
    return { error: Response.json({ error: `Meeting ${meetingId.slice(0, 8)}… not found. It may have been deleted or is still initializing. [meeting_not_found]`, code: "meeting_not_found", meeting_id: meetingId }, { status: 404 }) };
  }
  try {
    return { api: DashboardApi.get(dbPath), meetingId };
  } catch (err) {
    console.warn(`[Loom dashboard] meeting DB open failed for ${meetingId} at ${dbPath}:`, err instanceof Error ? err.message : String(err));
    if (isReadonlyError(err)) {
      return { error: Response.json({ error: `Meeting database needs WAL recovery and could not be checkpointed (${err instanceof Error ? err.message : "unknown error"}). Try GET /api/repair?meeting=${meetingId}, then reload. [db_readonly_unrecoverable]`, code: "db_readonly_unrecoverable", meeting_id: meetingId }, { status: 500 }) };
    }
    return { error: Response.json({ error: `Meeting database could not be opened (${err instanceof Error ? err.message : "unknown error"}). [db_open_failed]`, code: "db_open_failed" }, { status: 500 }) };
  }
}

export function handleRepairMeeting(url, directory) {
  const meetingId = url.searchParams.get("meeting");
  if (!meetingId || !isValidMeetingId(meetingId)) {
    return Response.json({ error: "valid meeting id required", code: "invalid_meeting_id" }, { status: 400 });
  }
  let dbPath = null;
  try { dbPath = getMeetingDbPath(directory, meetingId); } catch {}
  if (!dbPath) {
    return Response.json({ error: `Meeting ${meetingId.slice(0, 8)}… not found. [meeting_not_found]`, code: "meeting_not_found", meeting_id: meetingId }, { status: 404 });
  }
  try { DashboardApi.cache.delete(dbPath); } catch {}
  let repaired = false;
  try { repaired = repairDatabase(dbPath); } catch { repaired = false; }
  try {
    const api = DashboardApi.get(dbPath);
    const state = api.getState();
    if (!state) {
      return Response.json({ error: `Meeting database repaired but contains no meeting row. [db_empty]`, code: "db_empty", meeting_id: meetingId, repaired }, { status: 500 });
    }
    return Response.json({ ok: true, meeting_id: meetingId, repaired, status: state.status, round: state.round });
  } catch (err) {
    return Response.json({ error: `Repair failed (${err instanceof Error ? err.message : "unknown error"}). [db_open_failed]`, code: "db_open_failed", meeting_id: meetingId, repaired }, { status: 500 });
  }
}

export function startDashboard(directory, port, runtimeOpts = null) {
  initEmbeddingModel();
  startupRepairMeetingDbs(directory);
  if (runtimeOpts) {
    try { setControlRuntime(runtimeOpts); } catch {}
  }

  const capabilityToken = `${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
  const capabilityCookie = `loom_dashboard_${port}`;
  const pollSystem = createPollSystem(directory);
  const { sseClients, lastContributionId, lastOrchestratorMsgId, lastInterjectionId, lastErrorId, participantStatusCache, broadcast, subscribeToWrites, unsubscribeFromWrites, pingTimer, restartPollTimer } = pollSystem;
  let pollTimer = pollSystem.getPollTimer();
  let currentPollInterval = pollSystem.getCurrentPollInterval();

  // Bind localhost by default; dashboard.host config restores LAN access deliberately (audit 10 S2).
  let hostname = "127.0.0.1";
  try {
    const configuredHost = getConfig()?.dashboard?.host;
    if (typeof configuredHost === "string" && configuredHost) hostname = configuredHost;
  } catch {
    // Config not available (e.g. standalone dashboard) — safe default holds
  }
  const allowedHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  if (!allowedHosts.has(hostname)) {
    const allowLan = process.env.LOOM_ALLOW_LAN === "1";
    if (!allowLan) {
      console.warn(`[Loom dashboard] Non-loopback binding (${hostname}) blocked — set Loom dashboard.host to 127.0.0.1 or export LOOM_ALLOW_LAN=1 to expose to LAN. Falling back to 127.0.0.1.`);
      hostname = "127.0.0.1";
    } else {
      console.warn(`[Loom dashboard] Non-loopback binding (${hostname}) exposes full transcripts to the network (LOOM_ALLOW_LAN=1).`);
    }
  }

  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 60,
    async fetch(req) {
      try {
        const url = new URL(req.url);
        if (!isAllowedDashboardHost(req.headers.get("host"), hostname)) {
          return Response.json({ error: "invalid host" }, { status: 403, headers: SECURITY_HEADERS });
        }
        if (!isSameOriginRequest(req.headers, url)) {
          return Response.json({ error: "cross-origin request blocked" }, { status: 403, headers: SECURITY_HEADERS });
        }
        const guard = methodGuard(url.pathname, req.method);
        if (guard) return guard;
        if (url.pathname.startsWith("/api/") && !hasDashboardCapability(req.headers, capabilityToken, capabilityCookie)) {
          return Response.json({ error: "dashboard authentication required" }, { status: 401, headers: SECURITY_HEADERS });
        }

        if (url.pathname === "/" || url.pathname === "/index.html") {
          const nonce = crypto.randomUUID().replace(/-/g, "");
          const html = getHtmlShell(nonce);
          return new Response(html, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-cache",
              "Content-Security-Policy": `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'`,
              "Set-Cookie": `${capabilityCookie}=${capabilityToken}; HttpOnly; SameSite=Strict; Path=/`,
              "X-Content-Type-Options": "nosniff",
              "X-Frame-Options": "DENY",
            },
          });
        }

        if (url.pathname === "/api/meetings") {
          const sessionId = url.searchParams.get("session");
          if (sessionId) {
            // Session-filtered: only meetings for this session
            const dbs = getDatabasesBySessionId(sessionId);
            const meetings = [];
            for (const { dbPath, meetingId } of dbs) {
              try {
                const api = DashboardApi.get(dbPath);
                const state = api.getState();
                if (state) {
                  const participantCount = api.getParticipants().length;
                  meetings.push({
                    meeting_id: meetingId,
                    question: state.question,
                    status: state.status,
                    round: state.round,
                    max_rounds: state.max_rounds,
                    convergence: state.convergence,
                    created_at: state.created_at,
                    participant_count: participantCount,
                  });
                }
              } catch {}
            }
            if (meetings.length === 0) {
              // Fallback: the in-memory session index is populated at plugin
              // startup and persisted asynchronously with lock coalescing, so
              // a dropped persist (or a dashboard reused across sessions with
              // a stale ownerSessionId) can leave it empty right after start.
              // A direct DB scan still finds the meeting by opencode_session_id.
              try {
                const found = await findMeetingBySessionId(directory, sessionId);
                if (found?.dbPath) {
                  try {
                    const api = DashboardApi.get(found.dbPath);
                    const state = api.getState();
                    if (state) {
                      meetings.push({
                        meeting_id: found.meetingId,
                        question: state.question ?? found.question,
                        status: state.status ?? found.status,
                        round: state.round ?? found.round,
                        max_rounds: state.max_rounds ?? found.max_rounds,
                        convergence: state.convergence,
                        created_at: state.created_at,
                        participant_count: api.getParticipants().length,
                      });
                      console.warn(`[Loom dashboard] session index miss for ${sessionId} — served ${found.meetingId} via DB scan fallback`);
                    }
                  } catch {}
                }
              } catch {}
            }
            meetings.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
            return Response.json(meetings);
          }
          const meetings = listMeetings(directory);
          return Response.json(meetings);
        }

        if (url.pathname === "/api/session") {
          const sessionId = url.searchParams.get("session");
          if (!sessionId) {
            return Response.json({ error: "session id required" }, { status: 400 });
          }
          const meeting = await findMeetingBySessionId(directory, sessionId);
          if (!meeting) {
            return Response.json({ meeting: null });
          }
          return Response.json({ meeting });
        }

        if (url.pathname === "/api/meeting") {
          const { api, meetingId, error } = getMeetingApi(url, directory);
          if (error) return error;
          const limit = clampLimit(url.searchParams.get("limit"));
          const offset = clampOffset(url.searchParams.get("offset"));
          const includeContext = url.searchParams.get("include_context") !== "0";
          let contributions = api.getContributions(limit, offset);
          if (!includeContext) {
            contributions = contributions.map((c) => ({ ...c, prompt_context: null }));
          }
          const totalContributions = api.getContributionsCount();
          const embeddingModel = api.getEmbeddingModel(meetingId);
          return Response.json({
            state: api.getState(),
            participants: api.getParticipants(),
            contributions,
            turn_requests: api.getTurnRequests(),
            orchestrator_messages: api.getOrchestratorMessages(meetingId),
            round_summaries: api.getRoundSummaries(meetingId),
            state_patch_summary: api.getStatePatchSummary(),
            agent_errors: api.getAgentErrors(),
            artifact: api.getArtifact(),
            embedding_model: embeddingModel?.embedding_model ?? null,
            embedding_dim: embeddingModel?.embedding_dim ?? null,
            contributionsPagination: { total: totalContributions, limit, offset },
          });
        }

        if (url.pathname === "/api/artifact") {
          const { api, error } = getMeetingApi(url, directory);
          if (error) return error;
          return Response.json(api.getArtifact());
        }

        if (url.pathname === "/api/contribution_context") {
          const { api, error } = getMeetingApi(url, directory);
          if (error) return error;
          const contributionId = Number(url.searchParams.get("contribution_id"));
          if (!contributionId) {
            return Response.json({ error: "contribution_id required" }, { status: 400 });
          }
          const context = api.getContributionContext(contributionId);
          if (!context) {
            return Response.json({ error: "Contribution not found" }, { status: 404 });
          }
          return Response.json(context);
        }

        if (url.pathname === "/api/orchestrator_messages") {
          const { api, meetingId, error } = getMeetingApi(url, directory);
          if (error) return error;
          return Response.json({ messages: api.getOrchestratorMessages(meetingId) });
        }

        if (url.pathname === "/api/state") {
          const { api, error } = getMeetingApi(url, directory);
          if (error) return error;
          return Response.json(api.getState());
        }

        if (url.pathname === "/api/state_stats") {
          const { api, error } = getMeetingApi(url, directory);
          if (error) return error;
          return Response.json(api.getStateWithStats());
        }

        if (url.pathname === "/api/health") {
          return Response.json({
            status: "ok",
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
          });
        }

        if (url.pathname === "/api/models") {
          const { listDownloadedModels } = await import("./api.js");
          const models = listDownloadedModels();
          return Response.json({ models, status: embeddingStatus });
        }

        if (url.pathname === "/api/models/select") {
          if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
            return Response.json({ error: "Content-Type must be application/json" }, { status: 415, headers: SECURITY_HEADERS });
          }
          const body = await req.json().catch(() => null);
          const rawName = body?.model;
          if (!rawName || typeof rawName !== "string" || rawName.includes("..") || rawName.includes("\0") || rawName.length > 200) {
            return Response.json({ error: "model name required (valid string, max 200 chars, no path traversal)" }, { status: 400 });
          }
          // Allow only printable, no traversal
          if (/[<>:"|?*]/.test(rawName)) {
            return Response.json({ error: "invalid model name" }, { status: 400 });
          }
          const { listDownloadedModels } = await import("./api.js");
          const models = listDownloadedModels();
          const matched = models.find((m) => m.name === rawName || m.id === rawName);
          if (!matched) {
            return Response.json({ error: "model not found among downloaded models" }, { status: 404 });
          }
          // Validate matched name itself (defense against poisoned model.json)
          if (matched.name.includes("..") || matched.name.includes("\0")) {
            return Response.json({ error: "stored model name invalid" }, { status: 500 });
          }
          if (embeddingStatus.state === "initializing") {
            return Response.json({ error: "embedding model is currently initializing, please wait" }, { status: 409 });
          }
          const { initializeEmbedder, getEmbeddingDim, getEmbeddingMaxTokens } = await import("../services/embedding-service.js");
          embeddingStatus.state = "initializing";
          embeddingStatus.message = null;
          try {
            await initializeEmbedder(matched.name, matched.quant ?? "onnx/model_int8.onnx");
            embeddingStatus.state = "ready";
            embeddingStatus.model = matched.name;
            embeddingStatus.dims = getEmbeddingDim();
            embeddingStatus.maxTokens = getEmbeddingMaxTokens();
            embeddingStatus.initializedAt = new Date().toISOString();
            embeddingStatus.message = null;
            return Response.json({ ok: true, status: embeddingStatus });
          } catch (err) {
            embeddingStatus.state = "error";
            embeddingStatus.message = err instanceof Error ? err.message : String(err);
            return Response.json({ error: embeddingStatus.message }, { status: 500 });
          }
        }

        if (url.pathname === "/api/personas") {
          return handleListPersonas();
        }

        if (url.pathname === "/api/room/preview") {
          return handleRoomPreview(req);
        }

        if (url.pathname === "/api/orchestrator/preview") {
          return handleOrchestratorPreview(req);
        }

        if (url.pathname === "/api/llm-models") {
          return handleListLlmModels(url);
        }

        if (url.pathname === "/api/llm-models/filter") {
          return handleModelFilter(req);
        }

        if (url.pathname === "/api/meetings/start") {
          return handleStartMeeting(req);
        }

        if (url.pathname === "/api/meetings/cancel") {
          return handleCancelMeeting(req);
        }

        if (url.pathname === "/api/meetings/extend") {
          return handleExtendMeeting(req);
        }

        if (url.pathname === "/api/jobs") {
          return handleJobStatus(url);
        }

        if (url.pathname === "/api/metrics") {
          return Response.json(getMetricsSnapshot());
        }

        if (url.pathname === "/api/logs") {
          const limit = clampLimit(url.searchParams.get("limit"), 500);
          const level = url.searchParams.get("level");
          const meetingId = url.searchParams.get("meeting");
          return Response.json(getRecentLogs(limit, level, meetingId));
        }

        if (url.pathname === "/api/participants") {
          const { api, error } = getMeetingApi(url, directory);
          if (error) return error;
          return Response.json(api.getParticipants());
        }

        if (url.pathname === "/api/contributions") {
          const { api, error } = getMeetingApi(url, directory);
          if (error) return error;
          const includeContext = url.searchParams.get("include_context") !== "0";
          const since = url.searchParams.get("since");
          if (since !== null) {
            const sinceId = Number(since);
            if (!Number.isFinite(sinceId) || sinceId < 0) {
              return Response.json({ error: "since must be a non-negative number" }, { status: 400 });
            }
            const sinceLimit = clampLimit(url.searchParams.get("limit"), 500, 500);
            let contribs = api.getContributionsSince(sinceId);
            if (contribs.length > sinceLimit) contribs = contribs.slice(0, sinceLimit);
            if (!includeContext) contribs = contribs.map((c) => ({ ...c, prompt_context: null }));
            return Response.json({ contributions: contribs, total: contribs.length });
          }
          // Keyset pagination: prefer afterId when provided, fallback to offset for compat
          const afterId = url.searchParams.get("after");
          if (afterId !== null) {
            const after = Number(afterId);
            if (!Number.isFinite(after) || after < 0) {
              return Response.json({ error: "after must be a non-negative number" }, { status: 400 });
            }
            const limit = clampLimit(url.searchParams.get("limit"));
            let contributions = api.getContributionsAfter(after, limit);
            if (!includeContext) contributions = contributions.map((c) => ({ ...c, prompt_context: null }));
            const total = api.getContributionsCount();
            return Response.json({ contributions, total, limit, after });
          }
          const limit = clampLimit(url.searchParams.get("limit"));
          const offset = clampOffset(url.searchParams.get("offset"));
          let contributions = api.getContributions(limit, offset);
          if (!includeContext) contributions = contributions.map((c) => ({ ...c, prompt_context: null }));
          const total = api.getContributionsCount();
          return Response.json({ contributions, total, limit, offset });
        }

        if (url.pathname === "/api/turn_requests") {
          const { api, error } = getMeetingApi(url, directory);
          if (error) return error;
          return Response.json(api.getTurnRequests());
        }

        if (url.pathname === "/api/agent_errors") {
          const { api, error } = getMeetingApi(url, directory);
          if (error) return error;
          return Response.json(api.getAgentErrors());
        }

        if (url.pathname === "/api/forum/topics") {
          const { api, error } = getMeetingApi(url, directory);
          if (error) return error;
          const tag = url.searchParams.get("tag") || undefined;
          return Response.json({ topics: api.getForumTopics(tag) });
        }

        if (url.pathname === "/api/forum/topic") {
          const { api, error } = getMeetingApi(url, directory);
          if (error) return error;
          const topicId = Number(url.searchParams.get("topic_id"));
          if (!Number.isFinite(topicId) || topicId < 1) {
            return Response.json({ error: "topic_id required" }, { status: 400 });
          }
          const topic = api.getForumTopic(topicId);
          if (!topic) return Response.json({ error: "topic not found" }, { status: 404 });
          return Response.json(topic);
        }

        if (url.pathname === "/api/agent_contexts") {
          const { api, error } = getMeetingApi(url, directory);
          if (error) return error;
          const meeting = api.getState();
          const participants = api.getParticipants();
          return Response.json({ meeting, participants });
        }

        if (url.pathname === "/api/agent_context") {
          const { api, meetingId, error } = getMeetingApi(url, directory);
          if (error) return error;
          const participantId = url.searchParams.get("participant");
          if (!participantId) {
            return Response.json({ error: "participant id required" }, { status: 400 });
          }
          return Response.json(api.getAgentContext(meetingId, participantId));
        }

        if (url.pathname === "/api/export") {
          const { api, meetingId, error } = getMeetingApi(url, directory);
          if (error) return error;
          const format = url.searchParams.get("format") ?? "markdown";
          
          if (format === "json") {
            const exportJson = api.exportJSON(meetingId);
            const filename = `loom-${meetingId.slice(0, 8)}-${Date.now()}.json`;
            return new Response(exportJson, {
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Content-Disposition": `attachment; filename="${filename}"`,
              },
            });
          }
          
          const exportMarkdown = api.exportMarkdown(meetingId);
          const filename = `loom-${meetingId.slice(0, 8)}-${Date.now()}.md`;
          return new Response(exportMarkdown, {
            headers: {
              "Content-Type": "text/markdown; charset=utf-8",
              "Content-Disposition": `attachment; filename="${filename}"`,
            },
          });
        }

        if (url.pathname === "/api/export/stream") {
          const { api, meetingId, error } = getMeetingApi(url, directory);
          if (error) return error;
           const iterator = api.exportMarkdownStream(meetingId)[Symbol.iterator]();
           let finished = false;
           const stream = new ReadableStream({
             pull(controller) {
               if (finished) return;
               if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
               const next = iterator.next();
               if (next.done) {
                 finished = true;
                 try { controller.close(); } catch {}
                 return;
               }
               try { controller.enqueue(new TextEncoder().encode(next.value)); } catch { finished = true; }
             },
           });
          const filename = `loom-${meetingId.slice(0, 8)}-${Date.now()}.md`;
          return new Response(stream, {
            headers: {
              "Content-Type": "text/markdown; charset=utf-8",
              "Content-Disposition": `attachment; filename="${filename}"`,
              "Cache-Control": "no-cache",
            },
          });
        }

        if (url.pathname === "/api/repair") {
          return handleRepairMeeting(url, directory);
        }

        if (url.pathname === "/api/stream") {
          const { api, meetingId, error } = getMeetingApi(url, directory);
          if (error) return error;

          // Hold the client entry in a per-stream closure — cancel() receives the cancel
          // *reason*, not the controller (WHATWG Streams), so removal must use a captured
          // reference rather than an argument (audit 10 S1).
          let clientEntry = null;

          const stream = new ReadableStream({
            start(controller) {
              const isFirstClient = !sseClients.has(meetingId) || sseClients.get(meetingId).size === 0;
              if (!sseClients.has(meetingId)) {
                sseClients.set(meetingId, new Set());
              }
              // Seed lastContributionId on first SSE connect so first poll is delta-only
              if (isFirstClient && !lastContributionId.has(meetingId)) {
                try {
                  const maxId = api.getMaxContributionId();
                  lastContributionId.set(meetingId, maxId);
                } catch {}
                // Also seed other deltas to avoid replaying full history on first poll
                try { lastOrchestratorMsgId.set(meetingId, api.getMaxOrchestratorMessageId()); } catch {}
                try { lastInterjectionId.set(meetingId, api.getMaxTurnRequestId()); } catch {}
                try { lastErrorId.set(meetingId, api.getMaxErrorId()); } catch {}
              }
              clientEntry = { controller, slowSince: null };
              sseClients.get(meetingId).add(clientEntry);
              if (isFirstClient) subscribeToWrites(meetingId);
              sendSSE(clientEntry.controller, {
                type: "connected",
                data: { connected: true },
                timestamp: new Date().toISOString(),
              });
            },
            cancel() {
              if (clientEntry) {
                sseClients.get(meetingId)?.delete(clientEntry);
                const clients = sseClients.get(meetingId);
                if (!clients || clients.size === 0) unsubscribeFromWrites(meetingId);
                clientEntry = null;
              }
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
              ...SECURITY_HEADERS,
            },
          });
        }

        if (url.pathname.startsWith("/assets/")) {
          if (req.method !== "GET" && req.method !== "HEAD") {
            return Response.json({ error: "method not allowed" }, { status: 405, headers: { Allow: "GET, HEAD" } });
          }
          const assetPath = url.pathname.slice("/assets/".length);
          if (!isAssetPathSafe(assetPath, ASSETS_DIR)) {
            return new Response("Not found", { status: 404 });
          }
          const filePath = join(ASSETS_DIR, assetPath);
          const ext = extname(filePath).toLowerCase();
          const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
          const headers = { "Content-Type": contentType, ...SECURITY_HEADERS, "X-Content-Type-Options": "nosniff" };
          const etagVal = (() => {
            try {
              const s = statSync(filePath);
              const ino = s.ino ? `-${s.ino.toString(36)}` : "";
              return `W/"${s.mtimeMs.toString(36)}-${s.size.toString(36)}${ino}"`;
            } catch { return undefined; }
          })();
          if (etagVal) headers["ETag"] = etagVal;
          if (assetPath === "app.js") {
            headers["Cache-Control"] = "no-cache";
          } else if (assetPath === "styles.css") {
            headers["Cache-Control"] = "public, max-age=3600, must-revalidate";
          } else {
            headers["Cache-Control"] = "public, max-age=31536000, immutable";
          }
          const inm = req.headers.get("if-none-match");
          if (inm && headers["ETag"] && inm === headers["ETag"]) {
            return new Response(null, { status: 304, headers });
          }
          if (!headers["ETag"]) delete headers["ETag"];
          if (req.method === "HEAD") return new Response(null, { headers });
          return new Response(Bun.file(filePath), { headers });
        }

        return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
      } catch (err) {
        console.error("[Loom dashboard] request failed", err instanceof Error ? err.message : String(err));
        return Response.json({ error: "internal server error" }, { status: 500, headers: SECURITY_HEADERS });
      }
    },
  });

  let stopped = false;
  return {
    port: server.port,
    hostname,
    stop: () => {
      if (stopped) return;
      stopped = true;
      try { const cur = pollSystem.getPollTimer?.(); if (cur) clearInterval(cur); else if (pollTimer) clearInterval(pollTimer); } catch {}
      try { if (pingTimer) clearInterval(pingTimer); } catch {}
      try { pollSystem.stop?.(); } catch {}
      for (const clients of sseClients.values()) {
        for (const entry of clients) {
          try {
            entry.controller.close();
          } catch {
          }
        }
      }
      sseClients.clear();
      lastContributionId.clear();
      lastOrchestratorMsgId.clear();
      lastInterjectionId.clear();
      lastErrorId.clear();
      participantStatusCache.clear();
      DashboardApi.closeAll();
      try { server.stop(); } catch {}
    },
  };
}

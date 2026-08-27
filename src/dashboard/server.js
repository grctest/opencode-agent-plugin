import {
  DashboardApi,
  listMeetings,
} from "./api.js";
import { join, resolve, sep } from "node:path";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { getMetricsSnapshot } from "../metrics.js";
import { getRecentLogs } from "../logger.js";
import { getConfig } from "../config.js";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_QUANT } from "../services/model-manager.js";

// Route table helper — centralizes method guards and documents API surface.
// Each entry declares allowed methods; fetch handler checks before dispatch.
const ROUTE_TABLE = [
  { path: "/", methods: ["GET"] },
  { path: "/index.html", methods: ["GET"] },
  { path: "/api/meetings", methods: ["GET"] },
  { path: "/api/session", methods: ["GET"] },
  { path: "/api/meeting", methods: ["GET"] },
  { path: "/api/artifact", methods: ["GET"] },
  { path: "/api/contribution_context", methods: ["GET"] },
  { path: "/api/orchestrator_messages", methods: ["GET"] },
  { path: "/api/state", methods: ["GET"] },
  { path: "/api/state_stats", methods: ["GET"] },
  { path: "/api/health", methods: ["GET"] },
  { path: "/api/models", methods: ["GET"] },
  { path: "/api/models/select", methods: ["POST"] },
  { path: "/api/metrics", methods: ["GET"] },
  { path: "/api/logs", methods: ["GET"] },
  { path: "/api/participants", methods: ["GET"] },
  { path: "/api/contributions", methods: ["GET"] },
  { path: "/api/turn_requests", methods: ["GET"] },
  { path: "/api/agent_errors", methods: ["GET"] },
  { path: "/api/agent_contexts", methods: ["GET"] },
  { path: "/api/agent_context", methods: ["GET"] },
  { path: "/api/export", methods: ["GET"] },
  { path: "/api/export/stream", methods: ["GET"] },
  { path: "/api/stream", methods: ["GET"] },
];
function isMethodAllowed(pathname, method) {
  const entry = ROUTE_TABLE.find((r) => r.path === pathname);
  if (!entry) return true; // allow assets and unknown to fall through 404
  return entry.methods.includes(method);
}
function methodGuard(pathname, method) {
  if (!isMethodAllowed(pathname, method)) {
    return Response.json({ error: "method not allowed" }, { status: 405, headers: { Allow: ROUTE_TABLE.find((r) => r.path === pathname)?.methods.join(", ") ?? "" } });
  }
  return null;
}

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
  HTML_SHELL,
  PACKAGE_VERSION,
} from "./server/helpers.js";
import { createPollSystem } from "./server/poll.js";
import { getMeetingDbPath, isValidMeetingId } from "./api/free.js";
import { getDatabasesBySessionId } from "../database/session-index.js";
import { findMeetingBySessionId } from "../database/lookup.js";

const ASSETS_DIR = findAssetsDir();

function getMeetingApi(url, directory) {
  const meetingId = url.searchParams.get("meeting");
  if (!meetingId || !isValidMeetingId(meetingId)) {
    return { error: Response.json({ error: "valid meeting id required" }, { status: 400 }) };
  }
  const dbPath = getMeetingDbPath(directory, meetingId);
  if (!dbPath) {
    return { error: Response.json({ error: "not found" }, { status: 404 }) };
  }
  return { api: DashboardApi.get(dbPath), meetingId };
}

export function startDashboard(directory, port) {
  initEmbeddingModel();

  const pollSystem = createPollSystem(directory);
  const { sseClients, lastContributionId, lastOrchestratorMsgId, lastInterjectionId, lastErrorId, participantStatusCache, lastMtime, broadcast, pingTimer, restartPollTimer } = pollSystem;
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
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    console.warn(`[Loom dashboard] Non-loopback binding (${hostname}) exposes full transcripts to the network.`);
  }

  const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 60,
    async fetch(req) {
      try {
        const url = new URL(req.url);
        // Method guard via route table
        const guard = methodGuard(url.pathname, req.method);
        if (guard) return guard;

        if (url.pathname === "/" || url.pathname === "/index.html") {
          return new Response(HTML_SHELL, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-cache",
              "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
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

        if (url.pathname === "/api/models/select" && req.method === "POST") {
          const body = await req.json().catch(() => null);
          if (!body?.model) {
            return Response.json({ error: "model name required" }, { status: 400 });
          }
          const { listDownloadedModels } = await import("./api.js");
          const models = listDownloadedModels();
          const matched = models.find((m) => m.name === body.model || m.id === body.model);
          if (!matched) {
            return Response.json({ error: "model not found among downloaded models" }, { status: 404 });
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

        if (url.pathname === "/api/metrics") {
          return Response.json(getMetricsSnapshot());
        }

        // Recent in-process log lines from the logger ring buffer (audit 07 EH6).
        if (url.pathname === "/api/logs") {
          const limit = clampLimit(url.searchParams.get("limit"), 500);
          const level = url.searchParams.get("level");
          return Response.json(getRecentLogs(limit, level));
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
          const stream = new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              for (const chunk of api.exportMarkdownStream(meetingId)) {
                controller.enqueue(encoder.encode(chunk));
              }
              controller.close();
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
              sendSSE(clientEntry.controller, {
                type: "connected",
                data: { connected: true },
                timestamp: new Date().toISOString(),
              });
            },
            cancel() {
              if (clientEntry) {
                sseClients.get(meetingId)?.delete(clientEntry);
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
          const assetPath = url.pathname.slice("/assets/".length);
          if (!isAssetPathSafe(assetPath, ASSETS_DIR)) {
            return new Response("Not found", { status: 404 });
          }
          const filePath = join(ASSETS_DIR, assetPath);
          const lastDot = filePath.lastIndexOf(".");
          const ext = lastDot > 0 ? filePath.slice(lastDot) : "";
          const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
          const headers = { "Content-Type": contentType, ...SECURITY_HEADERS };
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
          return new Response(Bun.file(filePath), { headers });
        }

        return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
      } catch (err) {
        const message = err instanceof Error ? err.message : "internal error";
        return Response.json({ error: message }, { status: 500 });
      }
    },
  });

  return {
    port: server.port,
    hostname,
    stop: () => {
      if (pollTimer) clearInterval(pollTimer);
      if (pingTimer) clearInterval(pingTimer);
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
      lastMtime.clear();
      participantStatusCache.clear();
      DashboardApi.closeAll();
      server.stop();
    },
  };
}

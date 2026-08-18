import {
  DashboardApi,
  listMeetings,
  getMeetingDbPath,
  isValidMeetingId,
} from "./api.js";
import { join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { getMetricsSnapshot } from "../metrics.js";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_QUANT } from "../services/model-manager.js";

const embeddingStatus = {
  state: "idle",
  model: null,
  dims: null,
  maxTokens: null,
  message: null,
  initializedAt: null,
};

async function initEmbeddingModel() {
  if (embeddingStatus.state === "initializing") return;
  embeddingStatus.state = "initializing";
  embeddingStatus.message = null;
  const started = Date.now();
  try {
    const { initializeEmbedder, getEmbeddingDim, getEmbeddingMaxTokens } = await import("../services/embedding-service.js");
    await initializeEmbedder(DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_QUANT);
    embeddingStatus.state = "ready";
    embeddingStatus.model = DEFAULT_EMBEDDING_MODEL;
    embeddingStatus.dims = getEmbeddingDim();
    embeddingStatus.maxTokens = getEmbeddingMaxTokens();
    embeddingStatus.initializedAt = new Date().toISOString();
    console.log(`[Loom dashboard] Embedding model ${DEFAULT_EMBEDDING_MODEL} ready (${embeddingStatus.dims}d) in ${Date.now() - started}ms`);
  } catch (err) {
    embeddingStatus.state = "error";
    embeddingStatus.message = err instanceof Error ? err.message : String(err);
    console.warn(`[Loom dashboard] Embedding model init failed: ${embeddingStatus.message}`);
  }
}

function getPackageVersion() {
  try {
    const pkgPath = resolve(import.meta.dir, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const PACKAGE_VERSION = getPackageVersion();

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

const HTML_SHELL = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Loom Dashboard</title>
  <script>
    (function() {
      var t = localStorage.getItem("loom-theme") || "system";
      if (t !== "system") document.documentElement.setAttribute("data-theme", t);
    })();
  </script>
  <link rel="stylesheet" href="/assets/pure.css" />
  <link rel="stylesheet" href="/assets/pure-grids-responsive.css" />
  <link rel="stylesheet" href="/assets/styles.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/assets/app.js"></script>
</body>
</html>`;

function findAssetsDir() {
  const candidates = [
    resolve(import.meta.dir),
    resolve(import.meta.dir, "loom", "dashboard"),
    resolve(import.meta.dir, "dashboard"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "app.js"))) return dir;
  }
  return resolve(import.meta.dir);
}

const ASSETS_DIR = findAssetsDir();

const MIME_TYPES = {
  ".js": "application/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

function isAssetPathSafe(assetPath) {
  const resolved = resolve(ASSETS_DIR, assetPath);
  return resolved.startsWith(ASSETS_DIR) && existsSync(resolved);
}

function sendSSE(controller, event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  controller.enqueue(new TextEncoder().encode(data));
}

export function startDashboard(directory, port) {
  const sseClients = new Map();
  const lastContributionId = new Map();
  const lastOrchestratorMsgId = new Map();
  const lastInterjectionId = new Map();
  const lastErrorId = new Map();
  const participantStatusCache = new Map();

  initEmbeddingModel();

  const broadcast = (meetingId, event) => {
    const clients = sseClients.get(meetingId);
    if (!clients || clients.size === 0) return;
    for (const controller of clients) {
      try {
        sendSSE(controller, event);
      } catch {
        clients.delete(controller);
      }
    }
  };

  const ACTIVE_POLL_INTERVAL = 1000;
  const IDLE_POLL_INTERVAL = 5000;
  let currentPollInterval = ACTIVE_POLL_INTERVAL;
  let pollTimer = null;
  let consecutiveIdlePolls = 0;

  const TERMINAL_STATUSES = new Set(["converged", "cancelled", "timeout", "max_rounds_reached", "aborted", "deadlocked"]);

  const pollMeetings = () => {
    let hadActivity = false;
    for (const [meetingId, clients] of sseClients) {
      if (clients.size === 0) continue;
      try {
        const dbPath = getMeetingDbPath(directory, meetingId);
        if (!dbPath) continue;
        const api = DashboardApi.get(dbPath);

        const currentState = api.getState();
        if (currentState && TERMINAL_STATUSES.has(currentState.status)) {
          const wasTerminal = participantStatusCache.get(`terminal:${meetingId}`);
          if (!wasTerminal) {
            participantStatusCache.set(`terminal:${meetingId}`, "true");
            broadcast(meetingId, { type: "state", data: currentState, timestamp: new Date().toISOString() });
          }
          const artifact = api.getArtifact();
          if (artifact && participantStatusCache.get(`artifact:${meetingId}`) !== artifact.created_at) {
            participantStatusCache.set(`artifact:${meetingId}`, artifact.created_at);
            broadcast(meetingId, { type: "artifact", data: artifact, timestamp: new Date().toISOString() });
          }
          continue;
        }

        const maxId = api.getMaxContributionId();
        const prevId = lastContributionId.get(meetingId) ?? 0;
        if (maxId > prevId) {
          lastContributionId.set(meetingId, maxId);
          const newContributions = api.getContributionsSince(prevId);
          broadcast(meetingId, {
            type: "contributions",
            data: newContributions,
            timestamp: new Date().toISOString(),
          });
          hadActivity = true;
        }

        const maxMsgId = api.getMaxOrchestratorMessageId();
        const prevMsgId = lastOrchestratorMsgId.get(meetingId) ?? 0;
        if (maxMsgId > prevMsgId) {
          lastOrchestratorMsgId.set(meetingId, maxMsgId);
          const newMessages = api.getOrchestratorMessagesSince(prevMsgId, meetingId);
          if (newMessages.length > 0) {
            broadcast(meetingId, {
              type: "orchestrator_messages",
              data: newMessages,
              timestamp: new Date().toISOString(),
            });
          }
          hadActivity = true;
        }

        const maxIjId = api.getMaxTurnRequestId();
        const prevIjId = lastInterjectionId.get(meetingId) ?? 0;
        if (maxIjId > prevIjId) {
          lastInterjectionId.set(meetingId, maxIjId);
          const newTurnRequests = api.getTurnRequestsSince(prevIjId);
          if (newTurnRequests.length > 0) {
            broadcast(meetingId, {
              type: "turn_requests",
              data: newTurnRequests,
              timestamp: new Date().toISOString(),
            });
          }
          hadActivity = true;
        }

        const state = currentState;
        if (state) {
          const prevState = participantStatusCache.get(`state:${meetingId}`);
          const stateStr = JSON.stringify({ status: state.status, round: state.round, stats: state.stats });
          if (prevState !== stateStr) {
            participantStatusCache.set(`state:${meetingId}`, stateStr);
            broadcast(meetingId, {
              type: "state",
              data: state,
              timestamp: new Date().toISOString(),
            });
            if (state.status === "weaving") hadActivity = true;
          }
        }

        const participants = api.getParticipants();
        const statusKey = meetingId;
        const prevStatus = participantStatusCache.get(statusKey);
        const newStatus = JSON.stringify(participants.map((p) => ({ id: p.id, status: p.status })));
        if (prevStatus !== newStatus) {
          participantStatusCache.set(statusKey, newStatus);
          if (prevStatus !== undefined) {
            broadcast(meetingId, {
              type: "participants",
              data: participants,
              timestamp: new Date().toISOString(),
            });
            hadActivity = true;
          }
        }

        const maxErrorId = api.getMaxErrorId();
        const prevErrorId = lastErrorId.get(meetingId) ?? 0;
        if (maxErrorId > prevErrorId) {
          lastErrorId.set(meetingId, maxErrorId);
          const newErrors = api.getAgentErrors().filter((e) => e.id > prevErrorId);
          for (const err of newErrors) {
            broadcast(meetingId, {
              type: "agent_error",
              data: err,
              timestamp: new Date().toISOString(),
            });
          }
          hadActivity = true;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Loom dashboard] Poll error for meeting ${meetingId}:`, message);
        broadcast(meetingId, {
          type: "error",
          data: { message, meetingId, phase: "poll" },
          timestamp: new Date().toISOString(),
        });
      }
    }

    if (hadActivity) {
      consecutiveIdlePolls = 0;
      if (currentPollInterval !== ACTIVE_POLL_INTERVAL) {
        currentPollInterval = ACTIVE_POLL_INTERVAL;
        restartPollTimer();
      }
    } else {
      consecutiveIdlePolls++;
      if (consecutiveIdlePolls > 5 && currentPollInterval !== IDLE_POLL_INTERVAL) {
        currentPollInterval = IDLE_POLL_INTERVAL;
        restartPollTimer();
      }
    }

    // Prune stale entries for meetings with no SSE clients
    for (const meetingId of [...lastContributionId.keys()]) {
      if (!sseClients.has(meetingId) || sseClients.get(meetingId).size === 0) {
        lastContributionId.delete(meetingId);
        lastOrchestratorMsgId.delete(meetingId);
        lastInterjectionId.delete(meetingId);
        lastErrorId.delete(meetingId);
        participantStatusCache.delete(meetingId);
        participantStatusCache.delete(`state:${meetingId}`);
        participantStatusCache.delete(`terminal:${meetingId}`);
        participantStatusCache.delete(`artifact:${meetingId}`);
      }
    }
  };

  const restartPollTimer = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollMeetings, currentPollInterval);
  };

  pollTimer = setInterval(pollMeetings, currentPollInterval);

  const server = Bun.serve({
    port,
    async fetch(req) {
      try {
        const url = new URL(req.url);

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
          const meetings = listMeetings(directory);
          return Response.json(meetings);
        }

        if (url.pathname === "/api/meeting") {
          const { api, meetingId, error } = getMeetingApi(url, directory);
          if (error) return error;
          const limit = Math.min(Number(url.searchParams.get("limit")) || 200, 500);
          const offset = Number(url.searchParams.get("offset")) || 0;
          const contributions = api.getContributions(limit, offset);
          const totalContributions = api.getContributionsCount();
          const embeddingModel = api.getEmbeddingModel(meetingId);
          return Response.json({
            state: api.getState(),
            participants: api.getParticipants(),
            contributions,
            turn_requests_legacy: api.getTurnRequestsLegacy(),
            turn_requests: api.getTurnRequests(),
            orchestrator_messages: api.getOrchestratorMessages(meetingId),
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

        if (url.pathname === "/api/participants") {
          const { api, error } = getMeetingApi(url, directory);
          if (error) return error;
          return Response.json(api.getParticipants());
        }

        if (url.pathname === "/api/contributions") {
          const { api, error } = getMeetingApi(url, directory);
          if (error) return error;
          const since = Number(url.searchParams.get("since")) || 0;
          if (since > 0) {
            return Response.json(api.getContributionsSince(since));
          }
          const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
          const offset = Number(url.searchParams.get("offset")) || 0;
          const contributions = api.getContributions(limit, offset);
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

          const stream = new ReadableStream({
            start(controller) {
              if (!sseClients.has(meetingId)) {
                sseClients.set(meetingId, new Set());
              }
              sseClients.get(meetingId).add(controller);
              sendSSE(controller, {
                type: "connected",
                data: { connected: true },
                timestamp: new Date().toISOString(),
              });
            },
            cancel(controller) {
              sseClients.get(meetingId)?.delete(controller);
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        }

        if (url.pathname.startsWith("/assets/")) {
          const assetPath = url.pathname.slice("/assets/".length);
          if (!isAssetPathSafe(assetPath)) {
            return new Response("Not found", { status: 404 });
          }
          const filePath = join(ASSETS_DIR, assetPath);
          const ext = filePath.slice(filePath.lastIndexOf("."));
          const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
          return new Response(Bun.file(filePath), {
            headers: { "Content-Type": contentType },
          });
        }

        return new Response("Not found", { status: 404 });
      } catch (err) {
        const message = err instanceof Error ? err.message : "internal error";
        return Response.json({ error: message }, { status: 500 });
      }
    },
  });

  return {
    port: server.port,
    stop: () => {
      if (pollTimer) clearInterval(pollTimer);
      for (const clients of sseClients.values()) {
        for (const controller of clients) {
          try {
            controller.close();
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
      server.stop();
    },
  };
}

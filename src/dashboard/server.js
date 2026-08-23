import {
  DashboardApi,
  listMeetings,
} from "./api.js";
import { join, resolve, sep } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
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
  HTML_SHELL,
  PACKAGE_VERSION,
} from "./server/helpers.js";
import { createPollSystem } from "./server/poll.js";
import { getMeetingDbPath, isValidMeetingId } from "./api/free.js";

const ASSETS_DIR = findAssetsDir();

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
          const since = Number(url.searchParams.get("since")) || 0;
          if (since > 0) {
            let contribs = api.getContributionsSince(since);
            if (!includeContext) contribs = contribs.map((c) => ({ ...c, prompt_context: null }));
            return Response.json(contribs);
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
              if (!sseClients.has(meetingId)) {
                sseClients.set(meetingId, new Set());
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
          return new Response(Bun.file(filePath), {
            headers: { "Content-Type": contentType, ...SECURITY_HEADERS },
          });
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

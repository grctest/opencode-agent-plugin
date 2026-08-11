import {
  DashboardApi,
  listMeetings,
  getMeetingDbPath,
  isValidMeetingId,
} from "./api.js";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

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
  const lastErrorId = new Map();
  const participantStatusCache = new Map();

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

  const pollInterval = setInterval(() => {
    for (const [meetingId, clients] of sseClients) {
      if (clients.size === 0) continue;
      try {
        const dbPath = getMeetingDbPath(directory, meetingId);
        if (!dbPath) continue;
        const api = DashboardApi.get(dbPath);
        const maxId = api.getMaxContributionId();
        const prevId = lastContributionId.get(meetingId) ?? 0;
        if (maxId > prevId) {
          lastContributionId.set(meetingId, maxId);
          broadcast(meetingId, {
            type: "contribution",
            data: { newContributions: true, sinceId: prevId },
            timestamp: new Date().toISOString(),
          });
        }
        const state = api.getState();
        if (state) {
          broadcast(meetingId, {
            type: "state",
            data: state,
            timestamp: new Date().toISOString(),
          });
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
        }
      } catch {
      }
    }
  }, 1000);

  const server = Bun.serve({
    port,
    fetch(req) {
      try {
        const url = new URL(req.url);

        if (url.pathname === "/" || url.pathname === "/index.html") {
          return new Response(HTML_SHELL, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-cache",
            },
          });
        }

        if (url.pathname === "/api/meetings") {
          const meetings = listMeetings(directory);
          return Response.json(meetings);
        }

        if (url.pathname === "/api/state") {
          const meetingId = url.searchParams.get("meeting");
          if (!meetingId || !isValidMeetingId(meetingId)) {
            return Response.json({ error: "valid meeting id required" }, { status: 400 });
          }
          const dbPath = getMeetingDbPath(directory, meetingId);
          if (!dbPath) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          const api = DashboardApi.get(dbPath);
          return Response.json(api.getState());
        }

        if (url.pathname === "/api/participants") {
          const meetingId = url.searchParams.get("meeting");
          if (!meetingId || !isValidMeetingId(meetingId)) {
            return Response.json({ error: "valid meeting id required" }, { status: 400 });
          }
          const dbPath = getMeetingDbPath(directory, meetingId);
          if (!dbPath) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          const api = DashboardApi.get(dbPath);
          return Response.json(api.getParticipants());
        }

        if (url.pathname === "/api/contributions") {
          const meetingId = url.searchParams.get("meeting");
          if (!meetingId || !isValidMeetingId(meetingId)) {
            return Response.json({ error: "valid meeting id required" }, { status: 400 });
          }
          const dbPath = getMeetingDbPath(directory, meetingId);
          if (!dbPath) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          const api = DashboardApi.get(dbPath);
          const since = Number(url.searchParams.get("since")) || 0;
          if (since > 0) {
            return Response.json(api.getContributionsSince(since));
          }
          return Response.json(api.getContributions());
        }

        if (url.pathname === "/api/interjections") {
          const meetingId = url.searchParams.get("meeting");
          if (!meetingId || !isValidMeetingId(meetingId)) {
            return Response.json({ error: "valid meeting id required" }, { status: 400 });
          }
          const dbPath = getMeetingDbPath(directory, meetingId);
          if (!dbPath) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          const api = DashboardApi.get(dbPath);
          return Response.json(api.getInterjections());
        }

        if (url.pathname === "/api/agent_errors") {
          const meetingId = url.searchParams.get("meeting");
          if (!meetingId || !isValidMeetingId(meetingId)) {
            return Response.json({ error: "valid meeting id required" }, { status: 400 });
          }
          const dbPath = getMeetingDbPath(directory, meetingId);
          if (!dbPath) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          const api = DashboardApi.get(dbPath);
          return Response.json(api.getAgentErrors());
        }

        if (url.pathname === "/api/stream") {
          const meetingId = url.searchParams.get("meeting");
          if (!meetingId || !isValidMeetingId(meetingId)) {
            return Response.json({ error: "valid meeting id required" }, { status: 400 });
          }
          const dbPath = getMeetingDbPath(directory, meetingId);
          if (!dbPath) {
            return Response.json({ error: "not found" }, { status: 404 });
          }

          const stream = new ReadableStream({
            start(controller) {
              if (!sseClients.has(meetingId)) {
                sseClients.set(meetingId, new Set());
              }
              sseClients.get(meetingId).add(controller);
              sendSSE(controller, {
                type: "state",
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
      clearInterval(pollInterval);
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
      lastErrorId.clear();
      participantStatusCache.clear();
      DashboardApi.closeAll();
      server.stop();
    },
  };
}

/**
 * Shared dashboard control-plane runtime: injected opencode client,
 * background job registry, and request helpers.
 */
import { Logger } from "../../../logger.js";

export const logger = new Logger();

// Injected by the plugin host (src/plugin/return.js loom_viz execute).
export const runtime = {
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
export const jobs = new Map();
export const serverState = { runningMeetingId: null, startInFlight: false };

export function getDirectory() {
  return runtime.directory;
}

export function readJsonBody(req, maxBytes = 512 * 1024) {
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

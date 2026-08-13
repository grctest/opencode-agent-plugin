import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { Logger } from "../logger.js";

const indexLogger = new Logger();
const sessionIndex = new Map();
let indexDir = null;

function resolveIndexDir(directory) {
  if (directory && directory !== "/" && directory.trim() !== "") {
    return directory;
  }
  const home = process.env.HOME || process.env.USERPROFILE || "/root";
  const userConfig = join(home, ".config", "opencode");
  return userConfig;
}

function getIndexFilePath() {
  if (!indexDir) return null;
  const dir = resolveIndexDir(indexDir);
  return join(dir, "loom", "session-index.json");
}

export function loadSessionIndex(directory) {
  indexDir = directory;
  const resolvedDir = resolveIndexDir(directory);
  const filePath = join(resolvedDir, "loom", "session-index.json");
  try {
    const data = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(data);
    for (const [sessionId, entries] of Object.entries(parsed)) {
      const validEntries = entries.filter((e) => existsSync(e.dbPath));
      if (validEntries.length > 0) {
        sessionIndex.set(sessionId, validEntries);
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      indexLogger.warn("session_index_load_failed", "Failed to load session index", { filePath, error: err.message });
    }
  }
}

function persistSessionIndex() {
  const filePath = getIndexFilePath();
  if (!filePath) return;
  try {
    const obj = Object.fromEntries(sessionIndex);
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
    renameSync(tmpPath, filePath);
  } catch (err) {
    indexLogger.warn("session_index_persist_failed", "Failed to persist session index", { filePath, error: err.message });
  }
}

export function indexMeeting(dbPath, meetingId, sessionId) {
  if (!sessionId) return;
  const existing = sessionIndex.get(sessionId);
  if (!existing) {
    sessionIndex.set(sessionId, []);
  }
  const entries = sessionIndex.get(sessionId);
  if (!entries.some((e) => e.dbPath === dbPath)) {
    entries.push({ meetingId, dbPath });
    persistSessionIndex();
  }
}

export function unindexMeeting(dbPath) {
  for (const [sessionId, entries] of sessionIndex) {
    const filtered = entries.filter((e) => e.dbPath !== dbPath);
    if (filtered.length === 0) {
      sessionIndex.delete(sessionId);
    } else {
      sessionIndex.set(sessionId, filtered);
    }
  }
  persistSessionIndex();
}

export function getDatabasesBySessionId(sessionId) {
  const entries = sessionIndex.get(sessionId);
  return entries ? [...entries] : [];
}

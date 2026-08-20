import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveLoomBaseDir } from "../paths.js";

function getMeetingsIndexPath(directory) {
  return join(resolveLoomBaseDir(directory), "meetings", "index.json");
}

function loadMeetingsIndex(directory) {
  const filePath = getMeetingsIndexPath(directory);
  if (!existsSync(filePath)) return [];
  try {
    const data = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.meetings)) return parsed.meetings;
    return [];
  } catch {
    return [];
  }
}

function persistMeetingsIndex(directory, entries) {
  const filePath = getMeetingsIndexPath(directory);
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    const payload = { v: 1, meetings: entries };
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
    renameSync(tmpPath, filePath);
  } catch {}
}

export function upsertMeetingsIndex(directory, entry) {
  const entries = loadMeetingsIndex(directory);
  const idx = entries.findIndex((e) => e.meetingId === entry.meetingId);
  if (idx >= 0) {
    entries[idx] = { ...entries[idx], ...entry, updated_at: new Date().toISOString() };
  } else {
    entries.unshift({ ...entry, created_at: entry.created_at ?? new Date().toISOString(), updated_at: new Date().toISOString() });
  }
  // Keep sorted by created_at DESC
  entries.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  persistMeetingsIndex(directory, entries);
}

export function removeMeetingsIndex(directory, meetingId) {
  const entries = loadMeetingsIndex(directory);
  const filtered = entries.filter((e) => e.meetingId !== meetingId);
  if (filtered.length !== entries.length) {
    persistMeetingsIndex(directory, filtered);
  }
}

export function getMeetingsIndex(directory) {
  return loadMeetingsIndex(directory);
}

export function findMeetingsIndexBySession(directory, sessionId) {
  const entries = loadMeetingsIndex(directory);
  return entries.filter((e) => e.opencodeSessionId === sessionId || e.parentSessionId === sessionId);
}

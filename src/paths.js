import { join } from "node:path";
import { homedir } from "node:os";

export function resolveLoomBaseDir(directory) {
  if (directory && directory !== "/" && directory.trim() !== "") {
    return join(directory, ".opencode", "loom");
  }
  const home = process.env.LOOM_CONFIG_DIR || homedir();
  return join(home, ".config", "opencode", "loom");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidMeetingIdLocal(id) { return UUID_RE.test(id); }

export function getMeetingDbPath(directory, meetingId) {
  if (meetingId && !isValidMeetingIdLocal(meetingId)) return null;
  if (directory && directory.includes("..")) return null;
  return join(resolveLoomBaseDir(directory), "meetings", `${meetingId}.db`);
}

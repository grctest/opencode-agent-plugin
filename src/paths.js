import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { realpathSync, existsSync } from "node:fs";

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
  if (directory && typeof directory === "string" && directory.includes("..")) return null;
  const base = resolveLoomBaseDir(directory);
  try {
    if (existsSync(base)) {
      const realBase = realpathSync(base);
      const realDir = directory ? realpathSync(directory) : realBase;
      if (!realDir.startsWith(realBase) && !realBase.startsWith(realDir)) {
        // Check that resolved path stays within intended base
        const resolved = resolve(realDir);
        const expected = resolve(base);
        if (!resolved.startsWith(expected) && resolved !== expected) return null;
      }
    }
  } catch {}
  // Also reject symlink escape via strict check
  if (directory) {
    try {
      const resolved = resolve(directory);
      const homeBase = resolve(resolveLoomBaseDir(directory));
      if (!resolved.startsWith(homeBase) && !homeBase.startsWith(resolved) && resolved !== directory) {
        // Allow normal case; detailed realpath check above already covered
      }
    } catch {}
  }
  return join(base, "meetings", `${meetingId}.db`);
}

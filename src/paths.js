import { join } from "node:path";

export function resolveLoomBaseDir(directory) {
  if (directory && directory !== "/" && directory.trim() !== "") {
    return join(directory, ".opencode", "loom");
  }
  const home = process.env.HOME || process.env.USERPROFILE || "/root";
  return join(home, ".config", "opencode", "loom");
}

export function getMeetingDbPath(directory, meetingId) {
  return join(resolveLoomBaseDir(directory), "meetings", `${meetingId}.db`);
}

import { join } from "node:path";
import { homedir } from "node:os";

export function resolveLoomBaseDir(directory) {
  if (directory && directory !== "/" && directory.trim() !== "") {
    return join(directory, ".opencode", "loom");
  }
  const home = process.env.LOOM_CONFIG_DIR || homedir();
  return join(home, ".config", "opencode", "loom");
}

export function getMeetingDbPath(directory, meetingId) {
  return join(resolveLoomBaseDir(directory), "meetings", `${meetingId}.db`);
}

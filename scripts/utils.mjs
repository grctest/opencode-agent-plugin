/**
 * Shared utilities for install/update scripts.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

export const logInfo = (msg) => console.log(`${GREEN}[INFO]${RESET}  ${msg}`);
export const logWarn = (msg) => console.log(`${YELLOW}[WARN]${RESET}  ${msg}`);
export const logError = (msg) => console.log(`${RED}[ERROR]${RESET} ${msg}`);

export function isWSL() {
  try {
    const procVersion = readFileSync("/proc/version", "utf-8");
    return /microsoft|wsl/i.test(procVersion);
  } catch {
    return false;
  }
}

export function getWSLWindowsHome() {
  try {
    const result = spawnSync("wslpath", ["$(wslvar USERPROFILE)"], {
      shell: true,
      encoding: "utf-8",
    });
    if (result.status === 0 && result.stdout) {
      return result.stdout.trim();
    }
  } catch {
    // Fall through
  }
  return null;
}

export function detectOpencodeDir() {
  const candidates = [];

  if (process.env.OPENCODE_CONFIG_DIR) {
    candidates.push(process.env.OPENCODE_CONFIG_DIR);
  }

  candidates.push(join(homedir(), ".config", "opencode"));
  candidates.push(join(homedir(), ".opencode"));

  if (process.platform === "linux" && isWSL()) {
    const winHome = getWSLWindowsHome();
    if (winHome) {
      candidates.push(join(winHome, ".config", "opencode"));
      candidates.push(join(winHome, ".opencode"));
    }
  }

  for (const dir of candidates) {
    if (existsSync(dir)) {
      return dir;
    }
  }

  return null;
}

export function isLoomCommand(filename) {
  // Known-manifest approach (audit 08 SC3): only files we actually ship (plus
  // the explicitly-listed legacy name) are eligible for cleanup. A pattern
  // regex here used to delete unrelated user files whose names merely started
  // with "knit_"/"loom_".
  const loomCommands = ["knit.md", "list_knit_models.md", "enable_knit_models.md", "disable_knit_models.md", "reset_knit_models.md", "loom_viz.md", "loom_stop.md"];
  if (loomCommands.includes(filename)) return true;
  // Legacy single-file command — must be cleaned up on update/install
  if (filename === "knit_models.md") return true;
  return false;
}

export function findOpencodeJson(opencodeDir) {
  const candidates = [
    join(opencodeDir, "opencode.json"),
    join(opencodeDir, "opencode.jsonc"),
  ];

  for (const file of candidates) {
    if (existsSync(file)) {
      return file;
    }
  }

  return null;
}

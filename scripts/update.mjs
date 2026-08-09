/**
 * The Loom — Plugin Updater for opencode
 * Clears old installation and triggers fresh install.
 * Supports WSL, Linux, and macOS.
 *
 * Run with: node scripts/update.mjs
 */

import { existsSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const logInfo = (msg) => console.log(`${GREEN}[INFO]${RESET}  ${msg}`);
const logWarn = (msg) => console.log(`${YELLOW}[WARN]${RESET}  ${msg}`);
const logError = (msg) => console.log(`${RED}[ERROR]${RESET} ${msg}`);

// ─── Detect opencode config directory ─────────────────────────────────────────

function detectOpencodeDir() {
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

function isWSL() {
  try {
    const procVersion = readFileSync("/proc/version", "utf-8");
    return /microsoft|wsl/i.test(procVersion);
  } catch {
    return false;
  }
}

function getWSLWindowsHome() {
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

// ─── Clean old installation ───────────────────────────────────────────────────

function cleanOldInstallation(opencodeDir) {
  let cleaned = false;

  // Remove old plugin/loom/ directory (old format)
  const oldPluginDir = join(opencodeDir, "plugin", "loom");
  if (existsSync(oldPluginDir)) {
    rmSync(oldPluginDir, { recursive: true });
    logInfo(`  Removed old plugin/loom/ → ${oldPluginDir}`);
    cleaned = true;
  }

  // Remove stale empty plugin/ directory
  const oldPluginRoot = join(opencodeDir, "plugin");
  if (existsSync(oldPluginRoot)) {
    rmSync(oldPluginRoot, { recursive: true });
    logInfo(`  Removed old plugin/ dir`);
    cleaned = true;
  }

  // Remove old skill files
  const skillDir = join(opencodeDir, "skills", "loom");
  if (existsSync(skillDir)) {
    rmSync(skillDir, { recursive: true });
    logInfo(`  Removed old skill → ${skillDir}`);
    cleaned = true;
  }

  // Remove current loom plugin from plugins/ (will be reinstalled)
  const pluginsDir = join(opencodeDir, "plugins");
  const loomTarget = join(pluginsDir, "loom.js");
  if (existsSync(loomTarget)) {
    rmSync(loomTarget);
    logInfo(`  Removed old plugin → ${loomTarget}`);
    cleaned = true;
  }

  // Remove old command files
  const commandDir = join(opencodeDir, "commands");
  if (existsSync(commandDir)) {
    const loomCommands = readdirSync(commandDir).filter(
      (f) => f.endsWith(".md") && isLoomCommand(f)
    );
    for (const file of loomCommands) {
      rmSync(join(commandDir, file));
      logInfo(`  Removed old command → ${commandDir}/${file}`);
      cleaned = true;
    }
  }

  // Clean config entries
  if (cleanConfig(opencodeDir)) {
    cleaned = true;
  }

  if (!cleaned) {
    logInfo("No previous installation found — will perform fresh install");
  }

  return cleaned;
}

function isLoomCommand(filename) {
  const loomCommands = ["knit.md", "knit_models.md"];
  return loomCommands.includes(filename);
}

function findOpencodeJson(opencodeDir) {
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

function cleanConfig(opencodeDir) {
  const configFile = findOpencodeJson(opencodeDir);
  if (!configFile) {
    return false;
  }

  try {
    const content = readFileSync(configFile, "utf-8");
    const config = JSON.parse(content);
    let modified = false;

    // Remove old plugin entries
    if (Array.isArray(config.plugin)) {
      const originalLength = config.plugin.length;
      config.plugin = config.plugin.filter((p) => {
        const normalized = p.replace(/\\/g, "/");
        return !normalized.includes("plugin/loom") && !normalized.includes("plugin\\loom");
      });
      if (config.plugin.length !== originalLength) {
        logInfo("Removed old plugin entries from config");
        modified = true;
      }
      // If plugin array is now empty, remove it entirely
      if (config.plugin.length === 0) {
        delete config.plugin;
        logInfo("Removed empty plugin array from config");
        modified = true;
      }
    }

    // Remove old agent entry
    if (config.agent?.loom) {
      delete config.agent.loom;
      logInfo("Removed old loom agent from config");
      modified = true;
    }

    if (modified) {
      writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
    }

    return modified;
  } catch {
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log("");
console.log("═══════════════════════════════════════════════════════════════");
console.log("  The Loom — opencode plugin updater");
console.log("═══════════════════════════════════════════════════════════════");
console.log("");

// Check for opencode config
const opencodeDir = detectOpencodeDir();

if (!opencodeDir) {
  logError("Could not find opencode config directory.");
  console.log("");
  console.log("Searched:");
  console.log("  - OPENCODE_CONFIG_DIR (env var)");
  console.log("  - ~/.config/opencode");
  console.log("  - ~/.opencode");
  if (process.platform === "linux") {
    console.log("  - Windows %USERPROFILE%/.config/opencode (WSL)");
    console.log("  - Windows %USERPROFILE%/.opencode (WSL)");
  }
  console.log("");
  console.log("To fix:");
  console.log("  1. Ensure opencode is installed and configured");
  console.log("  2. Set OPENCODE_CONFIG_DIR to your config path:");
  console.log("     export OPENCODE_CONFIG_DIR=/path/to/opencode/config");
  console.log("");
  process.exit(1);
}

logInfo(`Found opencode config: ${opencodeDir}`);

// Step 1: Clean old installation
console.log("");
logInfo("Cleaning old installation...");
cleanOldInstallation(opencodeDir);

// Step 2: Run fresh install
console.log("");
logInfo("Running fresh install...");
console.log("");

const installScript = join(PROJECT_ROOT, "scripts", "install.mjs");
const result = spawnSync("node", [installScript], {
  cwd: PROJECT_ROOT,
  stdio: "inherit",
});

if (result.status !== 0) {
  logError("Install script failed");
  process.exit(1);
}

/**
 * The Loom — Plugin Installer for opencode
 * Detects opencode config directory and installs/updates plugin files.
 * Supports WSL, Linux, and macOS.
 *
 * Run with: node scripts/install.mjs
 */

import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
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

  // Explicit env override
  if (process.env.OPENCODE_CONFIG_DIR) {
    candidates.push(process.env.OPENCODE_CONFIG_DIR);
  }

  // Standard locations
  candidates.push(join(homedir(), ".config", "opencode"));
  candidates.push(join(homedir(), ".opencode"));

  // WSL: check for Windows opencode config
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

// ─── Install files ────────────────────────────────────────────────────────────

function installFiles(opencodeDir) {
  const pluginDir = join(opencodeDir, "plugin", "loom");
  const skillDir = join(opencodeDir, "skills", "loom");
  const commandDir = join(opencodeDir, "commands");

  // Clean and create directories
  for (const dir of [pluginDir, skillDir, commandDir]) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true });
    }
    mkdirSync(dir, { recursive: true });
  }

  // Copy compiled output
  const distDir = join(PROJECT_ROOT, "dist");
  if (!existsSync(distDir)) {
    throw new Error("dist/ directory not found. Build may have failed.");
  }

  cpSync(distDir, pluginDir, { recursive: true });
  logInfo(`  Installed plugin → ${pluginDir}`);

  // Copy commands (all .md files from commands directory)
  const commandsSrcDir = join(PROJECT_ROOT, "commands");
  if (existsSync(commandsSrcDir)) {
    const commandFiles = readdirSync(commandsSrcDir).filter((f) => f.endsWith(".md"));
    for (const file of commandFiles) {
      cpSync(join(commandsSrcDir, file), join(commandDir, file));
      logInfo(`  Installed command → ${commandDir}/${file}`);
    }
  }
}

// ─── Configure opencode.json ──────────────────────────────────────────────────

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

function configureOpencodeJson(opencodeDir, pluginPath) {
  const configFile = findOpencodeJson(opencodeDir);

  if (!configFile) {
    logWarn("No opencode.json found. Create one with:");
    console.log(`  { "plugin": ["${pluginPath}"], "agent": { "loom": {...} } }`);
    return;
  }

  try {
    const content = readFileSync(configFile, "utf-8");
    const config = JSON.parse(content);

    // Configure plugin
    if (!config.plugin) {
      config.plugin = [];
    }

    if (!Array.isArray(config.plugin)) {
      logWarn("opencode.json has 'plugin' as non-array. Skipping auto-config.");
      return;
    }

    const pluginAlreadyConfigured = config.plugin.some((p) => {
      const normalized = p.replace(/\\/g, "/");
      return normalized.includes("plugin/loom") || normalized.includes("plugin\\loom");
    });

    if (!pluginAlreadyConfigured) {
      config.plugin.push(pluginPath);
      logInfo("Added plugin to opencode.json");
    } else {
      logInfo("Plugin already configured in opencode.json");
    }

    // Configure agent
    if (!config.agent) {
      config.agent = {};
    }

    if (!config.agent.loom) {
      config.agent.loom = {
        mode: "primary",
        description: "Loom deliberation orchestrator. Only triggered by /knit command.",
        prompt: "You are the Loom orchestrator. When invoked via /knit, call the `knit` tool with the user's exact question. When invoked via /knit_models, call the `knit_models` tool. Do not take any other actions.",
      };
      logInfo("Added loom agent to opencode.json");
    } else {
      logInfo("Loom agent already configured in opencode.json");
    }

    writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
    logInfo(`Updated ${configFile}`);
  } catch (err) {
    logWarn(`Could not update opencode.json: ${err.message}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log("");
console.log("═══════════════════════════════════════════════════════════════");
console.log("  The Loom — opencode plugin installer");
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

// Verify build exists
const distDir = join(PROJECT_ROOT, "dist");
if (!existsSync(distDir)) {
  logError("dist/ directory not found.");
  console.log("");
  console.log("Run 'npm run build' first, then re-run this installer.");
  console.log("");
  process.exit(1);
}

const pluginEntry = join(opencodeDir, "plugin", "loom", "index.js");

// Install
try {
  console.log("");
  logInfo("Installing plugin files...");
  installFiles(opencodeDir);
  console.log("");
  logInfo("Configuring opencode.json...");
  configureOpencodeJson(opencodeDir, pluginEntry);
} catch (err) {
  logError(err.message || "Installation failed");
  process.exit(1);
}

// Summary
console.log("");
console.log("═══════════════════════════════════════════════════════════════");
console.log("  Installation complete!");
console.log("═══════════════════════════════════════════════════════════════");
console.log("");
console.log("Next steps:");
console.log("  1. Restart opencode or reload plugins");
console.log("  2. Run /knit_models to discover available models");
console.log("  3. Run /knit \"your question\" to start a deliberation");
console.log("");
logInfo("Done.");

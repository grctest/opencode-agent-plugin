/**
 * The Loom — Plugin Updater for opencode
 * Safe update sequence (audit 13 SC2): verify the new bundle BEFORE removing the
 * old installation, back up what gets removed, and restore the backup if install
 * fails. The old flow deleted first and installed second with no rollback, which
 * could brick a working installation on a stale/missing dist.
 *
 * Run with: npm run update:plugin  (bundles first — always ships current code)
 */

import { existsSync, rmSync, readFileSync, writeFileSync, readdirSync, mkdirSync, cpSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { detectOpencodeDir, isLoomCommand, findOpencodeJson, logInfo, logError } from "./utils.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

// ─── Bundle verification ──────────────────────────────────────────────────────

function verifyBundle() {
  const distPath = join(PROJECT_ROOT, "dist", "loom.js");
  if (!existsSync(distPath)) {
    logError("dist/loom.js is missing — run `npm run bundle` before updating.");
    process.exit(1);
  }
  const stat = statSync(distPath).size;
  if (!stat || stat === 0) {
    logError("dist/loom.js is empty — refusing to update to a zero-byte bundle.");
    process.exit(1);
  }
  // Syntax gate: a stale or corrupt bundle must never replace a working install
  const check = spawnSync(process.execPath, ["--check", distPath], { stdio: "pipe" });
  if (check.status !== 0) {
    logError("dist/loom.js failed syntax verification:");
    console.error(check.stderr?.toString() ?? "(no output)");
    process.exit(1);
  }
  logInfo(`Bundle verified (${(stat / (1024 * 1024)).toFixed(2)} MB, syntax OK)`);
}

function verifyToolRegistration() {
  const distPath = join(PROJECT_ROOT, "dist", "loom.js");
  const content = readFileSync(distPath, "utf-8");
  const required = [
    "loom_vector_search",
    "loom_query",
    "loom_evidence",
    "loom_vote",
    "loom_summon",
    "loom_request_next",
    "loom_type",
  ];
  const missing = required.filter((name) => !content.includes(`"${name}"`));
  if (missing.length > 0) {
    logError(`Bundle is missing ${missing.length} agent tool(s): ${missing.join(", ")}`);
    logError("The bundle must register all loom agent tools. Run 'npm run bundle' and try again.");
    process.exit(1);
  }
  logInfo(`All ${required.length} agent tools verified in bundle`);
}

// ─── Backup / rollback ────────────────────────────────────────────────────────

const BACKED_UP = [];

function backupFile(path) {
  if (!existsSync(path)) return;
  const bak = `${path}.update-bak`;
  try {
    cpSync(path, bak);
    BACKED_UP.push({ original: path, backup: bak });
  } catch (err) {
    logError(`Could not back up ${path}: ${err.message}`);
  }
}

function backupDir(path) {
  if (!existsSync(path)) return;
  const bak = `${path}.update-bak`;
  try {
    cpSync(path, bak, { recursive: true });
    BACKED_UP.push({ original: path, backup: bak });
  } catch (err) {
    logError(`Could not back up ${path}: ${err.message}`);
  }
}

function rollback() {
  logError("Update failed — restoring previous installation from backups...");
  for (const { original, backup } of BACKED_UP) {
    try {
      rmSync(original, { recursive: true, force: true });
      cpSync(backup, original, { recursive: true });
      logInfo(`  Restored ${original}`);
    } catch (err) {
      logError(`  FAILED to restore ${original} (backup kept at ${backup}): ${err.message}`);
    }
  }
}

// ─── Clean old installation (after backups exist) ─────────────────────────────

function cleanOldInstallation(opencodeDir) {
  let cleaned = false;

  // Remove old plugin/loom/ directory (old format)
  const oldPluginDir = join(opencodeDir, "plugin", "loom");
  if (existsSync(oldPluginDir)) {
    backupDir(oldPluginDir);
    rmSync(oldPluginDir, { recursive: true });
    logInfo(`  Removed old plugin/loom/ → ${oldPluginDir}`);
    cleaned = true;
  }

  // Remove stale empty plugin/ directory
  const oldPluginRoot = join(opencodeDir, "plugin");
  if (existsSync(oldPluginRoot) && readdirSync(oldPluginRoot).length === 0) {
    rmSync(oldPluginRoot);
    logInfo(`  Removed empty plugin/ dir`);
    cleaned = true;
  }

  // Remove old skill files
  const skillDir = join(opencodeDir, "skills", "loom");
  if (existsSync(skillDir)) {
    backupDir(skillDir);
    rmSync(skillDir, { recursive: true });
    logInfo(`  Removed old skill → ${skillDir}`);
    cleaned = true;
  }

  // Remove current loom plugin from plugins/ (will be reinstalled)
  const pluginsDir = join(opencodeDir, "plugins");
  const loomTarget = join(pluginsDir, "loom.js");
  if (existsSync(loomTarget)) {
    backupFile(loomTarget);
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
      backupFile(join(commandDir, file));
      rmSync(join(commandDir, file));
      logInfo(`  Removed old command → ${commandDir}/${file}`);
      cleaned = true;
    }
    const legacyModelCmd = join(commandDir, "knit_models.md");
    if (existsSync(legacyModelCmd)) {
      rmSync(legacyModelCmd);
      logInfo(`  Removed legacy command → ${legacyModelCmd} (replaced by list/enable/disable/reset_knit_models)`);
      cleaned = true;
    }
  }

  // Remove old personas folder
  const personasDir = join(opencodeDir, "personas", "loom");
  if (existsSync(personasDir)) {
    backupDir(personasDir);
    rmSync(personasDir, { recursive: true });
    logInfo(`  Removed old personas → ${personasDir}`);
    cleaned = true;
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

// Step 0: Verify the NEW bundle is present and valid BEFORE touching anything
logInfo("Verifying new bundle...");
verifyBundle();
verifyToolRegistration();

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

// Step 1: Back up + clean old installation
console.log("");
logInfo("Backing up and cleaning old installation...");
cleanOldInstallation(opencodeDir);

// Step 2: Run fresh install; roll back on failure
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
  rollback();
  process.exit(1);
}

console.log("");
logInfo("Update complete.");

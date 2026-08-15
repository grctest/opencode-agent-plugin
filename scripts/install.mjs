/**
 * The Loom — Plugin Installer for opencode
 * Detects opencode config directory and installs/updates plugin files.
 * Supports WSL, Linux, and macOS.
 *
 * Run with: node scripts/install.mjs
 */

import { existsSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectOpencodeDir, isLoomCommand, findOpencodeJson, logInfo, logWarn, logError } from "./utils.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

// ─── Install files ────────────────────────────────────────────────────────────

function installFiles(opencodeDir) {
  const pluginsDir = join(opencodeDir, "plugins");
  const commandDir = join(opencodeDir, "commands");

  // Remove stale plugin/loom/ directory (old format)
  const oldPluginDir = join(opencodeDir, "plugin", "loom");
  if (existsSync(oldPluginDir)) {
    rmSync(oldPluginDir, { recursive: true });
    logInfo(`  Removed stale plugin/loom/ → ${oldPluginDir}`);
  }

  // Remove stale skills/loom/ directory
  const oldSkillDir = join(opencodeDir, "skills", "loom");
  if (existsSync(oldSkillDir)) {
    rmSync(oldSkillDir, { recursive: true });
    logInfo(`  Removed stale skills/loom/ → ${oldSkillDir}`);
  }

  // Remove stale plugin/ dir if empty
  const oldPluginRoot = join(opencodeDir, "plugin");
  if (existsSync(oldPluginRoot) && readdirSync(oldPluginRoot).length === 0) {
    rmSync(oldPluginRoot);
    logInfo(`  Removed empty plugin/ dir`);
  }

  // Only remove and replace loom command files, preserving any other user commands
  if (existsSync(commandDir)) {
    const loomCommands = readdirSync(commandDir).filter(
      (f) => f.endsWith(".md") && isLoomCommand(f)
    );
    for (const file of loomCommands) {
      rmSync(join(commandDir, file));
      logInfo(`  Replaced command → ${commandDir}/${file}`);
    }
  } else {
    mkdirSync(commandDir, { recursive: true });
  }

  // Verify bundled plugin exists
  const bundledPlugin = join(PROJECT_ROOT, "dist", "loom.js");
  if (!existsSync(bundledPlugin)) {
    throw new Error("dist/loom.js not found. Run 'npm run bundle' first.");
  }

  // Create plugins/ directory (don't delete — other plugins could exist)
  if (!existsSync(pluginsDir)) {
    mkdirSync(pluginsDir, { recursive: true });
  }

  // Remove old loom file if present, then copy bundled plugin
  const loomTarget = join(pluginsDir, "loom.js");
  if (existsSync(loomTarget)) {
    rmSync(loomTarget);
  }
  cpSync(bundledPlugin, loomTarget);
  logInfo(`  Installed plugin → ${loomTarget}`);

  // Remove stale better-sqlite3 from opencode config (if present from previous install)
  const staleBetterSqlite3 = join(opencodeDir, "node_modules", "better-sqlite3");
  if (existsSync(staleBetterSqlite3)) {
    rmSync(staleBetterSqlite3, { recursive: true });
    logInfo("  Removed stale better-sqlite3 (bun:sqlite is built-in)");
  }

  // Copy loom commands
  const commandsSrcDir = join(PROJECT_ROOT, "commands");
  if (existsSync(commandsSrcDir)) {
    const commandFiles = readdirSync(commandsSrcDir).filter((f) => f.endsWith(".md"));
    for (const file of commandFiles) {
      cpSync(join(commandsSrcDir, file), join(commandDir, file));
      logInfo(`  Installed command → ${commandDir}/${file}`);
    }
  }

  // Copy personas folder
  const personasSrcDir = join(PROJECT_ROOT, "personas");
  const personasTargetDir = join(opencodeDir, "personas", "loom");
  if (existsSync(personasSrcDir)) {
    if (existsSync(personasTargetDir)) {
      rmSync(personasTargetDir, { recursive: true });
    }
    mkdirSync(personasTargetDir, { recursive: true });
    const personaFiles = readdirSync(personasSrcDir).filter((f) => f.endsWith(".json"));
    for (const file of personaFiles) {
      cpSync(join(personasSrcDir, file), join(personasTargetDir, file));
    }
    logInfo(`  Installed personas → ${personasTargetDir}`);
  }

  // Copy dashboard assets
  const dashboardSrcDir = join(PROJECT_ROOT, "dist", "dashboard");
  const dashboardTargetDir = join(opencodeDir, "plugins", "loom", "dashboard");
  if (existsSync(dashboardSrcDir)) {
    if (existsSync(dashboardTargetDir)) {
      rmSync(dashboardTargetDir, { recursive: true });
    }
    mkdirSync(dashboardTargetDir, { recursive: true });
    const dashboardFiles = readdirSync(dashboardSrcDir);
    for (const file of dashboardFiles) {
      cpSync(join(dashboardSrcDir, file), join(dashboardTargetDir, file));
    }
    logInfo(`  Installed dashboard → ${dashboardTargetDir}`);
  }
}

// ─── Configure opencode.json ──────────────────────────────────────────────────

function configureOpencodeJson(opencodeDir) {
  const configFile = findOpencodeJson(opencodeDir);

  if (!configFile) {
    logInfo("No opencode.json found — local plugins are auto-discovered from plugins/ dir");
    return;
  }

  try {
    const content = readFileSync(configFile, "utf-8");
    const config = JSON.parse(content);
    let modified = false;

    // Remove any stale plugin config entries pointing to the old plugin/loom path
    if (Array.isArray(config.plugin)) {
      const originalLength = config.plugin.length;
      config.plugin = config.plugin.filter((p) => {
        const normalized = p.replace(/\\/g, "/");
        return !normalized.includes("plugin/loom") && !normalized.includes("plugin\\loom");
      });
      if (config.plugin.length !== originalLength) {
        logInfo("Removed stale plugin entries from config");
        modified = true;
      }
      // If plugin array is now empty, remove it entirely
      if (config.plugin.length === 0) {
        delete config.plugin;
        logInfo("Removed empty plugin array from config");
        modified = true;
      }
    }

    if (modified) {
      writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
      logInfo(`Updated ${configFile}`);
    } else {
      logInfo(`Config OK — ${configFile}`);
    }
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

// Verify bundled plugin exists
const bundledPlugin = join(PROJECT_ROOT, "dist", "loom.js");
if (!existsSync(bundledPlugin)) {
  logError("dist/loom.js not found.");
  console.log("");
  console.log("Run 'npm run bundle' first, then re-run this installer.");
  console.log("");
  process.exit(1);
}

// Install
try {
  console.log("");
  logInfo("Installing plugin files...");
  installFiles(opencodeDir);
  console.log("");
  logInfo("Cleaning config...");
  configureOpencodeJson(opencodeDir);
  
  // Auto-download default embedding model
  console.log("");
  logInfo("Downloading default embedding model...");
  const { execSync } = await import("node:child_process");
  try {
    execSync("npm run model:download", { 
      cwd: PROJECT_ROOT, 
      stdio: "inherit",
      timeout: 120000 // 2 minute timeout
    });
    logInfo("Default embedding model downloaded successfully.");
  } catch (err) {
    logWarn(`Could not download default embedding model: ${err.message}`);
    logInfo("You can download it manually later with: npm run model:download");
  }

  // Install runtime deps (onnxruntime-node, @huggingface/tokenizers) into the
  // config's loom/deps dir so the deployed plugin can resolve them at runtime
  // (bare imports resolve relative to the plugin file, not the project).
  console.log("");
  logInfo("Installing runtime deps (onnxruntime-node, @huggingface/tokenizers)...");
  try {
    execSync("npm install --prefix " + join(opencodeDir, "loom", "deps") + " onnxruntime-node@^1.27.0 @huggingface/tokenizers@^0.1.3", {
      cwd: PROJECT_ROOT,
      stdio: "inherit",
      timeout: 300000 // 5 minute timeout
    });
    logInfo("Runtime deps installed successfully.");
  } catch (err) {
    logWarn(`Could not install runtime deps: ${err.message}`);
    logInfo("Run: npm install --prefix " + join(opencodeDir, "loom", "deps") + " onnxruntime-node@^1.27.0 @huggingface/tokenizers@^0.1.3");
  }
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

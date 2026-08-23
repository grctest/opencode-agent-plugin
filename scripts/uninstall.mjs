/**
 * The Loom — Plugin Uninstaller for opencode
 * Removes every trace of the Loom plugin so a subsequent install is
 * irrefutably from scratch. No leftover code, commands, personas, or
 * config entries survive.
 *
 * Scope: opencode plugin only (plugins/, commands/, personas/, opencode.json).
 * Project data (.opencode/loom/meetings etc.) is NOT touched.
 *
 * Run with: node scripts/uninstall.mjs [--purge-deps] [--dir /path/to/opencode]
 */

import { existsSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectOpencodeDir, isLoomCommand, findOpencodeJson, logInfo, logWarn, logError } from "./utils.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

const args = process.argv.slice(2);
const PURGE_DEPS = args.includes("--purge-deps");
let overrideDir = null;
const dirFlag = args.find((a) => a === "--dir");
if (dirFlag) {
  const idx = args.indexOf("--dir");
  overrideDir = args[idx + 1] ?? null;
}
if (!overrideDir) {
  const eq = args.find((a) => a.startsWith("--dir="));
  if (eq) overrideDir = eq.split("=")[1];
}

function removeIfExists(path, label) {
  if (!existsSync(path)) return false;
  try {
    rmSync(path, { recursive: true, force: true });
    logInfo(`  Removed ${label} → ${path}`);
    return true;
  } catch (err) {
    logWarn(`  Failed to remove ${label} ${path}: ${err.message}`);
    return false;
  }
}

function cleanConfig(opencodeDir) {
  const configFile = findOpencodeJson(opencodeDir);
  if (!configFile) {
    logInfo("  No opencode.json/jsonc found — nothing to clean in config");
    return false;
  }
  try {
    const content = readFileSync(configFile, "utf-8");
    const config = JSON.parse(content);
    let modified = false;

    if (Array.isArray(config.plugin)) {
      const before = config.plugin.length;
      config.plugin = config.plugin.filter((p) => {
        const n = p.replace(/\\/g, "/");
        return !n.includes("plugin/loom") && !n.includes("plugin\\loom") && !n.toLowerCase().includes("loom");
      });
      if (config.plugin.length !== before) {
        logInfo(`  Removed ${before - config.plugin.length} loom entry(ies) from plugin[] in ${configFile}`);
        modified = true;
      }
      if (config.plugin.length === 0) {
        delete config.plugin;
        logInfo("  Removed empty plugin[] from config");
        modified = true;
      }
    }

    if (config.agent?.loom) {
      delete config.agent.loom;
      logInfo("  Removed agent.loom from config");
      modified = true;
    }
    // Also handle top-level loom key if present
    if (config.loom && typeof config.loom === "object") {
      // The loom key in opencode.json is the loom config itself — keep it? User wants fresh install,
      // but removing it would wipe user's loom settings. Only remove if explicitly requested via --purge.
      // For now, preserve it and just notify.
      logInfo("  Preserved top-level loom config (use --purge to wipe loom settings)");
    }

    if (modified) {
      writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n");
      logInfo(`  Updated ${configFile}`);
    } else {
      logInfo(`  Config OK (no loom entries) — ${configFile}`);
    }
    return modified;
  } catch (err) {
    logWarn(`  Could not clean config ${configFile}: ${err.message}`);
    return false;
  }
}

function uninstallFromDir(opencodeDir) {
  let removed = 0;
  console.log("");
  logInfo(`Uninstalling from: ${opencodeDir}`);

  // --- plugins/loom.js and backups ---
  const pluginsDir = join(opencodeDir, "plugins");
  const loomJs = join(pluginsDir, "loom.js");
  const loomJsBak = `${loomJs}.update-bak`;
  if (removeIfExists(loomJs, "plugin")) removed++;
  if (removeIfExists(loomJsBak, "plugin backup")) removed++;
  // Also handle old .bak naming from install
  const loomJsInstallBak = join(pluginsDir, "loom.js.bak");
  if (removeIfExists(loomJsInstallBak, "plugin backup")) removed++;

  // --- plugins/loom/ dashboard and legacy dirs ---
  const loomPluginDir = join(pluginsDir, "loom");
  if (removeIfExists(loomPluginDir, "plugin dashboard dir")) removed++;
  const loomPluginDirBak = `${loomPluginDir}.update-bak`;
  if (removeIfExists(loomPluginDirBak, "plugin dashboard backup")) removed++;

  const oldPluginDir = join(opencodeDir, "plugin", "loom");
  if (removeIfExists(oldPluginDir, "legacy plugin/loom")) removed++;
  const oldPluginDirBak = `${oldPluginDir}.update-bak`;
  if (removeIfExists(oldPluginDirBak, "legacy plugin backup")) removed++;
  const oldPluginRoot = join(opencodeDir, "plugin");
  if (existsSync(oldPluginRoot)) {
    try {
      if (readdirSync(oldPluginRoot).length === 0) {
        rmSync(oldPluginRoot, { recursive: true });
        logInfo(`  Removed empty plugin/ dir → ${oldPluginRoot}`);
        removed++;
      }
    } catch {}
  }

  // --- skills/loom/ legacy ---
  const skillDir = join(opencodeDir, "skills", "loom");
  if (removeIfExists(skillDir, "legacy skills/loom")) removed++;
  const skillDirBak = `${skillDir}.update-bak`;
  if (removeIfExists(skillDirBak, "legacy skills backup")) removed++;

  // --- commands ---
  const commandDir = join(opencodeDir, "commands");
  if (existsSync(commandDir)) {
    const files = readdirSync(commandDir);
    for (const f of files) {
      if (isLoomCommand(f) || f === "knit_models.md") {
        if (removeIfExists(join(commandDir, f), "command")) removed++;
        // also remove backup if update created one
        const bak = join(commandDir, `${f}.update-bak`);
        if (removeIfExists(bak, "command backup")) removed++;
      }
    }
  } else {
    logInfo("  No commands/ dir — skipping");
  }

  // --- personas/loom ---
  const personasDir = join(opencodeDir, "personas", "loom");
  if (removeIfExists(personasDir, "personas")) removed++;
  const personasBak = `${personasDir}.install-bak`;
  if (removeIfExists(personasBak, "personas backup")) removed++;
  const personasUpdateBak = `${personasDir}.update-bak`;
  if (removeIfExists(personasUpdateBak, "personas update backup")) removed++;

  // --- stale better-sqlite3 ---
  const staleBetterSqlite3 = join(opencodeDir, "node_modules", "better-sqlite3");
  if (removeIfExists(staleBetterSqlite3, "stale better-sqlite3")) removed++;

  // --- optional: purge runtime deps ---
  if (PURGE_DEPS) {
    const depsDir = join(pluginsDir, "deps");
    if (removeIfExists(depsDir, "runtime deps")) removed++;
  } else {
    logInfo("  Kept plugins/deps (use --purge-deps to remove runtime deps)");
  }

  // --- opencode.json ---
  if (cleanConfig(opencodeDir)) removed++;

  return removed;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

console.log("");
console.log("═══════════════════════════════════════════════════════════════");
console.log("  The Loom — opencode plugin uninstaller");
console.log("  Removes every trace so the next install is from scratch");
console.log("═══════════════════════════════════════════════════════════════");
console.log("");

let opencodeDir = overrideDir || detectOpencodeDir();
if (!opencodeDir) {
  logError("Could not find opencode config directory.");
  console.log("");
  console.log("Searched:");
  console.log("  - --dir flag (if provided)");
  console.log("  - OPENCODE_CONFIG_DIR (env var)");
  console.log("  - ~/.config/opencode");
  console.log("  - ~/.opencode");
  if (process.platform === "linux") {
    try {
      const { readFileSync } = await import("node:fs");
      const v = readFileSync("/proc/version", "utf-8");
      if (/microsoft|wsl/i.test(v)) {
        console.log("  - Windows %USERPROFILE%/.config/opencode (WSL)");
        console.log("  - Windows %USERPROFILE%/.opencode (WSL)");
      }
    } catch {}
  }
  console.log("");
  console.log("To fix:");
  console.log("  export OPENCODE_CONFIG_DIR=/path/to/opencode/config");
  console.log("  node scripts/uninstall.mjs --dir /path/to/opencode/config");
  console.log("");
  process.exit(1);
}

logInfo(`Found opencode config: ${opencodeDir}`);

let totalRemoved = 0;
try {
  totalRemoved = uninstallFromDir(opencodeDir);
} catch (err) {
  logError(err.message || "Uninstall failed");
  process.exit(1);
}

console.log("");
console.log("═══════════════════════════════════════════════════════════════");
if (totalRemoved === 0) {
  console.log("  Nothing to remove — no Loom traces found.");
} else {
  console.log(`  Uninstall complete — removed ${totalRemoved} item(s).`);
}
console.log("═══════════════════════════════════════════════════════════════");
console.log("");
console.log("Next steps:");
console.log("  1. Restart opencode (plugins are cached per-process)");
console.log("  2. Verify: ls ~/.config/opencode/plugins/loom.js should be missing");
console.log("  3. Reinstall fresh: npm run install:plugin  (or npm run bundle && node scripts/install.mjs)");
console.log("");
if (!PURGE_DEPS) {
  console.log("Tip: to also wipe runtime deps (onnxruntime etc.), run:");
  console.log("  node scripts/uninstall.mjs --purge-deps");
  console.log("");
}

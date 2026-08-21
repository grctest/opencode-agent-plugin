#!/usr/bin/env node

/**
 * Syntax-check every JS/MJS source file in src/ and scripts/, plus dist if present.
 * Replaces the old hand-list of six files (audit 14 RH5 / audit 19 TC2).
 */

import { readdir, readFile, access } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const TARGET_DIRS = ["src", "scripts"];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(dir, out = []) {
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true });
  for (const entry of entries) {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(rel, out);
    } else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
      out.push(rel);
    }
  }
  return out;
}

const files = [];
for (const dir of TARGET_DIRS) {
  if (await exists(join(ROOT, dir))) {
    files.push(...(await collectFiles(dir)));
  }
}
files.sort();

let failed = 0;
for (const rel of files) {
  const result = spawnSync(process.execPath, ["--check", join(ROOT, rel)], {
    stdio: "pipe",
  });
  if (result.status !== 0) {
    failed++;
    console.error(`✗ ${rel}`);
    console.error(result.stderr.toString());
  }
}

if (await exists(join(ROOT, "dist", "loom.js"))) {
  const result = spawnSync(process.execPath, ["--check", join(ROOT, "dist", "loom.js")], {
    stdio: "pipe",
  });
  if (result.status !== 0) {
    failed++;
    console.error("✗ dist/loom.js");
    console.error(result.stderr.toString());
  }
}

console.log(`checked ${files.length} source files${failed ? `, ${failed} FAILED` : ", all OK"}`);
process.exit(failed ? 1 : 0);

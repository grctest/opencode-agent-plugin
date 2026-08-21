#!/usr/bin/env node

/**
 * Persona census generator (audit 15 DOC1).
 * Counts persona JSONs per tier directory and rewrites the README census table
 * between CENSUS-BEGIN/CENSUS-END markers so counts can never drift again.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const PERSONAS_DIR = join(ROOT, "personas");
const TIERS = ["junior", "mid", "senior", "principal", "civilian"];

const counts = {};
let total = 0;
for (const tier of TIERS) {
  const dir = join(PERSONAS_DIR, tier);
  if (!existsSync(dir)) {
    counts[tier] = 0;
    continue;
  }
  counts[tier] = readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  total += counts[tier];
}

console.log(`Census: ${TIERS.map((t) => `${t} ${counts[t]}`).join(" / ")} — total ${total}`);

const readmePath = join(ROOT, "README.md");
const BEGIN = "<!-- CENSUS-BEGIN -->";
const END = "<!-- CENSUS-END -->";

let readme = readFileSync(readmePath, "utf-8");
const table =
  `${BEGIN}\n` +
  `| Tier | Personas |\n|------|----------|\n` +
  TIERS.map((t) => `| ${t} | ${counts[t]} |`).join("\n") +
  `\n| **Total** | **${total}** |\n` +
  `${END}`;

// Auto-generate markers on first run if absent
if (!readme.includes(BEGIN)) {
  console.log("No CENSUS markers found in README — add them manually around the census table:");
  console.log(table);
  process.exit(0);
}

const start = readme.indexOf(BEGIN);
const end = readme.indexOf(END) + END.length;
readme = readme.slice(0, start) + table + readme.slice(end);
writeFileSync(readmePath, readme);
console.log("README census table regenerated.");

#!/usr/bin/env node
/**
 * Migration script: Renames "domains" → "tags" in all persona JSON files.
 * Also normalizes singular "domain" field to "tags" array.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const PERSONAS_DIR = join(import.meta.dirname, "..", "personas");
const TIERS = ["junior", "mid", "senior", "principal", "civilian"];

let migrated = 0;
let skipped = 0;
let errors = 0;

for (const tier of TIERS) {
  const tierDir = join(PERSONAS_DIR, tier);
  if (!existsSync(tierDir)) continue;

  const files = readdirSync(tierDir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const filePath = join(tierDir, file);
    try {
      const raw = readFileSync(filePath, "utf-8");
      const persona = JSON.parse(raw);
      let changed = false;

      // Handle singular "domain" string → tags
      if (typeof persona.domain === "string" && !persona.tags) {
        persona.tags = [persona.domain];
        delete persona.domain;
        changed = true;
      }

      // Handle "domains" array → tags
      if (Array.isArray(persona.domains) && !persona.tags) {
        persona.tags = persona.domains;
        delete persona.domains;
        changed = true;
      }

      // Handle "domains" string → tags array
      if (typeof persona.domains === "string" && !persona.tags) {
        persona.tags = [persona.domains];
        delete persona.domains;
        changed = true;
      }

      if (changed) {
        writeFileSync(filePath, JSON.stringify(persona, null, 2) + "\n");
        migrated++;
        console.log(`  migrated: ${tier}/${file}`);
      } else {
        skipped++;
      }
    } catch (err) {
      errors++;
      console.error(`  ERROR: ${tier}/${file}: ${err.message}`);
    }
  }
}

console.log(`\nDone: ${migrated} migrated, ${skipped} skipped, ${errors} errors`);

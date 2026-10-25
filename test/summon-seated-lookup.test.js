import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Deletion hardening: a meeting snapshots persona text into `participants`
// at start and never re-reads persona JSON files (resume/extend/restore all
// go through the participants table). So `loom_summon` must resolve a name
// against the SEATED room first — the catalog is only a fallback — and the
// docs must state the snapshot contract so nobody "fixes" a vanished file by
// re-reading it. Source assertions: the tool handler isn't callable without
// a live engine.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel) => readFileSync(join(root, rel), "utf8");
const summonSrc = readSrc("src/plugin/tools/vote-summon.js");
const readmeSrc = readSrc("README.md");

test("the summon lookup consults seated participants before the catalog", () => {
  const seatedIdx = summonSrc.indexOf("engine.getStateManager?.()?.getParticipants?.()");
  const catalogIdx = summonSrc.indexOf("const allPersonas = getPersonas();");
  assert.ok(seatedIdx > -1, "the seated-room lookup must exist");
  assert.ok(catalogIdx > -1, "the catalog stays as a fallback");
  assert.ok(seatedIdx < catalogIdx, "seated-first: a stored meeting's own records win over files on disk");
  assert.match(
    summonSrc,
    /if \(!found\) \{\s*\n\s*const allPersonas = getPersonas\(\);/,
    "the catalog loop only runs when no seat matched",
  );
});

test("the seated match maps every field the summon prompt renders", () => {
  // buildSummonPrompt reads these off `found` — a missing one silently drops
  // that section of the guest's lens instead of failing.
  for (const field of [
    "persona: c.persona",
    "agenda: c.agenda",
    "category: c.category ?? c.tier",
    "known_biases: c.known_biases",
    "communication_style: c.communication_style",
    "preferred_contribution_types: c.preferred_contribution_types",
    "anti_patterns: c.anti_patterns",
    "category_guidance: c.category_guidance ?? c.tier_guidance",
    "reflection_guidance: c.reflection_guidance",
  ]) {
    assert.ok(summonSrc.includes(field), `seated mapping must carry ${field}`);
  }
  assert.match(
    summonSrc,
    /String\(p\?\.config\?\.name \?\? ""\)\.trim\(\)\.toLowerCase\(\) === seatKey/,
    "the name match is trimmed and case-insensitive",
  );
});

test("an unknown persona fails with a message that names both possible sources", () => {
  assert.match(
    summonSrc,
    /not found — it is not in the catalog and not seated in this deliberation/,
    "the old generic message blamed only the catalog",
  );
});

test("the snapshot contract is documented, so files are never re-read to fix a seat", () => {
  assert.match(
    readmeSrc,
    /Personas are snapshotted into a meeting when it starts/,
    "README must state that seated text lives in the meeting's records",
  );
  assert.match(
    readmeSrc,
    /editing or deleting a persona file never changes a running or stored deliberation/,
    "the deletion guarantee is explicit",
  );
});

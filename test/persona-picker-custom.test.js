import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Source-level contracts for the Custom tab / custom-origin work (the picker
// is JSX — see room-selection-dialog.test.js for why source assertions).

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel) => readFileSync(join(root, rel), "utf8");
const pickerSrc = readSrc("src/dashboard/components/PersonaPickerDialog.jsx");
const roomSrc = readSrc("src/dashboard/components/RoomSelectionDialog.jsx");
const setupSrc = readSrc("src/dashboard/components/SetupTab.jsx");

test("catalog groups beyond the bundled six are browsable, not silently hidden", () => {
  // Persona files saved by the dashboard live under `custom/` — a group that
  // is intentionally NOT in CATEGORY_ORDER. Any loop over CATEGORY_ORDER alone
  // hides them from "All" and from counts.
  assert.match(
    pickerSrc,
    /Object\.keys\(categories\)\.filter\(\(k\) => !CATEGORY_ORDER\.includes\(k\)\)/,
    "groupKeys appends user folders after the bundled categories",
  );
  assert.match(pickerSrc, /const groupKeys = useMemo/, "the extra-group list is computed once per catalog");
  const countsLoop = pickerSrc.match(/const counts = useMemo\(\(\) => \{[\s\S]*?\}, \[catalog, groupKeys\]\)/);
  assert.ok(countsLoop, "counts iterate groupKeys (extras included), not CATEGORY_ORDER");
  assert.ok(
    !/for \(const t of CATEGORY_ORDER\) \{\s*\n\s*const n = \(categories\[t\] \?\? \[\]\)\.length/.test(pickerSrc),
    "the old CATEGORY_ORDER-only counter must be gone",
  );
});

test("the Custom filter is origin-based: spans every folder and keys off the loader flag", () => {
  assert.match(pickerSrc, /Custom \(\{counts\.custom\}\)/, "the tab renders only when custom personas exist");
  assert.match(
    pickerSrc,
    /categoryFilter === "custom" && p\?\.custom !== true\) continue;/,
    "the filter keeps only personas the loader flagged custom",
  );
  const wanted = pickerSrc.match(/const wanted = categoryFilter === "all" \|\| categoryFilter === "custom"[\s\S]{0,200}?\? groupKeys/);
  assert.ok(wanted, "the custom filter scans all groups, not one folder");
  assert.match(
    pickerSrc,
    /p\.custom === true && <Badge variant="secondary" className="shrink-0 text-\[11px\]">Custom<\/Badge>/,
    "rows show their custom origin",
  );
});

test("swapping still shows the current seat when its file left the catalog", () => {
  // Deleting a seated persona's source file must never strand or auto-reset
  // the seat — meetings read personas from their own records, not files.
  assert.match(
    pickerSrc,
    /const currentMissing = useMemo\(\(\) => \{[\s\S]*?Object\.values\(categories\)\.every\(/,
    "the stub triggers only when the persona is absent from EVERY group",
  );
  assert.match(pickerSrc, /data-testid="current-seat-stub"/, "the fallback row is present");
  assert.match(
    pickerSrc,
    /Kept as the current seat — the meeting reads seated personas from its own records/,
    "the stub explains why the seat survives",
  );
  assert.match(
    setupSrc,
    /currentSeat=\{s\.seats\[s\.swapIdx\]\}/,
    "SetupTab hands the full seat (agenda/persona) to the picker for the stub",
  );
});

test("the auto-select dialog joins ranked rows against every catalog group", () => {
  // buildRankingResult rows carry whatever category the index recorded; the
  // display join must still find the persona body wherever it lives.
  const join = roomSrc.match(/const byName = new Map\(\);([\s\S]{0,400}?)\n    \}/);
  assert.ok(join, "byName construction exists");
  assert.match(
    join[1],
    /for \(const \[t, arr\] of Object\.entries\(categories\)\)/,
    "the join iterates all groups via Object.entries, not CATEGORY_ORDER",
  );
});

test("personaDto prefers the file's own category over its folder", () => {
  const personasSrc = readSrc("src/dashboard/server/control/personas.js");
  assert.match(
    personasSrc,
    /const resolvedCategory = p\.category \?\? category \?\? legacyCategory;/,
    "a saved persona keeps its lens badge even though it lives under custom/",
  );
});

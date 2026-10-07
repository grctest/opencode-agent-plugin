import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initSchema, runMigrations, schemaParityReport, LATEST_SCHEMA_VERSION, MIGRATIONS } from "../src/database/schema.js";
import { parseSplitConfidence, rollupConfidence } from "../src/utils/confidence.js";

// N2 — schema changes ship atomically. P9 landed in the prompt and not the
// column; P16 landed in initSchema and not in LATEST_SCHEMA_VERSION. Both left
// the database making a claim the rest of the system did not honour:
// artifacts.confidence = "high" against prose "Number: Low", and user_version
// 12 for two structurally different shapes.

function freshDb() {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  return db;
}

/** A pre-N2 database: the old v12 artifacts shape, with the orphaned column. */
function v12Db() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE artifacts (
      meeting_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      decisions TEXT,
      action_items TEXT,
      open_questions TEXT,
      confidence TEXT,
      dissent TEXT,
      refusals TEXT,
      orchestrator_config TEXT,
      created_at TEXT NOT NULL
    );
    PRAGMA user_version = 12;
  `);
  return db;
}

test("LATEST_SCHEMA_VERSION and MIGRATIONS stay in lockstep", () => {
  assert.equal(MIGRATIONS.length, LATEST_SCHEMA_VERSION);
  assert.equal(LATEST_SCHEMA_VERSION, 17);
});

test("a migrated v12 DB and a fresh DB have identical shapes", () => {
  const migrated = v12Db();
  assert.equal(runMigrations(migrated), LATEST_SCHEMA_VERSION);
  const fresh = freshDb();

  const a = schemaParityReport(migrated);
  const b = schemaParityReport(fresh);
  assert.deepEqual(a.tables.artifacts, b.tables.artifacts);
  assert.equal(a.user_version, b.user_version);
  assert.equal(a.user_version, LATEST_SCHEMA_VERSION);
  // The orphaned P16 column is gone, and the P9 split has landed.
  assert.ok(!a.tables.artifacts.includes("dissent"));
  assert.ok(a.tables.artifacts.includes("confidence_name"));
  assert.ok(a.tables.artifacts.includes("confidence_number"));
});

test("the v12→v13 migration backfills the confidence split from the prose", () => {
  const db = v12Db();
  db.prepare(
    "INSERT INTO artifacts (meeting_id, content, confidence, dissent, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(
    "m1",
    "## Decision\nMercedes on the name.\n\n## Confidence\nHigh\n\nName: High; Number: Low — n=12 stale, band superseded.\n",
    "high",
    null,
    "2026-09-29T00:00:00.000Z",
  );
  runMigrations(db);
  const row = db.prepare("SELECT confidence, confidence_name, confidence_number FROM artifacts WHERE meeting_id = ?").get("m1");
  assert.equal(row.confidence_name, "high");
  assert.equal(row.confidence_number, "low");
  // The flat column is left untouched by the migration (it is a historical
  // value); what must never happen again is a NEW row claiming high while the
  // number layer is low — rollupConfidence is what writes that.
  assert.equal(rollupConfidence(row.confidence_name, row.confidence_number), "low");
});

test("runMigrations is idempotent and refuses a newer-than-known DB", () => {
  const db = v12Db();
  runMigrations(db);
  const before = schemaParityReport(db);
  runMigrations(db);
  assert.deepEqual(schemaParityReport(db), before);

  const newer = new DatabaseSync(":memory:");
  newer.exec("PRAGMA user_version = 99");
  assert.throws(() => runMigrations(newer), /newer than this plugin supports/);
});

test("parseSplitConfidence reads the prose layers and nothing else", () => {
  const text = "## Decision\nx\n\n## Confidence\nName: High; Number: Low — the band is unresolvable.\n\n## Action Items\n- none";
  assert.deepEqual(parseSplitConfidence(text), { name: "high", number: "low" });
  assert.deepEqual(parseSplitConfidence("## Confidence\nMedium\n"), { name: null, number: null });
  assert.deepEqual(parseSplitConfidence(""), { name: null, number: null });
  // A stray "Name:" outside the Confidence block must not be mined.
  assert.deepEqual(parseSplitConfidence("## Decision\nName: High wins\n\n## Confidence\nLow\n"), { name: null, number: null });
});

test("rollupConfidence takes the weaker layer", () => {
  assert.equal(rollupConfidence("high", "low"), "low");
  assert.equal(rollupConfidence("low", "high"), "low");
  assert.equal(rollupConfidence("high", "high"), "high");
  assert.equal(rollupConfidence("medium", "high"), "medium");
  // A missing layer defers to the one that is present.
  assert.equal(rollupConfidence("high", null), "high");
  assert.equal(rollupConfidence(null, "low"), "low");
  assert.equal(rollupConfidence(null, null), null);
  assert.equal(rollupConfidence("bogus", "low"), "low");
});

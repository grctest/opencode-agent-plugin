import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initSchema, runMigrations, schemaParityReport, SCHEMA_VERSION, LATEST_SCHEMA_VERSION } from "../src/database/schema.js";
import { parseSplitConfidence, rollupConfidence } from "../src/utils/confidence.js";

// Schema v1 (pre-userbase): a single version, no migrations. A fresh DB is
// stamped v1 with the v1 shape; the guard below only validates.

function freshDb() {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  return db;
}

test("schema is a single version with no migrations", () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(LATEST_SCHEMA_VERSION, SCHEMA_VERSION);
});

test("a fresh DB is stamped v1 with the v1 shape", () => {
  const report = schemaParityReport(freshDb());
  assert.equal(report.user_version, 1);
  // The confidence split ships as columns; the removed dissent column is gone.
  assert.ok(!report.tables.artifacts.includes("dissent"));
  assert.ok(report.tables.artifacts.includes("confidence_name"));
  assert.ok(report.tables.artifacts.includes("confidence_number"));
  // Participants carry category (never tier) and there is no turn_requests table.
  assert.ok(report.tables.participants.includes("category"));
  assert.ok(!report.tables.participants.includes("tier"));
  assert.ok(!("turn_requests" in report.tables));
});

test("runMigrations is idempotent on a current DB and refuses anything else", () => {
  const db = freshDb();
  runMigrations(db);
  const before = schemaParityReport(db);
  runMigrations(db);
  assert.deepEqual(schemaParityReport(db), before);

  const legacy = new DatabaseSync(":memory:");
  legacy.exec("PRAGMA user_version = 12");
  assert.throws(() => runMigrations(legacy), /not supported/);

  const newer = new DatabaseSync(":memory:");
  newer.exec("PRAGMA user_version = 99");
  assert.throws(() => runMigrations(newer), /not supported/);
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

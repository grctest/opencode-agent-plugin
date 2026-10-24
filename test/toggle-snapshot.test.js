import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { initSchema } from "../src/database/schema.js";
import { initializeMeeting } from "../src/database/meeting-operations.js";
import { getMeeting } from "../src/database/meeting-operations.js";

// W2 (P0.5/P1.14): the toggle snapshot. A meeting record must expose the
// effective toggle state in force at run time — agentTools.sameTurnSynthesis +
// taskMode, and the artifact-detector config — so a record reader can know how
// a meeting ran without asking the process that ran it. `customInstructions`
// and `parallelQueries` were already snapshot-verified in the study fixture.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "src");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  return db;
}

test("initializeMeeting persists sameTurnSynthesis + detectors in orchestrator_config", () => {
  const db = freshDb();
  initializeMeeting(db, "m-snap", {
    question: "Q?",
    maxRounds: 3,
    orchestratorConfig: {
      role: "neutral_facilitator",
      customInstructions: "Be direct.",
      model: "test/t",
      // W2 snapshot keys (as start.js writes them)
      sameTurnSynthesis: true,
      taskModeEffect: "discussion",
      detectors: {
        needsVerification: true,
        citationWarnings: false,
        dryRun: false,
      },
    },
    features: { parallelQueries: true, buildMode: false, taskMode: "discussion" },
    participants: [],
  });
  const row = getMeeting(db, "m-snap");
  assert.ok(row, "meeting row exists");
  const cfg = JSON.parse(row.orchestrator_config_json ?? "{}");
  assert.equal(cfg.sameTurnSynthesis, true, "agentTools.sameTurnSynthesis snapshot key present");
  assert.equal(cfg.taskModeEffect, "discussion");
  assert.deepEqual(cfg.detectors, { needsVerification: true, citationWarnings: false, dryRun: false });
  assert.deepEqual(cfg.customInstructions, "Be direct."); // pre-existing key still present
  const features = JSON.parse(row.feature_toggles_json ?? "{}");
  assert.equal(features.parallelQueries, true, "feature toggles preserved");
  assert.equal(features.buildMode, false);
});

test("start.js snapshots the effective toggles into orchestratorConfig before meeting init", () => {
  const src = readFileSync(join(SRC, "dashboard", "server", "control", "start.js"), "utf-8");
  assert.match(src, /sameTurnSynthesis/, "start.js snapshots sameTurnSynthesis");
  assert.match(src, /detectors\s*=\s*\{/, "start.js snapshots the detector config");
  assert.match(src, /needsVerification/, "needsVerification flag snapshotted");
  assert.match(src, /citationWarnings/, "citationWarnings flag snapshotted");
  assert.match(src, /buildMeetingAgentTools\(features\)/, "effective per-meeting tool config is computed once");
  // The hoisted computation feeds BOTH the snapshot and the orchestrator.
  const agentToolsUses = [...src.matchAll(/meetingAgentTools/g)];
  assert.ok(agentToolsUses.length >= 2, "hoisted tool config reused for engine creation, not recomputed");
});

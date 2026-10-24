import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { initSchema } from "../src/database/schema.js";
import { initializeMeeting } from "../src/database/meeting-operations.js";
import { addContribution, getContributions, ensureParticipantRow } from "../src/database/contribution-operations.js";
import { mapToolResults } from "../src/utils/text.js";

// W5 (P3.8): peer contribution rows carry a tool_calls summary. The study
// fixture showed all 10 contribution rows with empty tool_calls — because the
// meeting ran on code that predated the peer persistence — which made the
// audit's per-peer tool story reconstructable only from tool_audit rows. The
// current code maps the peer's toolResults through mapToolResults and stores
// them at persistence time; these tests pin that so a peer row that executed
// tools is durable in the row itself.
//
// Fixtures predating this change stay empty (their run is over — no backfill);
// every meeting run after the fix is verified here.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "src");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  return db;
}

function seedMeeting(db, meetingId, participantId) {
  initializeMeeting(db, meetingId, { question: "Q?", maxRounds: 3, participants: [] });
  ensureParticipantRow(db, meetingId, participantId, "Peer A");
  return db;
}

test("peer contribution round-trips a non-empty tool_calls array through the DB", () => {
  const db = seedMeeting(freshDb(), "m-1", "peer_a");
  const toolResults = [
    { tool: "websearch", callID: "c1", status: "success", output: '{"title":"audit review","url":"https://example.com/a"}' },
    { tool: "read", callID: "c2", status: "success", output: "line1\nline2" },
  ];
  const contribution = {
    id: 1,
    round: 2,
    participant_id: "peer_a",
    type: "evidence_response",
    content: "[Evidence from Peer A]\nFinding: staged rollouts reduce risk. Source: https://example.com. Strength: weak.",
    targets_which: null,
    batch_id: "m-1-2-asker",
    tool_calls: mapToolResults(toolResults), // exactly what query-evidence.js persists
    prompt_context: { type: "evidence_response", mode: "evidence", question: "What do audits say?" },
    created_at: new Date().toISOString(),
  };
  addContribution(db, "m-1", contribution, () => 2);
  const rows = getContributions(db, "m-1");
  assert.equal(rows.length, 1);
  const stored = rows[0];
  assert.ok(Array.isArray(stored.tool_calls), "tool_calls is an array");
  assert.equal(stored.tool_calls.length, 2, "non-empty: peer tools are durable in the row");
  assert.equal(stored.tool_calls[0].tool, "websearch");
  assert.equal(stored.tool_calls[0].status, "success");
  assert.ok(stored.tool_calls[0].output.includes("audit review"), "output preserved losslessly");
});

test("a peer with no tool calls still stores an empty array (not null) for uniform reads", () => {
  const db = seedMeeting(freshDb(), "m-2", "peer_b");
  addContribution(db, "m-2", {
    id: 1,
    round: 1,
    participant_id: "peer_b",
    type: "perspective_response",
    content: "[Perspective from Peer B]\nPosition: held because the cost band holds.",
    tool_calls: mapToolResults([]) ?? [],
    created_at: new Date().toISOString(),
  }, () => 1);
  const rows = getContributions(db, "m-2");
  assert.ok(Array.isArray(rows[0].tool_calls), "array even when empty");
  assert.equal(rows[0].tool_calls.length, 0);
});

test("query-evidence maps peer toolResults onto the persisted contribution row", () => {
  // Source-level pin (audit style): the peer persistence path builds the
  // contribution with tool_calls from mapToolResults — no silent drop.
  const src = readFileSync(join(SRC, "plugin", "tools", "query-evidence.js"), "utf-8");
  assert.match(src, /const contributionTools = mapToolResults\(toolResults\)/);
  assert.match(src, /tool_calls: contributionTools \?\? \[\]/);
  assert.match(src, /const \{ text, toolResults \} = extractAgentResponse\(res\.data\)/);
});

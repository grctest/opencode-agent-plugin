import { MeetingDatabase } from "../src/database.js";
import type { Contribution, Interjection } from "../src/types.js";
import { unlinkSync } from "node:fs";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function cleanupDb(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { unlinkSync(`${path}${suffix}`); } catch {}
  }
}

console.log("Testing database module...");

const dbPath = "/tmp/loom-test-meeting.db";
cleanupDb(dbPath);
const meetingId = "test-meeting-123";

const db = await MeetingDatabase.create(dbPath, meetingId);
db.initializeMeeting({
  question: "Test question",
  context: "Test context",
  maxRounds: 5,
  convergence: "moderator_forces",
  parentSessionId: "parent-1",
  participants: [
    { id: "p1", name: "Alice", persona: "analyst", agenda: "find truth", tier: "senior" },
    { id: "p2", name: "Bob", persona: "skeptic", agenda: "challenge", tier: "mid" },
  ],
});

const warp = db.getWarp();
assert(warp === "Test context", "warp initialized from context");

db.setWarp("Updated warp content");
assert(db.getWarp() === "Updated warp content", "warp can be written and read");

db.setRound(3);
assert(db.getRound() === 3, "round can be written and read");

assert(db.getStatus() === "initializing", "initial status is initializing");
db.setStatus("weaving");
assert(db.getStatus() === "weaving", "status can be updated");

const contribution: Contribution = {
  participant_id: "p1",
  content: "Test contribution",
  type: "propose",
  targets_which: null,
  timestamp: Date.now(),
};
db.addContribution(meetingId, { ...contribution, round: 1 });
const contributions = db.getContributions(meetingId);
assert(contributions.length === 1, "contribution added");
assert(contributions[0].content === "Test contribution", "contribution content matches");

const interjection: Interjection = {
  participant_id: "p1",
  priority: 8,
  reason: "urgent point",
  granted: false,
  pushback: null,
  resolved: "pending",
};
db.addInterjection(meetingId, interjection);
const interjections = db.getInterjections(meetingId);
assert(interjections.length === 1, "interjection added");
assert(interjections[0].priority === 8, "interjection priority matches");

db.writeAgentResponse(meetingId, "p1", 1, "[PROPOSE] My idea");
assert(db.hasAgentResponded(meetingId, "p1"), "agent has responded");
assert(db.readAgentResponse(meetingId, "p1") === "[PROPOSE] My idea", "agent response readable");

db.clearAgentResponse(meetingId, "p1");
assert(!db.hasAgentResponded(meetingId, "p1"), "agent response cleared");

db.writeAgentResponse(meetingId, "p1", 1, "response 1");
db.writeAgentResponse(meetingId, "p2", 1, "response 2");
assert(db.hasAgentResponded(meetingId, "p1"), "agent 1 responded");
assert(db.hasAgentResponded(meetingId, "p2"), "agent 2 responded");

const model = db.getParticipantModel("p1");
assert(model === null, "no model assigned to p1");

db.close();
cleanupDb(dbPath);

console.log("  All database tests PASS");
console.log("\nAll database tests passed!");

import {
  initMeetingFiles,
  writeSharedState,
  readSharedState,
  writeWarp,
  readWarp,
  writeRound,
  readRound,
  addContribution,
  readContributions,
  addInterjection,
  readInterjections,
  initAgentDir,
  writeAgentResponse,
  readAgentResponse,
  hasAgentResponded,
  clearAgentResponse,
  cleanupMeeting,
  _resetMemFs,
} from "../src/shared-files.js";
import type { SharedMeetingState, Contribution, Interjection } from "../src/types.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

console.log("Testing shared-files module...");

const meetingId = "test-meeting-123";

await initMeetingFiles(meetingId);

const state: SharedMeetingState = {
  meeting_id: meetingId,
  round: 1,
  warp: "Test warp content",
  question: "Test question",
  contributions: [],
  interjections: [],
  status: "weaving",
};

await writeSharedState(state);
const readState = await readSharedState(meetingId);
assert(readState !== null, "state can be read");
assert(readState?.round === 1, "round matches");
assert(readState?.question === "Test question", "question matches");

await writeWarp(meetingId, "Updated warp content");
const warp = await readWarp(meetingId);
assert(warp === "Updated warp content", "warp can be written and read");

await writeRound(meetingId, 3);
const round = await readRound(meetingId);
assert(round === 3, "round can be written and read");

const contribution: Contribution = {
  participant_id: "p1",
  content: "Test contribution",
  type: "propose",
  targets_which: null,
  timestamp: Date.now(),
};
await addContribution(meetingId, contribution);
const contributions = await readContributions(meetingId);
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
await addInterjection(meetingId, interjection);
const interjections = await readInterjections(meetingId);
assert(interjections.length === 1, "interjection added");
assert(interjections[0].priority === 8, "interjection priority matches");

await initAgentDir(meetingId, "agent-1");
await writeAgentResponse(meetingId, "agent-1", "[PROPOSE] My idea");
assert(await hasAgentResponded(meetingId, "agent-1"), "agent has responded");
const response = await readAgentResponse(meetingId, "agent-1");
assert(response === "[PROPOSE] My idea", "agent response readable");

await clearAgentResponse(meetingId, "agent-1");
assert(!(await hasAgentResponded(meetingId, "agent-1")), "agent response cleared");

await writeAgentResponse(meetingId, "agent-1", "response 1");
await writeAgentResponse(meetingId, "agent-2", "response 2");
await cleanupMeeting(meetingId);
assert(!(await hasAgentResponded(meetingId, "agent-1")), "meeting cleaned up");
assert(!(await hasAgentResponded(meetingId, "agent-2")), "all agent responses cleaned");

_resetMemFs();
const afterReset = await readSharedState(meetingId);
assert(afterReset === null, "memFs reset works");

console.log("  All shared-files tests PASS");
console.log("\nAll shared-files tests passed!");

import { LoomEngine, parseModeratorRuling, extractSection } from "../src/loom-engine.js";
import { evolveWarp } from "../src/warp.js";
import type { Tier } from "../src/types.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

// ─── Mock Client ───────────────────────────────────────────────────────

function createMockClient(responses: string[]) {
  let callCount = 0;
  return {
    session: {
      prompt: async (_opts: any) => {
        const text = responses[callCount] ?? "[PASS]";
        callCount++;
        return {
          data: {
            info: { cost: 0, tokens: { input: 100, output: 50, reasoning: 0 } },
            parts: [{ type: "text", text }],
          },
        };
      },
    },
    _callCount: () => callCount,
  };
}

// ─── Engine Construction ───────────────────────────────────────────────

console.log("Testing LoomEngine construction...");

const client = createMockClient([]);
const metadataFn = () => {};

const engine = new LoomEngine(
  client,
  "/tmp",
  metadataFn,
  {
    question: "Test question",
    context: "Test context",
    parentSessionId: "session-123",
    participants: [
      { id: "p1", name: "Alice", persona: "Engineer", agenda: "Build things", tier: "senior" },
      { id: "p2", name: "Bob", persona: "Skeptic", agenda: "Find problems", tier: "mid" },
    ],
    maxRounds: 3,
    convergence: "consensus",
  },
);

const state = engine.getState();
assert(state.participants.length === 2, "engine has 2 participants");
assert(state.question === "Test question", "engine stores question");
assert(state.max_rounds === 3, "engine stores max_rounds");
assert(state.status === "initializing", "engine starts initializing");
assert(state.convergence_mode === "consensus", "engine stores convergence mode");
assert(state.participants[0].config.name === "Alice", "first participant is Alice");
assert(state.participants[1].config.name === "Bob", "second participant is Bob");
console.log("  Construction: PASS");

// ─── Initialize ────────────────────────────────────────────────────────

console.log("Testing initialize...");
await engine.initialize();
assert(engine.getState().status === "weaving", "status is weaving after init");
console.log("  Initialize: PASS");

// ─── Veto Rights Enforcement ──────────────────────────────────────────

console.log("Testing veto rights enforcement...");

const engine2 = new LoomEngine(createMockClient([]), "/tmp", metadataFn, {
  question: "Test",
  context: "Test",
  parentSessionId: "s1",
  participants: [
    { id: "j1", name: "Junior", persona: "New", agenda: "Learn", tier: "junior" },
    { id: "s1", name: "Senior", persona: "Exp", agenda: "Guide", tier: "senior" },
  ],
  maxRounds: 2,
  convergence: "moderator_forces",
});

const juniorVeto = engine2.veto("j1", "I disagree");
assert(juniorVeto.ok === false, "junior veto is denied");
assert(juniorVeto.error?.includes("cannot veto"), "junior veto error message");

const seniorVeto = engine2.veto("s1", "This is risky");
assert(seniorVeto.ok === true, "senior veto is allowed");

const engine3 = new LoomEngine(createMockClient([]), "/tmp", metadataFn, {
  question: "Test",
  context: "Test",
  parentSessionId: "s1",
  participants: [
    { id: "p1", name: "Principal", persona: "Lead", agenda: "Decide", tier: "principal" },
  ],
  maxRounds: 2,
  convergence: "moderator_forces",
});

const principalVeto = engine3.veto("p1", "Wrong direction");
assert(principalVeto.ok === true, "principal veto is allowed");
console.log("  Veto rights: PASS");

// ─── Force End Rights Enforcement ─────────────────────────────────────

console.log("Testing force_end rights enforcement...");

const engine4 = new LoomEngine(createMockClient([]), "/tmp", metadataFn, {
  question: "Test",
  context: "Test",
  parentSessionId: "s1",
  participants: [
    { id: "j1", name: "Junior", persona: "New", agenda: "Learn", tier: "junior" },
    { id: "p1", name: "Principal", persona: "Lead", agenda: "Decide", tier: "principal" },
  ],
  maxRounds: 2,
  convergence: "moderator_forces",
});

const juniorForceEnd = engine4.forceEnd("j1");
assert(juniorForceEnd.ok === false, "junior force_end is denied");

const principalForceEnd = engine4.forceEnd("p1");
assert(principalForceEnd.ok === true, "principal force_end is allowed");
assert(engine4.getState().status === "converged", "force_end sets status to converged");
console.log("  Force end rights: PASS");

// ─── Abort ─────────────────────────────────────────────────────────────

console.log("Testing abort...");

const engine5 = new LoomEngine(createMockClient([]), "/tmp", metadataFn, {
  question: "Test",
  context: "Test",
  parentSessionId: "s1",
  participants: [
    { id: "p1", name: "Alice", persona: "Eng", agenda: "Build", tier: "senior" },
  ],
  maxRounds: 3,
  convergence: "consensus",
});

engine5.abort();
assert(engine5.getState().status === "aborted", "abort sets status to aborted");
console.log("  Abort: PASS");

// ─── Convergence: consensus mode ──────────────────────────────────────

console.log("Testing consensus convergence...");

const consensusClient = createMockClient(["[PASS]", "[PASS]"]);
const consensusEngine = new LoomEngine(consensusClient, "/tmp", metadataFn, {
  question: "Test",
  context: "Test",
  parentSessionId: "s1",
  participants: [
    { id: "p1", name: "Alice", persona: "Eng", agenda: "Build", tier: "senior" },
    { id: "p2", name: "Bob", persona: "Skeptic", agenda: "Check", tier: "mid" },
  ],
  maxRounds: 3,
  convergence: "consensus",
});

await consensusEngine.initialize();
const continue1 = await consensusEngine.runRound();
assert(continue1 === false, "consensus: all pass → stop");
assert(consensusEngine.getState().status === "converged", "consensus: status converged");
console.log("  Consensus convergence: PASS");

// ─── Convergence: majority mode ────────────────────────────────────────

console.log("Testing majority convergence...");

const majorityClient = createMockClient(["[PROPOSE] I think X", "[PASS]", "[PASS]"]);
const majorityEngine = new LoomEngine(majorityClient, "/tmp", metadataFn, {
  question: "Test",
  context: "Test",
  parentSessionId: "s1",
  participants: [
    { id: "p1", name: "Alice", persona: "Eng", agenda: "Build", tier: "senior" },
    { id: "p2", name: "Bob", persona: "Skeptic", agenda: "Check", tier: "mid" },
    { id: "p3", name: "Carol", persona: "PM", agenda: "Ship", tier: "junior" },
  ],
  maxRounds: 3,
  convergence: "majority",
});

await majorityEngine.initialize();
const continue2 = await majorityEngine.runRound();
assert(continue2 === false, "majority: >50% pass → stop");
assert(majorityEngine.getState().status === "converged", "majority: status converged");
console.log("  Majority convergence: PASS");

// ─── Convergence: moderator_forces (no early stop) ─────────────────────

console.log("Testing moderator_forces convergence...");

const modClient = createMockClient(["[PROPOSE] I think X", "[CHALLENGE] No, Y"]);
const modEngine = new LoomEngine(modClient, "/tmp", metadataFn, {
  question: "Test",
  context: "Test",
  parentSessionId: "s1",
  participants: [
    { id: "p1", name: "Alice", persona: "Eng", agenda: "Build", tier: "senior" },
    { id: "p2", name: "Bob", persona: "Skeptic", agenda: "Check", tier: "mid" },
  ],
  maxRounds: 3,
  convergence: "moderator_forces",
});

await modEngine.initialize();
const continue3 = await modEngine.runRound();
assert(continue3 === true, "moderator_forces: continues after round 1");
assert(modEngine.getState().status === "weaving", "moderator_forces: still weaving");
console.log("  Moderator_forces convergence: PASS");

// ─── Max rounds reached ────────────────────────────────────────────────

console.log("Testing max rounds...");

const maxClient = createMockClient([
  "[PROPOSE] A", "[PROPOSE] B",
  "[PROPOSE] A", "[PROPOSE] B",
  "[PROPOSE] A", "[PROPOSE] B",
]);
const maxEngine = new LoomEngine(maxClient, "/tmp", metadataFn, {
  question: "Test",
  context: "Test",
  parentSessionId: "s1",
  participants: [
    { id: "p1", name: "Alice", persona: "Eng", agenda: "Build", tier: "senior" },
    { id: "p2", name: "Bob", persona: "Skeptic", agenda: "Check", tier: "mid" },
  ],
  maxRounds: 2,
  convergence: "moderator_forces",
});

await maxEngine.initialize();
await maxEngine.runRound();
const continueMax = await maxEngine.runRound();
assert(continueMax === false, "max rounds: stops at max");
assert(maxEngine.getState().status === "max_rounds_reached", "max rounds: status set");
console.log("  Max rounds: PASS");

console.log("  Max rounds: PASS");

// ─── Moderator Ruling Parser ──────────────────────────────────────────

console.log("Testing parseModeratorRuling...");

const ruling1 = parseModeratorRuling(
  "decision: This discussion has circled enough, time to converge.\nnext_speaker: synthesize\nreason: Three challenges in a row with no new information."
);
assert(ruling1.decision.includes("circled enough"), "ruling1: decision parsed");
assert(ruling1.next_speaker === "synthesize", "ruling1: next_speaker parsed");
assert(ruling1.reason.includes("Three challenges"), "ruling1: reason parsed");

const ruling2 = parseModeratorRuling(
  "decision: Let Bob respond to this point.\nnext_speaker: p2\nreason: He hasn't spoken recently."
);
assert(ruling2.next_speaker === "p2", "ruling2: next_speaker is p2");

const ruling3 = parseModeratorRuling(
  "We should wrap this up and synthesize the findings."
);
assert(ruling3.next_speaker === "synthesize", "ruling3: fallback detects 'wrap up'");
assert(ruling3.decision.includes("wrap this up"), "ruling3: decision captured");

const ruling4 = parseModeratorRuling("The deliberation should continue with Carol.");
assert(ruling4.decision.includes("continue"), "ruling4: free-text captured as decision");

console.log("  Moderator ruling parser: PASS");

// ─── Call Vote ────────────────────────────────────────────────────────

console.log("Testing callVote...");

const voteEngine = new LoomEngine(createMockClient([]), "/tmp", metadataFn, {
  question: "Test",
  context: "Test",
  parentSessionId: "s1",
  participants: [
    { id: "j1", name: "Junior", persona: "New", agenda: "Learn", tier: "junior" },
    { id: "m1", name: "Middle", persona: "Balanced", agenda: "Check", tier: "mid" },
    { id: "s1", name: "Senior", persona: "Exp", agenda: "Guide", tier: "senior" },
  ],
  maxRounds: 3,
  convergence: "majority",
});

const juniorVote = voteEngine.callVote("j1");
assert(juniorVote.ok === false, "junior cannot call vote");
assert(juniorVote.error?.includes("cannot call votes"), "junior vote error");

voteEngine.getState().participants[1].reflection = "I am ready to conclude this discussion.";
voteEngine.getState().participants[2].reflection = "Yes, ready to conclude.";

const midVote = voteEngine.callVote("m1");
assert(midVote.ok === true, "mid can call vote");
assert(midVote.result?.includes("Vote passed"), "vote passes with majority ready");

const voteEngine2 = new LoomEngine(createMockClient([]), "/tmp", metadataFn, {
  question: "Test",
  context: "Test",
  parentSessionId: "s1",
  participants: [
    { id: "m1", name: "Middle", persona: "Balanced", agenda: "Check", tier: "mid" },
    { id: "s1", name: "Senior", persona: "Exp", agenda: "Guide", tier: "senior" },
    { id: "p1", name: "Principal", persona: "Lead", agenda: "Decide", tier: "principal" },
  ],
  maxRounds: 3,
  convergence: "majority",
});

const seniorVote = voteEngine2.callVote("s1");
assert(seniorVote.ok === true, "senior can call vote");
assert(seniorVote.result?.includes("Vote failed"), "vote fails when no one is ready");

console.log("  Call vote: PASS");

// ─── Warp Compaction ──────────────────────────────────────────────────

console.log("Testing warp compaction...");

const warpEngine = new LoomEngine(createMockClient([]), "/tmp", metadataFn, {
  question: "Test",
  context: "Initial context with substantial background information. ".repeat(800),
  parentSessionId: "s1",
  participants: [
    { id: "p1", name: "Alice", persona: "Eng", agenda: "Build", tier: "senior" },
  ],
  maxRounds: 3,
  convergence: "consensus",
});

const initialWarpLen = warpEngine.getState().warp.length;
assert(initialWarpLen > 2000, "warp starts large");

const round: any = {
  number: 1,
  contributions: [],
  interjections: [],
  token_path: ["p1"],
  summary: "A detailed summary of the round with many important points established. ".repeat(30),
};

const warpRef = { warp: warpEngine.getState().warp };
warpRef.warp = evolveWarp(warpRef.warp, round);

const afterWarpLen = warpRef.warp.length;
assert(afterWarpLen < initialWarpLen + round.summary.length, "warp was compacted");

console.log("  Warp compaction: PASS");

// ─── Artifact Tests ───────────────────────────────────────────────────

console.log("Testing artifact functions...");

const testOutput = `## Decision
We should use approach X because it balances all concerns.

## Reasoning
Based on the discussion, approach X offers the best tradeoffs between speed and safety.

## Action Items
1. Implement the core module
2. Write integration tests
3. Deploy to staging

## Dissenting Views
- Bob preferred approach Y due to lower cost.

## Open Questions
- How will this perform at scale?

## Confidence
Medium`;

const decisions = extractSection(testOutput, "Decision");
assert(decisions.length === 1, "extract decision section (numbered)");
assert(decisions[0].includes("approach X"), "decision content");

const actions = extractSection(testOutput, "Action Items");
assert(actions.length === 3, "extract action items (numbered)");
assert(actions[0].includes("core module"), "first action item");
assert(actions[1].includes("integration tests"), "second action item");

const questions = extractSection(testOutput, "Open Questions");
assert(questions.length === 1, "extract open questions");
assert(questions[0].includes("scale"), "question content");

const emptySection = extractSection(testOutput, "Nonexistent");
assert(emptySection.length === 0, "nonexistent section returns empty");

console.log("  Artifact functions: PASS");

// ─── Interjection Pipeline Tests ──────────────────────────────────────

console.log("Testing interjection pipeline...");

import { checkForInterjections } from "../src/interjections.js";

const mockParticipants: any[] = [
  { config: { id: "p1", name: "Alice", tier: "senior", persona: "Engineer" }, tier_config: { rights: { interject: true }, model: "anthropic/claude-3-5-sonnet-20241022", system_prompt_addendum: "" }, status: "speaking", reflection: "", contributions_count: 0 },
  { config: { id: "p2", name: "Bob", tier: "mid", persona: "Skeptic" }, tier_config: { rights: { interject: true }, model: "anthropic/claude-3-5-sonnet-20241022", system_prompt_addendum: "" }, status: "listening", reflection: "", contributions_count: 0 },
  { config: { id: "p3", name: "Carol", tier: "junior", persona: "Creative" }, tier_config: { rights: { interject: true }, model: "anthropic/claude-3-5-haiku-20241022", system_prompt_addendum: "" }, status: "listening", reflection: "", contributions_count: 0 },
];

const mockWeft = [{ participant_id: "p1", type: "propose", content: "I think we should use approach X.", targets_which: null, timestamp: Date.now() }];

let interjectionResult = await checkForInterjections(
  "p1",
  mockWeft,
  mockParticipants,
  null,
  "/tmp",
  async (_s: string, _m: any, _msg: string) => {
    return `[WAIT: Bob]
[INTERJECT: Carol, Priority: 8, Reason: "I have a critical security concern that cannot wait"]`;
  },
  () => ({ providerID: "anthropic", modelID: "claude-3-opus-20240229" }),
);

assert(interjectionResult.length === 1, "one interjection detected");
assert(interjectionResult[0].participant_id === "p3", "Carol is the interjector");
assert(interjectionResult[0].priority === 8, "priority parsed correctly");
assert(interjectionResult[0].reason.includes("security"), "reason parsed correctly");

let noInterjectionResult = await checkForInterjections(
  "p1",
  mockWeft,
  mockParticipants,
  null,
  "/tmp",
  async () => `[WAIT: Bob]
[WAIT: Carol]`,
  () => ({ providerID: "anthropic", modelID: "claude-3-opus-20240229" }),
);

assert(noInterjectionResult.length === 0, "no interjections when all wait");

const juniorOnlyParticipants = [
  { config: { id: "p1", name: "Alice", tier: "senior", persona: "Eng" }, tier_config: { rights: { interject: true }, model: "anthropic/claude-3-5-sonnet-20241022", system_prompt_addendum: "" }, status: "speaking", reflection: "", contributions_count: 0 },
  { config: { p2: "", name: "", tier: "", persona: "" }, tier_config: { rights: { interject: false } }, status: "listening", reflection: "", contributions_count: 0 } as any,
];

let failedInterjectionResult = await checkForInterjections(
  "p1",
  mockWeft,
  mockParticipants,
  null,
  "/tmp",
  async () => { throw new Error("LLM failed"); },
  () => ({ providerID: "anthropic", modelID: "claude-3-opus-20240229" }),
);

assert(failedInterjectionResult.length === 0, "graceful handling of LLM failure");

console.log("  Interjection pipeline: PASS");

// ─── Confidence Derivation ────────────────────────────────────────────

console.log("Testing deriveConfidence...");

import { deriveConfidence as deriveConf } from "../src/artifact.js";

const highConfWeft = [
  { participant_id: "p1", type: "propose", content: "A", targets_which: null, timestamp: 0 },
  { participant_id: "p2", type: "support", content: "B", targets_which: null, timestamp: 0 },
  { participant_id: "p3", type: "refine", content: "C", targets_which: null, timestamp: 0 },
];
assert(deriveConf(highConfWeft, 0) === "high", "no dissent + low challenge ratio = high");

const medConfWeft = [
  { participant_id: "p1", type: "propose", content: "A", targets_which: null, timestamp: 0 },
  { participant_id: "p2", type: "challenge", content: "B", targets_which: null, timestamp: 0 },
  { participant_id: "p3", type: "support", content: "C", targets_which: null, timestamp: 0 },
  { participant_id: "p4", type: "refine", content: "D", targets_which: null, timestamp: 0 },
];
assert(deriveConf(medConfWeft, 1) === "medium", "one dissent + moderate challenge = medium");

const lowConfWeft = [
  { participant_id: "p1", type: "challenge", content: "A", targets_which: null, timestamp: 0 },
  { participant_id: "p2", type: "challenge", content: "B", targets_which: null, timestamp: 0 },
  { participant_id: "p3", type: "dissent", content: "C", targets_which: null, timestamp: 0 },
];
assert(deriveConf(lowConfWeft, 2) === "low", "high challenge ratio + dissent = low");

console.log("  Confidence derivation: PASS");

console.log("\nAll engine tests passed!");

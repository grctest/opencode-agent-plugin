import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPersonaProposalPrompt,
  extractBalancedJsonArray,
  parseProposalResponse,
  formatProposalFile,
  generatePersonaProposals,
} from "../src/persona-proposals.js";

// Post-synthesis persona proposals (T6): review files only, never applied.

const SEATS = [
  { config: { name: "Risk Officer", category: "senior", persona: "Names irreversible commitments.", agenda: "De-risk the plan.", known_biases: ["over-weights tail risk"], anti_patterns: ["Vague warnings without numbers"] }, status: "listening" },
  { config: { name: "Curious Intern", category: "junior", persona: "Asks why.", agenda: "Expose assumptions.", known_biases: [], anti_patterns: [] }, status: "listening" },
  { config: { name: "Ghost", category: "mid", persona: "Failed seat.", agenda: "Nothing.", known_biases: [], anti_patterns: [] }, status: "failed" },
];

test("proposal prompt carries the roster, artifact, and grounded-only contract", () => {
  const prompt = buildPersonaProposalPrompt(SEATS, { content: "Decision: ship. Dissent: Risk Officer warned [#3]." });
  assert.match(prompt, /Risk Officer/);
  assert.match(prompt, /Curious Intern/);
  assert.match(prompt, /Dissent: Risk Officer warned/);
  assert.match(prompt, /Grounded-only/);
  assert.match(prompt, /empty array \[\] is a valid answer/);
  assert.match(prompt, /at most 2/);
});

test("balanced array extraction survives prose and nested brackets", () => {
  assert.equal(extractBalancedJsonArray("no brackets"), null);
  assert.equal(extractBalancedJsonArray('[{"a": "[x]"}] trailing'), '[{"a": "[x]"}]');
  assert.equal(extractBalancedJsonArray('[{"a": "unclosed"'), null);
});

test("parser keeps known personas, caps lists, drops strangers and filler", () => {
  const text = `Here you go: ${JSON.stringify([
    { name: "Risk Officer", anti_patterns_add: ["a1", "a2", "a3"], known_biases_add: ["b1", "b2"], rationale: "Seen when the room waved [#3] through." },
    { name: "Stranger", anti_patterns_add: ["x"] },
    { name: "Curious Intern", anti_patterns_add: [], known_biases_add: [] },
    "not-an-object",
  ])} done.`;
  const { proposals, parseError } = parseProposalResponse(text, SEATS);
  assert.equal(parseError, null);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].name, "Risk Officer");
  assert.deepEqual(proposals[0].anti_patterns_add, ["a1", "a2"]);
  assert.deepEqual(proposals[0].known_biases_add, ["b1"]);
  assert.match(proposals[0].rationale, /waved/);
});

test("parser reports unusable output instead of guessing", () => {
  assert.equal(parseProposalResponse("no json here", SEATS).parseError, "no JSON array found");
  assert.equal(parseProposalResponse("[1, 2", SEATS).parseError, "no JSON array found");
  assert.equal(parseProposalResponse('{"name": "x"}', SEATS).parseError, "no JSON array found");
});

test("formatter renders reviewable diffs with a manual-apply header", () => {
  const file = formatProposalFile({
    meetingId: "m1",
    question: "Ship?",
    proposals: [{ name: "Risk Officer", anti_patterns_add: ["Name the rollback cost in dollars"], known_biases_add: [], rationale: "Warned thrice [#3][#9]." }],
    rawText: null,
    parseError: null,
  });
  assert.match(file, /Human review required/);
  assert.match(file, /## Risk Officer/);
  assert.match(file, /\+ anti_patterns: "Name the rollback cost in dollars"/);
  assert.match(file, /Warned thrice/);
  const empty = formatProposalFile({ meetingId: "m1", question: "Q", proposals: [], rawText: null, parseError: null });
  assert.match(empty, /nothing observed that warrants a file change/);
});

test("generate writes one file via a single ephemeral call and never throws", async () => {
  const calls = [];
  const written = {};
  const sessionManager = {
    runEphemeralPrompt: async (participant, opts, meetingId) => {
      calls.push({ participant, opts, meetingId });
      assert.deepEqual(opts.tools, {});
      assert.equal(participant.config.name, "Persona Reviewer");
      return { ok: true, data: { parts: [{ type: "text", text: `Notes: ${JSON.stringify([{ name: "Risk Officer", anti_patterns_add: ["Cite the rollback owner"], known_biases_add: [], rationale: "Missed owner twice." }])}` }] } };
    },
  };
  const path = await generatePersonaProposals({
    sessionManager,
    participants: SEATS,
    artifact: { content: "Decision: ship. Dissent held by Risk Officer [#3]." },
    model: { providerID: "p", modelID: "m" },
    meetingId: "m1",
    directory: "/tmp",
    question: "Ship?",
    writeFile: async (id, text) => { written[id] = text; return `/proposals/${id}.md`; },
  });
  assert.equal(path, "/proposals/m1.md");
  assert.equal(calls.length, 1);
  assert.match(written.m1, /## Risk Officer/);
  assert.match(written.m1, /Cite the rollback owner/);
});

test("generate returns null without participants, model, or on call failure", async () => {
  const writeFile = async () => { throw new Error("must not be called"); };
  assert.equal(await generatePersonaProposals({ sessionManager: {}, participants: [], artifact: {}, model: { providerID: "p", modelID: "m" }, meetingId: "m", directory: "/t", question: "q", writeFile }), null);
  assert.equal(await generatePersonaProposals({ sessionManager: {}, participants: SEATS, artifact: {}, model: null, meetingId: "m", directory: "/t", question: "q", writeFile }), null);
  const failing = { runEphemeralPrompt: async () => ({ ok: false, error: new Error("down") }) };
  assert.equal(await generatePersonaProposals({ sessionManager: failing, participants: SEATS, artifact: {}, model: { providerID: "p", modelID: "m" }, meetingId: "m", directory: "/t", question: "q", writeFile }), null);
});

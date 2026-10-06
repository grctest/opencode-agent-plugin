import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeQuery,
  extractQueryFromAudit,
  buildEvidenceCache,
  formatEvidenceCacheForPrompt,
} from "../src/evidence-cache.js";
import { buildAgentSystemPrompt, buildAgentUserPrompt } from "../src/prompts/agent.js";
import { buildSynthesisPrompt } from "../src/prompts/synthesis.js";

// P5 — normalizeQuery: lowercase, strip punctuation, collapse whitespace.
test("normalizeQuery lowercases, strips punctuation, collapses whitespace", () => {
  assert.equal(normalizeQuery("F1 2027 Calendar!!!"), "f1 2027 calendar");
  assert.equal(normalizeQuery("  Antonelli   seat?  "), "antonelli seat");
  assert.equal(normalizeQuery(""), "");
  assert.equal(normalizeQuery(null), "");
  assert.equal(normalizeQuery(undefined), "");
});

// P5 — extractQueryFromAudit: websearch {query}, webfetch {url}, JSON-string input.
test("extractQueryFromAudit parses websearch and webfetch inputs", () => {
  assert.equal(extractQueryFromAudit({ tool: "websearch", input: JSON.stringify({ query: "f1 calendar" }) }), "f1 calendar");
  assert.equal(extractQueryFromAudit({ tool: "websearch", input: { query: "f1 calendar" } }), "f1 calendar");
  assert.equal(extractQueryFromAudit({ tool: "webfetch", input: JSON.stringify({ url: "https://fia.com/x" }) }), "https://fia.com/x");
  assert.equal(extractQueryFromAudit({ tool: "webfetch", input: { urls: ["https://a.com", "https://b.com"] } }), "https://a.com");
  assert.equal(extractQueryFromAudit({ tool: "websearch", input: "not json" }), null);
  assert.equal(extractQueryFromAudit({ tool: "websearch", input: JSON.stringify({}) }), null);
  assert.equal(extractQueryFromAudit({ tool: "loom_query", input: JSON.stringify({ query: "q" }) }), null);
  assert.equal(extractQueryFromAudit(null), null);
});

// P5 — buildEvidenceCache: filters research tools, dedupes by normalized query,
// latest wins, bounds digest length.
test("buildEvidenceCache dedupes by normalized query, latest wins, skips non-research tools", () => {
  const audits = [
    { id: 1, tool: "websearch", participant_id: "a", round: 1, input: JSON.stringify({ query: "F1 2027 Calendar" }), output: "first result" },
    { id: 2, tool: "websearch", participant_id: "b", round: 2, input: JSON.stringify({ query: "f1 2027 calendar!!!" }), output: "second result" },
    { id: 3, tool: "webfetch", participant_id: "a", round: 2, input: JSON.stringify({ url: "https://fia.com" }), output: "fia page" },
    { id: 4, tool: "loom_query", participant_id: "a", round: 2, input: JSON.stringify({ query: "should be skipped" }), output: "peer answer" },
    { id: 5, tool: "websearch", participant_id: "c", round: 3, input: JSON.stringify({ query: "Antonelli seat" }), output: "seat confirmed" },
  ];
  const cache = buildEvidenceCache(audits);
  assert.equal(cache.length, 3);
  const cal = cache.find((e) => e.normalized === "f1 2027 calendar");
  assert.ok(cal, "calendar query present");
  assert.equal(cal.searches, 2, "duplicate counted");
  assert.equal(cal.digest, "second result", "latest digest wins");
  assert.equal(cal.round, 2);
  assert.equal(cal.participantId, "b");
  assert.ok(!cache.some((e) => e.normalized === "should be skipped"), "loom_query excluded");
});

test("buildEvidenceCache bounds entries and digest length", () => {
  const audits = Array.from({ length: 30 }, (_, i) => ({
    id: i + 1, tool: "websearch", participant_id: "a", round: 1,
    input: JSON.stringify({ query: `query ${i}` }), output: "x".repeat(1000),
  }));
  const cache = buildEvidenceCache(audits, { maxEntries: 10, digestLength: 50 });
  assert.equal(cache.length, 10);
  assert.ok(cache.every((e) => e.digest.length <= 50));
  assert.deepEqual(buildEvidenceCache([]), []);
  assert.deepEqual(buildEvidenceCache(null), []);
});

// P5 — formatEvidenceCacheForPrompt: empty cache renders nothing (flag-off
// byte-identical); non-empty renders a delimited block.
test("formatEvidenceCacheForPrompt renders empty for empty cache", () => {
  assert.equal(formatEvidenceCacheForPrompt([]), "");
  assert.equal(formatEvidenceCacheForPrompt(null), "");
});

test("formatEvidenceCacheForPrompt renders queries with attribution", () => {
  const cache = [{
    query: "f1 2027 calendar", normalized: "f1 2027 calendar",
    participantId: "analyst", round: 2, tool: "websearch",
    digest: "23 rounds confirmed", searches: 2,
  }];
  const block = formatEvidenceCacheForPrompt(cache);
  assert.match(block, /## Prior Searches — shared evidence cache/);
  assert.match(block, /"f1 2027 calendar" — analyst r2 \(×2\): 23 rounds confirmed/);
  assert.match(block, /cite-or-supersede/);
});

// P5 — user prompt carries the Prior Searches block only when a cache is passed.
test("user prompt renders Prior Searches block when evidenceCache provided", () => {
  const participant = {
    config: { id: "p0", name: "P", category: "mid", persona: "persona", agenda: "agenda" },
    status: "listening",
  };
  const cache = [{
    query: "f1 2027 calendar", normalized: "f1 2027 calendar",
    participantId: "analyst", round: 1, tool: "websearch",
    digest: "23 rounds", searches: 1,
  }];
  const withCache = buildAgentUserPrompt(participant, "", [], 2, "Q", [], "", [], [], null, false, true, {}, { evidenceCache: cache });
  assert.match(withCache, /## Prior Searches — shared evidence cache/);
  assert.match(withCache, /"f1 2027 calendar" — analyst r1: 23 rounds/);
  const without = buildAgentUserPrompt(participant, "", [], 2, "Q", [], "", [], [], null, false, true, {}, {});
  assert.doesNotMatch(without, /## Prior Searches/);
});

// P3 — system prompt carries the naked-numbers and calibration-sheet rules.
test("system prompt carries no-naked-numbers and calibration-sheet rules", () => {
  const participant = {
    config: { id: "p0", name: "P", category: "mid", persona: "persona", agenda: "agenda" },
    status: "listening",
  };
  const sys = buildAgentSystemPrompt(participant, { activeCount: 3, agentTools: { enabled: false } });
  const contract = sys.split("## OUTPUT CONTRACT")[1] ?? "";
  assert.match(contract, /12\. No naked numbers/);
  assert.match(contract, /\(n, window, source\)/);
  assert.match(contract, /n<10 may illustrate a point but never license a conclusion/);
  assert.match(contract, /13\. Calibration sheet at authorship/);
  assert.match(contract, /base rate, historical precedent, or data that justifies the number/);
  assert.match(contract, /Calibration added two rounds later is not calibration/);
});

// P5 — system prompt tool ladder carries the cite-or-supersede rule.
test("system prompt tool ladder carries cite-or-supersede rule", () => {
  const participant = {
    config: { id: "p0", name: "P", category: "mid", persona: "persona", agenda: "agenda" },
    status: "listening",
  };
  const agentTools = { enabled: true, builtIn: { websearch: true, webfetch: true } };
  const sys = buildAgentSystemPrompt(participant, { activeCount: 3, agentTools });
  assert.match(sys, /Cite-or-supersede, don't re-search/);
  assert.match(sys, /Prior Searches/);
});

// P3 — synthesis prompt carries the naked-numbers check and calibration-sheet rules.
test("synthesis prompt carries no-naked-numbers and calibration-sheet rules", () => {
  const prompt = buildSynthesisPrompt("Q?", "transcript [#1]", [], [], "",  "", {});
  assert.match(prompt, /7\. \*\*No naked numbers:\*\*/);
  assert.match(prompt, /scan your draft for every percentage and rate/);
  assert.match(prompt, /n<10 may illustrate but never licenses a conclusion/);
  assert.match(prompt, /8\. \*\*Calibration sheet for gate ladders:\*\*/);
  assert.match(prompt, /uncalibrated — needs base rate/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentSystemPrompt, buildAgentUserPrompt } from "../src/prompts/agent.js";
import { buildQueryPrompt, buildVotePrompt, buildSummonPrompt } from "../src/prompts/interaction-prompts.js";
import { buildToolsMap } from "../src/round-executor/tools.js";
import { DEFAULT_CONFIG, NESTED_SCHEMA } from "../src/config/defaults.js";
import { getPersonas, lintPersonaStyle, lintTruncation, lintRunons, lintCircularity, lintRangeRule, lintDepth, lintEmbodiment } from "../src/composer/persona-loader.js";

// Prompt-lint (audit P3-A): mechanical contradiction detection. Every check
// here is a defect class from the prompt audit that a human reviewer reads
// past. If a check fails, the prompt and the runtime (or two prompts)
// disagree — fix the code, not the test.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "src");

function participant(overrides = {}) {
  return {
    config: {
      id: "lint-agent",
      name: "Lint Engineer",
      tier: "senior",
      persona: "A lint-fixture persona with enough characters to render verbatim in the identity block.",
      agenda: "Verify prompt invariants hold across refactors.",
      tier_guidance: "Be precise.",
      known_biases: ["assumes the worst edge case will hit first"],
      communication_style: "Direct",
      preferred_contribution_types: ["challenge"],
      anti_patterns: ["Avoid vagueness without data"],
      model: { providerID: "test", modelID: "test-model" },
      ...overrides,
    },
    status: "listening",
  };
}

function cloneTools() {
  return structuredClone(DEFAULT_CONFIG.agentTools);
}

// 1. The contract claims "read last" — and is the final block.
test("contract is the final block of the system prompt", () => {
  const sys = buildAgentSystemPrompt(participant(), { activeCount: 5, agentTools: cloneTools() });
  const contract = sys.indexOf("## OUTPUT CONTRACT");
  assert.ok(contract > 0, "contract header missing");
  assert.ok(contract > sys.indexOf("## WHEN TO PASS"), "contract must follow WHEN TO PASS");
  assert.ok(contract > sys.indexOf("## Research Tools"), "contract must follow the tool reference");
  assert.match(sys, /read last, it governs; in conflict it wins/);
});

// 2. No advertised hard cap the runtime does not enforce.
test("tool budget is worded as guidance, not a hard cap", () => {
  const sys = buildAgentSystemPrompt(participant(), { activeCount: 5, agentTools: cloneTools() });
  assert.doesNotMatch(sys, /Up to \d+ (loom|tool) calls per turn/);
  assert.match(sys, /logged, not hard-stopped/);
});

// 3. Tools described == tools offered, across config combos.
function availableSet(sys) {
  const m = sys.match(/Available: ([^\n]+)/);
  assert.ok(m, "Available line missing");
  const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  // Four forum tool names collapse to the loom_forum flag, like buildToolsMap.
  return new Set(names.map((n) => (n.startsWith("loom_forum_") ? "loom_forum" : n)));
}
function offeredSet(agentTools, activeCount) {
  return new Set(
    Object.keys(buildToolsMap({ agentTools }, { activeCount }))
      .map((n) => (n.startsWith("loom_forum_") ? "loom_forum" : n)),
  );
}
for (const [label, mutate, activeCount] of [
  ["default", null, 5],
  ["forum-off", (t) => { t.loom.loom_forum = false; }, 5],
  ["solo", null, 1],
]) {
  test(`described tools match offered tools (${label})`, () => {
    const at = cloneTools();
    if (mutate) mutate(at);
    const sys = buildAgentSystemPrompt(participant(), { activeCount, agentTools: at });
    if (!at.enabled) return;
    assert.deepEqual([...availableSet(sys)].sort(), [...offeredSet(at, activeCount)].sort());
  });
}

// 3b. Forum descriptions vanish with the flag (not just the tool list).
test("forum description block is gated on loom_forum", () => {
  const off = cloneTools();
  off.loom.loom_forum = false;
  const sys = buildAgentSystemPrompt(participant(), { activeCount: 5, agentTools: off });
  assert.doesNotMatch(sys, /loom_forum_create_topic/);
  assert.doesNotMatch(sys, /Forum — async sub-discussions/);
});

// 4. Bias line grammar: no "you tend to Assumes".
test("bias line reads as grammatical continuation", () => {
  const sys = buildAgentSystemPrompt(
    participant({ known_biases: ["Assumes malicious intent by default", "May over-weight edge cases"] }),
    { activeCount: 5, agentTools: cloneTools() },
  );
  assert.match(sys, /watch for these tendencies in your own reasoning/);
  assert.doesNotMatch(sys, /you tend to [A-Z]/);
});

// 5. Bracket-tag policy is identical across primary and peer prompts.
test("bracket-tag policy agrees across surfaces", () => {
  const sys = buildAgentSystemPrompt(participant(), { activeCount: 5, agentTools: cloneTools() });
  assert.match(sys, /ignored everywhere except loom_vote ballots/);
  const caller = { config: { id: "a", name: "A", tier: "mid" } };
  const target = { config: { id: "t", name: "T", tier: "mid" }, status: "listening" };
  const vote = buildVotePrompt(caller, target, "proposal", "Q?", [], 1, 3, "", null);
  assert.match(vote, /\[Vote: A\]/);
});

// 6. Every documented persona field reaches a prompt.
test("every persona field is consumed by a prompt builder", () => {
  const p = participant({
    persona: "UNIQUEPERSONAZZZ",
    agenda: "UNIQUEAGENDAZZZ",
    tier_guidance: "UNIQUETIERZZZ",
    reflection_guidance: "UNIQUEREFLECTZZZ",
    known_biases: ["uniquebiaszzz"],
    communication_style: "UNIQUESTYLEZZZ",
    preferred_contribution_types: ["unique type zzz"],
    anti_patterns: ["Unique anti-pattern zzz with instead clause"],
  });
  const sys = buildAgentSystemPrompt(p, { activeCount: 5, agentTools: cloneTools() });
  for (const needle of ["UNIQUEPERSONAZZZ", "UNIQUEAGENDAZZZ", "UNIQUETIERZZZ", "uniquebiaszzz", "UNIQUESTYLEZZZ", "unique type zzz", "Unique anti-pattern zzz"]) {
    assert.ok(sys.includes(needle), `persona field missing from system prompt: ${needle}`);
  }
  const caller = { config: { id: "a", name: "A", tier: "mid" } };
  const q = buildQueryPrompt(caller, p, "note", "Q?", [], 1, 3, "", "perspective", null);
  assert.ok(q.includes("UNIQUEREFLECTZZZ"), "reflection_guidance missing from perspective prompt");
  const summoned = buildSummonPrompt(
    { name: "G", tier: "senior", persona: "P", expertise: ["e"], communication_style: "S", tier_guidance: "UNIQUEGUESTLENSZZZ", known_biases: ["guestbiaszzz"], anti_patterns: ["Guest craft zzz instead do this"] },
    caller, "issue", [], 1, 3, "", "Q?",
  );
  assert.ok(summoned.includes("UNIQUEGUESTLENSZZZ"), "guest tier lens missing from summon prompt");
});

// 7. Corpus hygiene: no lint warnings on bundled personas (corpus audit §6.6,
// §12). lintEmbodiment keeps instructions inside the agents' real toolset —
// read/glob/grep, websearch/webfetch, allowlisted bash, loom peer tools.
test("bundled personas pass all corpus lints", () => {
  const all = getPersonas();
  const bad = [];
  for (const [tier, arr] of Object.entries(all)) {
    for (const p of arr) {
      for (const w of [...lintPersonaStyle(p), ...lintTruncation(p), ...lintRunons(p), ...lintCircularity(p), ...lintRangeRule(p, tier), ...lintDepth(p, tier), ...lintEmbodiment(p)]) {
        bad.push(`${tier}/${p.name}: ${w}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

// 7d. Embodiment guard: a persona must not tell the agent to use a body or a
// device it does not have. The lens survives; the action must be evidence-based.
test("persona instructions stay inside the agent toolset", () => {
  const all = getPersonas();
  const forbidden = [
    /run the proposal on/i, /screen reader running/i, /keyboard-only/i,
    /by feel/i, /transcribe hours/i, /replicate the procedure/i, /you watch (thirty|people|a team|a class)/i,
  ];
  const bad = [];
  for (const arr of Object.values(all)) {
    for (const p of arr) {
      const text = [p.agenda, p.tier_guidance, p.reflection_guidance, (p.anti_patterns ?? []).join(" | ")].filter(Boolean).join(" ");
      for (const re of forbidden) {
        if (re.test(text)) bad.push(`${p.name}: ${re}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

// 7b. Shared template budget (corpus audit F1): the longest common opening
// within a tier must fit a small budget. Professional tiers share ~nothing;
// civilian shares at most the deliberate range-rule block (~430 chars). A
// dominant template fails this test. No two files may be identical either.
test("tier_guidance shares at most a budgeted opening per tier", () => {
  const all = getPersonas();
  const bad = [];
  const BUDGET = { civilian: 450 };
  const lcp = (strs) => {
    let pre = strs[0] ?? "";
    for (const s of strs.slice(1)) {
      let i = 0;
      while (i < pre.length && i < s.length && pre[i] === s[i]) i++;
      pre = pre.slice(0, i);
    }
    return pre;
  };
  for (const [tier, arr] of Object.entries(all)) {
    const texts = arr.map((p) => String(p.tier_guidance ?? ""));
    const prefix = lcp(texts);
    const limit = BUDGET[tier] ?? 60;
    if (prefix.length > limit) bad.push(`${tier}: shared opening is ${prefix.length} chars (budget ${limit}): "${prefix.slice(0, 80)}…"`);
    const seen = new Map();
    for (const p of arr) {
      const full = String(p.tier_guidance ?? "");
      const opening = full;
      if (seen.has(opening)) bad.push(`${tier}: "${opening}…" shared by ${seen.get(opening)} and ${p.name}`);
      else seen.set(opening, p.name);
    }
  }
  assert.deepEqual(bad, []);
});

// 7c. Civilian lenses carry the range rule (corpus audit §6.1): the hobby-trap
// returns the next time someone edits a file without it.
test("civilian tier_guidance carries the range rule", () => {
  const all = getPersonas();
  const bad = [];
  for (const p of (all.civilian ?? [])) {
    if (!/at most (one|once)/.test(String(p.tier_guidance ?? ""))) bad.push(p.name);
  }
  assert.deepEqual(bad, []);
});

// 8. Cache busts on persona text edits (verified failure before the fix).
test("system prompt cache busts on persona text edits", () => {
  const at = cloneTools();
  const mk = (persona) => participant({ id: "cache-probe", persona });
  const a = buildAgentSystemPrompt(mk("First persona text long enough to be rendered verbatim here."), { activeCount: 5, agentTools: at });
  const b = buildAgentSystemPrompt(mk("A COMPLETELY DIFFERENT persona text that is also long enough to render."), { activeCount: 5, agentTools: at });
  assert.notEqual(a, b);
  assert.ok(!b.includes("First persona text"), "stale prompt served after persona edit");
});

// 9. First speaker gets an opener, not a citation demand.
test("first speaker is not ordered to cite [#id]", () => {
  const user = buildAgentUserPrompt(participant(), "", [], 1, "Q", [], "", [], [], null, false, true, {});
  assert.match(user, /You are first/);
  assert.doesNotMatch(user, /engage at least one \[#id\]/);
});

// 10. Roster example id comes from the roster, never invented.
test("roster example id is drawn from the live roster", () => {
  const user = buildAgentUserPrompt(
    participant(), "", [{ id: 1, participant_id: "x", content: "hi" }], 2, "Q", [], "", [],
    [{ id: "abc_1", name: "Abc", tier: "mid", status: "listening", persona: "p" }],
    { stance: "s", version: 1, updated_round: 1 }, true, true, {},
  );
  assert.ok(user.includes('{target: "abc_1"'), "example id must be the first roster id");
  assert.doesNotMatch(user, /dr_sarah_3/);
});

// 11. Round-phase doctrine reaches primary turns when maxRounds is known.
test("primary user prompt carries round-phase guidance", () => {
  const withPhase = buildAgentUserPrompt(participant(), "", [], 1, "Q", [], "", [], [], null, false, true, {}, { maxRounds: 4 });
  assert.match(withPhase, /Round phase/);
  const withoutPhase = buildAgentUserPrompt(participant(), "", [], 1, "Q", [], "", [], [], null, false, true, {});
  assert.doesNotMatch(withoutPhase, /Round phase/);
});

// 12. Steering hint renders before the final patch line (recency).
test("steering hint precedes the final patch line", () => {
  const user = buildAgentUserPrompt(
    participant(), "", [], 2, "Q", [], "", [], [], { stance: "s", version: 1, updated_round: 1 },
    false, false, { skillState: true }, { steeringHint: "consolidate first", maxRounds: 4 },
  );
  const hint = user.indexOf("STEERING_HINT");
  const patch = user.indexOf("Then call loom_state_patch once");
  assert.ok(hint > 0 && patch > 0 && hint < patch, "hint must precede the final patch line");
});

// 13. N0 regression guard: enforcement retries harvest tools, never prose.
test("mandatory retry never overwrites the contribution", () => {
  const src = readFileSync(join(SRC, "round-executor", "agent", "execute-turn.js"), "utf-8");
  assert.doesNotMatch(src, /finalText = retryResponse\.text/);
  assert.match(src, /mandatory_retry_text_ignored/);
  assert.match(src, /synthesis_too_short/);
});

// 14. Pass/patch exclusivity is stated where the model decides.
test("pass/patch exclusivity is stated in contract and tool", () => {
  const sys = buildAgentSystemPrompt(participant(), { activeCount: 5, agentTools: cloneTools() });
  assert.match(sys, /mutually exclusive in one turn/);
  const passSrc = readFileSync(join(SRC, "plugin", "tools", "pass.js"), "utf-8");
  assert.match(passSrc, /mutually exclusive/);
});

// 15. Mandatory default parity: config default matches the Setup tab.
test("mandatory defaults exist in config and schema", () => {
  assert.equal(DEFAULT_CONFIG.agentTools.mandatory?.skillState, true);
  for (const k of ["forums", "skillState", "agentQueries", "localSearch", "onlineResearch"]) {
    assert.ok(NESTED_SCHEMA[`agentTools.mandatory.${k}`], `schema missing agentTools.mandatory.${k}`);
  }
});

// 16. Mode survives tools-off (read-only must be stated, not implied).
test("mode is rendered when agent tools are disabled", () => {
  const at = cloneTools();
  at.enabled = false;
  const sys = buildAgentSystemPrompt(participant(), { activeCount: 5, agentTools: at });
  assert.match(sys, /## Mode/);
  assert.match(sys, /\*\*PLAN\*\*/);
});

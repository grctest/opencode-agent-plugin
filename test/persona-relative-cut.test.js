import test from "node:test";
import assert from "node:assert/strict";
import {
  selectTopNPerTier,
  rankPersonasForQuestion,
  composeRoomWithSimilarity,
  rankCrossTierCandidates,
  isQuantitativeQuestion,
  isQuantitativePersona,
} from "../src/composer/room.js";
import { getPersonas } from "../src/composer/persona-loader.js";

// P15 — the absolute relevance floor (maxCosineDistance 0.85 → maxL2 ≈ 1.304)
// admitted 181/181 personas and never bound, so it contributed nothing. The
// relative cut ranks within each tier and keeps the top-N regardless of
// absolute similarity.

test("selectTopNPerTier keeps the top-N by rank regardless of absolute distance", () => {
  const results = [
    { persona_name: "a", distance: 1.45 },
    { persona_name: "b", distance: 1.40 },
    { persona_name: "c", distance: 1.50 },
    { persona_name: "d", distance: 1.35 },
  ];
  // All four are ABOVE the old absolute floor (≈1.304) — the old floor would
  // reject every one of them; the relative cut keeps the best three.
  const kept = selectTopNPerTier(results, 3);
  assert.deepEqual(kept.map((r) => r.persona_name), ["d", "b", "a"]);
});

test("selectTopNPerTier sorts unscored (null-distance) rows last and clamps n", () => {
  const results = [
    { persona_name: "kw", distance: null },
    { persona_name: "far", distance: 1.9 },
    { persona_name: "near", distance: 0.2 },
  ];
  assert.deepEqual(selectTopNPerTier(results, 2).map((r) => r.persona_name), ["near", "far"]);
  assert.equal(selectTopNPerTier(results).length, 3);
  assert.equal(selectTopNPerTier(results, 1).length, 1);
  assert.equal(selectTopNPerTier(results, 99).length, 3);
  assert.equal(selectTopNPerTier([], 3).length, 0);
});

test("keyword composition seats a top-N persona per tier (relative cut)", async () => {
  const question = "What is the probability that the forecast model predicts next quarter's revenue accurately?";
  const room = await composeRoomWithSimilarity(question, "", { keywordOnly: true });
  assert.ok(room.participants.length >= 2, "room should seat participants");
  const personas = getPersonas();
  for (const p of room.participants) {
    const pool = personas[p.tier] ?? [];
    if (pool.length === 0) continue;
    const ranked = rankPersonasForQuestion(pool, question);
    const rank = ranked.findIndex((r) => r.persona.name === p.name);
    assert.ok(rank >= 0, `seated persona ${p.name} should exist in tier ${p.tier}`);
    assert.ok(rank < 3, `seated persona ${p.name} should be within the top-3 of tier ${p.tier} by rank (was ${rank + 1})`);
  }
});

test("keyword composition is deterministic across calls", async () => {
  const question = "How will the new pricing model affect churn and expansion revenue?";
  const a = await composeRoomWithSimilarity(question, "", { keywordOnly: true });
  const b = await composeRoomWithSimilarity(question, "", { keywordOnly: true });
  assert.deepEqual(a.participants.map((p) => p.id), b.participants.map((p) => p.id));
});

// N11 — the relative cut still returns three candidates per tier however far
// away they are, which is how a mechanical keyboard enthusiast ranked #2 for a
// car-manufacturer question in deliberation 1355a723. The cross-tier floor is
// the behaviour change that was never made: when the nominal tier has nothing
// on-topic, the seat goes to the best candidate in any tier.

test("a quantitative question is recognised as one", () => {
  assert.equal(isQuantitativeQuestion("Which car manufacturer wins the most races in 2027?"), false);
  assert.equal(isQuantitativeQuestion("What is the probability the forecast model predicts next quarter's revenue?"), true);
  assert.equal(isQuantitativeQuestion("Estimate the win share band and its confidence level."), true);
  assert.equal(isQuantitativeQuestion("Should we migrate the auth service?"), false);
});

test("a quantitative persona is recognised by tag or expertise", () => {
  const personas = getPersonas();
  const actuarial = personas.mid.find((p) => p.name === "Actuarial Analyst");
  assert.ok(actuarial, "catalog has an Actuarial Analyst");
  assert.equal(isQuantitativePersona(actuarial), true);
  const all = Object.values(personas).flat();
  const keyboardish = all.find((p) => /keyboard/i.test(`${p.name} ${p.persona}`));
  if (keyboardish) assert.equal(isQuantitativePersona(keyboardish), false);
});

test("cross-tier ranking breaks near-ties toward a quantitative persona", () => {
  const personas = getPersonas();
  const actuarial = personas.mid.find((p) => p.name === "Actuarial Analyst");
  const rows = [
    { persona_name: "off-topic-near", distance: 1.00, persona: { name: "off-topic-near", tags: ["hardware"] } },
    { persona_name: "Actuarial Analyst", distance: 1.02, persona: actuarial },
  ];
  // Without the tie-break the nearer row wins; on a quantitative question the
  // quantitative persona takes the seat.
  assert.equal(rankCrossTierCandidates(rows, { quantitative: false })[0].persona_name, "off-topic-near");
  assert.equal(rankCrossTierCandidates(rows, { quantitative: true })[0].persona_name, "Actuarial Analyst");
  // A real distance gap is not a tie.
  const far = [
    { persona_name: "off-topic-near", distance: 1.40, persona: { name: "off-topic-near", tags: ["hardware"] } },
    { persona_name: "Actuarial Analyst", distance: 1.02, persona: actuarial },
  ];
  assert.equal(rankCrossTierCandidates(far, { quantitative: true })[0].persona_name, "Actuarial Analyst");
});

test("the car-manufacturer question no longer seats a keyboard enthusiast", async () => {
  const question = "Which car manufacturer is going to win the most races in 2027?";
  const room = await composeRoomWithSimilarity(question, "", { keywordOnly: true });
  const named = room.participants.map((p) => p.name);
  assert.ok(named.length >= 2, "room should seat participants");
  for (const name of named) {
    assert.doesNotMatch(name, /keyboard/i, `a keyboard persona was seated for a car-manufacturer question: ${named.join(", ")}`);
  }
  // Composition stays deterministic — a floor that reorders seats by chance is
  // not a floor, it is noise.
  const again = await composeRoomWithSimilarity(question, "", { keywordOnly: true });
  assert.deepEqual(again.participants.map((p) => p.id), room.participants.map((p) => p.id));
});

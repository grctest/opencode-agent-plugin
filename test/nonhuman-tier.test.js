import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { getPersonas, lintPersonaStyle, lintTruncation, lintRunons, lintCircularity, lintDepth, lintEmbodiment } from "../src/composer/persona-loader.js";
import { mergeSeatCandidates, candidatePoolsForTier, composeRoomWithSimilarity, rankPersonasForQuestion } from "../src/composer/room.js";
import { initSchema, runMigrations, LATEST_SCHEMA_VERSION, MIGRATIONS } from "../src/database/schema.js";
import { getRightsForTier } from "../src/utils/tier.js";


const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nonhuman = () => getPersonas().nonhuman ?? [];

// tierMeta.jsx is JSX and node:test cannot import it, so the dashboard's tier
// metadata is read as source and asserted structurally. Deliberately not an
// import: the point is that a tier cannot be added to the engine and then
// forgotten in the UI, and reading the literal catches that without pulling
// esbuild into the test run.
const tierMetaSrc = readFileSync(join(root, "src/dashboard/components/tierMeta.jsx"), "utf8");

// The nonhuman tier is a POOL, not a reserved seat: every seat also considers
// these personas and ranks the union. Two invariants follow, and both are
// load-bearing — a reserved seat would put an alien voice on questions it has
// nothing to say about, and a shared cut across pools would let personas
// written to be adjacent to everything evict the in-tier specialists.

test("the nonhuman tier loads, and every bundled persona is a person with a body of lore", () => {
  const all = nonhuman();
  assert.ok(all.length >= 30, `expected a substantial non-human catalog, got ${all.length}`);
  for (const p of all) {
    assert.ok(p.name, "every non-human persona is named");
    assert.ok(p.persona.length > 80, `${p.name}: description is too thin to build a voice from`);
    assert.ok(Array.isArray(p.tags) && p.tags.length > 0, `${p.name}: needs tags`);
    assert.ok(Array.isArray(p.expertise) && p.expertise.length > 0, `${p.name}: needs expertise`);
  }
});

test("non-human persona names are unique across the whole catalog", () => {
  const all = Object.values(getPersonas()).flat();
  const seen = new Map();
  for (const p of all) {
    assert.ok(!seen.has(p.name), `duplicate persona name "${p.name}" (${seen.get(p.name)} and ${p.tier ?? "nonhuman"})`);
    seen.set(p.name, p.tier ?? "nonhuman");
  }
});

test("non-human personas pass the same corpus lints as the human tiers", () => {
  const bad = [];
  for (const p of nonhuman()) {
    for (const w of [
      ...lintPersonaStyle(p), ...lintTruncation(p), ...lintRunons(p), ...lintCircularity(p, ),
      ...lintDepth(p, "nonhuman"), ...lintEmbodiment(p),
    ]) bad.push(`${p.name}: ${w}`);
  }
  assert.deepEqual(bad, []);
});

test("a non-human persona's instructions stay inside the agent toolset", () => {
  // The authoring law for this tier: a being's senses become the EVIDENCE it
  // demands, never the actions it takes. A bat that says "I echolocate" is
  // unactionable for an agent with read/grep/websearch; a bat that asks what
  // would have to bounce back is a lens. These regexes are the same ones the
  // embodiment lint uses, asserted here on the tier as a whole.
  const forbidden = [
    /run the proposal on/i, /screen reader running/i, /keyboard-only/i, /by feel/i,
    /transcribe hours/i, /replicate the procedure/i, /you watch (thirty|people|a team|a class)/i,
  ];
  const bad = [];
  for (const p of nonhuman()) {
    const text = [p.agenda, p.tier_guidance, p.reflection_guidance, (p.anti_patterns ?? []).join(" | ")].filter(Boolean).join(" ");
    for (const re of forbidden) if (re.test(text)) bad.push(`${p.name}: ${re}`);
  }
  assert.deepEqual(bad, []);
});

test("no non-human persona is a human job role wearing a costume", () => {
  // The tier exists to hold sentients with no human career. A "CISO" here
  // would duplicate a principal persona, and no existing lint can catch it.
  // Matched against the NAME only: expertise is a technical description of the
  // lens, and a reef genuinely has specialist niches — the thing that must
  // never appear is a persona named after an office.
  const office = /\b(engineer|manager|director|analyst|consultant|designer|technician|officer|administrator|specialist|architect|developer|researcher|auditor|accountant|planner|operator|strategist|broker|advisor|founder|president|clerk|scientist|writer|coach|founder)\b/i;
  const bad = nonhuman().filter((p) => office.test(p.name)).map((p) => p.name);
  assert.deepEqual(bad, []);
});

test("the nonhuman tier is a distinct voice, not a template with the nouns swapped", () => {
  // The 60-char shared-opening budget for non-civilian tiers: any shared
  // preamble across 40+ personas is the corpus's one forbidden shape.
  const lcp = (strs) => {
    let pre = strs[0] ?? "";
    for (const s of strs.slice(1)) {
      let i = 0;
      while (i < pre.length && i < s.length && pre[i] === s[i]) i++;
      pre = pre.slice(0, i);
    }
    return pre;
  };
  const texts = nonhuman().map((p) => String(p.tier_guidance ?? ""));
  assert.ok(lcp(texts).length <= 60, `shared tier_guidance opening is ${lcp(texts).length} chars`);
  // Also: no two tier_guidance may be identical.
  assert.equal(new Set(texts).size, texts.length);
});

// --- pool mechanics -------------------------------------------------------

test("a seat draws from its own tier and the non-human pool", () => {
  assert.deepEqual(candidatePoolsForTier("mid"), ["mid", "nonhuman"]);
  assert.deepEqual(candidatePoolsForTier("civilian"), ["civilian", "nonhuman"]);
  // A nonhuman seat is already the pool; it must not search itself twice.
  assert.deepEqual(candidatePoolsForTier("nonhuman"), ["nonhuman"]);
});

test("the non-human pool is ranked per-pool before the union, so it cannot evict in-tier specialists", () => {
  // Every non-human persona is nearer than every mid persona. A shared cut
  // would seat three non-humans and drop M1 entirely; per-pool cutting keeps
  // the mid tier's own top-3 alive and lets the non-humans compete above them.
  const nonhumanRows = [
    { persona_name: "N1", distance: 0.10 }, { persona_name: "N2", distance: 0.12 },
    { persona_name: "N3", distance: 0.14 }, { persona_name: "N4", distance: 0.16 },
  ];
  const midRows = [
    { persona_name: "M1", distance: 0.30 }, { persona_name: "M2", distance: 0.31 },
    { persona_name: "M3", distance: 0.32 }, { persona_name: "M4", distance: 0.33 },
  ];
  const merged = mergeSeatCandidates(midRows, nonhumanRows, "mid", 3);
  assert.deepEqual(merged.filter((r) => r.tier === "mid").map((r) => r.persona_name), ["M1", "M2", "M3"],
    "a mid persona must be excluded by another mid persona, never by a non-human one");
  // It still wins when it is genuinely nearest — the point is distance, not a quota.
  assert.equal(merged[0].persona_name, "N1");
  // A tier's fourth-best row never reaches the union at all.
  assert.ok(!merged.some((r) => r.persona_name === "M4" || r.persona_name === "N4"));
});

test("a non-human persona loses the seat when the human tier is nearer", () => {
  const nonhumanRows = [{ persona_name: "N1", distance: 1.90 }];
  const midRows = [{ persona_name: "M1", distance: 0.20 }];
  const merged = mergeSeatCandidates(midRows, nonhumanRows, "mid", 3);
  assert.equal(merged[0].persona_name, "M1");
  assert.equal(merged[0].tier, "mid");
});

test("mergeSeatCandidates tags every row with the pool it came from", () => {
  const merged = mergeSeatCandidates([{ persona_name: "M1", distance: 0.5 }], [{ persona_name: "N1", distance: 0.4 }], "senior", 3);
  assert.deepEqual(merged.map((r) => [r.persona_name, r.tier]).sort(), [["M1", "senior"], ["N1", "nonhuman"]]);
  // Untagged in-tier rows resolve to the NOMINAL tier, not to undefined.
  assert.equal(merged.find((r) => r.persona_name === "M1").tier, "senior");
});

test("a seated non-human persona is the top of its own pool, so the in-tier invariant still holds", async () => {
  // The generalization of the P15 test to the new tier: whoever holds a seat
  // is within the top-3 of the tier it was actually selected from — including
  // a non-human persona, which is the invariant a shared cut would break.
  const question = "Why does the coral reef bleach and can it recover?";
  const room = await composeRoomWithSimilarity(question, "", { keywordOnly: true });
  for (const p of room.participants) {
    const pool = getPersonas()[p.tier] ?? [];
    if (pool.length === 0) continue;
    const rank = rankPersonasForQuestion(pool, question).findIndex((r) => r.persona.name === p.name);
    assert.ok(rank >= 0 && rank < 3, `${p.name} (${p.tier}) ranked ${rank + 1} in its own pool`);
  }
});

test("keyword composition seats a non-human persona when it is the best match", async () => {
  const room = await composeRoomWithSimilarity("why does the coral reef bleach and can it recover", "", { keywordOnly: true });
  const seats = room.participants.map((p) => p.name);
  assert.ok(seats.length >= 2);
  const nonhumanSeats = room.participants.filter((p) => p.tier === "nonhuman");
  // Not a hard requirement of every question — but this one is squarely about
  // a system a non-human persona is written to speak for.
  assert.ok(nonhumanSeats.length > 0, `expected a non-human seat for a reef question, got ${seats.join(", ")}`);
});

test("non-human personas do not crowd specialists off purely human questions", async () => {
  // The crowding risk named before the tier existed: personas written to be
  // adjacent to everything will match anything, and an over-eager pool would
  // put a river in an API design review.
  for (const question of [
    "How do we design our API?",
    "Should I buy GameStop stock?",
    "What are the risks of storing credit card numbers ourselves?",
  ]) {
    const room = await composeRoomWithSimilarity(question, "", { keywordOnly: true });
    const nonhumanSeats = room.participants.filter((p) => p.tier === "nonhuman").map((p) => p.name);
    // No more than one non-human seat out of three, and never two of the same
    // voice — a pool that wins every seat is a quota in disguise.
    assert.ok(nonhumanSeats.length <= 1, `${nonhumanSeats.length} non-human seats for "${question}": ${room.participants.map((p) => p.name).join(", ")}`);
    assert.ok(room.participants.length >= 2, `room collapsed for "${question}"`);
  }
});

test("composition stays deterministic with a non-human pool in it", async () => {
  const question = "How does sediment transport downstream after a flood?";
  const a = await composeRoomWithSimilarity(question, "", { keywordOnly: true });
  const b = await composeRoomWithSimilarity(question, "", { keywordOnly: true });
  assert.deepEqual(a.participants.map((p) => p.id), b.participants.map((p) => p.id));
});

// --- plumbing -------------------------------------------------------------

test("the nonhuman tier is admitted everywhere a tier is named", async () => {
  // Four separate tier whitelists plus the DB CHECK: a tier that is valid in
  // one surface and not another persists a participant that cannot be read
  // back, or is silently dropped at the dashboard.
  assert.ok(getRightsForTier("nonhuman").call_vote, "a non-human seat holds a vote like any other");
  assert.match(tierMetaSrc, /TIER_ORDER\s*=\s*\[[^\]]*"nonhuman"/, "the dashboard tier order must list nonhuman");
  assert.match(tierMetaSrc, /nonhuman:\s*\{\s*label:/, "the dashboard needs a label for the tier");
  assert.match(tierMetaSrc, /nonhuman:[\s\S]*?blurb:/, "the dashboard needs a blurb for the tier");
  assert.equal(LATEST_SCHEMA_VERSION, 14);
  assert.equal(MIGRATIONS.length, LATEST_SCHEMA_VERSION);

  // And every surface that decides whether a seat is legal, renderable, or
  // given a model. A tier that is valid in one and not another either persists
  // a participant that cannot be read back, or renders as a blank badge.
  for (const [file, pattern] of [
    ["src/composer/persona-loader.js", /VALID_TIERS\s*=\s*new Set\(\[[^\]]*"nonhuman"/],
    ["src/dashboard/server/control.js", /ALLOWED_TIERS\s*=\s*new Set\(\[[^\]]*"nonhuman"/],
    ["src/dashboard/stores/setupForm.js", /KNOWN_TIERS\s*=\s*new Set\(\[[^\]]*"nonhuman"/],
    ["src/dashboard/server/orchestrator-preview.js", /KNOWN_TIERS\s*=\s*new Set\(\[[^\]]*"nonhuman"/],
    ["src/dashboard/components/Badges.jsx", /validTier\s*=\s*new Set\(\[[^\]]*"nonhuman"/],
    ["src/model-discovery.js", /priorityOrder\s*=\s*\[[^\]]*"nonhuman"/],
  ]) {
    assert.match(readFileSync(join(root, file), "utf8"), pattern, `${file} must admit the nonhuman tier`);
  }

  // Model assignment must not treat it as the lowest tier: an unranked nonhuman
  // sorts last and would be handed the weakest model in the room.
  const plan = await import("../src/model-discovery.js");
  const ranked = plan.assignModelsByTier(
    [{ providerID: "p", modelID: "big", name: "big", context: 200000, reasoning: true, active: true }, { providerID: "p", modelID: "small", name: "small", context: 8000, reasoning: false, active: true }],
    { providerID: "p", modelID: "small" },
    ["principal", "nonhuman", "junior"],
  );
  assert.ok(ranked.length === 3, "every role gets a model");
  assert.notEqual(ranked[1].modelID, undefined, "the nonhuman seat is assigned a model");
});

test("a fresh database accepts a nonhuman participant", () => {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  db.exec("INSERT INTO meetings (id,question,status,max_rounds,convergence,created_at,updated_at) VALUES ('m1','q','initializing',4,0,'t','t')");
  db.exec("INSERT INTO participants (id,meeting_id,name,persona,agenda,tier) VALUES ('p1','m1','The Octopus','x','y','nonhuman')");
  assert.equal(db.prepare("SELECT tier FROM participants WHERE id='p1'").get().tier, "nonhuman");
});

test("the v13→v14 migration widens the CHECK and preserves participants and their children", () => {
  // The rebuild drops and recreates a parent table that three child tables
  // reference. Get this wrong and a migration silently cascades away every
  // contribution, turn request and error for every existing meeting.
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  db.exec("INSERT INTO meetings (id,question,status,max_rounds,convergence,created_at,updated_at) VALUES ('m1','q','initializing',4,0,'t','t')");
  db.exec("DROP TABLE participants");
  db.exec(`CREATE TABLE participants (
      id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      name TEXT NOT NULL, persona TEXT NOT NULL, agenda TEXT NOT NULL,
      tier TEXT NOT NULL CHECK(tier IN ('junior','mid','senior','principal','civilian')),
      provider_id TEXT, model_id TEXT, session_id TEXT,
      session_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'listening' CHECK(status IN ('listening','speaking','passed','failed','summoned')),
      reflection TEXT NOT NULL DEFAULT '', state_json TEXT NOT NULL DEFAULT '{}',
      known_biases TEXT, communication_style TEXT, preferred_contribution_types TEXT,
      anti_patterns TEXT, tier_guidance TEXT, reflection_guidance TEXT, tags TEXT, expertise TEXT,
      UNIQUE(meeting_id, name))`);
  db.exec("CREATE INDEX idx_participants_meeting ON participants(meeting_id)");
  db.exec("PRAGMA user_version = 13");
  db.exec("INSERT INTO participants (id,meeting_id,name,persona,agenda,tier,session_version) VALUES ('old1','m1','Old','x','y','mid',3)");
  db.exec("INSERT INTO contributions (meeting_id,participant_id,round,type,content,created_at) VALUES ('m1','old1',0,'contribution','hello','t')");
  db.exec("INSERT INTO turn_requests (meeting_id,participant_id,round,content,created_at) VALUES ('m1','old1',0,'plz','t')");
  db.exec("INSERT INTO agent_errors (meeting_id,participant_id,round,error_type,created_at) VALUES ('m1','old1',0,'boom','t')");

  assert.equal(runMigrations(db), LATEST_SCHEMA_VERSION);
  assert.match(
    db.prepare("SELECT sql FROM sqlite_master WHERE name='participants'").get().sql,
    /CHECK\(tier IN \([^)]*'nonhuman'/,
    "the CHECK must admit nonhuman after migration",
  );
  db.exec("INSERT INTO participants (id,meeting_id,name,persona,agenda,tier) VALUES ('nh','m1','The Whale','x','y','nonhuman')");
  // The row survived the rebuild, with its non-default column intact.
  assert.equal(db.prepare("SELECT session_version FROM participants WHERE id='old1'").get().session_version, 3);
  // The children did NOT cascade away — this is the failure the rebuild risks.
  assert.equal(db.prepare("SELECT count(*) c FROM contributions").get().c, 1);
  assert.equal(db.prepare("SELECT count(*) c FROM turn_requests").get().c, 1);
  assert.equal(db.prepare("SELECT count(*) c FROM agent_errors").get().c, 1);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  // Indexes are dropped with the old table and must come back.
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='participants' AND name='idx_participants_meeting'").get());
  // Still a whitelist, not a free-for-all.
  assert.throws(() => db.exec("INSERT INTO participants (id,meeting_id,name,persona,agenda,tier) VALUES ('z','m1','Z','x','y','wizard')"), /CHECK/);
});

test("the v13→v14 migration is a no-op on a database that already admits nonhuman", () => {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const before = db.prepare("SELECT sql FROM sqlite_master WHERE name='participants'").get().sql;
  runMigrations(db);
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='participants'").get().sql, before);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, LATEST_SCHEMA_VERSION);
});

test("the nonhuman tier ships in the packaged personas directory", () => {
  const dir = join(root, "personas", "nonhuman");
  assert.ok(existsSync(dir), "personas/nonhuman must exist in the package");
  const files = nonhuman();
  assert.ok(files.length > 0);
  for (const p of files) assert.ok(p.version, `${p.name} should carry a version`);
});

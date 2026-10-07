import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { getPersonas, lintPersonaStyle, lintTruncation, lintRunons, lintCircularity, lintEmbodiment } from "../src/composer/persona-loader.js";
import { buildRankingResult } from "../src/composer/room.js";
import { initSchema, runMigrations, LATEST_SCHEMA_VERSION, MIGRATIONS } from "../src/database/schema.js";
import { BASE_RIGHTS } from "../src/utils/category.js";


const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nonhuman = () => getPersonas().nonhuman ?? [];

// tierMeta.jsx is JSX and node:test cannot import it, so the dashboard's category
// metadata is read as source and asserted structurally. Deliberately not an
// import: the point is that a category cannot be added to the engine and then
// forgotten in the UI, and reading the literal catches that without pulling
// esbuild into the test run.
const tierMetaSrc = readFileSync(join(root, "src/dashboard/components/tierMeta.jsx"), "utf8");

// The nonhuman category is a CATEGORY, not a reserved seat. Room composition ranks the
// whole catalog as one flat pool, so these personas reach a seat on the same
// distance measurement as any human — and, equally, can sit at the bottom of
// the list. What the category must not acquire is a quota: nothing may force one in
// or cap how many appear. The flat-pool behaviour itself is covered in
// persona-ranking.test.js; what is asserted here is that this category remains a
// first-class category throughout the engine.

test("the nonhuman category loads, and every bundled persona is a person with a body of lore", () => {
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
  for (const [category, pool] of Object.entries(getPersonas())) {
    for (const p of pool) {
      assert.ok(!seen.has(p.name), `duplicate persona name "${p.name}" (${seen.get(p.name)} and ${category})`);
      seen.set(p.name, category);
    }
  }
});

test("non-human personas pass the same corpus lints as the human categories", () => {
  const bad = [];
  for (const p of nonhuman()) {
    for (const w of [
      ...lintPersonaStyle(p), ...lintTruncation(p), ...lintRunons(p), ...lintCircularity(p),
      ...lintEmbodiment(p),
    ]) bad.push(`${p.name}: ${w}`);
  }
  assert.deepEqual(bad, []);
});

test("a non-human persona's instructions stay inside the agent toolset", () => {
  // The authoring law for this category: a being's senses become the EVIDENCE it
  // demands, never the actions it takes. A bat that says "I echolocate" is
  // unactionable for an agent with read/grep/websearch; a bat that asks what
  // would have to bounce back is a lens. These regexes are the same ones the
  // embodiment lint uses, asserted here on the category as a whole.
  const forbidden = [
    /run the proposal on/i, /screen reader running/i, /keyboard-only/i, /by feel/i,
    /transcribe hours/i, /replicate the procedure/i, /you watch (thirty|people|a team|a class)/i,
  ];
  const bad = [];
  for (const p of nonhuman()) {
    const text = [p.agenda, p.category_guidance, p.reflection_guidance, (p.anti_patterns ?? []).join(" | ")].filter(Boolean).join(" ");
    for (const re of forbidden) if (re.test(text)) bad.push(`${p.name}: ${re}`);
  }
  assert.deepEqual(bad, []);
});

test("no non-human persona is a human job role wearing a costume", () => {
  // The category exists to hold sentients with no human career. A "CISO" here
  // would duplicate a principal persona, and no existing lint can catch it.
  // Matched against the NAME only: expertise is a technical description of the
  // lens, and a reef genuinely has specialist niches — the thing that must
  // never appear is a persona named after an office.
  const office = /\b(engineer|manager|director|analyst|consultant|designer|technician|officer|administrator|specialist|architect|developer|researcher|auditor|accountant|planner|operator|strategist|broker|advisor|founder|president|clerk|scientist|writer|coach|founder)\b/i;
  const bad = nonhuman().filter((p) => office.test(p.name)).map((p) => p.name);
  assert.deepEqual(bad, []);
});

test("the nonhuman category is a distinct voice, not a template with the nouns swapped", () => {
  // Any shared preamble across 40+ personas is the corpus's one forbidden shape.
  const lcp = (strs) => {
    let pre = strs[0] ?? "";
    for (const s of strs.slice(1)) {
      let i = 0;
      while (i < pre.length && i < s.length && pre[i] === s[i]) i++;
      pre = pre.slice(0, i);
    }
    return pre;
  };
  const texts = nonhuman().map((p) => String(p.category_guidance ?? ""));
  assert.ok(lcp(texts).length <= 60, `shared category_guidance opening is ${lcp(texts).length} chars`);
  // Also: no two category_guidance may be identical.
  assert.equal(new Set(texts).size, texts.length);
});

// --- pool mechanics -------------------------------------------------------

test("a non-human persona ranks in the same flat pool, with no category quota", () => {
  // The flat pool replaced a per-category cut that used to cap each category's
  // contribution. What must survive the replacement is the absence of any
  // quota: a non-human persona is seated when it is genuinely nearest, and a
  // distant one is not promoted to fill a seat.
  const nearest = buildRankingResult([
    { persona_name: "N1", category: "nonhuman", distance: 0.05 },
    { persona_name: "M1", category: "mid", distance: 0.20 },
    { persona_name: "M2", category: "mid", distance: 0.21 },
  ], 2);
  assert.deepEqual(nearest.selected.map((r) => r.name), ["N1", "M1"]);

  // Distance the other way round: no non-human is promoted over nearer humans.
  const humansNearer = buildRankingResult([
    { persona_name: "M1", category: "mid", distance: 0.20 },
    { persona_name: "S1", category: "senior", distance: 0.30 },
    { persona_name: "N1", category: "nonhuman", distance: 1.90 },
  ], 2);
  assert.deepEqual(humansNearer.selected.map((r) => r.name), ["M1", "S1"]);
  assert.ok(!humansNearer.selected.some((r) => r.category === "nonhuman"));
});

// --- plumbing -------------------------------------------------------------

test("the nonhuman category is admitted everywhere a category is named", async () => {
  // Categories are open organizational labels: no whitelist anywhere, and all
  // seats hold identical rights.
  assert.ok(BASE_RIGHTS.contribute && BASE_RIGHTS.call_vote, "every seat holds identical rights");
  assert.match(tierMetaSrc, /CATEGORY_ORDER\s*=\s*\[[^\]]*"nonhuman"/, "the dashboard category order must list nonhuman");
  assert.match(tierMetaSrc, /nonhuman:\s*\{\s*label:/, "the dashboard needs a label for the category");
  assert.match(tierMetaSrc, /nonhuman:[\s\S]*?blurb:/, "the dashboard needs a blurb for the category");
  assert.equal(LATEST_SCHEMA_VERSION, 17);
  assert.equal(MIGRATIONS.length, LATEST_SCHEMA_VERSION);

  // Model assignment is random and category-blind: every seat draws a model.
  const plan = await import("../src/model-discovery.js");
  const drawn = plan.assignModelsRandomly(
    [{ providerID: "p", modelID: "big", name: "big" }, { providerID: "p", modelID: "small", name: "small" }],
    3,
    () => 0.1,
  );
  assert.equal(drawn.length, 3, "every seat gets a model");
  for (const a of drawn) assert.ok(a.providerID && a.modelID, "assignment carries a concrete model");
});

test("a fresh database accepts a nonhuman participant", () => {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  db.exec("INSERT INTO meetings (id,question,status,max_rounds,convergence,created_at,updated_at) VALUES ('m1','q','initializing',4,0,'t','t')");
  db.exec("INSERT INTO participants (id,meeting_id,name,persona,agenda,category) VALUES ('p1','m1','The Octopus','x','y','nonhuman')");
  assert.equal(db.prepare("SELECT category FROM participants WHERE id='p1'").get().category, "nonhuman");
});

test("the v13→v14 migration widens the CHECK and preserves participants and their children", () => {
  // The rebuild drops and recreates a parent table that child tables
  // reference. Get this wrong and a migration silently cascades away every
  // contribution and error for every existing meeting.
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
  db.exec("INSERT INTO agent_errors (meeting_id,participant_id,round,error_type,created_at) VALUES ('m1','old1',0,'boom','t')");

  assert.equal(runMigrations(db), LATEST_SCHEMA_VERSION);
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='participants'").get().sql;
  assert.match(sql, /\bcategory TEXT NOT NULL/, "the column must be renamed to category after migration");
  assert.doesNotMatch(sql, /CHECK\s*\(\s*(tier|category)\s+IN/i, "no seniority whitelist may survive the migration");
  db.exec("INSERT INTO participants (id,meeting_id,name,persona,agenda,category) VALUES ('nh','m1','The Whale','x','y','nonhuman')");
  // An arbitrary new category is accepted too — the whitelist is gone.
  db.exec("INSERT INTO participants (id,meeting_id,name,persona,agenda,category) VALUES ('w','m1','The Wizard','x','y','wizard')");
  // The row survived the rebuild, with its non-default column intact.
  assert.equal(db.prepare("SELECT session_version FROM participants WHERE id='old1'").get().session_version, 3);
  // The children did NOT cascade away — this is the failure the rebuild risks.
  assert.equal(db.prepare("SELECT count(*) c FROM contributions").get().c, 1);
  assert.equal(db.prepare("SELECT count(*) c FROM agent_errors").get().c, 1);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  // Indexes are dropped with the old table and must come back.
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='participants' AND name='idx_participants_meeting'").get());
});

test("migrations are a no-op on an up-to-date database", () => {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const before = db.prepare("SELECT sql FROM sqlite_master WHERE name='participants'").get().sql;
  runMigrations(db);
  assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='participants'").get().sql, before);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, LATEST_SCHEMA_VERSION);
});

test("the nonhuman category ships in the packaged personas directory", () => {
  const dir = join(root, "personas", "nonhuman");
  assert.ok(existsSync(dir), "personas/nonhuman must exist in the package");
  const files = nonhuman();
  assert.ok(files.length > 0);
  for (const p of files) assert.ok(p.version, `${p.name} should carry a version`);
});

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractVariants,
  discoverModels,
  assignModelsToParticipants,
  getDefaultModel,
  selectFallbackModel,
} from "../src/services/model-service.js";
import { parseFastPathModel } from "../src/config/utils.js";
import { initSchema, runMigrations, LATEST_SCHEMA_VERSION } from "../src/database/schema.js";

// Model variants (opencode reasoning-effort overlays, e.g. low/medium/high):
// discovery preserves the catalog list, assignment threads the selection,
// the server validates it, and v17 persists it. Unknown variants must never
// be forwarded blindly — upstream fails model resolution on those.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel) => readFileSync(join(root, rel), "utf8");

test("extractVariants reads both catalog shapes and nothing else", () => {
  assert.deepEqual(extractVariants({ variants: { high: {}, low: {} } }), ["high", "low"]);
  assert.deepEqual(extractVariants({ variants: [{ id: "max" }, { id: "low" }] }), ["max", "low"]);
  assert.deepEqual(extractVariants({ variants: ["low", "high", "low"] }), ["low", "high"]);
  assert.deepEqual(extractVariants({}), []);
  assert.deepEqual(extractVariants({ variants: null }), []);
  assert.deepEqual(extractVariants({ variants: [{ nope: true }, { id: "" }] }), []);
  assert.deepEqual(extractVariants(null), []);
});

test("discoverModels preserves variants and the session variant", async () => {
  const client = {
    session: {
      get: async () => ({ data: { model: { providerID: "anthropic", modelID: "claude", variant: "high" } } }),
    },
    provider: {
      list: async () => ({
        data: {
          providers: [
            {
              id: "openai",
              models: {
                "gpt-5.2": { id: "gpt-5.2", name: "GPT", status: "active", variants: { low: {}, high: {} } },
                "plain": { id: "plain", name: "Plain", status: "active" },
                "old": { id: "old", name: "Old", status: "deprecated", variants: { low: {} } },
              },
            },
          ],
          connected: [],
        },
      }),
    },
  };
  const { available, sessionModel } = await discoverModels(client, "/tmp", "s1");
  const byId = new Map(available.map((m) => [m.modelID, m]));
  assert.deepEqual(byId.get("gpt-5.2").variants, ["low", "high"]);
  assert.deepEqual(byId.get("plain").variants, []);
  assert.ok(!byId.has("old"), "deprecated models stay excluded");
  assert.deepEqual(sessionModel, { providerID: "anthropic", modelID: "claude", variant: "high" });
});

test("assignment preserves explicit variants and never invents them", () => {
  const available = [{ providerID: "p", modelID: "m", variants: ["low", "high"] }];
  // Object-form override keeps its variant.
  const [a] = assignModelsToParticipants(
    [{ id: "s1", model: { providerID: "p", modelID: "m", variant: "high" } }],
    available,
  );
  assert.equal(a.model.variant, "high");
  // String-form override supports the provider/model#variant reference.
  const [b] = assignModelsToParticipants([{ id: "s1", model_override: "p/m#low" }], available);
  assert.deepEqual(b.model, { providerID: "p", modelID: "m", variant: "low" });
  // Random draws carry no variant — the server default applies.
  const [c] = assignModelsToParticipants([{ id: "s1" }], available, null, () => 0);
  assert.ok(!("variant" in c.model), `random draw must not set a variant, got ${JSON.stringify(c.model)}`);
});

test("getDefaultModel carries the seat variant", () => {
  const d = getDefaultModel([{ model: { providerID: "p", modelID: "m", variant: "max" } }]);
  assert.deepEqual(d, { providerID: "p", modelID: "m", variant: "max" });
  assert.deepEqual(getDefaultModel([{ model: { providerID: "p", modelID: "m" } }]), { providerID: "p", modelID: "m" });
});

test("selectFallbackModel keeps the variant only when offered", () => {
  const breaker = { getHealthyModels: (ms) => ms };
  const pool = [
    { providerID: "p", modelID: "other", status: "active", limit: { context: 1000 }, variants: ["high"] },
    { providerID: "p", modelID: "plain", status: "active", limit: { context: 999999 }, variants: [] },
  ];
  // Quality sort picks "plain" (larger context) which offers no variants.
  const dropped = selectFallbackModel({ providerID: "p", modelID: "m", variant: "high" }, pool, breaker);
  assert.equal(dropped.modelID, "plain");
  assert.ok(!("variant" in dropped), "unknown variant on the fallback must be dropped, not forwarded");
  const kept = selectFallbackModel(
    { providerID: "p", modelID: "m", variant: "high" },
    [{ providerID: "p", modelID: "alt", status: "active", limit: { context: 1000 }, variants: ["high"] }],
    breaker,
  );
  assert.equal(kept.variant, "high");
});

test("parseFastPathModel accepts an optional #variant suffix", () => {
  assert.deepEqual(parseFastPathModel("anthropic/claude-haiku"), { providerID: "anthropic", modelID: "claude-haiku" });
  assert.deepEqual(parseFastPathModel("openai/gpt-5.2#high"), { providerID: "openai", modelID: "gpt-5.2", variant: "high" });
  assert.equal(parseFastPathModel("novariant"), null);
});

test("v17 persists seat and orchestrator variants; pre-v17 rows read as default", () => {
  assert.equal(LATEST_SCHEMA_VERSION, 17);
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(cols("participants").includes("model_variant"), "fresh participants carry model_variant");
  assert.ok(cols("meetings").includes("orchestrator_model_variant"), "fresh meetings carry orchestrator_model_variant");

  // A v16-shape DB gains the columns through the migration with no backfill.
  const old = new DatabaseSync(":memory:");
  old.exec(`CREATE TABLE participants (
    id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, name TEXT NOT NULL, persona TEXT NOT NULL,
    agenda TEXT NOT NULL, category TEXT NOT NULL, provider_id TEXT, model_id TEXT, session_id TEXT,
    session_version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'listening', reflection TEXT NOT NULL DEFAULT '',
    state_json TEXT NOT NULL DEFAULT '{}', known_biases TEXT, communication_style TEXT,
    preferred_contribution_types TEXT, anti_patterns TEXT, category_guidance TEXT,
    reflection_guidance TEXT, tags TEXT, expertise TEXT, UNIQUE(meeting_id, name));
    CREATE TABLE meetings (id TEXT PRIMARY KEY, question TEXT NOT NULL, context TEXT,
    status TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 0, fabric TEXT, max_rounds INTEGER NOT NULL,
    convergence TEXT NOT NULL, tags TEXT, parent_session_id TEXT, opencode_session_id TEXT,
    next_speaker_id TEXT, state_of_play TEXT, stats TEXT, embedding_model TEXT, embedding_dim INTEGER,
    reflecting_participants TEXT, querying_participants TEXT, evidence_participants TEXT,
    summoning_participants TEXT, semantic_degraded INTEGER NOT NULL DEFAULT 0,
    persistence_degraded INTEGER NOT NULL DEFAULT 0, orchestrator_provider_id TEXT,
    orchestrator_model_id TEXT, feature_toggles_json TEXT, orchestrator_config_json TEXT,
    rate_limit_state TEXT, settled_items TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    PRAGMA user_version = 16;`);
  assert.equal(runMigrations(old), LATEST_SCHEMA_VERSION);
  const migratedCols = (t) => old.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(migratedCols("participants").includes("model_variant"));
  assert.ok(migratedCols("meetings").includes("orchestrator_model_variant"));
  old.prepare("INSERT INTO participants (id, meeting_id, name, persona, agenda, category, provider_id, model_id) VALUES (?,?,?,?,?,?,?,?)")
    .run("s1", "m1", "Ada", "p", "a", "mid", "p", "m");
  assert.equal(old.prepare("SELECT model_variant FROM participants WHERE id = ?").get("s1").model_variant, null);
});

// The dashboard setup UI is JSX (no DOM in node:test), so its contract is
// asserted against the source — same pattern as room-selection-dialog.test.js.
test("SetupTab offers a variant picker beside each model picker", () => {
  const src = readSrc("src/dashboard/components/SetupTab.jsx");
  assert.ok(src.includes("loom-seat-variant-"), "per-seat variant select exists in the persona row");
  assert.ok(src.includes("loom-orchestrator-variant"), "orchestrator variant select exists");
  assert.ok(/variantsForKey\(s\.model\)\.length > 0/.test(src), "seat picker only renders when the model offers variants");
  assert.ok(/variantsForKey\(orchestrator\.model\)\.length > 0/.test(src), "orchestrator picker only renders when the model offers variants");
  assert.ok(src.includes("{ ...x, model: v, variant: null }"), "changing the seat model resets its variant");
  assert.ok(src.includes("variant: v === \"default\" ? null : v"), "selecting Default clears the variant (server default)");
  assert.ok(src.includes("if (variant) ref.variant = variant"), "seat variants are posted to /api/meetings/start");
  assert.ok(src.includes("if (orchestrator.variant) ref.variant = orchestrator.variant"), "the orchestrator variant is posted");
});

test("server exposes variants and validates selections", () => {
  const src = readSrc("src/dashboard/server/control.js");
  assert.ok(src.includes("variants: Array.isArray(m.variants) ? [...m.variants] : []"), "/api/llm-models exposes variant lists");
  assert.ok(src.includes('unknown variant'), "unknown orchestrator variants are rejected");
  assert.ok(src.includes("dashboard_seat_variant_unknown"), "unknown seat variants fall back with a warning");
  assert.ok(src.includes("storedVariantFor"), "resume/extend revalidate stored variants against the catalog");
});

test("session prompts forward the variant as a separate field", () => {
  const src = readSrc("src/session-contract.js");
  assert.ok(src.includes('{ variant: model.variant }'), "variant rides alongside model, upstream-style");
});

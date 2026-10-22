import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initSchema } from "../src/database/schema.js";
import { seedSubProblemsTopic } from "../src/database/forum-operations.js";
import { ensureParticipantRow } from "../src/database/contribution-operations.js";
import { isProviderUnavailableError, classifyProviderUnavailableError, isRetryableError, isInputRejectionError } from "../src/utils/retry.js";

// ---------------------------------------------------------------------------
// P1 — a provider outage is its own class.
//
// It was unclassified, and the cost was measured in a live meeting: a 402
// "Endpoint is unavailable" matched no branch of isRetryableError, so the
// failure never counted against the circuit breaker, the synthesis-recovery
// path kept re-prompting the same dead endpoint, and the retry loop did it
// again — six dead calls at ~80s each before the fallback model was reached.
test("a provider outage is classified, and is not retryable on the same model", () => {
  const outage = Object.assign(new Error("Upstream request failed: Endpoint is unavailable."), {
    status: 402,
    providerError: "APIError",
  });
  assert.equal(classifyProviderUnavailableError(outage)?.type, "provider_unavailable");
  assert.ok(isProviderUnavailableError(outage));
  // The generic retry helper must not hammer a dead endpoint.
  assert.equal(isRetryableError(outage), false);
});

test("a transient 5xx stays retryable and is NOT a provider outage", () => {
  const fivexx = Object.assign(new Error("upstream error"), { status: 503 });
  // A 5xx is per-request flakiness: the existing backoff handles it.
  assert.equal(isRetryableError(fivexx), true);
  assert.equal(isProviderUnavailableError(fivexx), false);
});

test("a bare 402 billing refusal is not a provider outage", () => {
  const billing = Object.assign(new Error("payment required"), { status: 402 });
  // The input-rejection classifier owns billing; claiming it as an outage
  // would route around a limit that a different model also hits.
  assert.equal(isProviderUnavailableError(billing), false);
  assert.ok(isInputRejectionError(billing));
});

test("a model that no longer exists is a provider outage", () => {
  const gone = Object.assign(new Error("model 'x' is not available"), { status: 404 });
  assert.ok(isProviderUnavailableError(gone));
});

// ---------------------------------------------------------------------------
// P2 — a cancelled meeting makes no further calls.
//
// The catch path used to treat an abort like any other failure: a loom result
// had been persisted for the batch, so it ran the synthesis-recovery prompt —
// a 34,056-char prompt issued 240ms after "Loom cancelled by user".
test("an aborted turn is recognised as an abort, not a failure", () => {
  const aborted = Object.assign(new Error("Aborted"), { name: "AbortError" });
  assert.ok(/abort/i.test(aborted.message));
  // A provider failure is NOT an abort: it must still reach the fallback.
  const outage = Object.assign(new Error("Upstream request failed: Endpoint is unavailable."), { status: 402 });
  assert.doesNotMatch(outage.message, /abort/i);
});

// ---------------------------------------------------------------------------
// P3 — the forum's starter topic, and the orchestrator's isolation.
//
// forum_topics.author_id REFERENCES participants(id), so the seed needs an
// author row. An earlier version satisfied the FK by creating a participant row
// for a synthetic author "orchestrator" — which put a phantom seat into the
// participants table, and the dashboard's participant list did not filter the
// 'summoned' status, so the orchestrator appeared in the active participant
// list the moment a meeting started.
//
// The orchestrator is not a participant: it has its own area and is called
// last. The seed is authored by a real seat, and it never invents one.
test("the forum seed creates its topic without inventing a participant", () => {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  db.exec("PRAGMA foreign_keys = ON;");
  // The meeting and a real participant, as init() would have created them.
  db.prepare("INSERT INTO meetings (id, question, status, max_rounds, convergence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "m-1", "Should we ship?", "weaving", 4, "none", new Date().toISOString(), new Date().toISOString(),
  );
  db.prepare("INSERT INTO participants (id, meeting_id, name, persona, agenda, category, status) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "p-1", "m-1", "Ada", "persona", "agenda", "mid", "listening",
  );

  const before = db.prepare("SELECT id FROM participants ORDER BY id").all().map((r) => r.id);
  const seed = seedSubProblemsTopic(db, "m-1", "Should we ship?", { authorId: "p-1" });
  assert.ok(seed?.id, "the seed must create a topic");
  const row = db.prepare("SELECT id, title, author_id FROM forum_topics WHERE id = ?").get(seed.id);
  assert.ok(row, "the topic must be in the table");
  // The author is a REAL seat.
  assert.equal(row.author_id, "p-1");
  // And the participants table is untouched — no phantom orchestrator seat.
  const after = db.prepare("SELECT id FROM participants ORDER BY id").all().map((r) => r.id);
  assert.deepEqual(after, before, "the seed must not add a participant row");
  assert.ok(!after.includes("orchestrator"), "the orchestrator is not a participant");
  // A second call is a no-op (idempotent).
  assert.equal(seedSubProblemsTopic(db, "m-1", "Should we ship?", { authorId: "p-1" }), null);
});

test("the forum seed declines rather than inventing an author row", () => {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  db.exec("PRAGMA foreign_keys = ON;");
  db.prepare("INSERT INTO meetings (id, question, status, max_rounds, convergence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "m-3", "Should we ship?", "weaving", 4, "none", new Date().toISOString(), new Date().toISOString(),
  );
  // No author at all, and an author that has no seat row: both must decline
  // (degraded, not fatal) and leave the participants table alone.
  assert.equal(seedSubProblemsTopic(db, "m-3", "Should we ship?"), null);
  assert.equal(seedSubProblemsTopic(db, "m-3", "Should we ship?", { authorId: "nobody" }), null);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM participants").get().c, 0, "no participant row may be created");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM forum_topics").get().c, 0, "no topic without an author");
});

test("a non-seat participant row never appears in the participant list", () => {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  db.prepare("INSERT INTO meetings (id, question, status, max_rounds, convergence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "m-4", "Q", "weaving", 4, "none", new Date().toISOString(), new Date().toISOString(),
  );
  db.prepare("INSERT INTO participants (id, meeting_id, name, persona, agenda, category, status) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "p-1", "m-4", "Ada", "persona", "agenda", "mid", "listening",
  );
  // A summoned guest expert (and, before the fix, the system author) is NOT a
  // seat: the participant list must exclude it.
  db.prepare("INSERT INTO participants (id, meeting_id, name, persona, agenda, category, status) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "guest-1", "m-4", "Guest Expert", "persona", "agenda", "mid", "summoned",
  );
  // The dashboard's query (src/dashboard/api/queries.js) and the runtime
  // reader (getAllParticipantsWithStatus) both filter 'summoned'.
  const dashboard = db.prepare("SELECT id FROM participants WHERE status != 'summoned' ORDER BY category ASC").all().map((r) => r.id);
  assert.deepEqual(dashboard, ["p-1"]);
  const runtime = db.prepare("SELECT id FROM participants WHERE meeting_id = ? AND status != 'summoned'").all("m-4").map((r) => r.id);
  assert.deepEqual(runtime, ["p-1"]);
});

test("the participant-row helper is idempotent", () => {
  const db = new DatabaseSync(":memory:");
  initSchema(db);
  db.prepare("INSERT INTO meetings (id, question, status, max_rounds, convergence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "m-2", "Q", "weaving", 4, "none", new Date().toISOString(), new Date().toISOString(),
  );
  assert.equal(ensureParticipantRow(db, "m-2", "orchestrator", "Orchestrator", "mid"), true);
  assert.equal(ensureParticipantRow(db, "m-2", "orchestrator", "Orchestrator", "mid"), false);
});

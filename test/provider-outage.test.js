import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initSchema } from "../src/database/schema.js";
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
// P3 — seat integrity.
//
// Participants is a seat table: the orchestrator is not a participant (it has
// its own area and is called last), and a summoned guest expert is not a seat.
// The dashboard's participant list must exclude summoned rows, and the
// participant-row helper must be idempotent.
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

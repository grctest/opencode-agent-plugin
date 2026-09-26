import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  setDatabaseClass,
  openReadonlyDatabase,
  withReadonlyDb,
  isReadonlyError,
} from "../src/database/connection.js";
import { sweepRecoveryLitter } from "../src/database/maintenance.js";
import { MeetingExtender } from "../src/services/meeting-extender.js";
import * as synthesis from "../src/orchestrator/synthesis.js";

// bun:sqlite is unavailable under `node --test`, so install a fake Database
// class that models the one behavior recovery depends on: a readonly open
// succeeds lazily and the FIRST read fails while a dirty WAL sidecar exists
// and no writable checkpoint has cleared it.
class FakeDb {
  constructor(path, opts = {}) {
    this.path = path;
    this.opts = opts;
    this.closed = false;
    if (String(path).includes("immutable=1")) {
      this.mode = "immutable";
    } else {
      this.mode = opts.readonly ? "readonly" : "writable";
    }
    if (FakeDb.throwOnOpen) throw new Error("database disk image is malformed");
  }
  exec(sql) {
    if (String(sql).includes("wal_checkpoint") && !FakeDb.skipCheckpoint) {
      FakeDb.checkpointed.add(this.path);
    }
    return {};
  }
  prepare() {
    const self = this;
    return {
      get() {
        if (self.mode === "immutable") {
          if (FakeDb.failImmutable) throw new Error("cannot open immutable");
          return { name: "meetings" };
        }
        if (
          self.mode === "readonly" &&
          !FakeDb.checkpointed.has(self.path) &&
          existsSync(`${self.path}-wal`)
        ) {
          throw new Error("attempt to write a readonly database");
        }
        return { name: "meetings" };
      },
    };
  }
  close() {
    this.closed = true;
  }
}
FakeDb.checkpointed = new Set();
FakeDb.skipCheckpoint = false;
FakeDb.failImmutable = false;
FakeDb.throwOnOpen = false;

function resetFakes() {
  FakeDb.checkpointed = new Set();
  FakeDb.skipCheckpoint = false;
  FakeDb.failImmutable = false;
  FakeDb.throwOnOpen = false;
}

function makeMeetingDir() {
  const dir = join(tmpdir(), `loom-recovery-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function aged(dirPath, name) {
  const p = join(dirPath, name);
  writeFileSync(p, "x");
  const t = new Date(Date.now() - 2 * 3600_000);
  utimesSync(p, t, t);
  return p;
}

test("sweepRecoveryLitter removes crash-orphaned tmps but keeps live files", () => {
  resetFakes();
  setDatabaseClass(FakeDb);
  const dir = makeMeetingDir();
  const base = join(dir, ".opencode", "loom");
  mkdirSync(join(base, "meetings"), { recursive: true });

  const agedBase = aged(base, "session-index.json.tmp");
  const agedReport = aged(join(base, "meetings"), "m.md.tmp.1.aa");
  const agedFilter = aged(base, "models-filter.json.tmp.1");
  const preview = join(tmpdir(), `loom-preview-${randomUUID()}.db`);
  writeFileSync(preview, "x");
  const pt = new Date(Date.now() - 2 * 3600_000);
  utimesSync(preview, pt, pt);

  const freshTmp = join(base, "meetings", "fresh.md.tmp.1");
  writeFileSync(freshTmp, "x");
  const realDb = join(base, "meetings", "m.db");
  writeFileSync(realDb, "x");
  const realMd = join(base, "meetings", "m.md");
  writeFileSync(realMd, "x");

  const swept = sweepRecoveryLitter(dir);

  assert.equal(swept, 4);
  assert.ok(!existsSync(agedBase), "aged session-index tmp swept");
  assert.ok(!existsSync(agedReport), "aged report rename tmp swept");
  assert.ok(!existsSync(agedFilter), "aged filter tmp swept");
  assert.ok(!existsSync(preview), "killed preview DB swept");
  assert.ok(existsSync(freshTmp), "fresh tmp kept (may belong to a live writer)");
  assert.ok(existsSync(realDb), "meeting DB never touched");
  assert.ok(existsSync(realMd), "report never touched");
  rmSync(dir, { recursive: true, force: true });
});

test("openReadonlyDatabase reads a clean database with no recovery", () => {
  resetFakes();
  setDatabaseClass(FakeDb);
  const dbPath = join(makeMeetingDir(), "clean.db");
  writeFileSync(dbPath, "sqlite");
  const out = openReadonlyDatabase(dbPath);
  assert.equal(out.recovered, false);
  assert.equal(out.degraded, undefined);
  assert.ok(out.db);
});

test("openReadonlyDatabase checkpoints a dirty WAL left by a force close", () => {
  resetFakes();
  setDatabaseClass(FakeDb);
  const dbPath = join(makeMeetingDir(), "dirty.db");
  writeFileSync(dbPath, "sqlite");
  writeFileSync(`${dbPath}-wal`, "uncheckpointed");
  const out = openReadonlyDatabase(dbPath);
  assert.equal(out.recovered, true, "checkpoint ran and readonly open succeeded on retry");
  assert.equal(out.degraded, undefined);
  assert.ok(FakeDb.checkpointed.has(dbPath));
});

test("openReadonlyDatabase falls back to the immutable image when the WAL cannot be checkpointed", () => {
  resetFakes();
  setDatabaseClass(FakeDb);
  FakeDb.skipCheckpoint = true; // writable checkpoint cannot clear the WAL
  const dbPath = join(makeMeetingDir(), "stuck.db");
  writeFileSync(dbPath, "sqlite");
  writeFileSync(`${dbPath}-wal`, "unrecoverable");
  const out = openReadonlyDatabase(dbPath);
  assert.equal(out.recovered, true);
  assert.equal(out.degraded, "immutable");
});

test("openReadonlyDatabase falls back to a tmp copy when the immutable open fails", () => {
  resetFakes();
  setDatabaseClass(FakeDb);
  FakeDb.skipCheckpoint = true;
  FakeDb.failImmutable = true;
  const dbPath = join(makeMeetingDir(), "stuck2.db");
  writeFileSync(dbPath, "sqlite");
  writeFileSync(`${dbPath}-wal`, "unrecoverable");
  const out = openReadonlyDatabase(dbPath);
  assert.equal(out.degraded, "copy");
  assert.ok(out.db.closed === false || typeof out.db.close === "function");
});

test("openReadonlyDatabase rethrows non-recovery errors untouched", () => {
  resetFakes();
  setDatabaseClass(FakeDb);
  FakeDb.throwOnOpen = true;
  const dbPath = join(makeMeetingDir(), "corrupt.db");
  writeFileSync(dbPath, "sqlite");
  assert.throws(() => openReadonlyDatabase(dbPath), /malformed/);
});

test("withReadonlyDb advances the ladder when the query itself hits WAL recovery", () => {
  resetFakes();
  setDatabaseClass(FakeDb);
  const dbPath = join(makeMeetingDir(), "query-fail.db");
  writeFileSync(dbPath, "sqlite");
  writeFileSync(`${dbPath}-wal`, "late wal");
  // First open succeeds; the query fails readonly — models a WAL appearing
  // between open and query.
  FakeDb.checkpointed.add(dbPath);
  let calls = 0;
  const out = withReadonlyDb(dbPath, () => {
    calls++;
    if (calls === 1) throw new Error("attempt to write a readonly database");
    return "row";
  });
  assert.equal(out.result, "row");
  assert.equal(out.recovered, true);
  assert.equal(calls, 2);
});

test("withReadonlyDb rethrows non-readonly query errors without recovery", () => {
  resetFakes();
  setDatabaseClass(FakeDb);
  const dbPath = join(makeMeetingDir(), "query-corrupt.db");
  writeFileSync(dbPath, "sqlite");
  FakeDb.checkpointed.add(dbPath);
  assert.throws(
    () => withReadonlyDb(dbPath, () => { throw new Error("database disk image is malformed"); }),
    /malformed/,
  );
  assert.ok(!FakeDb.checkpointed.has(`${dbPath}-copy`), "no copy attempt for non-readonly errors");
});

test("isReadonlyError matches recovery errors only", () => {
  assert.ok(isReadonlyError(new Error("attempt to write a readonly database")));
  assert.ok(isReadonlyError(new Error("SQLITE_READONLY: attempt to write a readonly database")));
  assert.ok(!isReadonlyError(new Error("SQLITE_BUSY: database is locked")));
  assert.ok(!isReadonlyError(new Error("database disk image is malformed")));
});

function makeExtenderDb(initialFabric) {
  const calls = [];
  return {
    calls,
    _fabric: initialFabric,
    getFabric() { return this._fabric; },
    setFabric(f) { calls.push("setFabric"); this._fabric = f; },
    setRound(r) { calls.push("setRound"); },
    setMaxRounds(n) { calls.push("setMaxRounds"); },
    clearAgentErrors() { calls.push("clearAgentErrors"); },
    setParticipantStatus() { calls.push("setParticipantStatus"); },
    transaction(fn) { return fn(); },
  };
}

function makeExtenderState() {
  return {
    getMaxRounds: () => 4,
    setMaxRounds: () => {},
    getFabric: () => "",
    setFabric: () => {},
    forceTransitionTo: () => {},
    setParticipantStatus: () => {},
    getParticipants: () => [{ config: { id: "a" } }],
    getContext: () => "",
    setContext: () => {},
    getCurrentRound: () => 2,
  };
}

test("MeetingExtender is idempotent when a killed extend is retried with the same prompt", async () => {
  const db = makeExtenderDb("Should we migrate?");
  const sm = makeExtenderState();
  const sess = { postProgress: async () => {} };
  const ext = new MeetingExtender();

  await ext.extend({ database: db, stateManager: sm, sessionManager: sess, newPrompt: "Go deeper" });
  assert.ok(db.calls.includes("setFabric"), "first extend appends fabric");
  assert.ok(db.calls.includes("setMaxRounds"), "first extend bumps max_rounds");
  assert.ok(db._fabric.endsWith("**User Input:** Go deeper"));

  const firstCallCount = db.calls.length;
  await ext.extend({ database: db, stateManager: sm, sessionManager: sess, newPrompt: "Go deeper" });
  const newCalls = db.calls.slice(firstCallCount);
  assert.ok(!newCalls.includes("setFabric"), "retry with same prompt does not append fabric twice");
  assert.ok(!newCalls.includes("setMaxRounds"), "retry with same prompt does not bump max_rounds twice");
  assert.ok(newCalls.includes("setParticipantStatus"), "retry still revives participants for the new loop");
});

test("MeetingExtender still applies a genuinely different prompt", async () => {
  const db = makeExtenderDb("Should we migrate?\n\n**User Input:** Go deeper");
  const sm = makeExtenderState();
  const sess = { postProgress: async () => {} };
  const ext = new MeetingExtender();

  await ext.extend({ database: db, stateManager: sm, sessionManager: sess, newPrompt: "Different angle" });
  assert.ok(db.calls.includes("setFabric"));
  assert.ok(db._fabric.endsWith("**User Input:** Different angle"));
});

test("finishSynthesis re-applies the original terminal status after synthesizing", async () => {
  const persisted = [];
  let status = "weaving";
  const ctx = {
    _synthesize: async () => "OUTPUT",
    _persistState: async () => { persisted.push(status); },
    _stateManager: {
      getStatus: () => status,
      transitionTo: (s) => { status = s; },
    },
    _logger: { warn: () => {} },
  };
  const out = await synthesis.finishSynthesis.call(ctx, "converged");
  assert.equal(out, "OUTPUT");
  assert.equal(status, "converged", "terminal status restored after synthesis");
  assert.deepEqual(persisted, ["converged"], "terminal status re-persisted");
});

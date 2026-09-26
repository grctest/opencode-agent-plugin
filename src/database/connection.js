import { existsSync, copyFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { resolveOpencodeConfigDir } from "../paths.js";

const VEC_CANDIDATE_PKGS = [
  'sqlite-vec-linux-x64',
  'sqlite-vec-linux-arm64',
  'sqlite-vec-darwin-arm64',
  'sqlite-vec-darwin-x64',
  'sqlite-vec-win32-x64',
];
const VEC_EXTS = ['vec0.so', 'vec0.dylib', 'vec0.node'];
let cachedVecPath = null;
let vecPathResolved = false;

export function invalidateVecPathCache() {
  vecPathResolved = false;
  cachedVecPath = null;
}

let _vecPathCacheTime = 0;
const VEC_CACHE_TTL_MS = 60_000;

export function resolveVecPath() {
  if (vecPathResolved) {
    const now = Date.now();
    const stale = now - _vecPathCacheTime > VEC_CACHE_TTL_MS;
    if (cachedVecPath && existsSync(cachedVecPath)) return cachedVecPath;
    if (cachedVecPath && !existsSync(cachedVecPath)) {
      vecPathResolved = false;
      cachedVecPath = null;
    } else if (vecPathResolved && !stale) {
      return cachedVecPath;
    } else if (stale) {
      // TTL expired — re-scan even on cached miss
      vecPathResolved = false;
      cachedVecPath = null;
    }
  }
  vecPathResolved = true;
  _vecPathCacheTime = Date.now();
  const baseDir = (import.meta.dir ?? import.meta.dirname ?? '.');
  const roots = [
    join(baseDir, 'deps', 'node_modules'),
    join(baseDir, '../deps', 'node_modules'),
    join(baseDir, 'node_modules'),
    join(baseDir, '../node_modules'),
    join(baseDir, '../../node_modules'),
  ];
  try {
    const configDir = resolveOpencodeConfigDir();
    roots.push(join(configDir, 'plugins', 'deps', 'node_modules'));
    roots.push(join(configDir, 'loom', 'deps', 'node_modules'));
  } catch {}
  for (const root of roots) {
    for (const pkg of VEC_CANDIDATE_PKGS) {
      for (const ext of VEC_EXTS) {
        const p = join(root, pkg, ext);
        if (existsSync(p)) {
          cachedVecPath = p;
          return cachedVecPath;
        }
      }
    }
  }
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve('sqlite-vec-linux-x64/package.json');
    const dir = dirname(pkgPath);
    for (const ext of VEC_EXTS) {
      const p = join(dir, ext);
      if (existsSync(p)) {
        cachedVecPath = p;
        return cachedVecPath;
      }
    }
  } catch {}
  return null;
}

let DatabaseClass = null;
let dbReady = null;

export function getDatabaseClass() {
  return DatabaseClass;
}

export function setDatabaseClass(cls) {
  DatabaseClass = cls;
}

export function ensureDb() {
  if (DatabaseClass) return Promise.resolve();
  if (dbReady) return dbReady;
  dbReady = (async () => {
    const mod = await import("bun:sqlite");
    DatabaseClass = mod.Database;
  })();
  // Reset on rejection so future callers can retry (e.g., binary missing transiently)
  dbReady.catch(() => { dbReady = null; });
  return dbReady;
}

export function safeParseJsonArray(value) {
  if (!value) return undefined;
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function isoNow() {
  return new Date().toISOString();
}

/**
 * True for WSL DrvFs mounts (/mnt/c, /mnt/d, …) where chmod semantics are
 * emulated and SQLite file locking behaves differently from native ext4.
 * Callers skip POSIX permission hardening there — chmod is a no-op at best
 * and can make files inaccessible at worst.
 */
export function isDrvFsPath(p) {
  return typeof p === "string" && (p.startsWith("/mnt/") || p === "/mnt");
}

function isReadonlyWalError(err) {
  const msg = String(err?.message ?? err ?? "");
  return /attempt to write a readonly database|readonly/i.test(msg);
}

export function isReadonlyError(err) {
  return isReadonlyWalError(err);
}

function probeReadonlyDb(db) {
  // bun:sqlite defers WAL recovery until the first read — a bare
  // `new Database(path, {readonly:true})` can succeed and then throw
  // SQLITE_READONLY on the first SELECT. Probe here so recovery runs
  // inside openReadonlyDatabase instead of leaking to callers.
  db.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
}

function tryCheckpointDb(dbPath) {
  // Single writable recovery attempt: checkpoint an uncheckpointed WAL
  // left behind by a force-closed server, then close immediately.
  // Returns true when the writable open + checkpoint succeeded.
  const Cls = getDatabaseClass();
  if (!Cls) return false;
  let writer = null;
  try {
    writer = new Cls(dbPath);
    try { writer.exec("PRAGMA busy_timeout = 2000"); } catch {}
    try { writer.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
    return true;
  } catch {
    return false;
  } finally {
    try { writer?.close(); } catch {}
  }
}

/**
 * Open a plain readonly handle. bun:sqlite defers WAL recovery until the
 * first read — a bare `new Database(path, {readonly:true})` can succeed and
 * then throw SQLITE_READONLY on the first SELECT — so the probe makes
 * recovery failures surface at open instead of leaking to the caller's query.
 */
function openPlainReadonly(dbPath) {
  const Cls = getDatabaseClass();
  if (!Cls) throw new Error("Database class not initialized — call ensureDb() first");
  const db = new Cls(dbPath, { readonly: true });
  try { db.exec("PRAGMA busy_timeout = 5000"); } catch {}
  probeReadonlyDb(db);
  return db;
}

/**
 * Last-resort open for a WAL that cannot be checkpointed (read-only volume,
 * foreign lock, corrupt WAL): `immutable=1` reads the main image without WAL
 * recovery; if that fails, read a copy (no sidecars alongside it). Serves the
 * LAST CHECKPOINTED state — committed-but-uncheckpointed rows are lost, which
 * callers must flag as `degraded` and never build recovery decisions on.
 */
function openDegradedReadonly(dbPath) {
  const Cls = getDatabaseClass();
  if (!Cls) throw new Error("Database class not initialized — call ensureDb() first");
  try {
    const db = new Cls(`file:${dbPath}?immutable=1`, { readonly: true });
    try { db.exec("PRAGMA busy_timeout = 5000"); } catch {}
    probeReadonlyDb(db);
    return { db, degraded: "immutable" };
  } catch {}
  try {
    mkdirSync(join(tmpdir(), "loom-ro"), { recursive: true });
    const tmpPath = join(tmpdir(), "loom-ro", `ro-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
    copyFileSync(dbPath, tmpPath);
    const db = new Cls(tmpPath, { readonly: true });
    try { db.exec("PRAGMA busy_timeout = 5000"); } catch {}
    probeReadonlyDb(db);
    try { unlinkSync(tmpPath); } catch {}
    return { db, degraded: "copy" };
  } catch (err) {
    err.isRecoveryAttempt = true;
    throw err;
  }
}

/**
 * The ordered ways to open a database readonly. A strategy advances only on
 * a WAL-recovery error — BUSY/LOCKED and corruption propagate immediately —
 * and the final (degraded) strategy is terminal: its failure is flagged and
 * rethrown so callers keep their skip-and-retry behavior.
 */
function buildReadonlyOpenStrategies(dbPath) {
  return [
    { name: "readonly", open: () => ({ db: openPlainReadonly(dbPath) }) },
    { name: "checkpoint", open: () => { tryCheckpointDb(dbPath); return { db: openPlainReadonly(dbPath) }; } },
    { name: "degraded", open: () => openDegradedReadonly(dbPath) },
  ];
}

function openStrategies(dbPath) {
  let sawRecoveryFailure = false;
  for (const strategy of buildReadonlyOpenStrategies(dbPath)) {
    let opened;
    try {
      opened = strategy.open();
    } catch (err) {
      if (!isReadonlyWalError(err)) {
        if (sawRecoveryFailure) err.isRecoveryAttempt = true;
        throw err;
      }
      if (strategy.name === "degraded") {
        err.isRecoveryAttempt = true;
        throw err;
      }
      sawRecoveryFailure = true;
      continue;
    }
    return {
      db: opened.db,
      recovered: sawRecoveryFailure,
      ...(opened.degraded ? { degraded: opened.degraded } : {}),
    };
  }
  throw new Error("openStrategies: exhausted readonly open strategies without a result");
}

/**
 * Open a SQLite database in readonly mode, tolerating WAL recovery state.
 *
 * Background: a WAL-mode DB with an uncheckpointed WAL (force-closed server,
 * crashed writer, DrvFs mount) requires a write to recover on open — see
 * buildReadonlyOpenStrategies for the ordered recovery ladder.
 *
 * Returns `{ db, recovered, degraded? }` where `recovered` means at least
 * one recovery strategy ran and `degraded` marks the last-resort open.
 */
export function openReadonlyDatabase(dbPath) {
  return openStrategies(dbPath);
}

/**
 * Run a read callback against a readonly handle with the same recovery
 * ladder. Covers the case where the open probes fine but a later `prepare`
 * still hits SQLITE_READONLY (e.g. a WAL appeared between open and query).
 * Always closes the handle. Returns `{ result, recovered, degraded? }`.
 */
export function withReadonlyDb(dbPath, fn) {
  let sawRecoveryFailure = false;
  for (const strategy of buildReadonlyOpenStrategies(dbPath)) {
    let opened;
    try {
      opened = strategy.open();
    } catch (err) {
      if (!isReadonlyWalError(err)) {
        if (sawRecoveryFailure) err.isRecoveryAttempt = true;
        throw err;
      }
      if (strategy.name === "degraded") {
        err.isRecoveryAttempt = true;
        throw err;
      }
      sawRecoveryFailure = true;
      continue;
    }
    const db = opened.db;
    try {
      const result = fn(db);
      const out = { result, recovered: sawRecoveryFailure };
      if (opened.degraded) out.degraded = opened.degraded;
      try { db.close(); } catch {}
      return out;
    } catch (err) {
      try { db.close(); } catch {}
      if (!isReadonlyWalError(err)) {
        if (sawRecoveryFailure) err.isRecoveryAttempt = true;
        throw err;
      }
      if (strategy.name === "degraded") {
        err.isRecoveryAttempt = true;
        throw err;
      }
      sawRecoveryFailure = true;
    }
  }
  throw new Error("withReadonlyDb: exhausted readonly open strategies without a result");
}

/**
 * Best-effort writable WAL checkpoint used at dashboard startup / repair.
 * Returns true when the DB could be opened for writing and checkpointed.
 */
export function repairDatabase(dbPath) {
  try {
    if (!existsSync(dbPath)) return false;
  } catch { return false; }
  const Cls = getDatabaseClass();
  if (!Cls) return false;
  let writer = null;
  try {
    writer = new Cls(dbPath);
    try { writer.exec("PRAGMA busy_timeout = 2000"); } catch {}
    try { writer.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
    try { probeReadonlyDb(writer); } catch {}
    return true;
  } catch {
    return false;
  } finally {
    try { writer?.close(); } catch {}
  }
}

export { VEC_CANDIDATE_PKGS };

import { existsSync, copyFileSync, mkdirSync } from "node:fs";
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

function tryImmutableOpen(dbPath) {
  // Last resort for a WAL that cannot be checkpointed (read-only FS,
  // DrvFs lock, corrupt WAL): open the main image without WAL recovery
  // so the last checkpointed state is still readable instead of the
  // meeting vanishing from the dashboard.
  const Cls = getDatabaseClass();
  if (!Cls) throw new Error("Database class not initialized — call ensureDb() first");
  // SQLite URI immutable=1 skips WAL recovery entirely.
  try {
    const db = new Cls(`file:${dbPath}?immutable=1`, { readonly: true });
    try { db.exec("PRAGMA busy_timeout = 5000"); } catch {}
    probeReadonlyDb(db);
    return { db, recovered: true, degraded: "immutable" };
  } catch {}
  // Fallback: copy the main image to tmp and read the copy (no -wal/-shm
  // alongside it, so no recovery is attempted). WAL-only tail is lost,
  // but committed history renders.
  try {
    mkdirSync(join(tmpdir(), "loom-ro"), { recursive: true });
    const tmpPath = join(tmpdir(), "loom-ro", `ro-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`);
    copyFileSync(dbPath, tmpPath);
    const db = new Cls(tmpPath, { readonly: true });
    try { db.exec("PRAGMA busy_timeout = 5000"); } catch {}
    probeReadonlyDb(db);
    return { db, recovered: true, degraded: "copy" };
  } catch (err) {
    err.isRecoveryAttempt = true;
    throw err;
  }
}

/**
 * Open a SQLite database in readonly mode, tolerating WAL recovery state.
 *
 * Background: a WAL-mode DB with an uncheckpointed WAL (force-closed server,
 * crashed writer, DrvFs mount) requires a write to recover on open. A pure
 * `readonly:true` open then fails with `SQLITE_READONLY: attempt to write a
 * readonly database` even for SELECTs — and bun:sqlite defers that failure
 * until the first read, so we probe inside this function.
 *
 * Strategy: readonly open + probe. On a readonly-recovery error only, run a
 * single writable `wal_checkpoint(TRUNCATE)` and retry readonly once. When
 * the checkpoint itself cannot run, fall back to an immutable / copy open of
 * the last checkpointed image so history still renders. BUSY / LOCKED errors
 * are rethrown untouched so callers keep their existing non-blocking
 * skip-and-retry behavior.
 *
 * Returns `{ db, recovered, degraded? }`. Throws on failure; `isRecoveryAttempt`
 * distinguishes unrecoverable readonly errors for distinct log codes.
 */
export function openReadonlyDatabase(dbPath, { checkpointOnReadonly = true } = {}) {
  const DatabaseClass = getDatabaseClass();
  if (!DatabaseClass) throw new Error("Database class not initialized — call ensureDb() first");
  const openProbe = () => {
    const db = new DatabaseClass(dbPath, { readonly: true });
    try { db.exec("PRAGMA busy_timeout = 5000"); } catch {}
    probeReadonlyDb(db);
    return db;
  };
  try {
    return { db: openProbe(), recovered: false };
  } catch (err) {
    if (!checkpointOnReadonly || !isReadonlyWalError(err)) throw err;
    const checkpointed = tryCheckpointDb(dbPath);
    void checkpointed;
    try {
      return { db: openProbe(), recovered: true };
    } catch (retryErr) {
      if (!isReadonlyWalError(retryErr)) {
        retryErr.isRecoveryAttempt = true;
        throw retryErr;
      }
      // Writable checkpoint didn't help (read-only FS / DrvFs lock /
      // corrupt WAL) — serve the last checkpointed image instead of
      // dropping the meeting from the dashboard.
      try {
        return tryImmutableOpen(dbPath);
      } catch (fallbackErr) {
        fallbackErr.isRecoveryAttempt = true;
        throw fallbackErr;
      }
    }
  }
}

/**
 * Run a read callback against a readonly handle with WAL-recovery retry.
 * Covers the case where `open` probes fine but a later `prepare` still hits
 * SQLITE_READONLY (e.g. WAL appeared between open and query). Retries once
 * after a writable checkpoint, then via the immutable/copy fallback.
 * Always closes the handle. Returns `{ result, recovered, degraded? }`.
 */
export function withReadonlyDb(dbPath, fn, { checkpointOnReadonly = true } = {}) {
  const opened = openReadonlyDatabase(dbPath, { checkpointOnReadonly });
  let db = opened.db;
  const close = () => { try { db?.close(); } catch {} db = null; };
  try {
    const result = fn(db);
    const out = { result, recovered: opened.recovered };
    if (opened.degraded) out.degraded = opened.degraded;
    close();
    return out;
  } catch (err) {
    close();
    if (!checkpointOnReadonly || !isReadonlyWalError(err)) throw err;
    tryCheckpointDb(dbPath);
    let retry = null;
    try {
      retry = openReadonlyDatabase(dbPath, { checkpointOnReadonly: false });
    } catch {
      const fb = tryImmutableOpen(dbPath);
      try {
        const result = fn(fb.db);
        try { fb.db?.close(); } catch {}
        return { result, recovered: true, degraded: fb.degraded };
      } catch (fnErr) {
        try { fb.db?.close(); } catch {}
        fnErr.isRecoveryAttempt = true;
        throw fnErr;
      }
    }
    try {
      const result = fn(retry.db);
      const out = { result, recovered: true };
      if (retry.degraded) out.degraded = retry.degraded;
      try { retry.db?.close(); } catch {}
      return out;
    } catch (retryErr) {
      try { retry.db?.close(); } catch {}
      if (!isReadonlyWalError(retryErr)) {
        retryErr.isRecoveryAttempt = true;
        throw retryErr;
      }
      const fb = tryImmutableOpen(dbPath);
      try {
        const result = fn(fb.db);
        try { fb.db?.close(); } catch {}
        return { result, recovered: true, degraded: fb.degraded };
      } catch (fnErr) {
        try { fb.db?.close(); } catch {}
        fnErr.isRecoveryAttempt = true;
        throw fnErr;
      }
    }
  }
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

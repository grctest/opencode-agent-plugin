import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

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

export function resolveVecPath() {
  if (vecPathResolved) {
    if (cachedVecPath && existsSync(cachedVecPath)) return cachedVecPath;
    if (cachedVecPath && !existsSync(cachedVecPath)) {
      vecPathResolved = false;
      cachedVecPath = null;
    } else if (vecPathResolved) {
      return cachedVecPath;
    }
  }
  vecPathResolved = true;
  const baseDir = (import.meta.dir ?? import.meta.dirname ?? '.');
  const roots = [
    join(baseDir, 'deps', 'node_modules'),
    join(baseDir, '../deps', 'node_modules'),
    join(baseDir, 'node_modules'),
    join(baseDir, '../node_modules'),
    join(baseDir, '../../node_modules'),
  ];
  try {
    const home = homedir();
    roots.push(join(home, '.config', 'opencode', 'plugins', 'deps', 'node_modules'));
    roots.push(join(home, '.config', 'opencode', 'loom', 'deps', 'node_modules'));
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

export { VEC_CANDIDATE_PKGS };

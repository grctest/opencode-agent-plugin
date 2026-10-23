import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The composition-root forwarder invariant.
//
// History: `_collectForumTopics` was defined and called (`this._collectForumTopics()`)
// inside src/orchestrator/synthesis.js but its forwarder was never wired onto
// MeetingOrchestrator in src/orchestrator.js — so every meeting crashed at the
// final synthesis step with `TypeError: this._collectForumTopics is not a
// function`, exactly the "confirmed, deployed" failure mode.
//
// The event handlers live on the MeetingOrchestrator instance; the helper
// modules in src/orchestrator/*.js are plain functions whose `this` is that
// instance. So ANY `this._x(...)` inside a helper module must resolve to a
// method on the class in src/orchestrator.js — a forwarder. These tests make
// a missing forwarder a test failure instead of a production crash.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

// ---- class body of MeetingOrchestrator -------------------------------------

const COMP = fs.readFileSync(path.join(SRC, "orchestrator.js"), "utf8");
const compLines = COMP.split("\n");
const classStart = compLines.findIndex((l) => /class\s+\w+\s*(\{|extends)/.test(l));
assert.ok(classStart >= 0, "src/orchestrator.js must declare a class");
const classBody = compLines.slice(classStart).join("\n");

// Method-ish definitions in the class body: `(async |get |set )*name(args) {`.
function classMethodNames(body) {
  const names = new Set();
  for (const [, name] of body.matchAll(/^\s*(?:(?:static\s+)?(?:async\s+)?|[gs]et\s+)?#?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm)) {
    names.add(name);
  }
  return names;
}
const methods = classMethodNames(classBody);
assert.ok(methods.size > 20, "the class body was located — sanity check");

// ---- helper module exports, resolved through the namespace imports ----------

const helperImports = [...COMP.matchAll(/import \* as (\w+) from "\.\/orchestrator\/([\w-]+)\.js"/g)];
assert.ok(helperImports.length >= 3, "namespace imports for the orchestrator helpers");

const helperExports = new Map(); // namespace (without the "Helpers" suffix) -> Set<exported name>
for (const [, ns, file] of helperImports) {
  const text = fs.readFileSync(path.join(SRC, "orchestrator", `${file}.js`), "utf8");
  const exported = new Set();
  for (const [, name] of text.matchAll(/^\s*export\s+(?:async\s+)?function\s+(\w+)/gm)) exported.add(name);
  const maybe = new Set(exported);
  helperExports.set(ns.replace(/Helpers$/, ""), maybe);
}

test("every `this._x(...)` in orchestrator helper modules has a forwarder on MeetingOrchestrator", () => {
  const missing = [];
  const files = fs.readdirSync(path.join(SRC, "orchestrator")).filter((f) => f.endsWith(".js"));
  for (const file of files) {
    const text = fs.readFileSync(path.join(SRC, "orchestrator", file), "utf8");
    for (const lineText of text.split("\n")) {
      const line = lineText.trim();
      if (line.startsWith("//") || line.startsWith("*")) continue;
      // `this._name(` — a method invocation on the orchestrator instance.
      // Property reads (`this._db`), dots (`this._logger.info(`), and plain
      // fields are not invocations and must not count.
      for (const [, name] of lineText.matchAll(/this\s*\.\s*(\w+)\s*\(/g)) {
        if (!/[A-Za-z]/.test(name)) continue;
        if (methods.has(name)) continue;
        // A helper module may also define the symbol for its own file-local
        // use, but the only way a helper's `this` binding can be met is via
        // the class; a same-file export assists nothing at runtime. Class-only.
        missing.push(`${file}: this.${name}(`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    "helper modules call these methods via `this` — wire a forwarder in src/orchestrator.js for each",
  );
});

test("every `xxxHelpers._y.call(this)` forwarder names a real export of its module", () => {
  const broken = [];
  for (const m of classBody.matchAll(/(\w+)Helpers\.(\w+)\.call\(this/g)) {
    const [, ns, fn] = m;
    const exports = helperExports.get(ns);
    if (!exports) { broken.push(`${ns}Helpers is not a namespace import from src/orchestrator`); continue; }
    if (!exports.has(fn)) broken.push(`${ns}Helpers.${fn} — no such export`);
  }
  // The same modules are also re-used with explicit import * as in the class
  // head; extra forwards on other modules would be silent dead code.
  for (const m of classBody.matchAll(/(?:^|[^\w.])((\w+)Helpers)\.(\w+)\(/g)) {
    const [, , ns, fn] = m;
    const exports = helperExports.get(ns);
    if (exports && !exports.has(fn)) broken.push(`${ns}Helpers.${fn} — no such export`);
  }
  assert.deepEqual(broken, [], "every forwarder must name an existing helper export");
});

test("the class carries no forum-thread forwarders (deleted capability)", () => {
  const leftovers = [...classBody.matchAll(/_collectForum\w*/g)].map((m) => m[0]);
  assert.deepEqual(leftovers, [], "the deleted forum collectors must not be half-removed");
});

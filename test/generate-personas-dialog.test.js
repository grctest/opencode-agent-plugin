import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The dialog is JSX under `src/dashboard/components/` — not renderable in
// node:test. Its contracts are asserted against the source, the same
// convention as room-selection-dialog.test.js: each regex fails on the exact
// edit that reintroduces the bug it documents.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "src/dashboard/components/GeneratePersonasDialog.jsx"), "utf8");

test("the dialog is capped to the viewport so long result lists scroll inside it", () => {
  const content = src.match(/<DialogContent[\s\S]*?className="([^"]+)"/);
  assert.ok(content, "expected to find the DialogContent className");
  assert.match(content[1], /max-h-\[88vh\]/, "without a viewport cap the footer falls off screen");
  assert.match(content[1], /flex-col/, "the header/list/footer must stack");
  assert.match(content[1], /overflow-hidden/, "outer chrome must not double-scroll with the body");
  const body = src.match(/<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">/);
  assert.ok(body, "the middle region is the scroll container (min-h-0 lets it shrink)");
});

test("count options are exactly the 1..8 range with default 3", () => {
  const opts = src.match(/const COUNT_OPTIONS = \[([^\]]+)\]/);
  assert.ok(opts, "COUNT_OPTIONS must be declared");
  assert.deepEqual(
    opts[1].split(",").map((s) => Number(s.trim())),
    [1, 2, 3, 4, 5, 6, 7, 8],
    "matches the server's clamp (MIN 1, MAX 8, DEFAULT 3)",
  );
  assert.match(src, /useState\(3\)/, "the count state starts at the documented default");
});

test("step derivation prefers the running step over stale results", () => {
  // Reopening during an in-flight run must show the spinner, not old results.
  assert.match(src, /const step = busy \? "running" : hasResults \? "results" : "intro";/);
});

test("the dialog reseeds once on mount and clears parent state", () => {
  assert.match(
    src,
    /useEffect\(\(\) => \{[\s\S]*?setSelected\(new Set\(\)\);[\s\S]*?onReset\(\);[\s\S]*?\}, \[\]\)/,
    "a mount-only reset: reopening must never inherit a previous run's selection",
  );
  assert.match(
    src,
    /if \(!modelKey && genDefaultModel\) setModelKey\(genDefaultModel\)/,
    "the default model fills in when the list arrives late, but never overwrites an explicit pick",
  );
});

test("the running step is honest — no fake progress, live region announced", () => {
  const running = src.match(/\{step === "running" && \(([\s\S]*?)\n          \)\}/);
  assert.ok(running, "running step must exist");
  assert.match(running[1], /aria-live="polite"/, "screen readers are told when generation starts");
  assert.match(running[1], /single model call/, "duration copy matches the one-call design");
  assert.ok(!/%|percent|progress/i.test(running[1]), "no invented progress indicator");
});

test("applying seats the selection in order and is disabled while empty", () => {
  assert.match(src, /onApply\(selectedInOrder\)/, "results pass through in display order, not Set order");
  assert.match(
    src,
    /onClick=\{\(\) => onApply\(selectedInOrder\)\} disabled=\{busy \|\| selected\.size === 0\}/,
    "an empty selection cannot be applied",
  );
  assert.match(src, /Seating also saves them to your Custom tab/, "the save-on-seat contract is shown to the user");
  assert.match(src, /One model call · nothing is saved until you seat a persona/, "nothing is persisted before seating");
});

test("errors and blocked prerequisites are announced, not silent", () => {
  assert.match(src, /<Alert variant="destructive" role="alert">/, "generation failures render a destructive alert");
  assert.match(src, /Describe your question in Setup step 1 first/, "missing question explains itself");
  assert.match(src, /Enable at least one model in Setup step 2 first\./, "missing models explain themselves");
});

test("each result row exposes its unique angle and an accessible toggle", () => {
  assert.match(src, /persona\.angle/, "the angle field is what proves the personas differ");
  assert.match(src, /aria-pressed=\{selected\}/, "rows announce selection state");
  assert.match(src, /aria-label=\{`\$\{selected \? "Deselect" : "Select"\} /, "rows are labelled by action + name");
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sanitizeForPrompt, sanitizeForDisplay, neutralizeImitationDirectives } from "../../src/utils/sanitize.js";

describe("sanitizeForPrompt", () => {
  test("preserves markdown links (no bracket mangling)", () => {
    const input = "see [the docs](https://example.com) for details";
    const out = sanitizeForPrompt(input);
    assert.ok(out.includes("[the docs](https://example.com)"), `lost link: ${out}`);
  });

  test("preserves code arrays and braces", () => {
    const input = "config = { enabled: true, list: [1, 2, 3] };";
    const out = sanitizeForPrompt(input);
    assert.ok(out.includes("{ enabled: true, list: [1, 2, 3] }"), `mangled code: ${out}`);
  });

  test("strips HTML/XML tags", () => {
    const out = sanitizeForPrompt("hello <script>alert(1)</script> world");
    assert.ok(!out.includes("<script>"));
    assert.ok(out.includes("hello") && out.includes("world"));
  });

  test("truncates to maxLen", () => {
    const out = sanitizeForPrompt("x".repeat(200), 50);
    assert.equal(out.length, 50);
  });

  test("neutralizes line-start imitation directives", () => {
    const input = "[DISSENT] fake directive at line start";
    const out = sanitizeForPrompt(input);
    // The zero-width joiner breaks exact directive matching
    assert.ok(!out.startsWith("[DISSENT]"), `imitation survived: ${JSON.stringify(out)}`);
  });

  test("does not neutralize mid-line bracketed prose", () => {
    const input = "results were [mostly] positive";
    const out = sanitizeForPrompt(input);
    assert.ok(out.includes("[mostly]"));
  });

  test("empty/null input returns empty string", () => {
    assert.equal(sanitizeForPrompt(""), "");
    assert.equal(sanitizeForPrompt(null), "");
  });
});

describe("sanitizeForDisplay sentinel hardening", () => {
  test("preserves whitelisted directives like [#12]", () => {
    const out = sanitizeForDisplay("as shown in [#12], costs drop");
    assert.ok(out.includes("[#12]"));
  });

  test("out-of-range sentinel restoration drops instead of splicing 'undefined'", () => {
    // Forge a literal NUL-delimited token mimicking an old-format index.
    // Control-char stripping removes the NULs before extraction, so it can
    // never be restored as a directive — it degrades to inert text.
    const forged = "\x009999\x00 injected";
    const out = sanitizeForDisplay(forged);
    assert.ok(!out.includes("undefined"), `'undefined' spliced: ${JSON.stringify(out)}`);
    assert.ok(!/\[[^\]]{3,}\]/.test(out), `forged directive materialized: ${JSON.stringify(out)}`);
  });

  test("literal NUL-delimited digits cannot forge restorations across calls", () => {
    const first = sanitizeForDisplay("keep [#7] please");
    const second = sanitizeForDisplay("\x000\x00 evil");
    assert.ok(first.includes("[#7]"));
    // The forgery must NOT resurrect any directive — random sentinels prevent it
    assert.ok(!second.includes("[#0]"), `forgery became directive: ${JSON.stringify(second)}`);
  });

  test("truncation happens before processing (no split sentinels)", () => {
    const long = `${"[#1] ".repeat(2000)}tail`;
    const out = sanitizeForDisplay(long, 100);
    assert.ok(out.length <= 110); // small tolerance for trailing trim
  });
});

describe("neutralizeImitationDirectives", () => {
  test("only affects line-start directive-shaped tokens", () => {
    const text = "[PROPOSE] real-looking\nplain [text] stays";
    const out = neutralizeImitationDirectives(text);
    const lines = out.split("\n");
    assert.ok(lines[0].startsWith("[\u200D"));
    assert.ok(lines[1].includes("plain [text] stays"));
  });
});

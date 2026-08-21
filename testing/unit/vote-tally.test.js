import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { extractVoteLetter, buildTally } from "../../src/utils/vote-tally.js";

describe("extractVoteLetter (audit 16 MA2)", () => {
  test("parses [Vote: A] format", () => {
    assert.equal(extractVoteLetter("[Vote: A] because cost"), "A");
    assert.equal(extractVoteLetter("[Vote: b] risk is lower"), "B");
  });

  test("parses numbered votes", () => {
    assert.equal(extractVoteLetter("[Vote: 2] second option"), "2");
  });

  test("falls back to standalone letter on its own line", () => {
    assert.equal(extractVoteLetter("my reasoning:\nB\nbecause"), "B");
  });

  test("returns null on no vote", () => {
    assert.equal(extractVoteLetter("no vote here at all"), null);
    assert.equal(extractVoteLetter(""), null);
    assert.equal(extractVoteLetter(null), null);
  });
});

describe("buildTally (audit 16 MA2 — the quirky line-rewrite path)", () => {
  test("counts source + responses and reports leading option", () => {
    const { lines, counts, totalVoters } = buildTally({
      question: "Pick one",
      sourceLetter: "A",
      sourceLabel: "caller",
      responses: [
        { voter: "alice", content: "[Vote: B] cheaper" },
        { voter: "bob", content: "[Vote: A] faster" },
      ],
    });
    assert.equal(counts.A, 2);
    assert.equal(counts.B, 1);
    assert.equal(totalVoters, 3);
    const joined = lines.join("\n");
    // The rewrite regex merges repeated letters with the previous voter list
    assert.ok(joined.includes("A: 2 votes (caller — source, bob)"));
    assert.ok(joined.includes("Leading option: A (2 votes)"));
  });

  test("handles votes that parse to nothing", () => {
    const { counts, totalVoters } = buildTally({
      question: "q",
      sourceLetter: null,
      sourceLabel: "src",
      responses: [{ voter: "x", content: "no vote in this text" }],
    });
    assert.deepEqual(counts, {});
    assert.equal(totalVoters, 2);
  });

  test("three-way tally keeps per-letter lines distinct", () => {
    const { lines } = buildTally({
      question: "q",
      sourceLetter: "C",
      sourceLabel: "src",
      responses: [
        { voter: "v1", content: "[Vote: C] yes" },
        { voter: "v2", content: "[Vote: B] no" },
        { voter: "v3", content: "[Vote: A] maybe" },
      ],
    });
    const joined = lines.join("\n");
    for (const letter of ["A", "B", "C"]) {
      assert.ok(joined.includes(`${letter}:`), `missing ${letter}`);
    }
  });
});

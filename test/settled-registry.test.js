import test from "node:test";
import assert from "node:assert/strict";
import { parseSettledBullet, mergeSettledBullet } from "../src/lib/settled-registry.js";
import { getSettledItemsRaw, setSettledItemsRaw } from "../src/database/meeting-operations.js";

// parseSettledBullet — extracts clerk-designated consensus items from a round
// summary. The clerk emits a **Settled:** bullet with one-line claims + [#id].
test("parseSettledBullet extracts inline settled items", () => {
  const summary = `## Output
- **Established:** The split holds [#9]
- **Settled:** Mercedes HPP best engine shop, McLaren best whole team on identical PU [#9][#12]
- **Contested:** Thresholds differ [#33][#39]
- **Evidence:** None
- **Open:** Which U21s?`;
  const items = parseSettledBullet(summary);
  assert.equal(items.length, 1);
  assert.match(items[0], /Mercedes HPP best engine shop/);
  assert.match(items[0], /\[#9\]\[#12\]/);
});

test("parseSettledBullet extracts multi-line settled lists", () => {
  const summary = `- **Settled:**
  - Mercedes HPP best engine shop [#9]
  - McLaren best whole team [#12]
- **Contested:** none`;
  const items = parseSettledBullet(summary);
  assert.equal(items.length, 2);
  assert.match(items[0], /Mercedes HPP/);
  assert.match(items[1], /McLaren best whole team/);
});

test("parseSettledBullet returns empty for None and missing bullet", () => {
  assert.deepEqual(parseSettledBullet("- **Settled:** None this round\n- **Contested:** x"), []);
  assert.deepEqual(parseSettledBullet("- **Established:** nothing\n- **Open:** q?"), []);
  assert.deepEqual(parseSettledBullet(""), []);
  assert.deepEqual(parseSettledBullet(null), []);
});

// mergeSettledBullet — cumulative, deduped by normalized text (strips [#id]
// refs so the same claim with different citations still dedupes), capped.
test("mergeSettledBullet adds new items and reports change", () => {
  const { items, changed } = mergeSettledBullet([], "- **Settled:** Mercedes HPP best shop [#9]", 1);
  assert.equal(changed, true);
  assert.equal(items.length, 1);
  assert.equal(items[0].round, 1);
  assert.match(items[0].text, /Mercedes HPP/);
});

test("mergeSettledBullet dedupes paraphrases with different citations", () => {
  const existing = [{ text: "Mercedes HPP best engine shop [#9]", holders: [], round: 1 }];
  // Same claim, different [#id] refs — normalized key strips refs, so no dup.
  const { items, changed } = mergeSettledBullet(existing, "- **Settled:** Mercedes HPP best engine shop, McLaren best whole team [#12][#14]", 2);
  assert.equal(changed, true);
  assert.equal(items.length, 2);
});

test("mergeSettledBullet is a no-op when nothing new converges", () => {
  const existing = [{ text: "Mercedes HPP best engine shop [#9]", holders: [], round: 1 }];
  const { items, changed } = mergeSettledBullet(existing, "- **Settled:** None this round", 2);
  assert.equal(changed, false);
  assert.equal(items.length, 1);
});

test("mergeSettledBullet caps the registry for prompt size", () => {
  let items = [];
  for (let round = 1; round <= 15; round++) {
    const res = mergeSettledBullet(items, `- **Settled:** Consensus item number ${round} [#${round}]`, round);
    items = res.items;
  }
  assert.ok(items.length <= 10, `registry capped at 10, got ${items.length}`);
  // Newest kept: the cap drops the oldest.
  assert.match(items[items.length - 1].text, /number 15/);
});

// Regression: a DB created while CREATE TABLE lacked settled_items (stamped
// v12 without the column) must self-heal instead of throwing "no such
// column" and aborting the meeting. Fake db simulates the pre-migration
// schema, then the ALTER, then normal operation.
function preMigrationDb() {
  const columns = new Set(["id", "question", "status"]);
  const store = {};
  return {
    prepare(sql) {
      if (sql.startsWith("PRAGMA table_info")) {
        return { all: () => [...columns].map((name) => ({ name })) };
      }
      if (sql.startsWith("ALTER TABLE")) {
        return { run: () => { columns.add("settled_items"); } };
      }
      if (sql.startsWith("SELECT settled_items")) {
        return {
          get: () => {
            if (!columns.has("settled_items")) throw new Error("no such column: settled_items");
            return { settled_items: store.settled ?? null };
          },
        };
      }
      if (sql.startsWith("UPDATE meetings SET settled_items")) {
        return {
          run: (json) => {
            if (!columns.has("settled_items")) throw new Error("no such column: settled_items");
            store.settled = json;
          },
        };
      }
      throw new Error(`unexpected SQL in fake: ${sql}`);
    },
    exec(sql) {
      if (sql.startsWith("ALTER TABLE")) columns.add("settled_items");
      else throw new Error(`unexpected exec: ${sql}`);
    },
  };
}

test("settled accessors self-heal a DB missing the column", () => {
  const db = preMigrationDb();
  // Read on a column-less DB returns "" instead of throwing.
  assert.equal(getSettledItemsRaw(db, "m1"), "");
  // Write self-heals (ALTER) then persists.
  setSettledItemsRaw(db, "m1", JSON.stringify([{ text: "x [#1]", holders: [], round: 1 }]));
  const back = getSettledItemsRaw(db, "m1");
  const parsed = JSON.parse(back);
  assert.equal(parsed.length, 1);
  assert.match(parsed[0].text, /x \[#1\]/);
});

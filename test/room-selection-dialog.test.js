import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_LIST_HEIGHT, resolveListHeight } from "../src/dashboard/components/roomSelectionLayout.js";

// The auto-select dialog is the only place in the dashboard that virtualises
// with react-window. It is also the component with the most subtle layout
// contract, and both of its bugs so far were shipped by rewriting it from
// memory instead of copying the working sibling (PersonaPickerDialog):
//
//   - the react-window v1 props against v2, which threw "Invalid index 0"
//   - `min-h-0` on the list wrapper, which let the height feedback loop below
//     collapse the list to one row and stay there
//
// None of that is reachable from node:test — the component is JSX and the
// failure needs a DOM. So the invariants are asserted against the source
// instead, the same way nonhuman-tier.test.js reads tierMeta.jsx. A source
// assertion is a weaker check than a render, but it fails at review time on
// the exact edit that reintroduces each bug.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel) => readFileSync(join(root, rel), "utf8");
const dialogSrc = readSrc("src/dashboard/components/RoomSelectionDialog.jsx");
const pickerSrc = readSrc("src/dashboard/components/PersonaPickerDialog.jsx");

test("the dialog itself has a definite height, so the list never depends on content", () => {
  // This is the root cause behind both the collapse and the "half height"
  // report, and it is upstream of the floor. With `max-h-[88vh]` the dialog's
  // height is derived from its contents, so the list wrapper's `flex-1` has
  // nothing stable to resolve against: it measures whatever the current
  // children happen to add up to. Unmount the list and the whole chain settles
  // at a smaller number, which is what "about half as tall" looked like.
  //
  // A definite height (`h-[85vh]`) makes the parent's height independent of its
  // contents, so `flex-1` resolves to the same pixels whether the list is
  // mounted, empty, or showing a placeholder.
  const content = dialogSrc.match(/<DialogContent[\s\S]*?className="([^"]+)"/);
  assert.ok(content, "expected to find the DialogContent className");
  assert.match(
    content[1],
    /\bh-\[[^\]]+\]/,
    `dialog needs a definite height, got "${content[1]}" — max-h alone leaves it content-derived`,
  );
  assert.ok(
    !/\bmax-h-\[/.test(content[1]),
    "a max-height on the dialog leaves its height content-derived",
  );
});

test("the list viewport has a height floor rather than being free to collapse", () => {
  // `min-h-0` opts the wrapper out of any minimum height. Because the List's
  // height is what gives the wrapper its height, that turns a measurement into
  // a feedback loop: hide every tier -> the List unmounts -> the wrapper
  // collapses -> the observer records the collapsed height -> re-showing tiers
  // mounts a List that short, which keeps the wrapper short, forever.
  assert.ok(
    !/className="[^"]*\bmin-h-0\b[^"]*"[^>]*ref=\{listWrapRef\}/.test(dialogSrc),
    "the list wrapper must not use min-h-0 — it removes the floor that breaks the height feedback loop",
  );
  const wrapper = dialogSrc.match(/<div ref=\{listWrapRef\} className="([^"]+)"/);
  assert.ok(wrapper, "expected to find the list wrapper by ref");
  assert.match(
    wrapper[1],
    /min-h-\[\d+px\]/,
    `list wrapper needs a min-h-[Npx] floor, got "${wrapper[1]}"`,
  );
});

test("the JS height floor and the CSS height floor agree", () => {
  // Two representations of one number, in two different languages. If they
  // drift, whichever is smaller is the floor that actually applies and the
  // other is decoration — so pin them together.
  const css = Number(dialogSrc.match(/min-h-\[(\d+)px\]/)?.[1]);
  assert.ok(Number.isFinite(css), "expected a min-h-[Npx] class on the list wrapper");
  assert.equal(css, MIN_LIST_HEIGHT, `CSS floor ${css}px != JS floor ${MIN_LIST_HEIGHT}px`);
});

test("the measured height can never be set below the floor", () => {
  // Defence in depth. The CSS floor is the primary guarantee, but the setter
  // clamps too, so a future layout change that removes the CSS floor still
  // cannot produce a one-row-tall list.
  assert.ok(
    /setListHeight\(resolveListHeight\(el\.clientHeight\)\)/.test(dialogSrc),
    "the measured height must go through resolveListHeight",
  );
  assert.ok(
    dialogSrc.includes('from "./roomSelectionLayout.js"'),
    "the floor must come from the shared layout module so the two cannot drift",
  );
});

test("resolveListHeight returns the measured height unchanged, and floors below", () => {
  // This is the whole contract, testable without a layout engine. The property
  // that matters for the reported bug: the function is a pure function of the
  // measured height, so a round-trip through the observer cannot compound —
  // feeding 520 back in yields 520, not something progressively smaller.
  assert.equal(resolveListHeight(520), 520);
  assert.equal(resolveListHeight(300), 300);
  assert.equal(resolveListHeight(MIN_LIST_HEIGHT), MIN_LIST_HEIGHT);
  assert.equal(resolveListHeight(MIN_LIST_HEIGHT - 1), MIN_LIST_HEIGHT, "below the floor clamps up");
  assert.equal(resolveListHeight(1), MIN_LIST_HEIGHT);
});

test("resolveListHeight never reports an unmeasured height as zero", () => {
  // Zero is the "not measured yet" sentinel that gates the List render. If an
  // unmeasured or zero wrapper leaked through as 0 it would be indistinguishable
  // from that sentinel and the list would never paint.
  assert.equal(resolveListHeight(0), MIN_LIST_HEIGHT);
  assert.equal(resolveListHeight(-50), MIN_LIST_HEIGHT);
  assert.equal(resolveListHeight(Number.NaN), MIN_LIST_HEIGHT);
  assert.equal(resolveListHeight(undefined), MIN_LIST_HEIGHT);
});

test("resolveListHeight is idempotent, so repeated observations cannot shrink it", () => {
  // The failure mode this whole change is about: a loop where observing the
  // height feeds it back as the rendered height. Idempotence is what makes that
  // loop incapable of drifting.
  for (const start of [180, 220, 260, 400, 640]) {
    let h = start;
    for (let i = 0; i < 5; i++) h = resolveListHeight(h);
    assert.equal(h, resolveListHeight(start), `drifted from ${start} to ${h}`);
  }
});

test("the dialog uses the react-window v2 List API", () => {
  // v2 takes rowComponent/rowCount/rowHeight/rowProps and ignores the v1 names
  // entirely, so a v1 call renders with rowCount === undefined and throws
  // "Invalid index 0". Assert both halves: the v2 names are present and the v1
  // names that v2 ignores are absent from the List call.
  const listTag = dialogSrc.match(/<List\b[\s\S]*?\/>/);
  assert.ok(listTag, "expected to find the <List> element");
  const list = listTag[0];
  for (const prop of ["rowComponent=", "rowCount=", "rowHeight=", "rowProps="]) {
    assert.ok(list.includes(prop), `react-window v2 List requires ${prop}`);
  }
  for (const legacy of ["itemCount", "itemSize", "itemData", "itemKey", "itemComponent"]) {
    assert.ok(!list.includes(legacy), `${legacy} is react-window v1 and is ignored by v2`);
  }
  // Height arrives via style in v2; there is no height prop.
  assert.ok(/style=\{\{[^}]*height: listHeight/.test(list), "v2 takes height via style, not a height prop");
});

test("the row component reads rows through v2 rowProps", () => {
  // v2 injects {index, style, ariaAttributes} and spreads rowProps. It does not
  // pass itemCount/itemData, so a row that destructures `items` from anywhere
  // else silently sees undefined and renders nothing.
  assert.match(
    dialogSrc,
    /function RankRow\(\{[^}]*index[^}]*style[^}]*ariaAttributes[^}]*items/s,
    "RankRow must destructure items alongside the v2-injected props",
  );
});

test("an empty filter result does not leave the list rendered at zero height", () => {
  // Defensive: the List must not be mounted while there is nothing to list, and
  // it must not be mounted on a measured height that predates the measurement.
  assert.ok(
    /visible\.length > 0 && listHeight > 0/.test(dialogSrc),
    "the List should render only when there are rows and a measured height",
  );
});

test("the dialog stays consistent with the sibling it was modelled on", () => {
  // PersonaPickerDialog is the reference implementation and does not have
  // either bug. When the two diverge on the shared layout contract, the
  // divergence is the defect — this test exists so that a future change to one
  // is not silently unmatched by the other.
  for (const [name, src] of [["RoomSelectionDialog", dialogSrc], ["PersonaPickerDialog", pickerSrc]]) {
    assert.match(
      src,
      /min-h-\[\d+px\] flex-1/,
      `${name}: both dialogs must floor the list viewport the same way`,
    );
    assert.match(src, /rowComponent=/, `${name}: both dialogs must use the react-window v2 API`);
  }
});
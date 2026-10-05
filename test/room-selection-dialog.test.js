import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
  const js = Number(dialogSrc.match(/const MIN_LIST_HEIGHT = (\d+)/)?.[1]);
  assert.ok(Number.isFinite(css), "expected a min-h-[Npx] class on the list wrapper");
  assert.ok(Number.isFinite(js), "expected a MIN_LIST_HEIGHT constant");
  assert.equal(css, js, `CSS floor ${css}px != JS floor ${js}px`);
});

test("the measured height can never be set below the floor", () => {
  // Defence in depth. The CSS floor is the primary guarantee, but the setter
  // clamps too, so a future layout change that removes the CSS floor still
  // cannot produce a one-row-tall list.
  assert.ok(
    /setListHeight\(Math\.max\(MIN_LIST_HEIGHT, el\.clientHeight\)\)/.test(dialogSrc),
    "listHeight must be clamped to MIN_LIST_HEIGHT when measured",
  );
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
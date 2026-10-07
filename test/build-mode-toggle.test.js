import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentSystemPrompt } from "../src/prompts/agent.js";
import { buildToolsMap } from "../src/round-executor/tools.js";
import { DEFAULT_CONFIG, NESTED_SCHEMA } from "../src/config/defaults.js";

// Plan/Build deliberation mode (Setup-tab toggle): Build must BOTH say BUILD
// in the prompt AND offer the write/edit tools at runtime — a toggle that
// only rewords the prompt while the map withholds the tools would repeat the
// "1 write in 1,071 rows" failure this toggle exists to prevent. Plan must do
// neither. Server/UI files are JSX- or dependency-blocked for import, so like
// tierMeta.jsx they are asserted structurally as source.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p) => readFileSync(join(root, p), "utf8");
// Post-split tree readers: SetupTab composes setup/* cards, the control
// plane composes server/control/* stages — scan the trees, not the facades.
const srcTree = (dir, rel) => {
  const out = [src(rel)];
  for (const f of readdirSync(join(root, dir))) {
    if (/\.(jsx?|tsx?)$/.test(f)) out.push(readFileSync(join(root, dir, f), "utf8"));
  }
  return out.join("\n");
};

function participant() {
  return {
    config: {
      id: "mode-agent",
      name: "Mode Engineer",
      category: "senior",
      persona: "A mode-fixture persona with enough characters to render verbatim in the identity block.",
      agenda: "Verify plan/build mode invariants hold across refactors.",
      category_guidance: "Be precise.",
      known_biases: ["assumes the worst edge case will hit first"],
      communication_style: "Direct",
      preferred_contribution_types: ["challenge"],
      anti_patterns: ["Avoid vagueness without data"],
      model: { providerID: "test", modelID: "test-model" },
    },
    status: "listening",
  };
}

function toolsWith(buildMode) {
  const at = structuredClone(DEFAULT_CONFIG.agentTools);
  at.buildMode = buildMode;
  return at;
}

function availableLine(sys) {
  const m = sys.match(/Available: ([^\n]+)/);
  assert.ok(m, "Available line missing");
  return m[1];
}

test("defaults ship Plan (read-only) and validate agentTools.buildMode", () => {
  assert.equal(DEFAULT_CONFIG.agentTools.buildMode, false);
  assert.deepEqual(NESTED_SCHEMA["agentTools.buildMode"], { type: "boolean" });
});

test("Plan mode: prompt says PLAN and the map withholds write/edit", () => {
  const at = toolsWith(false);
  const sys = buildAgentSystemPrompt(participant(), { activeCount: 5, agentTools: at });
  assert.match(sys, /\*\*PLAN\*\* — read-only/);
  assert.doesNotMatch(availableLine(sys), /\bwrite\b/);
  assert.doesNotMatch(availableLine(sys), /\bedit\b/);
  const map = buildToolsMap({ agentTools: at }, { activeCount: 5, omitStatePatch: true });
  assert.ok(!("write" in map), "plan must not offer write");
  assert.ok(!("edit" in map), "plan must not offer edit");
});

test("Build mode: prompt says BUILD and the map offers write/edit", () => {
  const at = toolsWith(true);
  const sys = buildAgentSystemPrompt(participant(), { activeCount: 5, agentTools: at });
  assert.match(sys, /\*\*BUILD\*\* — you may write\/edit/);
  assert.match(availableLine(sys), /\bwrite\b/);
  assert.match(availableLine(sys), /\bedit\b/);
  const map = buildToolsMap({ agentTools: at }, { activeCount: 5, omitStatePatch: true });
  assert.equal(map.write, true);
  assert.equal(map.edit, true);
});

test("server: features.buildMode normalizes strict and reaches the tool build", () => {
  const control = srcTree("src/dashboard/server/control", "src/dashboard/server/control.js");
  assert.match(control, /buildMode: raw\.buildMode === true/);
  assert.match(control, /tools\.buildMode = buildMode/);
  assert.match(control, /const buildMode = features\.buildMode === true/);
  assert.ok(!control.includes("tools.buildMode = false"), "plan must not be hardcoded");
  assert.match(control, /write: buildMode/);
  assert.match(control, /edit: buildMode/);
});

test("setup store: buildMode defaults to Plan and sanitizes strict", () => {
  const store = src("src/dashboard/stores/setupForm.js");
  assert.match(store, /buildMode: false/);
  assert.match(store, /buildMode: rawFeatures\.buildMode === true/);
});

test("setup tab: orchestrator card exposes the Plan/Build mode toggle", () => {
  const tab = srcTree("src/dashboard/components/setup", "src/dashboard/components/SetupTab.jsx");
  assert.match(tab, /Deliberation mode/);
  assert.match(tab, /loom-orchestrator-deliberationMode/);
  assert.match(tab, /setFeature\("buildMode", value === "build"\)/);
  assert.match(tab, /features\.buildMode === true \? "build" : "plan"/);
  assert.match(tab, /Plan — read-only/);
  assert.match(tab, /Build — may write/);
});

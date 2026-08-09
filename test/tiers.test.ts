import { getTierConfig, splitModel, can, getRightsForTier, getPromptForTier } from "../src/tiers.js";
import type { Tier, TierConfig, TierRights } from "../src/types.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`FAIL: ${message} — expected ${expected}, got ${actual}`);
  }
}

// ─── splitModel ────────────────────────────────────────────────────────

console.log("Testing splitModel...");
assert(
  splitModel("anthropic/claude-3-opus-20240229").providerID === "anthropic",
  "splitModel extracts providerID"
);
assert(
  splitModel("anthropic/claude-3-opus-20240229").modelID === "claude-3-opus-20240229",
  "splitModel extracts modelID"
);
try {
  splitModel("no-slash-here");
  assert(false, "splitModel should throw on missing slash");
} catch {
  // expected
}
console.log("  splitModel: PASS");

// ─── getTierConfig ─────────────────────────────────────────────────────

console.log("Testing getTierConfig...");
const juniorConfig = getTierConfig("junior");
assertEqual(juniorConfig.temperature, 0.5, "junior default temperature");
assert(juniorConfig.system_prompt_addendum.length > 0, "junior has system prompt addendum");
assert(juniorConfig.rights.contribute === true, "junior can contribute");
assert(juniorConfig.rights.veto === false, "junior cannot veto");

const principalConfig = getTierConfig("principal");
assert(principalConfig.rights.veto === true, "principal can veto");
assert(principalConfig.rights.force_end === true, "principal can force end");
assert(principalConfig.rights.call_vote === true, "principal can call vote");

const seniorConfig = getTierConfig("senior");
assert(seniorConfig.rights.veto === true, "senior can veto");

const overridden = getTierConfig("custom-role", { model: "test/model", temperature: 0.3 });
assertEqual(overridden.model, "test/model", "override applies model");
assertEqual(overridden.temperature, 0.3, "override applies temperature");
assert(overridden.rights.contribute === true, "custom role gets base rights");
assert(seniorConfig.rights.force_end === false, "senior cannot force end");

const midConfig = getTierConfig("mid");
assert(midConfig.rights.call_vote === true, "mid can call vote");
assert(midConfig.rights.veto === false, "mid cannot veto");

// With overrides
const customConfig = getTierConfig("junior", { model: "custom/model", temperature: 0.1 });
assertEqual(customConfig.model, "custom/model", "override applies model");
assertEqual(customConfig.temperature, 0.1, "override applies temperature");

// Custom tier with overrides
const customRoleConfig = getTierConfig("security-engineer", { model: "anthropic/claude-3-opus-20240229" });
assertEqual(customRoleConfig.model, "anthropic/claude-3-opus-20240229", "custom tier model override");
assert(customRoleConfig.rights.contribute === true, "custom tier gets base rights");
console.log("  getTierConfig: PASS");

// ─── can() ─────────────────────────────────────────────────────────────

console.log("Testing can()...");
const makeParticipant = (tier: Tier) => ({
  tier_config: getTierConfig(tier),
});

assert(can(makeParticipant("junior"), "interject") === true, "junior can interject");
assert(can(makeParticipant("junior"), "veto") === false, "junior cannot veto");
assert(can(makeParticipant("junior"), "force_end") === false, "junior cannot force end");
assert(can(makeParticipant("senior"), "veto") === true, "senior can veto");
assert(can(makeParticipant("senior"), "force_end") === false, "senior cannot force end");
assert(can(makeParticipant("principal"), "veto") === true, "principal can veto");
assert(can(makeParticipant("principal"), "force_end") === true, "principal can force end");
assert(can(makeParticipant("mid"), "call_vote") === true, "mid can call vote");
assert(can(makeParticipant("mid"), "veto") === false, "mid cannot veto");
console.log("  can(): PASS");

// ─── Tier Rights ───────────────────────────────────────────────────

console.log("Testing tier rights...");
const tiers: Tier[] = ["junior", "mid", "senior", "principal"];
for (const tier of tiers) {
  const rights = getRightsForTier(tier);
  assert(typeof rights.contribute === "boolean", `${tier} has contribute`);
  assert(typeof rights.interject === "boolean", `${tier} has interject`);
  assert(typeof rights.call_vote === "boolean", `${tier} has call_vote`);
  assert(typeof rights.veto === "boolean", `${tier} has veto`);
  assert(typeof rights.force_end === "boolean", `${tier} has force_end`);
}

const customRights = getRightsForTier("security-engineer");
assert(customRights.contribute === true, "custom tier gets default rights");
assert(customRights.call_vote === true, "custom tier can call votes");
console.log("  Tier rights: PASS");

console.log("\nAll tier tests passed!");

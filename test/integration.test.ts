/**
 * Integration smoke test for The Loom.
 *
 * This test documents the manual verification steps needed to confirm
 * the system works against the real opencode API.
 *
 * Run with: npx tsx test/integration.test.ts
 *
 * Prerequisites:
 * 1. opencode is installed and configured with at least one provider
 * 2. You have access to the opencode API (free tier is fine)
 * 3. At least 2 models are available
 */

import { getTierConfig, splitModel, getRightsForTier, getPromptForTier } from "../src/tiers.js";
import { composeRoom, formatRoomPreview } from "../src/composer.js";
import { createModelPlan, selectModelsForRoles, formatModelPlan } from "../src/model-discovery.js";
import { parseAgentResponse } from "../src/validation.js";
import { evolveWarp, formatTranscript } from "../src/warp-manager.js";
import { resolveInterjections, formatInterjectionNotes } from "../src/interjection-resolver.js";
import type { AvailableModel, ParticipantConfig } from "../src/types.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

console.log("=== The Loom Integration Smoke Test ===\n");

// ─── Test 1: Model Discovery ──────────────────────────────────────────────

console.log("Test 1: Model Discovery Pipeline");

const mockModels: AvailableModel[] = [
  { providerID: "anthropic", modelID: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", status: "active", cost: { input: 0, output: 0 }, limit: { context: 200000, output: 4096 }, reasoning: false, temperature: true },
  { providerID: "anthropic", modelID: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", status: "active", cost: { input: 0, output: 0 }, limit: { context: 200000, output: 4096 }, reasoning: false, temperature: true },
  { providerID: "anthropic", modelID: "claude-3-opus-20240229", name: "Claude 3 Opus", status: "active", cost: { input: 0.015, output: 0.075 }, limit: { context: 200000, output: 4096 }, reasoning: true, temperature: true },
];

const roles = ["junior", "mid", "senior", "principal"];
const assignments = selectModelsForRoles(mockModels, roles);
assert(assignments.length === 4, "One assignment per role");
assert(assignments[0].tier === "principal", "Principal gets highest-ranked model");

const plan = createModelPlan(mockModels, roles);
assert(plan.participants.length === 4, "Plan has 4 participants");
assert(plan.orchestrator.tier === "mid", "Orchestrator is mid tier");

const preview = formatModelPlan(plan);
assert(preview.includes("principal") || preview.includes("Principal"), "Preview shows principal tier");
assert(preview.includes("free") || preview.includes("$"), "Preview shows cost info");

console.log("  Model discovery: PASS\n");

// ─── Test 2: Room Composition ──────────────────────────────────────────────

console.log("Test 2: Room Composition");

const highStakes = composeRoom("Should we migrate our database architecture?", 5);
assert(highStakes.participants.length === 5, "High stakes with 5 participants");
assert(highStakes.participants.some((p) => p.tier === "principal"), "Has a principal");
assert(highStakes.estimated_rounds <= 5, "Estimated rounds <= participant count");

const lowStakes = composeRoom("What color should the button be?");
assert(lowStakes.participants.length >= 2, "Low stakes has 2+ participants");
assert(!lowStakes.participants.some((p) => p.tier === "principal"), "No principal for low stakes");

const customCount = composeRoom("Design our API strategy", 7);
assert(customCount.participants.length === 7, "Custom count respected");

const roomPreview = formatRoomPreview(highStakes);
assert(roomPreview.includes("Proposed Deliberation Room"), "Preview has title");
assert(roomPreview.includes("| # | Name |"), "Preview has table header");
assert(roomPreview.length > 200, "Preview has substantial content");

console.log("  Room composition: PASS\n");

// ─── Test 3: Response Parsing ──────────────────────────────────────────────

console.log("Test 3: Response Parsing");

const pass = parseAgentResponse("p1", "[PASS]");
assert(pass.content === "[PASS]", "PASS detected");

const propose = parseAgentResponse("p2", "[PROPOSE] We should use event-driven architecture");
assert(propose.content === "We should use event-driven architecture", "PROPOSE content parsed");
assert(propose.type === "propose", "PROPOSE type detected");

const withInterjection = parseAgentResponse(
  "p3",
  "[CHALLENGE] Security concern [INTERJECT: Priority: 9, Reason: \"This has a critical auth bypass\"]",
);
assert(withInterjection.type === "challenge", "Type detected with interjection");
assert(withInterjection.interjection !== null, "Interjection detected");
assert(withInterjection.interjection?.priority === 9, "Priority parsed");
assert(withInterjection.content === "Security concern", "Content cleaned of interjection");

const malformed = parseAgentResponse("p1", "Just some random text without tags");
assert(malformed.type === "propose", "Default type for untagged text");

console.log("  Response parsing: PASS\n");

// ─── Test 4: Interjection Resolution ───────────────────────────────────────

console.log("Test 4: Interjection Resolution");

import type { Interjection, Round } from "../src/types.js";

const mockRound: Round = {
  number: 1,
  contributions: [],
  interjections: [
    { participant_id: "p1", priority: 9, reason: "Critical error", granted: false, pushback: null, resolved: "pending" },
    { participant_id: "p2", priority: 7, reason: "Important point", granted: false, pushback: null, resolved: "pending" },
    { participant_id: "p3", priority: 5, reason: "Minor comment", granted: false, pushback: null, resolved: "pending" },
  ],
  token_path: [],
  summary: "",
};

await resolveInterjections(mockRound, async () => true);

const granted = mockRound.interjections.filter((ij) => ij.granted);
const denied = mockRound.interjections.filter((ij) => ij.resolved === "denied");
assert(granted.length === 2, "Priority 9 and 7 granted");
assert(denied.length === 1, "Priority 5 denied");

const notes = formatInterjectionNotes(mockRound);
assert(notes.includes("Critical error"), "Notes include granted interjection");
assert(!notes.includes("Minor comment"), "Notes exclude denied interjection");

console.log("  Interjection resolution: PASS\n");

// ─── Test 5: Warp Evolution ────────────────────────────────────────────────

console.log("Test 5: Warp Evolution");

const warp1 = "Initial context";
const round1: Round = {
  number: 1,
  contributions: [{ participant_id: "p1", content: "We should use X", type: "propose", targets_which: null, timestamp: 0 }],
  interjections: [],
  token_path: ["p1"],
  summary: "Round established approach X",
};

const evolved = evolveWarp(warp1, round1);
assert(evolved.includes("Initial context"), "Warp preserves existing context");
assert(evolved.includes("Round established approach X"), "Warp includes new summary");

const longWarp = "A".repeat(11000);
const round2: Round = {
  number: 2,
  contributions: [{ participant_id: "p1", content: "B".repeat(100), type: "propose", targets_which: null, timestamp: 0 }],
  interjections: [],
  token_path: ["p1"],
  summary: "New info",
};

const compacted = evolveWarp(longWarp, round2);
assert(compacted.length < longWarp.length + 100, "Long warp is compacted");
assert(compacted.includes("New info"), "Compacted warp includes new summary");

console.log("  Warp evolution: PASS\n");

// ─── Test 6: Tier Configuration ────────────────────────────────────────────

console.log("Test 6: Tier Configuration");

const juniorConfig = getTierConfig("junior");
assert(juniorConfig.rights.contribute === true, "Junior can contribute");
assert(juniorConfig.rights.veto === false, "Junior cannot veto");
assert(juniorConfig.system_prompt_addendum.length > 0, "Junior has guidance text");

const principalConfig = getTierConfig("principal");
assert(principalConfig.rights.veto === true, "Principal can veto");
assert(principalConfig.rights.force_end === true, "Principal can force end");

const customConfig = getTierConfig("security-engineer");
assert(customConfig.rights.contribute === true, "Custom tier can contribute");
assert(customConfig.rights.call_vote === true, "Custom tier gets voting rights");
assert(customConfig.system_prompt_addendum.length > 0, "Custom tier has guidance");

const overrideConfig = getTierConfig("junior", { model: "anthropic/claude-3-opus-20240229", temperature: 0.2 });
assert(overrideConfig.model === "anthropic/claude-3-opus-20240229", "Model override applied");
assert(overrideConfig.temperature === 0.2, "Temperature override applied");

console.log("  Tier configuration: PASS\n");

// ─── Manual Verification Checklist ─────────────────────────────────────────

console.log("=== Manual Verification Checklist ===");
console.log("The following must be verified against the real opencode API:\n");
console.log("[ ] 1. session.create({parentID, title}) creates a visible child session in the UI");
console.log("[ ] 2. session.prompt({path: {id: childId}, body: {system, model, parts}}) returns text");
console.log("[ ] 3. Per-model assignments work (different models for different tiers)");
console.log("[ ] 4. Free-tier models produce coherent deliberation output");
console.log("[ ] 5. Multiple agents can run concurrently without interference");
console.log("[ ] 6. The full /knit flow completes end-to-end");
console.log("[ ] 7. Interjections are detected and resolved correctly in real deliberation");
console.log("[ ] 8. Warp compaction triggers correctly for long contexts");
console.log("");
console.log("To verify: run /knit_models then /knit with a real question.");
console.log("");

console.log("All automated tests PASSED!");

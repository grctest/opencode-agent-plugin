import { composeRoom, formatRoomPreview } from "../src/composer.js";
import type { Tier } from "../src/types.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

// ─── composeRoom ───────────────────────────────────────────────────────

console.log("Testing composeRoom...");

const highStakes = composeRoom("Should we migrate our database architecture?");
assert(highStakes.participants.length >= 3, "high stakes has 3+ participants");
assert(
  highStakes.participants.some((p) => p.tier === "principal"),
  "high stakes includes principal"
);
assert(
  highStakes.participants.some((p) => p.tier === "senior"),
  "high stakes includes senior"
);
assert(highStakes.estimated_rounds > 0, "high stakes has estimated rounds");
assert(highStakes.reasoning.length > 0, "high stakes has reasoning");

const lowStakes = composeRoom("What color should we use for the button?");
assert(lowStakes.participants.length >= 2, "low stakes has 2+ participants");
assert(
  !lowStakes.participants.some((p) => p.tier === "principal"),
  "low stakes has no principal"
);
assert(
  lowStakes.participants.some((p) => p.tier === "junior"),
  "low stakes includes junior"
);

const mediumStakes = composeRoom("How should we refactor this module?");
assert(mediumStakes.participants.length >= 3, "medium stakes has 3+ participants");
assert(
  mediumStakes.participants.some((p) => p.tier === "junior"),
  "medium stakes includes junior"
);

// All participants have unique IDs
const allIds = highStakes.participants.map((p) => p.id);
const uniqueIds = new Set(allIds);
assert(
  allIds.length === uniqueIds.size,
  "high stakes participant IDs are unique"
);

// All participants have required fields
for (const p of highStakes.participants) {
  assert(p.name.length > 0, `participant ${p.id} has name`);
  assert(p.persona.length > 0, `participant ${p.id} has persona`);
  assert(p.agenda.length > 0, `participant ${p.id} has agenda`);
  assert(["junior", "mid", "senior", "principal"].includes(p.tier), `participant ${p.id} has valid tier`);
}

console.log("  composeRoom: PASS");

// ─── formatRoomPreview ────────────────────────────────────────────────

console.log("Testing formatRoomPreview...");
const preview = formatRoomPreview(highStakes);
assert(preview.includes("Proposed Deliberation Room"), "preview has title");
assert(preview.includes("| # | Name | Tier |"), "preview has table header");
assert(preview.includes("Estimated rounds"), "preview has estimated rounds");
assert(preview.includes("confirm"), "preview asks for confirmation");

for (const p of highStakes.participants) {
  assert(preview.includes(p.name), `preview includes ${p.name}`);
  assert(preview.includes(p.tier), `preview includes tier ${p.tier}`);
}
console.log("  formatRoomPreview: PASS");

console.log("\nAll composer tests passed!");

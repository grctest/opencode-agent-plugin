// npm run docs:verify — asserts ORCHESTRATION_ARCHITECTURE.md's numeric claims
// against the live constants (audit X1/Phase 2). Fails the build on drift so
// the architecture doc cannot silently diverge from the code again.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { STATE_PATCH_CAPS } from "../src/state-patch.js";
import { SOP_CAPS, SOP_SECTIONS } from "../src/state-of-play.js";
import { LENGTH_LIMITS } from "../src/prompts/constants.js";
import { TUNING } from "../src/config/defaults.js";
import { ORCHESTRATOR_SUMMARY_ALWAYS, ORCHESTRATOR_SUMMARY_BANDS } from "../src/orchestrator/models.js";
import { buildNeutralSynthesizerSystem } from "../src/synthesis/sections.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const doc = readFileSync(join(root, "ORCHESTRATION_ARCHITECTURE.md"), "utf8");

let failures = 0;
function check(label, cond, hint = "") {
  if (cond) {
    console.log(`ok   ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}${hint ? ` — ${hint}` : ""}`);
  }
}

check("STATE_PATCH_CAPS.buckets is 8", STATE_PATCH_CAPS.buckets === 8);
check("doc states buckets 8", /\b8\b.*(bullets|bucket)/i.test(doc));
check(
  "doc Live budgets match code (1200 code / 800 prose)",
  doc.includes("1200") && doc.includes("800"),
  "architectural doc must state the agent.js:261 budgets",
);
check(
  "doc prose range matches LENGTH_LIMITS.agentProseWords",
  doc.includes(LENGTH_LIMITS.agentProseWords),
  `expected ${LENGTH_LIMITS.agentProseWords}`,
);
check(
  "pinnedFacts + reserve <= buckets invariant holds",
  STATE_PATCH_CAPS.pinnedFacts + STATE_PATCH_CAPS.reserve <= STATE_PATCH_CAPS.buckets,
);
check("TUNING.MAX_CRITIQUE_RETRIES is finite", Number.isFinite(TUNING.MAX_CRITIQUE_RETRIES));
check(
  "doc does not claim the stale 320/220 Live budgets",
  !doc.includes("320 / prose 220") && !doc.includes("code 320"),
);
check(
  "doc does not claim a round-summary 8k cap",
  !/round summary.*8k|8k.*round summar/i.test(doc),
);
// State-of-Play render caps: the doc states them, the code owns them
// (SOP_CAPS), and this check fails if either side moves alone.
check(
  `doc states the SoP section caps (${SOP_CAPS.items} items / ${SOP_CAPS.itemChars} chars)`,
  new RegExp(`\\*\\*${SOP_CAPS.items} most recent\\*\\*`).test(doc) && doc.includes(String(SOP_CAPS.itemChars)),
  "doc must state the SoP item and character caps",
);
check(
  "doc does not claim the stale 5/300 SoP caps",
  !/\*\*5 most recent\*\*/.test(doc) && !/truncated to \*\*300 characters\*\*/.test(doc),
);
// One consensus section, not two: the doc must not document the split.
check(
  "doc documents the single consensus section",
  doc.includes(SOP_SECTIONS.agreed[0]),
  `doc must name the consensus section "${SOP_SECTIONS.agreed[0]}"`,
);
check(
  "doc does not present a separate '## Agreements' section",
  !/^## Agreements$/m.test(doc),
  "the shared SoP has ONE consensus section",
);
// The summary style drives the output contract, not only the word band.
check(
  "doc states the summary-style output contract",
  doc.includes(ORCHESTRATOR_SUMMARY_ALWAYS) && doc.includes(ORCHESTRATOR_SUMMARY_BANDS.concise.shape),
  "doc must state the band-driven bullet contract and the never-omitted slots",
);
// The synthesizer's window claim is resolved from the model, never hardcoded.
const neutralSystem = buildNeutralSynthesizerSystem(null);
check(
  "the synthesizer system prompt does not hardcode a window",
  !/use the 200k window/.test(neutralSystem) && /use the large window/.test(neutralSystem),
  "an unknown window must stay honest, not become 200k",
);
check(
  "the synthesizer system prompt states a resolved window",
  /use the 32k window/.test(buildNeutralSynthesizerSystem(32000)),
);
// The closing-round steer is ratchet-aware.
check(
  "doc describes the confirmation-ballot steer",
  /re-poll the superseded question/.test(doc),
  "the closing-round steer must ask for a confirmation ballot when one was already held",
);

if (failures > 0) {
  console.error(`\ndocs:verify failed with ${failures} drift(s).`);
  process.exit(1);
}
console.log("\ndocs:verify passed.");

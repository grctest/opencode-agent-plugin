// npm run docs:verify — asserts ORCHESTRATION_ARCHITECTURE.md's numeric claims
// against the live constants (audit X1/Phase 2). Fails the build on drift so
// the architecture doc cannot silently diverge from the code again.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { STATE_PATCH_CAPS } from "../src/state-patch.js";
import { LENGTH_LIMITS } from "../src/prompts/constants.js";
import { TUNING } from "../src/config/defaults.js";

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

if (failures > 0) {
  console.error(`\ndocs:verify failed with ${failures} drift(s).`);
  process.exit(1);
}
console.log("\ndocs:verify passed.");

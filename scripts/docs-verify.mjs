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
import { buildSettledBlock } from "../src/prompts/blocks.js";
import { isProviderUnavailableError } from "../src/utils/retry.js";
import { readFileSync as readFile } from "node:fs";
import { renderClerkAccount } from "../src/lib/clerk-summary.js";
import { SYNTHESIS_SECTION_CONTRACT } from "../src/synthesis/sections.js";

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
// The shared consensus section is the ORCHESTRATOR's judgement, and the room
// sees it in every round.
const settledItems = [{ text: "The room converged that scopes are Sundays [#4]", holders: ["Ada", "Ben"] }];
const settledEarly = buildSettledBlock(settledItems, false);
check(
  "the settled block carries the items in every phase",
  /The room converged/.test(settledEarly) && !/see Agreements & Proposals/.test(settledEarly),
  "the early-phase pointer named a section that was empty in every recorded meeting",
);
check(
  "doc states that the consensus section is the orchestrator's",
  /consensus section, and it is the orchestrator's/.test(doc) || /it is the \*\*round clerk's\*\* consensus judgement/.test(doc),
  "doc must state who owns the shared consensus section",
);
// The room receives the clerk's JUDGEMENT, not a prose prefix.
const clerkSummary = [
  "- **Established:** the migration landed behind a flag",
  "- **Settled:** scope is 24 Sundays excluding Sprints [#4]",
  "- **Contested:** token revocation is unresolved [#7]",
  "- **Next:** the CRO prices the parity question",
].join("\n");
const account = renderClerkAccount(clerkSummary);
check(
  "the room's copy of the clerk's account carries its action-bearing bullets",
  /Settled:.*24 Sundays/.test(account) && /Contested:.*revocation/.test(account) && /Next:.*parity/.test(account),
  "the 600-char prefix contained only the Established bullet (0/10 rounds)",
);
check(
  "doc states the clerk's account reaches the room as bullets",
  /clerk's account reaches the room as its BULLETS/.test(doc),
  "doc must describe how the room receives the clerk's account",
);
// The dissent slot is a slot, and it is sourced from the orchestrator.
check(
  "the dissent slot is part of the section contract",
  SYNTHESIS_SECTION_CONTRACT.always.includes("Dissenting Views"),
  "the artifact must always have a dissent slot",
);
// The citation-id index is part of the contract: a [​#N] a reader cannot
// resolve is a hole in the record (rule 1b + the deterministic backfill).
check(
  "the reference index is part of the section contract",
  SYNTHESIS_SECTION_CONTRACT.always.includes("References"),
  "the artifact must always carry a ## References index",
);
check(
  "the doc states the reference-index backfill",
  /citation ids resolve for a human/.test(doc) && /ensureReferenceIndex/.test(doc),
  "the human-resolvability pass must be documented in the synthesis section",
);
check(
  "doc states the dissent slot is the orchestrator's judgement",
  /Dissenting Views\*\* is a SLOT, not a detector/.test(doc) || /is a SLOT, not a detector/.test(doc),
  "doc must state that dissent is carried, not re-derived",
);
// A provider outage is its own class, and a cancelled meeting makes no calls.
check(
  "a provider outage is classified as one",
  isProviderUnavailableError(Object.assign(new Error("Upstream request failed: Endpoint is unavailable."), { status: 402, providerError: "APIError" })),
  "the endpoint-unavailable shape must be recognised so the turn routes to a fallback",
);
check(
  "a transient 5xx is not a provider outage",
  !isProviderUnavailableError(Object.assign(new Error("upstream error"), { status: 503 })),
  "per-request flakiness keeps its backoff",
);
check(
  "doc states the provider-outage class and the abort rule",
  /Provider outages are their own class/.test(doc) && /cancelled meeting makes no further calls/i.test(doc),
  "doc must state how the failure ladder treats an outage and an abort",
);
// The orchestrator is not a participant: it has its own area and is called
// last. It must never be injected into the participants table, and every
// participant list must exclude non-seat rows.
const queriesSrc = readFile(join(root, "src/dashboard/api/queries.js"), "utf8");
const exportsSrc = readFile(join(root, "src/dashboard/api/exports.js"), "utf8");
const contribSrc = readFile(join(root, "src/database/contribution-operations.js"), "utf8");
check(
  "the dashboard participant list excludes non-seat rows",
  /FROM participants WHERE status != 'summoned'/.test(queriesSrc),
  "a participant list without the filter shows a phantom seat",
);
check(
  "the export bundle's seat rows exclude non-seat rows",
  /FROM participants WHERE status != 'summoned'/.test(exportsSrc),
  "the evaluation bundle must carry seats only",
);
check(
  "the runtime participant reader excludes non-seat rows",
  /FROM participants WHERE meeting_id = \? AND status != 'summoned'/.test(contribSrc),
  "the runtime roster must carry seats only",
);
check(
  "doc states that the orchestrator is not a participant",
  /the orchestrator is never a participant/i.test(doc),
  "doc must record the orchestrator's isolation",
);

if (failures > 0) {
  console.error(`\ndocs:verify failed with ${failures} drift(s).`);
  process.exit(1);
}
console.log("\ndocs:verify passed.");

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildAgentSystemPrompt, buildAgentUserPrompt } from "../src/prompts/agent.js";
import { DEFAULT_CONFIG } from "../src/config/defaults.js";

// Golden-turn fixture (audit P3-C): one fixed agent, one fixed turn. Section
// hashes make accidental prompt edits show up as a reviewable diff — update
// the EXPECTED hashes deliberately, in the same commit as the prompt change,
// and say why in the commit message.

function sectionHashes(text) {
  const out = {};
  for (const chunk of text.trim().split(/\n[ \t]*(?=## )/)) {
    const m = chunk.match(/^## (.+?)(?:\n|$)/);
    out[(m ? m[1] : "(preamble)").trim()] = createHash("sha1")
      .update(chunk.replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);
  }
  return out;
}

function fixture() {
  const agentTools = structuredClone(DEFAULT_CONFIG.agentTools);
  const participant = {
    config: {
      id: "golden_mid", name: "Golden Analyst", tier: "mid",
      persona: "A golden-fixture analyst persona with enough characters to render verbatim in the identity block here.",
      agenda: "Hold the golden line: verify prompt structure across refactors.",
      tier_guidance: "Make one tradeoff explicit.",
      reflection_guidance: "Map through fixture lens.",
      known_biases: ["over-weights fixture scope"],
      communication_style: "Terse and exact.",
      preferred_contribution_types: ["refine"],
      anti_patterns: ["Avoid hand-waving without data — instead, cite a [#id]."],
      model: { providerID: "test", modelID: "t" },
    },
    status: "listening",
  };
  const sys = buildAgentSystemPrompt(participant, { activeCount: 4, agentTools });
  const user = buildAgentUserPrompt(
    participant,
    "## Question\nShould we ship?\n\n## Agreements\n- Ship Friday",
    [{ id: 7, participant_id: "peer_a", content: "Ship Friday is risky without a rollback plan." }],
    2, "Should we ship?", ["engineering"], "golden context", [],
    [{ id: "peer_a", name: "Peer A", tier: "senior", status: "listening", persona: "Risk person." }],
    { stance: "Ship with rollback.", established: ["rollback plan exists"], contested: [], open: ["downtime budget?"], facts: ["Rollback tested twice [#7]"], files: ["src/ship.ts"], version: 2, updated_round: 2, updated_contribution_id: 7 },
    false, true, { skillState: true },
    { maxRounds: 4, contextWindow: 200000, steeringHint: "consolidate before new threads", lastRoundSummary: "Round 1 opened the rollback thread." },
  );
  return { sys, user };
}

const EXPECTED_SYS = {
  "(preamble)": "0f0fdcb74306",
  "Identity": "502d36cd5397",
  "Agenda": "4d2e63f50946",
  "Disposition": "9a865e4985dd",
  "Craft (positive anti-patterns)": "48d74bb60ea6",
  "Tier Doctrine": "367eda2be27c",
  "Mode": "e2f67c7b37e3",
  "Research Tools — Tool Ladder": "ebf7f2ee8879",
  "WHEN TO PASS": "1904d4e9e776",
  "OUTPUT CONTRACT — read last, it governs; in conflict it wins": "2ed7d0542bbd",
};

const EXPECTED_USER = {
  "Tags: engineering": "56e10a76c6c9",
  "Round 2": "e1e1a679a199",
  "Original User Context — from the person who asked": "e20b822ca4a8",
  "State of Play — PROVISIONAL (early round — challenge cheaply; little is settled yet)": "f2652d3285fd",
  "Question": "801b74dda742",
  "Agreements": "b9bd9a58922f",
  "Last Round Summary": "718f0b0bc3f9",
  "Your State — CARRIED FORWARD (everything below is the ONLY memory you have next turn; prose is discarded)": "a38ea027ed4d",
  "Other Participants — valid loom_query targets (use target = id exactly, not display name)": "4745981b61b7",
  "Live — Recent Contributions": "fce0b7f16023",
  "Your Turn — Weighted Guidance": "f2f853a832a0",
};

test("golden system prompt sections are unchanged", () => {
  const { sys } = fixture();
  assert.deepEqual(sectionHashes(sys), EXPECTED_SYS);
});

test("golden user prompt sections are unchanged", () => {
  const { user } = fixture();
  assert.deepEqual(sectionHashes(user), EXPECTED_USER);
});

test("golden prompts keep contract-last ordering", () => {
  const { sys, user } = fixture();
  const lastSysHeader = [...sys.matchAll(/^ *## (.+?) *$/gm)].pop()?.[1] ?? "";
  assert.ok(lastSysHeader.startsWith("OUTPUT CONTRACT"), `last system section is ${lastSysHeader}`);
  assert.ok(user.trimEnd().endsWith("Nothing you write in prose carries forward on its own."), "user prompt must end on the patch line");
});

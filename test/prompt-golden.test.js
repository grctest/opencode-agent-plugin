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
      id: "golden_mid", name: "Golden Analyst", category: "mid",
      persona: "A golden-fixture analyst persona with enough characters to render verbatim in the identity block here.",
      agenda: "Hold the golden line: verify prompt structure across refactors.",
      category_guidance: "Make one tradeoff explicit.",
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
    [{ id: "peer_a", name: "Peer A", category: "senior", status: "listening", persona: "Risk person." }],
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
  "Persona Lens": "58099a30ac4a",
  // 2026-10-21 deliberation-quality revision (P1): new Subject-Matter Primacy
  // section after Persona Lens; Disposition bias clause is once-per-meeting.
  "Subject-Matter Primacy": "9407a2744440",
  "Disposition": "8ec81de19f9f",
  // 2026-10-21 (P2/P5/P9 threading): Mode + tool-ladder rework — frozen terms
  // are a round-1 first-speaker obligation, tool failure requires checking the
  // result status, and the undeclared/programming keeps the code scaffold.
  "Mode": "ff0bfbbb2d11",
  // loom_summon is capability-gated: this fixture runs with no embedding model
  // loaded (the default in a fresh checkout), so the tool ladder omits it from
  // the available list, the guidance bullet, and the mandatory-peer-interaction
  // note. The hash moves to reflect the tool being absent, not reworded.
  // Tail-pass design: loom_state_patch is hidden from the primary Available
  // list and contract (the patch-only tail owns it), and WHEN TO PASS is
  // tool-agnostic. Hashes below reflect the hidden-patch wording. Hash moved
  // again for the forum read-through fix (post-mortem 7811b8db §8): the
  // "prior [#id]" ladder line now names the [#T{id}] thread-cite form so the
  // forum satisfies the citation contract instead of grading as uncited.
  "Research Tools — Tool Ladder": "d6a2f7cd1588",
  "WHEN TO PASS": "4013ac9d695b",
  // Tool calls are unlimited: the contract states no per-turn tool-call limit.
  // Category rename: clause 5 precedence reads persona/category guidance.
  // 2026-10-21 (P2/P3/P4/P6/P7): contract gains the citation budget (§2),
  // round-1 frozen-terms obligation (§10), stance-diff patch rule, projection
  // licensing (§12), and binding query acceptance.
  "OUTPUT CONTRACT — read last, it governs; in conflict it wins": "5f06e547062b",
};

const EXPECTED_USER = {
  "Tags: engineering": "56e10a76c6c9",
  "Round 2": "e1e1a679a199",
  "Original User Context — from the person who asked": "e20b822ca4a8",
  "State of Play — PROVISIONAL (early round — challenge cheaply; little is settled yet)": "f2652d3285fd",
  "Question": "801b74dda742",
  "Agreements": "b9bd9a58922f",
  "Last Round Summary": "718f0b0bc3f9",
  "Your State — CARRIED FORWARD (your private notes for your next turn; the room never sees this block — they only read your contribution prose)": "17d527b1ab23",
  "Other Participants — valid loom_query targets (use target = id exactly, not display name)": "4745981b61b7",
  "Live — Recent Contributions": "fce0b7f16023",
  // Tail-pass: Weighted Guidance no longer ends on a patch call line — the
  // patch-only tail owns it, so recency belongs to deliberation.
  // 2026-10-21 (P2/P8): first-speaker round-1 definition obligation replaces
  // "open the strongest thread"; final-round "decides" line added to the
  // late-round density bullet.
  "Your Turn — Weighted Guidance": "b0e5899307a7",
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
  assert.ok(user.trimEnd().replace(/\}+$/, "").trimEnd().endsWith("is what the room and the end user read."), "user prompt must end on the contribution, not the patch line");
});

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAgentSystemPrompt,
  buildAgentUserPrompt,
  buildSynthesisPrompt,
  buildModeratorPrompt,
  LENGTH_LIMITS,
  TIER_ORDER,
} from "../../src/prompts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(__dirname, "../golden");
const UPDATE = process.argv.includes("--update-goldens") || process.env.UPDATE_GOLDENS === "1";

function golden(name) {
  const p = join(GOLDEN_DIR, name);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf-8");
}

function makeParticipant(overrides = {}) {
  return {
    config: {
      name: "Security Engineer",
      tier: "senior",
      persona: "You are a seasoned security engineer.",
      agenda: "Ensure baselines.",
      tags: ["security"],
      expertise: ["auth"],
      known_biases: ["Over-indexes on security"],
      communication_style: "Technical",
      preferred_contribution_types: ["CHALLENGE"],
      tier_guidance: "Senior guidance.",
      reflection_guidance: "Reflect via security lens.",
      ...overrides,
    },
    tier_config: { temperature: 0.7 },
    status: "listening",
    contributions_count: 1,
    currentBatchId: "test-batch",
    reflection: "",
  };
}

describe("prompt goldens (audit 19 Phase 2)", () => {
  test("agent system prompt golden", () => {
    const p = makeParticipant();
    const actual = buildAgentSystemPrompt(p);
    if (UPDATE) {
      writeFileSync(join(GOLDEN_DIR, "agent-system-prompt.txt"), actual);
      return;
    }
    const expected = golden("agent-system-prompt.txt");
    assert.equal(actual, expected, "Agent system prompt drift — review and run with UPDATE_GOLDENS=1 if intentional");
  });

  test("agent user prompt golden", () => {
    const p = makeParticipant();
    const actual = buildAgentUserPrompt(
      p,
      "## Decisions\n- none",
      "Prior JWT context",
      [{ id: 1, participant_id: "p1", type: "propose", content: "Use JWTs", round: 1, targets_which: null, created_at: new Date().toISOString() }],
      { number: 2, summary: "Round 1 summary" },
      "Should we migrate to JWTs?",
      ["security"]
    );
    if (UPDATE) {
      writeFileSync(join(GOLDEN_DIR, "agent-user-prompt.txt"), actual);
      return;
    }
    const expected = golden("agent-user-prompt.txt");
    assert.equal(actual, expected, "Agent user prompt drift");
  });

  test("synthesis prompt golden", () => {
    const p = makeParticipant();
    const transcript = "[#1] Propose by Alice: Use JWTs\n[#2] Challenge by Bob: Revocation is hard";
    const actual = buildSynthesisPrompt("Should we migrate to JWTs?", transcript, [p], ["security"], "## Decisions\n- none", []);
    if (UPDATE) {
      writeFileSync(join(GOLDEN_DIR, "synthesis-prompt.txt"), actual);
      return;
    }
    const expected = golden("synthesis-prompt.txt");
    assert.equal(actual, expected, "Synthesis prompt drift");
  });

  test("moderator prompt golden", () => {
    const actual = buildModeratorPrompt("deadlock flagged", 3, 5, 10, [{ type: "challenge", participant_id: "p1", content: "We disagree", tool_calls: [] }], [], "");
    if (UPDATE) {
      writeFileSync(join(GOLDEN_DIR, "moderator-prompt.txt"), actual);
      return;
    }
    const expected = golden("moderator-prompt.txt");
    assert.equal(actual, expected, "Moderator prompt drift");
  });

  test("length-limits and tier-order goldens pin the single source of truth", () => {
    if (UPDATE) {
      writeFileSync(join(GOLDEN_DIR, "length-limits.json"), JSON.stringify(LENGTH_LIMITS, null, 2) + "\n");
      writeFileSync(join(GOLDEN_DIR, "tier-order.json"), JSON.stringify(TIER_ORDER, null, 2) + "\n");
      return;
    }
    assert.deepEqual(LENGTH_LIMITS, JSON.parse(golden("length-limits.json")));
    assert.deepEqual(TIER_ORDER, JSON.parse(golden("tier-order.json")));
  });
});

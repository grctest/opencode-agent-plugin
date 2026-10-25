/**
 * Prompt for generating bespoke deliberation personas from a user's query.
 *
 * The hard requirement this prompt exists to satisfy: generated personas must
 * be *distinct takes on this specific question*, not N rephrasings of one
 * archetype. The diversity contract (§ Diversity) forces pairwise-different
 * lenses across five axes, and every persona carries an explicit `angle`
 * field so the UI can show — and a human can verify — what makes it unique.
 *
 * Pure module: string composition only, no I/O, no imports, so it is directly
 * unit-testable under node:test.
 */

export const GENERATION_CATEGORIES = ["civilian", "junior", "mid", "senior", "principal", "nonhuman"];
export const CONTRIBUTION_TYPES = ["challenge", "question", "refine", "evidence", "propose", "dissent", "synthesize", "support"];
export const MAX_GENERATE_COUNT = 8;
export const MIN_GENERATE_COUNT = 1;
export const DEFAULT_GENERATE_COUNT = 3;

const AVOID_NAMES_BUDGET = 8000;
const NEARBY_MAX = 6;
const NEARBY_AGENDA_MAX = 220;

export function clampGenerateCount(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_GENERATE_COUNT;
  return Math.min(MAX_GENERATE_COUNT, Math.max(MIN_GENERATE_COUNT, n));
}

function formatAvoidNames(names) {
  const list = Array.isArray(names) ? names.filter((n) => typeof n === "string" && n.trim()) : [];
  if (list.length === 0) return "(none)";
  let joined = list.join(", ");
  if (joined.length > AVOID_NAMES_BUDGET) joined = `${joined.slice(0, AVOID_NAMES_BUDGET)}…`;
  return joined;
}

function formatNearby(nearby) {
  const rows = (Array.isArray(nearby) ? nearby : []).slice(0, NEARBY_MAX);
  if (rows.length === 0) return "(catalog ranking unavailable)";
  return rows
    .map((p, i) => `${i + 1}. ${p?.name ?? "unknown"} [${p?.category ?? "mid"}] — ${String(p?.agenda ?? "").slice(0, NEARBY_AGENDA_MAX)}`)
    .join("\n");
}

/**
 * @param {Object} opts
 * @param {string} opts.question - the deliberation question (already sanitized/capped by caller)
 * @param {string} [opts.context]
 * @param {number} [opts.count] - how many personas to generate (1..8)
 * @param {string[]} [opts.avoidNames] - every existing catalog name (collision + lens avoidance)
 * @param {{name:string, category:string, agenda:string}[]} [opts.nearby] - catalog personas nearest the query
 * @returns {{system: string, text: string}}
 */
export function buildPersonaGenerationPrompt({ question, context = "", count = DEFAULT_GENERATE_COUNT, avoidNames = [], nearby = [] }) {
  const n = clampGenerateCount(count);
  const ctx = typeof context === "string" && context.trim() ? context.trim() : null;

  const text = `# Task
Design exactly ${n} distinct persona definitions for a deliberation room that will debate the query below. Each persona is played by an LLM agent arguing from its own point of view.

## The query
<question>
${question}
</question>${ctx ? `
<context>
${ctx}
</context>` : ""}

## Diversity contract (hard requirements)
- Every persona must own a DIFFERENT primary lens — the angle from which they judge this decision.
- Deliberately vary the set across these axes:
  - stakeholder proximity: builder/implementer, operator/maintainer, paying customer or affected end-user, adversarial/red-team, neutral observer
  - discipline: e.g. security, reliability/ops, UX, data, legal/compliance/ethics, finance, domain craft
  - risk posture: cautious, pragmatic/balanced, aggressive/bold
  - seniority: spread across junior/mid/senior/principal — do not make them all senior
  - time horizon: this quarter vs. years out
- No two personas may share the same primary lens, and no two may be the same discipline plus the same stakeholder group.
- At most one persona may be nonhuman, and only if an inhuman vantage genuinely adds something no human lens could for THIS query.
- No generic archetypes ("Senior Engineer", "Business Stakeholder", "The Expert"). Every persona is a concrete role with context and something concrete to lose if this decision goes badly.
- Every agenda must reference the actual decision at hand — not a generic discipline goal.

## The angle field
Each persona carries "angle": one sentence (≤180 chars) naming its unique take on the question. Angles must be mutually distinct — reading them in sequence should feel like a list of genuinely different objections, not synonyms.

## Schema (JSON array of exactly ${n} objects; keys exactly as listed)
{
  "name": "string, ≤80 chars, unique in this batch",
  "persona": "string, 600-1800 chars, second person: You are ... — who they are, what they have done, how they see the world, what they care about here",
  "agenda": "string, 40-600 chars, what they push for in THIS deliberation",
  "category": "${GENERATION_CATEGORIES.join(" | ")}",
  "angle": "string, ≤180 chars",
  "tags": ["3-6 short lowercase phrases"],
  "expertise": ["3-6 concrete skills"],
  "known_biases": ["2-4 entries, each a lowercase continuation like over-weights X / under-values Y / assumes Z"],
  "communication_style": "1-2 sentences describing voice and rhythm",
  "preferred_contribution_types": ["2-4 of: ${CONTRIBUTION_TYPES.join(", ")}"],
  "anti_patterns": ["2-4 entries, each of the form Never <behavior> — instead, <alternative>."],
  "category_guidance": "30-300 chars: how this persona translates the deliberation through their lens",
  "reflection_guidance": "optional, ≤300 chars: what they re-check in themselves afterward"
}

## Style rules
- Write persona/agenda/guidance as instructions to an LLM in second person ("You are ..."). Never first-person autobiography; never references to bodies, devices, sensors, or physical actions (no "as I type", "watch the screen", "call the customer").
- known_biases start lowercase and must read as continuations after "watch for these tendencies in your reasoning:".
- No run-on sentences; no circular definitions ("expert because experienced").
- Anti-patterns must be actionable and end with the alternative, not just the prohibition.
- Concrete over abstract: name the artifact, metric, or failure mode this persona would raise.

## Existing personas — do not duplicate these lenses
Names you must NOT reuse (guarantees no collisions with the ${Array.isArray(avoidNames) ? avoidNames.length : 0} existing personas):
${formatAvoidNames(avoidNames)}

Catalog personas already closest to this query — take a deliberately different angle than these (or skip them entirely if your ${n} lenses are already distinct):
${formatNearby(nearby)}

## Output
Respond with ONLY the JSON array containing exactly ${n} objects. No markdown fences, no commentary before or after.`;

  const system = "You are a deliberation-room persona designer for Loom. You write persona definitions for LLM agents that argue a specific decision from distinct, well-defined perspectives. You respond with ONLY a JSON array — no markdown fences, no prose.";

  return { system, text };
}

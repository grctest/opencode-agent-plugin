import { z } from 'zod';

/**
 * Zod schemas for validating all agent I/O and internal data structures.
 * Provides runtime validation with clear error messages.
 * Bracket-tag directives (QUERY/EVIDENCE/SUMMON/CALL_VOTE/REQUEST_NEXT) have been removed.
 * All peer interactions now use real loom_* tools (loom_query, loom_evidence, loom_vote, loom_summon, loom_request_next).
 */

// Contribution types — primary agent turns are now untyped ("contribution");
// peer responses retain their specific types for timeline grouping.
// vote_tally removed: tally is inline tool output interpreted by invoker, not a persisted row.
export const ContributionTypeSchema = z.enum([
  'contribution',
  'pass',
  'query_response',
  'perspective_response',
  'critique_response',
  'evidence_response',
  'summoned_response',
  'vote_response',
]);

// Agent response parsed from LLM output — peer-interaction fields are now always null (real tool use only)
export const AgentResponseSchema = z.object({
  participant_id: z.string(),
  content: z.string().max(20000),
  type: ContributionTypeSchema,
  request_next: z.object({
    priority: z.number().int().min(1).max(10),
    reason: z.string().min(1).max(500),
  }).nullable(),
  query: z.object({
    queries: z.array(z.object({
      target: z.string().min(1),
      question: z.string().min(1).max(500),
      mode: z.enum(['clarify', 'perspective', 'evidence', 'critique', 'risks', 'assumptions', 'alternatives']).optional(),
    })).min(1),
  }).nullable(),
  evidence: z.object({
    targets: z.array(z.string()).min(1).max(2),
    question: z.string().min(1).max(500),
  }).nullable(),
  summon: z.object({
    persona_name: z.string().min(1).max(100),
    issue: z.string().min(1).max(500),
  }).nullable(),
  vote: z.object({
    question: z.string().min(1).max(500),
  }).nullable(),
});

// SKILL.state per-agent patch schema (§5.2) — one static deliberation schema for all meetings.
//
// Hardening: this schema is NOT a gate. Every field is permissive (string, list,
// or arbitrary object) and carries no maximum, because every shape problem
// observed in production was the model's formatting, not its reasoning:
//   - 6 of 21 patches in one meeting were refused for string length (stance 401
//     vs a 400 cap, bullets 281 vs 280) — content the system wanted.
//   - 2 were refused for `{established_add: {contested_add: {contested_add:
//     {item: [...]}}}}` — the model mirroring the `_add` suffix into a nest.
// coerceStatePatch() (src/state-patch.js) normalizes all of it; applyStatePatch
// trims to STATE_PATCH_CAPS at *storage* time, so bounds still hold without
// anything ever failing. A loom_state_patch must never fail on shape.
// Every field is `z.unknown()`: the schema's job here is to be incapable of
// rejecting. Documenting the intended shape belongs in the tool description
// (which the model reads), not in a validator that can only cost a turn.
// coerceStatePatch() is the sole interpreter of whatever arrives.
//
// (zod 4.1 note: `z.record(z.any())` — the 1-arg form — throws at parse time
// with "Cannot read properties of undefined (reading '_zod')". If a record
// member is ever reintroduced here it must use the 2-arg form.)
const LoosePatchField = z.unknown();

export const StatePatchSchema = z.object({
  stance: LoosePatchField,
  established_add: LoosePatchField,
  contested_add: LoosePatchField,
  open_add: LoosePatchField,
  facts_add: LoosePatchField,
  files_add: LoosePatchField,
  remove: LoosePatchField,
}).passthrough();

// Raw parsing — no longer type-aware. Agents just write prose; the following
// agents interpret the full content directly. We keep a single placeholder type.
export function parseAgentResponseRaw(response, tier) {
  const text = response.trim();

  if (!text || text.length < 3) {
    return null;
  }

  const content = text;

  return {
    content,
    type: 'contribution',
    request_next: null,
    query: null,
    evidence: null,
    summon: null,
    vote: null,
  };
}



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
export const StatePatchSchema = z.object({
  stance: z.string().min(1).max(400).optional(),
  established_add: z.array(z.string().min(1).max(280)).max(3).default([]),
  contested_add: z.array(z.string().min(1).max(280)).max(3).default([]),
  open_add: z.array(z.string().min(1).max(280)).max(3).default([]),
  facts_add: z.array(z.string().min(1).max(280)).max(3).default([]),
  files_add: z.array(z.string().min(1).max(160)).max(3).default([]),
  remove: z.array(z.string().min(1).max(280)).max(5).default([]),
}).strict().refine(
  (p) => (p.stance !== undefined) || p.established_add.length || p.contested_add.length ||
          p.open_add.length || p.facts_add.length || p.files_add.length || p.remove.length,
  { message: "empty patch — at least one field must be set" }
);

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



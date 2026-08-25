import { z } from 'zod';

/**
 * Zod schemas for validating all agent I/O and internal data structures.
 * Provides runtime validation with clear error messages.
 * Bracket-tag directives (QUERY/EVIDENCE/SUMMON/CALL_VOTE/REQUEST_NEXT) have been removed.
 * All peer interactions now use real loom_* tools (loom_query, loom_evidence, loom_vote, loom_summon, loom_request_next).
 */

// Contribution types — primary agent turns are now untyped ("contribution");
// peer responses retain their specific types for timeline grouping.
export const ContributionTypeSchema = z.enum([
  'contribution',
  'query_response',
  'perspective_response',
  'critique_response',
  'evidence_response',
  'summoned_response',
  'vote_response',
  'vote_tally',
]);

// Kept for backward compat with stored data — always null for new turns (use loom_request_next tool instead)
export const RequestNextSchema = z.object({
  priority: z.number().int().min(1).max(10),
  reason: z.string().min(1).max(500),
}).nullable();

// Kept for backward compat — always null (use loom_query tool)
export const QuerySchema = z.object({
  queries: z.array(z.object({
    target: z.string().min(1),
    question: z.string().min(1).max(500),
    mode: z.enum(['clarify', 'perspective', 'evidence', 'critique', 'risks', 'assumptions', 'alternatives']).optional(),
  })).min(1),
}).nullable();

export const EvidenceSchema = z.object({
  targets: z.array(z.string()).min(1).max(2),
  question: z.string().min(1).max(500),
}).nullable();

export const SummonSchema = z.object({
  persona_name: z.string().min(1).max(100),
  issue: z.string().min(1).max(500),
}).nullable();

export const VoteSchema = z.object({
  question: z.string().min(1).max(500),
}).nullable();

// Agent response parsed from LLM output — peer-interaction fields are now always null (real tool use only)
export const AgentResponseSchema = z.object({
  participant_id: z.string(),
  content: z.string().max(5000),
  type: ContributionTypeSchema,
  request_next: RequestNextSchema,
  query: QuerySchema,
  evidence: EvidenceSchema,
  summon: SummonSchema,
  vote: VoteSchema,
});

// Raw parsing — no longer type-aware. Agents just write prose; the following
// agents interpret the full content directly. We keep a single placeholder type.
export function parseAgentResponseRaw(response, tier) {
  const text = response.trim();

  if (!text || text.length < 3) {
    return null;
  }

  if (text === '[PASS]') {
    return { content: '[PASS]', type: 'contribution', request_next: null, query: null, evidence: null, summon: null, vote: null };
  }

  const cleaned = text.replace(/^\[(?:PROPOSE|CHALLENGE|REFINE|SUPPORT|DISSENT|SYNTHESIZE|QUESTION|REFUSE(?::[^\]]*)?)\]\s*/i, '').trim();
  const content = cleaned.length > 0 ? cleaned : text;

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

// Kept for backward compat — now always returns null since loom_type is removed.
export function extractDeclaredType(toolResults) {
  return null;
}

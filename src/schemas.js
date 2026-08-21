import { z } from 'zod';

/**
 * Zod schemas for validating all agent I/O and internal data structures.
 * Provides runtime validation with clear error messages.
 * Bracket-tag directives (QUERY/EVIDENCE/SUMMON/CALL_VOTE/REQUEST_NEXT) have been removed.
 * All peer interactions now use real loom_* tools (loom_query, loom_evidence, loom_vote, loom_summon, loom_request_next).
 */

// Contribution types that agents can produce
export const ContributionTypeSchema = z.enum([
  'propose',
  'challenge',
  'refine',
  'support',
  'dissent',
  'synthesize',
  'question',
  'refuse',
  'query_response',
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

// Kept for backward compat — always null (use loom_query etc. tools)
export const QuerySchema = z.object({
  targets: z.array(z.string()).min(1).max(2),
  question: z.string().min(1).max(500),
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

// Raw parsing — bracket directives removed. Only contribution type prefix is parsed.
// All peer interactions now use real loom_* tools; this parser no longer extracts QUERY/EVIDENCE/SUMMON/VOTE/REQUEST_NEXT.
export function parseAgentResponseRaw(response, tier) {
  const text = response.trim();

  if (!text || text.length < 3) {
    return null;
  }

  if (text === '[PASS]') {
    return { content: '[PASS]', type: 'propose', request_next: null, query: null, evidence: null, summon: null, vote: null };
  }

  const TYPE_PREFIXES = {
    '[PROPOSE]': 'propose',
    '[CHALLENGE]': 'challenge',
    '[REFINE]': 'refine',
    '[SUPPORT]': 'support',
    '[DISSENT]': 'dissent',
    '[SYNTHESIZE]': 'synthesize',
    '[QUESTION]': 'question',
    '[REFUSE]': 'refuse',
  };

  let type = 'propose';
  let contentStart = 0;
  let refuseReason = null;

  for (const [prefix, t] of Object.entries(TYPE_PREFIXES)) {
    if (prefix === '[REFUSE]') {
      if (text.startsWith('[REFUSE]')) {
        type = t;
        contentStart = 8;
        break;
      }
      const refuseMatch = text.match(/^\[REFUSE:\s*([^\]]*?)\]\s*/i);
      if (refuseMatch) {
        type = t;
        refuseReason = refuseMatch[1].trim();
        contentStart = refuseMatch[0].length;
        break;
      }
      continue;
    }
    if (text.startsWith(prefix)) {
      type = t;
      contentStart = prefix.length;
      break;
    }
  }

  const rawContent = text.slice(contentStart).trim();

  return {
    content: refuseReason ? `${refuseReason}. ${rawContent}`.trim() : rawContent,
    type,
    request_next: null,
    query: null,
    evidence: null,
    summon: null,
    vote: null,
  };
}
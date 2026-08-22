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

// Raw parsing — contribution type is now declared via loom_type tool, not a text prefix.
// This parser only normalizes content: it handles [PASS] and strips any stray
// legacy [TAG] prefix for display cleanliness, but does NOT infer type from text.
export function parseAgentResponseRaw(response, tier) {
  const text = response.trim();

  if (!text || text.length < 3) {
    return null;
  }

  if (text === '[PASS]') {
    return { content: '[PASS]', type: 'propose', request_next: null, query: null, evidence: null, summon: null, vote: null };
  }

  // Strip a single leading legacy tag if the model still emits one (e.g. "[CHALLENGE] ...").
  // This is display hygiene only — the authoritative type comes from the loom_type tool.
  const cleaned = text.replace(/^\[(?:PROPOSE|CHALLENGE|REFINE|SUPPORT|DISSENT|SYNTHESIZE|QUESTION|REFUSE(?::[^\]]*)?)\]\s*/i, '').trim();
  const content = cleaned.length > 0 ? cleaned : text;

  return {
    content,
    type: 'propose', // placeholder — RoundExecutor overwrites with loom_type tool result
    request_next: null,
    query: null,
    evidence: null,
    summon: null,
    vote: null,
  };
}

/**
 * Extracts the declared contribution type from loom_type tool results.
 * The agent is expected to call loom_type({type}) exactly once per turn;
 * we take the last such call as authoritative. Returns null if not called.
 * @param {Array} toolResults - mapped tool results (from mapToolResults)
 * @returns {string|null}
 */
export function extractDeclaredType(toolResults) {
  if (!Array.isArray(toolResults) || toolResults.length === 0) return null;
  const VALID = new Set(['propose','challenge','refine','support','dissent','synthesize','question','refuse']);
  let found = null;
  for (const tr of toolResults) {
    const name = tr.tool ?? tr.attempted_tool;
    if (name !== 'loom_type') continue;
    if (tr.status === 'error') continue;
    // Input may be stringified JSON or object
    let input = tr.input;
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { continue; }
    }
    const candidate = typeof input?.type === 'string' ? input.type.toLowerCase().trim() : null;
    if (candidate && VALID.has(candidate)) {
      found = candidate;
    }
  }
  return found;
}
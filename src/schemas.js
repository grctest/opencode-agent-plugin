import { z } from 'zod';
import { getPriorityCap } from './shared.js';

/**
 * Zod schemas for validating all agent I/O and internal data structures.
 * Provides runtime validation with clear error messages.
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

// Turn order request directive from agent response (replaces interjection)
export const RequestNextSchema = z.object({
  priority: z.number().int().min(1).max(10),
  reason: z.string().min(1).max(500),
}).nullable();

// Directed query directive from agent response
export const QuerySchema = z.object({
  targets: z.array(z.string()).min(1).max(2),
  question: z.string().min(1).max(500),
}).nullable();

// Evidence request directive from agent response
export const EvidenceSchema = z.object({
  targets: z.array(z.string()).min(1).max(2),
  question: z.string().min(1).max(500),
}).nullable();

// Persona summon directive from agent response
export const SummonSchema = z.object({
  persona_name: z.string().min(1).max(100),
  issue: z.string().min(1).max(500),
}).nullable();

// Vote directive from agent response
export const VoteSchema = z.object({
  question: z.string().min(1).max(500),
}).nullable();

// Agent response parsed from LLM output
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

// Raw parsing (extracted from validation.js) - EXPORTED for reuse
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

  let rawContent = text.slice(contentStart).trim();

  // Parse [REQUEST_NEXT] directive (replaces [INTERJECT])
  const rnMatch = rawContent.match(
    /\[REQUEST_NEXT:\s*Priority:\s*(\d+),\s*Reason:\s*"([^"]+)"\s*\]/i,
  );

  let request_next = null;

  if (rnMatch) {
    const rawPriority = Math.min(10, Math.max(1, parseInt(rnMatch[1])));
    const priorityCap = getPriorityCap(tier);
    const priority = Math.min(rawPriority, priorityCap);
    const reason = rnMatch[2].trim();
    request_next = { priority, reason };
    rawContent = rawContent.slice(0, rnMatch.index).trim();
  }

  // Parse [QUERY: @target1, @target2] directive
  const QUERY_TAG_RE = /\[QUERY:\s*@([^\]]+)\]\s*/gi;
  let query = null;
  const queryTargets = [];
  const queryMatches = [];
  let queryMatch;

  while ((queryMatch = QUERY_TAG_RE.exec(rawContent)) !== null) {
    const ids = queryMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
    queryTargets.push(...ids);
    queryMatches.push(queryMatch);
  }

  if (queryTargets.length > 0 && queryMatches.length > 0) {
    const lastMatch = queryMatches[queryMatches.length - 1];
    const afterLastTag = lastMatch.index + lastMatch[0].length;
    const questionText = rawContent.slice(afterLastTag).trim();
    // Strip all QUERY tags from content
    rawContent = rawContent.replace(QUERY_TAG_RE, '').trim();
    // Cap at 2 targets
    query = {
      targets: queryTargets.slice(0, 2),
      question: questionText.slice(0, 500),
    };
  }

  // Parse [EVIDENCE: @target1, @target2] directive
  const EVIDENCE_TAG_RE = /\[EVIDENCE:\s*@([^\]]+)\]\s*/gi;
  let evidence = null;
  const evidenceTargets = [];
  const evidenceMatches = [];
  let evidenceMatch;

  while ((evidenceMatch = EVIDENCE_TAG_RE.exec(rawContent)) !== null) {
    const ids = evidenceMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
    evidenceTargets.push(...ids);
    evidenceMatches.push(evidenceMatch);
  }

  if (evidenceTargets.length > 0 && evidenceMatches.length > 0) {
    const lastMatch = evidenceMatches[evidenceMatches.length - 1];
    const afterLastTag = lastMatch.index + lastMatch[0].length;
    const questionText = rawContent.slice(afterLastTag).trim();
    rawContent = rawContent.replace(EVIDENCE_TAG_RE, '').trim();
    evidence = {
      targets: evidenceTargets.slice(0, 2),
      question: questionText.slice(0, 500),
    };
  }

  // Parse [SUMMON: Persona Name] directive
  const SUMMON_TAG_RE = /\[SUMMON:\s*([^\]]+)\]\s*/gi;
  let summon = null;
  const summonMatches = [];
  let summonMatch;

  while ((summonMatch = SUMMON_TAG_RE.exec(rawContent)) !== null) {
    summonMatches.push(summonMatch);
  }

  if (summonMatches.length > 0) {
    const lastMatch = summonMatches[summonMatches.length - 1];
    const afterLastTag = lastMatch.index + lastMatch[0].length;
    const issueText = rawContent.slice(afterLastTag).trim();
    rawContent = rawContent.replace(SUMMON_TAG_RE, '').trim();
    summon = {
      persona_name: lastMatch[1].trim(),
      issue: issueText.slice(0, 500),
    };
  }

  // Parse [CALL_VOTE] directive
  const VOTE_TAG_RE = /\[CALL_VOTE\]\s*/gi;
  let vote = null;
  const voteMatches = [];
  let voteMatch;

  while ((voteMatch = VOTE_TAG_RE.exec(rawContent)) !== null) {
    voteMatches.push(voteMatch);
  }

  if (voteMatches.length > 0) {
    const lastMatch = voteMatches[voteMatches.length - 1];
    const afterLastTag = lastMatch.index + lastMatch[0].length;
    const questionText = rawContent.slice(afterLastTag).trim();
    rawContent = rawContent.replace(VOTE_TAG_RE, '').trim();
    vote = {
      question: questionText.slice(0, 500),
    };
  }

  return {
    content: refuseReason ? `${refuseReason}. ${rawContent}`.trim() : rawContent,
    type,
    request_next,
    query,
    evidence,
    summon,
    vote,
  };
}
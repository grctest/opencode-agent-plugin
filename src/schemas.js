import { z } from 'zod';
import { Logger } from './logger.js';
import { getPriorityCap } from './shared.js';

const schemaLogger = new Logger();

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
  'interjection',
  'refuse',  // For Phase 5.1
]);

// Governance directive types that can be embedded in agent responses
export const GovernanceDirectiveSchema = z.object({
  directive: z.enum(['extend_rounds', 'force_converge', 'raise_objection', 'request_topic', 'nominate_synthesizer', 'escalate']),
  value: z.union([z.number(), z.string()]).optional(),
  reason: z.string().max(500).optional(),
  target_id: z.string().optional(),
});

// Interjection directive from agent response
export const InterjectionSchema = z.object({
  priority: z.number().int().min(1).max(10),
  reason: z.string().min(1).max(500),
  target: z.string().optional(),
  draft: z.string().max(2000).optional(),
}).nullable();

// Agent response parsed from LLM output
export const AgentResponseSchema = z.object({
  participant_id: z.string(),
  content: z.string().max(5000),
  type: ContributionTypeSchema,
  interjection: InterjectionSchema,
  governance: GovernanceDirectiveSchema.optional(),
});

// Validates and returns parsed result or null
export function parseAgentResponseSafe(participantId, response, tier) {
  // First parse the type prefix and interjection directive
  const parsed = parseAgentResponseRaw(response, tier);
  if (!parsed) return null;

  const result = AgentResponseSchema.safeParse({
    participant_id: participantId,
    ...parsed,
  });

  if (result.success) {
    return result.data;
  }

  // Log validation failure for debugging
  schemaLogger.warn("response_schema_failed", "Agent response failed schema validation", result.error.flatten());
  return null;
}

// Raw parsing (extracted from validation.js) - EXPORTED for reuse
export function parseAgentResponseRaw(response, tier) {
  const text = response.trim();

  if (!text || text.length < 3) {
    return null;
  }

  if (text === '[PASS]') {
    return { content: '[PASS]', type: 'propose', interjection: null };
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
  let governance = null;
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

  const ijMatch = rawContent.match(
    /\[INTERJECT:\s*Priority:\s*(\d+),\s*Reason:\s*"([^"]+)"(?:\s*,\s*Target:\s*([^\]]+?))?\s*\]/i,
  );

  let interjection = null;
  let cleanContent = rawContent;

  if (ijMatch) {
    const rawPriority = Math.min(10, Math.max(1, parseInt(ijMatch[1])));
    const priorityCap = getPriorityCap(tier);
    const priority = Math.min(rawPriority, priorityCap);
    const reason = ijMatch[2].trim();
    const target = ijMatch[3] ? ijMatch[3].trim() : null;
    const beforeIJ = rawContent.slice(0, ijMatch.index).trim();
    const afterIJ = rawContent.slice(ijMatch.index + ijMatch[0].length).trim();
    interjection = { priority, reason, target, draft: afterIJ || null };
    cleanContent = beforeIJ;
  }

  // Parse governance directive
  const govMatch = cleanContent.match(
    /\[GOVERNANCE:\s*(\w+)(?::\s*([^\]]+?))?\s*\]/i,
  );

  if (govMatch) {
    const directiveKey = govMatch[1].toLowerCase();
    const valueStr = govMatch[2];
    const directiveMap = {
      extend_rounds: 'extend_rounds',
      force_converge: 'force_converge',
      raise_objection: 'raise_objection',
      request_topic: 'request_topic',
      nominate_synthesizer: 'nominate_synthesizer',
      escalate: 'escalate',
    };
    const directive = directiveMap[directiveKey];
    if (directive) {
      let value;
      if (directive === 'extend_rounds' && valueStr) {
        const parsedNum = parseInt(valueStr, 10);
        if (Number.isFinite(parsedNum)) value = parsedNum;
      } else if (valueStr) {
        value = valueStr.trim();
      }
      governance = { directive, ...(value !== undefined ? { value } : {}), reason: valueStr || undefined };
    }
    cleanContent = cleanContent.slice(0, govMatch.index).trim() + cleanContent.slice(govMatch.index + govMatch[0].length).trim();
    cleanContent = cleanContent.trim();
  }

  return {
    content: refuseReason ? `${refuseReason}. ${cleanContent}`.trim() : cleanContent,
    type,
    interjection,
    governance,
  };
}
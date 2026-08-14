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
]);

// Governance directive types that can be embedded in agent responses
export const GovernanceDirectiveSchema = z.object({
  directive: z.enum(['extend_rounds', 'force_converge', 'raise_objection', 'request_topic', 'nominate_synthesizer', 'escalate']),
  value: z.union([z.number(), z.string()]).optional(),
  reason: z.string().max(500).optional(),
  target_id: z.string().optional(),
});

// Turn order request directive from agent response (replaces interjection)
export const RequestNextSchema = z.object({
  priority: z.number().int().min(1).max(10),
  reason: z.string().min(1).max(500),
}).nullable();

// Agent response parsed from LLM output
export const AgentResponseSchema = z.object({
  participant_id: z.string(),
  content: z.string().max(5000),
  type: ContributionTypeSchema,
  request_next: RequestNextSchema,
  governance: GovernanceDirectiveSchema.optional(),
});

// Raw parsing (extracted from validation.js) - EXPORTED for reuse
export function parseAgentResponseRaw(response, tier) {
  const text = response.trim();

  if (!text || text.length < 3) {
    return null;
  }

  if (text === '[PASS]') {
    return { content: '[PASS]', type: 'propose', request_next: null };
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

  // Parse [REQUEST_NEXT] directive (replaces [INTERJECT])
  const rnMatch = rawContent.match(
    /\[REQUEST_NEXT:\s*Priority:\s*(\d+),\s*Reason:\s*"([^"]+)"\s*\]/i,
  );

  let request_next = null;
  let cleanContent = rawContent;

  if (rnMatch) {
    const rawPriority = Math.min(10, Math.max(1, parseInt(rnMatch[1])));
    const priorityCap = getPriorityCap(tier);
    const priority = Math.min(rawPriority, priorityCap);
    const reason = rnMatch[2].trim();
    const beforeRN = rawContent.slice(0, rnMatch.index).trim();
    request_next = { priority, reason };
    cleanContent = beforeRN;
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
    request_next,
    governance,
  };
}
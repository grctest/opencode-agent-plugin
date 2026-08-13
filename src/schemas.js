import { z } from 'zod';

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
  console.warn('[Validation] Agent response failed schema:', result.error.flatten());
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

// Import getPriorityCap from shared
import { getPriorityCap } from './shared.js';

// Contribution stored in database
export const ContributionSchema = z.object({
  id: z.number().int().positive(),
  participant_id: z.string(),
  round: z.number().int().min(0),
  type: ContributionTypeSchema,
  content: z.string(),
  targets_which: z.string().nullable(),
  timestamp: z.number(),
});

// Round data structure
export const RoundSchema = z.object({
  number: z.number().int().min(1),
  contributions: z.array(ContributionSchema),
  interjections: z.array(z.object({
    participant_id: z.string(),
    target_participant_id: z.string().nullable(),
    round: z.number().int().min(1).optional(),
    priority: z.number().int().min(1).max(10),
    reason: z.string(),
    granted: z.boolean(),
    pushback: z.string().nullable(),
    resolved: z.string(),
  })),
  governance: z.array(z.object({
    participant_id: z.string(),
    directive: GovernanceDirectiveSchema.shape.directive,
    value: z.union([z.number(), z.string()]).nullable(),
  })).optional(),
  summary: z.string().optional(),
});

// Meeting state schema
export const MeetingStateSchema = z.object({
  id: z.string().uuid(),
  question: z.string(),
  context: z.string(),
  participants: z.array(z.object({
    config: z.object({
      id: z.string(),
      name: z.string(),
      persona: z.string(),
      agenda: z.string(),
      tier: z.enum(['junior', 'mid', 'senior', 'principal']),
      model: z.object({
        providerID: z.string(),
        modelID: z.string(),
      }).optional(),
    }),
    tier_config: z.object({
      temperature: z.number(),
      rights: z.object({
        contribute: z.boolean(),
        interject: z.boolean(),
        call_vote: z.boolean(),
        veto: z.boolean(),
        force_end: z.boolean(),
      }),
    }),
    session_id: z.string(),
    status: z.enum(['listening', 'speaking', 'passed', 'failed']),
    reflections: z.array(z.string()),
    contributions_count: z.number().int().min(0),
  })),
  warp: z.string(),
  weft: z.array(ContributionSchema),
  rounds: z.array(RoundSchema),
  current_round: z.number().int().min(0),
  max_rounds: z.number().int().min(1).max(10),
  status: z.enum(['initializing', 'weaving', 'converged', 'cancelled', 'timeout', 'max_rounds_reached']),
  artifact: z.object({
    content: z.string(),
    format: z.string(),
    decisions: z.array(z.string()),
    action_items: z.array(z.string()),
    dissent: z.array(z.object({
      participant_id: z.string(),
      content: z.string(),
      unresolved: z.boolean(),
    })),
    open_questions: z.array(z.string()),
    confidence: z.enum(['high', 'medium', 'low']).nullable(),
  }).nullable(),
  objections: z.array(z.object({
    participant_id: z.string(),
    content: z.string(),
    unresolved: z.boolean(),
  })),
  convergence_mode: z.enum(['consensus', 'majority', 'moderator_forces']),
  domain: z.string().nullable(),
  next_contribution_id: z.number().int().min(0),
});

// Configuration schema
export const ConfigSchema = z.object({
  agentTimeoutMs: z.number().int().min(10000).max(600000),
  synthesisTimeoutMs: z.number().int().min(10000).max(600000),
  maxWarpChars: z.number().int().min(1000).max(50000),
  maxContributionWords: z.number().int().min(50).max(2000),
  maxInterjectionWords: z.number().int().min(20).max(1000),
  defaultMaxRounds: z.number().int().min(1).max(10),
  minRounds: z.number().int().min(1).max(5),
  turnMode: z.enum(['sequential', 'staged', 'parallel']),
  stagedBatchSize: z.number().int().min(2).max(7),
  interjectionThresholds: z.object({
    autoGrant: z.number().int().min(1).max(10),
    pushback: z.number().int().min(1).max(10),
  }),
  maxInterjectionsPerRound: z.number().int().min(1).max(5),
  moderatorTrigger: z.object({
    minContributions: z.number().int().min(1).max(10),
    recentChallenges: z.number().int().min(1).max(10),
    lookbackWindow: z.number().int().min(2).max(10),
  }),
  maxRetryAttempts: z.number().int().min(0).max(5),
  retryBaseDelayMs: z.number().int().min(100).max(30000),
  retryMaxDelayMs: z.number().int().min(1000).max(60000),
  maxConcurrentPrompts: z.number().int().min(1).max(20),
  defaultMeetingTimeoutMs: z.number().int().min(60000).max(3600000),
  enableLlmWarpCompaction: z.boolean(),
  convergence: z.object({
    repetitionWindow: z.number().int().min(2).max(10),
    lowNoveltyCosineThreshold: z.number().min(0).max(1),
    diminishingReturnsWindow: z.number().int().min(2).max(10),
    semanticConvergenceFromRound: z.number().int().min(2).max(10),
    staleParticipantRatio: z.number().min(0).max(1),
    moderatorForcesMinRound: z.number().int().min(1).max(5),
    moderatorForcesHalfActiveRound: z.number().int().min(2).max(10),
  }),
});
export const TUNING = {
  MAX_ITERATIONS: 100,
  WATCHDOG_TICK_MS: 30_000,
  RING_BUFFER_SIZE: 500,
  SKIP_PASSED_MIN_ROUND: 3,
  SKIP_PASSED_LOOKBACK: 10,
  SKIP_PASSED_WINDOW: 2,
  EXTENSION_EXTRA_ROUNDS_FALLBACK: 4,
  MAX_CRITIQUE_RETRIES: 3,
  SYSTEM_PROMPT_CACHE_MAX: 50,
  EMBEDDING_CACHE_MAX: 512,
  LATENCY_SAMPLE_LIMIT: 100,
  DASHBOARD_IDLE_TIMEOUT_MS: 60_000,
  MAX_DB_CACHE_SIZE: 10,
  VOTE_TIMEOUT_MS: 60_000,
  SUMMON_TIMEOUT_MS: 90_000,
  // N9 — the closing round gets one bounded, patch-only turn per participant
  // that did not patch, so a short final round cannot cost the room its
  // memory. 0 disables the grace pass.
  FINAL_ROUND_PATCH_GRACE_MS: 45_000,
  FANOUT: { queryBatch: 5, voteBatch: 5, rpm: 100 },
  CONTENT_TRUNCATION: { question: 10000, result: 4000, content: 4000, summary: 800 },
  STATE_OF_PLAY: { bucketCap: 8, truncation: 500, reflectionTruncation: 400 },
  VEC_SEARCH_TOPK: 15,
  // Context sizing moved to utils/context-budget.js, which resolves the limit
  // per model (windows run 32k..1M) rather than from a single global constant.
  // Its CHARS_PER_TOKEN/HEADROOM are the live knobs; keep this list to
  // behavioural switches, not sizing arithmetic.
};

export const DEFAULT_CONFIG = {
  agentTimeoutMs: 240000,
  synthesisTimeoutMs: 180000,
  defaultMaxRounds: 4,
  minRounds: 2,
  fastPathModel: "",
  embeddingModel: "Snowflake/snowflake-arctic-embed-xs",
  embeddingQuant: "onnx/model_int8.onnx",
  maxSummonsPerRound: 2,
  maxSummonsPerAgent: 1,
  maxRetryAttempts: 2,
  retryBaseDelayMs: 1000,
  retryMaxDelayMs: 8000,
  synthesisMaxRetries: 1,
  stallTimeoutMs: 600000,
  dashboard: { host: "127.0.0.1" },
  composition: {
    maxCosineDistance: 0.85,
    topNPerTier: 3,
    // N11 — the one absolute distance left in composition, and a cross-tier
    // switch rather than an exclusion: a tier whose best candidate is further
    // away than this has nothing on-topic to offer, so the seat goes to the
    // best candidate in any tier rather than to the least-off-topic persona in
    // the nominal one. Raise it to disable (the relative cut alone then
    // applies, which is the P15 behaviour and the reason a keyboard
    // enthusiast ranked #2 for a car-manufacturer question).
    maxTierDistance: 1.25,
  },
  // N3 — automated artifact detectors ship advisory and OFF by default. Both
  // `Needs Verification` and `Citation Warnings` were majority-false in
  // deliberation 1355a723 (~40% precision), and a warning section that is
  // mostly wrong trains readers to skip it. A detector that cannot state its
  // precision runs dry (counts only, nothing written to the artifact) until a
  // hand-audited sample clears `precisionFloor` over `minDryRunMeetings`.
  detectors: {
    needsVerification: false,
    citationWarnings: false,
    dryRun: true,
    dryRunMeetings: 2,
    precisionFloor: 0.9,
    // A 57-character ballot cannot be checked for topical support.
    minCitationTargetChars: 400,
  },
  modelDiversity: true,
  tuning: JSON.parse(JSON.stringify(TUNING)),
  circuitBreaker: {
    failureThreshold: 3,
    resetTimeoutMs: 300000,
  },
  modelFallback: {
    enabled: true,
    maxRetriesPerModel: 2,
    maxFallbackAttempts: 1,
  },
  agentTools: {
    enabled: true,
    buildMode: false,
    builtIn: {
      webfetch: true,
      websearch: true,
      read: true,
      write: false,
      edit: false,
      bash: {
        enabled: false,
        allowlist: ["git", "ls", "wc", "head", "tail", "grep", "find", "cat"],
      },
      glob: true,
      grep: true,
      lsp: false,
    },
    loom: {
      loom_query: true,
      loom_vote: true,
      loom_summon: true,
      loom_request_next: true,
      loom_pass: true,
      loom_forum: true,
      loom_state_patch: true,
    },
    sameTurnSynthesis: true,
    // Capability policy — single default shared with the Setup tab
    // (control.js SKILL_STATE_MODES). skillState:true means the SKILL.state
    // toggle is on: every non-pass turn ends with loom_state_patch as the
    // agent's absolutely-last inline tool call. Prompt emphasis is the only
    // enforcement — a miss is logged and the turn stands (no follow-up call).
    // The salience surfaces in prompts/agent.js (contract item 8, guidance
    // bullet, final line) all render REQUIRED whenever the tool is enabled.
    mandatory: {
      forums: false,
      skillState: true,
      agentQueries: false,
      localSearch: false,
      onlineResearch: false,
    },
    reflection: {
      bash: false,
      glob: false,
      grep: false,
    },
    maxToolCallsPerTurn: 12,
    maxToolOutputTokens: 12000,
    maxQueryTargetsPerTurn: 3,
    parallelQueries: true,
  },
};

export const CONFIG_SCHEMA = {
  agentTimeoutMs: { type: 'number', min: 0, max: 600000 },
  synthesisTimeoutMs: { type: 'number', min: 0, max: 600000 },
  defaultMaxRounds: { type: 'number', min: 1, max: 10 },
  minRounds: { type: 'number', min: 1, max: 5 },
  fastPathModel: { type: 'string' },
  embeddingModel: { type: 'string' },
  embeddingQuant: { type: 'string' },
  maxRetryAttempts: { type: 'number', min: 0, max: 5 },
  retryBaseDelayMs: { type: 'number', min: 100, max: 30000 },
  retryMaxDelayMs: { type: 'number', min: 1000, max: 60000 },
  stallTimeoutMs: { type: 'number', min: 30000, max: 1800000 },
  maxSummonsPerRound: { type: 'number', min: 0, max: 5 },
  maxSummonsPerAgent: { type: 'number', min: 0, max: 3 },
  synthesisMaxRetries: { type: 'number', min: 0, max: 5 },
  modelDiversity: { type: 'boolean' },
};

export const NESTED_SCHEMA = {
  'dashboard.host': { type: 'string' },
  'composition.maxCosineDistance': { type: 'number', min: 0.1, max: 1.9 },
  'composition.topNPerTier': { type: 'number', min: 1, max: 10 },
  'composition.maxTierDistance': { type: 'number', min: 0.1, max: 2.9 },
  'detectors.needsVerification': { type: 'boolean' },
  'detectors.citationWarnings': { type: 'boolean' },
  'detectors.dryRun': { type: 'boolean' },
  'detectors.dryRunMeetings': { type: 'number', min: 1, max: 50 },
  'detectors.precisionFloor': { type: 'number', min: 0.5, max: 1 },
  'detectors.minCitationTargetChars': { type: 'number', min: 0, max: 5000 },
  'circuitBreaker.failureThreshold': { type: 'number', min: 1, max: 10 },
  'circuitBreaker.resetTimeoutMs': { type: 'number', min: 10000, max: 3600000 },
  'agentTools.enabled': { type: 'boolean' },
  'agentTools.builtIn.webfetch': { type: 'boolean' },
  'agentTools.builtIn.websearch': { type: 'boolean' },
  'agentTools.builtIn.web_fetch': { type: 'boolean' },
  'agentTools.builtIn.web_search': { type: 'boolean' },
  'agentTools.builtIn.read': { type: 'boolean' },
  'agentTools.builtIn.bash.enabled': { type: 'boolean' },
  'agentTools.builtIn.glob': { type: 'boolean' },
  'agentTools.builtIn.grep': { type: 'boolean' },
  'agentTools.builtIn.lsp': { type: 'boolean' },
  'agentTools.loom.loom_query': { type: 'boolean' },
  'agentTools.loom.loom_vote': { type: 'boolean' },
  'agentTools.loom.loom_summon': { type: 'boolean' },
  'agentTools.loom.loom_request_next': { type: 'boolean' },
  'agentTools.loom.loom_pass': { type: 'boolean' },
  'agentTools.loom.loom_forum': { type: 'boolean' },
  'agentTools.loom.loom_state_patch': { type: 'boolean' },
  'agentTools.sameTurnSynthesis': { type: 'boolean' },
  'agentTools.mandatory.forums': { type: 'boolean' },
  'agentTools.mandatory.skillState': { type: 'boolean' },
  'agentTools.mandatory.agentQueries': { type: 'boolean' },
  'agentTools.mandatory.localSearch': { type: 'boolean' },
  'agentTools.mandatory.onlineResearch': { type: 'boolean' },
  'agentTools.reflection.bash': { type: 'boolean' },
  'agentTools.reflection.glob': { type: 'boolean' },
  'agentTools.reflection.grep': { type: 'boolean' },
  'agentTools.maxToolCallsPerTurn': { type: 'number', min: 1, max: 50 },
  'agentTools.maxToolOutputTokens': { type: 'number', min: 1000, max: 20000 },
  'agentTools.maxQueryTargetsPerTurn': { type: 'number', min: 1, max: 7 },
  'agentTools.parallelQueries': { type: 'boolean' },
  'modelFallback.enabled': { type: 'boolean' },
  'modelFallback.maxRetriesPerModel': { type: 'number', min: 0, max: 5 },
  'modelFallback.maxFallbackAttempts': { type: 'number', min: 0, max: 3 },
};

export const DEPRECATED_KEYS = {
  maxTurnRequestWords: 'never enforced — turn-request length is governed by prompts; key removed',
  maxTurnRequestsPerRound: 'never enforced — ordering is planTurnOrder; key removed',
  'turnRequestThresholds.autoGrant': 'dormant by design — ordering is planTurnOrder, not autoGrant; key removed',
  'agentTools.loom.loom_evidence': 'merged into loom_query with mode evidence — use loom_query with mode evidence instead',
  'agentTools.loom.loom_type': 'removed — primary agent turns are no longer typed, following agents interpret content directly',
  'agentTools.loom.loom_vector_search': 'removed — use loom_forum or loom_query for prior context; fabric RAG deleted',
  'agentTools.patchRetry': 'removed — no enforcement follow-up call exists; mandatory flags drive prompt emphasis only, a miss is logged and the turn stands',
};

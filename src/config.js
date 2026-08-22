import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_CONFIG = {
  agentTimeoutMs: 120000,
  synthesisTimeoutMs: 180000,
  defaultMaxRounds: 3,
  minRounds: 2,
  fastPathModel: "",
  embeddingModel: "Snowflake/snowflake-arctic-embed-xs",
  embeddingQuant: "onnx/model_int8.onnx",
  maxSummonsPerRound: 2,
  maxSummonsPerAgent: 1,
  moderatorTrigger: { minContributions: 3, recentChallenges: 2, lookbackWindow: 4 },
  maxRetryAttempts: 2,
  retryBaseDelayMs: 1000,
  retryMaxDelayMs: 8000,
  synthesisMaxRetries: 1,
  defaultMeetingTimeoutMs: 900000,
  stallTimeoutMs: 300000,
  maxTotalTokens: 0,
  modelDiversity: true,
  dashboard: { host: "127.0.0.1" },
  composition: { maxCosineDistance: 0.85 },
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
    builtIn: {
      webfetch: true,
      websearch: true,
      read: true,
      bash: {
        enabled: true,
        allowlist: ["git", "ls", "wc", "head", "tail", "grep", "find"],
      },
      glob: true,
      grep: true,
      lsp: false,
    },
    loom: {
      loom_vector_search: true,
      loom_query: true,
      loom_evidence: true,
      loom_vote: true,
      loom_summon: true,
      loom_request_next: true,
      loom_type: true,
    },
    sameTurnSynthesis: true,
    reflection: {
      bash: false,
      glob: false,
      grep: false,
    },
    maxToolCallsPerTurn: 8,
    maxToolOutputTokens: 6000,
  },
};

const CONFIG_SCHEMA = {
  agentTimeoutMs: { type: 'number', min: 10000, max: 600000 },
  synthesisTimeoutMs: { type: 'number', min: 10000, max: 600000 },
  defaultMaxRounds: { type: 'number', min: 1, max: 10 },
  minRounds: { type: 'number', min: 1, max: 5 },
  fastPathModel: { type: 'string' },
  embeddingModel: { type: 'string' },
  embeddingQuant: { type: 'string' },
  maxRetryAttempts: { type: 'number', min: 0, max: 5 },
  retryBaseDelayMs: { type: 'number', min: 100, max: 30000 },
  retryMaxDelayMs: { type: 'number', min: 1000, max: 60000 },
  defaultMeetingTimeoutMs: { type: 'number', min: 60000, max: 3600000 },
  stallTimeoutMs: { type: 'number', min: 30000, max: 1800000 },
  maxTotalTokens: { type: 'number', min: 0, max: 100000000 },
  maxSummonsPerRound: { type: 'number', min: 0, max: 5 },
  maxSummonsPerAgent: { type: 'number', min: 0, max: 3 },
  modelDiversity: { type: 'boolean' },
  synthesisMaxRetries: { type: 'number', min: 0, max: 5 },
};

const NESTED_SCHEMA = {
  'moderatorTrigger.minContributions': { type: 'number', min: 1, max: 10 },
  'moderatorTrigger.recentChallenges': { type: 'number', min: 1, max: 10 },
  'moderatorTrigger.lookbackWindow': { type: 'number', min: 2, max: 10 },
  'dashboard.host': { type: 'string' },
  'composition.maxCosineDistance': { type: 'number', min: 0.1, max: 1.9 },
  'circuitBreaker.failureThreshold': { type: 'number', min: 1, max: 10 },
  'circuitBreaker.resetTimeoutMs': { type: 'number', min: 10000, max: 3600000 },
  'agentTools.enabled': { type: 'boolean' },
  'agentTools.builtIn.webfetch': { type: 'boolean' },
  'agentTools.builtIn.websearch': { type: 'boolean' },
  // Backward-compat aliases for the pre-1.x snake_case tool names
  'agentTools.builtIn.web_fetch': { type: 'boolean' },
  'agentTools.builtIn.web_search': { type: 'boolean' },
  'agentTools.builtIn.read': { type: 'boolean' },
  'agentTools.builtIn.bash.enabled': { type: 'boolean' },
  'agentTools.builtIn.glob': { type: 'boolean' },
  'agentTools.builtIn.grep': { type: 'boolean' },
  'agentTools.builtIn.lsp': { type: 'boolean' },
  'agentTools.loom.loom_vector_search': { type: 'boolean' },
  'agentTools.loom.loom_query': { type: 'boolean' },
  'agentTools.loom.loom_evidence': { type: 'boolean' },
  'agentTools.loom.loom_vote': { type: 'boolean' },
  'agentTools.loom.loom_summon': { type: 'boolean' },
  'agentTools.loom.loom_request_next': { type: 'boolean' },
  'agentTools.loom.loom_type': { type: 'boolean' },
  'agentTools.sameTurnSynthesis': { type: 'boolean' },
  'agentTools.reflection.bash': { type: 'boolean' },
  'agentTools.reflection.glob': { type: 'boolean' },
  'agentTools.reflection.grep': { type: 'boolean' },
  'agentTools.maxToolCallsPerTurn': { type: 'number', min: 1, max: 20 },
  'agentTools.maxToolOutputTokens': { type: 'number', min: 1000, max: 20000 },
  'modelFallback.enabled': { type: 'boolean' },
  'modelFallback.maxRetriesPerModel': { type: 'number', min: 0, max: 5 },
  'modelFallback.maxFallbackAttempts': { type: 'number', min: 0, max: 3 },
};

/**
 * Deep-merge `source` over `target` (audit 08 C1). Conflict semantics:
 * - object + object → recursive merge
 * - scalar source over object target → if the object has an `enabled` key, promote
 *   the scalar to `{...target, enabled: scalar}` (bash-style shorthand); otherwise the scalar replaces the object.
 * - object source over scalar target → object wins (wrap not attempted).
 * - otherwise → source wins.
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    // Polymorphic guard: builtIn.bash can be {enabled,allowlist} in target but boolean in source.
    // Preserve allowlist when user writes bash:true/false shorthand.
    if (
      source[key] !== null &&
      typeof source[key] === 'boolean' &&
      target[key] !== null &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key]) &&
      'enabled' in target[key]
    ) {
      result[key] = { ...target[key], enabled: source[key] };
      continue;
    }
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] !== null &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

/** Recursively collect leaf-key paths of a plain object ("a.b.c"). */
function collectLeafPaths(obj, prefix = '', out = []) {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) {
      collectLeafPaths(value, path, out);
    } else {
      out.push(path);
    }
  }
  return out;
}

function validateConfigKey(key, value) {
  const schema = CONFIG_SCHEMA[key];
  if (!schema) return { valid: true };
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { valid: false, error: `"${key}" must be a number, got ${typeof value}` };
    }
    if (schema.min !== undefined && value < schema.min) {
      return { valid: false, error: `"${key}" must be >= ${schema.min}, got ${value}` };
    }
    if (schema.max !== undefined && value > schema.max) {
      return { valid: false, error: `"${key}" must be <= ${schema.max}, got ${value}` };
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') {
      return { valid: false, error: `"${key}" must be a string, got ${typeof value}` };
    }
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') {
      return { valid: false, error: `"${key}" must be a boolean, got ${typeof value}` };
    }
  }
  return { valid: true };
}

function stripJsoncComments(content) {
  // String-aware state-machine parser: only strip // and /* */ when outside strings
  let withoutComments = '';
  let inString = false;
  let stringChar = '';
  let escaped = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1] ?? '';
    if (inString) {
      withoutComments += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === stringChar) {
        inString = false;
        stringChar = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      withoutComments += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      // line comment — skip to end of line
      i++;
      while (i + 1 < content.length && content[i + 1] !== '\n') {
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      // block comment — skip to */
      i++;
      while (i + 1 < content.length) {
        i++;
        if (content[i] === '*' && content[i + 1] === '/') {
          i++;
          break;
        }
      }
      continue;
    }
    withoutComments += ch;
  }

  // Remove trailing commas respecting strings
  let stripped = '';
  inString = false;
  stringChar = '';
  escaped = false;
  for (let i = 0; i < withoutComments.length; i++) {
    const ch = withoutComments[i];
    if (inString) {
      stripped += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === stringChar) {
        inString = false;
        stringChar = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      stripped += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < withoutComments.length && /\s/.test(withoutComments[j])) {
        j++;
      }
      if (j < withoutComments.length && (withoutComments[j] === '}' || withoutComments[j] === ']')) {
        continue;
      }
    }
    stripped += ch;
  }
  return stripped;
}

export function parseFastPathModel(modelStr) {
  if (!modelStr || typeof modelStr !== 'string' || !modelStr.includes('/')) return null;
  const idx = modelStr.indexOf('/');
  const providerID = modelStr.slice(0, idx).trim();
  const modelID = modelStr.slice(idx + 1).trim();
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

function parseConfigFileContent(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    // Try jsonc stripping for .jsonc files or files with comments
    if (filePath.endsWith('.jsonc') || content.includes('//') || content.includes('/*')) {
      const stripped = stripJsoncComments(content);
      parsed = JSON.parse(stripped);
    } else {
      throw e;
    }
  }
  return parsed;
}

function homeOpenCodeDir() {
  return join(homedir(), '.config', 'opencode');
}

/**
 * Collect config candidates in resolution order (audit 08 C1).
 * Project files are more specific than home files and win on conflict;
 * within a location, `.loomrc.json` (loom-native) beats opencode.json's "loom" key.
 * Returns [{path, config}] in increasing precedence order.
 */
function collectConfigCandidates(directory) {
  const candidates = [];
  const readCandidate = (path) => {
    try {
      if (!existsSync(path)) return;
      const parsed = parseConfigFileContent(path);
      if (parsed && typeof parsed === 'object') {
        // .loomrc.json: top-level keys, no wrapper; opencode.json: "loom" key wrapper
        const config = parsed.loom && typeof parsed.loom === 'object' ? parsed.loom : parsed;
        candidates.push({ path, config });
      }
    } catch { /* unreadable/malformed candidate — skipped */ }
  };

  if (directory) {
    readCandidate(join(directory, 'opencode.json'));
    readCandidate(join(directory, 'opencode.jsonc'));
    readCandidate(join(directory, '.loomrc.json'));
  }

  const homeDir = homeOpenCodeDir();
  readCandidate(join(homeDir, 'opencode.json'));
  readCandidate(join(homeDir, 'opencode.jsonc'));
  readCandidate(join(homeDir, '.loomrc.json'));

  return candidates;
}

function getNestedValue(obj, path) {
  let current = obj;
  for (const part of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function setNestedValue(obj, path, value) {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] == null || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function validateNestedConfig(userConfig, merged, warnings) {
  for (const [path, schema] of Object.entries(NESTED_SCHEMA)) {
    const value = getNestedValue(userConfig, path);
    if (value === undefined) continue;
    let invalid = false;
    let reason = '';
    if (schema.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        reason = `must be a number, got ${typeof value}`;
        invalid = true;
      } else if (schema.min !== undefined && value < schema.min) {
        reason = `must be >= ${schema.min}, got ${value}`;
        invalid = true;
      } else if (schema.max !== undefined && value > schema.max) {
        reason = `must be <= ${schema.max}, got ${value}`;
        invalid = true;
      }
    } else if (schema.type === 'boolean') {
      if (typeof value !== 'boolean') {
        reason = `must be a boolean, got ${typeof value}`;
        invalid = true;
      }
    } else if (schema.type === 'string') {
      if (typeof value !== 'string') {
        reason = `must be a string, got ${typeof value}`;
        invalid = true;
      }
    }
    if (invalid) {
      const defaultVal = getNestedValue(DEFAULT_CONFIG, path);
      warnings.push(`Config "${path}" ${reason}. Using default: ${defaultVal}`);
      setNestedValue(merged, path, defaultVal);
    }
  }
}

function validateCrossField(merged, warnings) {
  if (merged.defaultMaxRounds < merged.minRounds) {
    const prev = merged.minRounds;
    merged.minRounds = merged.defaultMaxRounds;
    warnings.push(`Config "minRounds" (${prev}) clamped to defaultMaxRounds (${merged.defaultMaxRounds}) — minRounds cannot exceed defaultMaxRounds.`);
  }
}

/**
 * Keys removed from the schema (audit 08 C3): they were never consumed by the
 * planner. Setting them now produces one clear deprecation warning instead of a nag.
 */
const DEPRECATED_KEYS = {
  maxTurnRequestWords: 'never enforced — turn-request length is governed by prompts; key removed',
  maxTurnRequestsPerRound: 'never enforced — ordering is planTurnOrder; key removed',
  'turnRequestThresholds.autoGrant': 'dormant by design — ordering is planTurnOrder, not autoGrant; key removed',
};

function validateAllowlistEntries(merged, userConfig, warnings) {
  const raw = getNestedValue(userConfig, 'agentTools.builtIn.bash.allowlist');
  if (raw === undefined) return;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    warnings.push('Config "agentTools.builtIn.bash.allowlist" must be an array of strings — ignoring non-conforming value.');
    setNestedValue(merged, 'agentTools.builtIn.bash.allowlist', [...DEFAULT_CONFIG.agentTools.builtIn.bash.allowlist]);
  }
}

/**
 * Apply LOOM_* environment overrides after file resolution (audit 08 C5).
 * LOOM_<KEY> for top-level numeric/boolean/string schema keys, e.g. LOOM_AGENT_TIMEOUT_MS.
 */
function applyEnvOverrides(merged, warnings) {
  for (const [key, schema] of Object.entries(CONFIG_SCHEMA)) {
    const envName = 'LOOM_' + key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    const raw = process.env[envName];
    if (raw === undefined || raw === '') continue;
    if (schema.type === 'number') {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        warnings.push(`Env ${envName}="${raw}" is not a number — ignored.`);
        continue;
      }
      merged[key] = parsed;
    } else if (schema.type === 'boolean') {
      merged[key] = raw === '1' || raw.toLowerCase() === 'true';
    } else {
      merged[key] = raw;
    }
  }
}

function buildConfig(directory) {
  let userConfig = {};
  const warnings = [];
  /** Per-key source tracking: leaf config path -> winning file path (audit 08 C1). */
  const keySources = {};
  let primarySource = null;

  const candidates = collectConfigCandidates(directory);
  for (const { path, config } of candidates) {
    userConfig = deepMerge(userConfig, config);
    primarySource = path;
    for (const leafPath of collectLeafPaths(config)) {
      keySources[leafPath] = path;
    }
  }

  const merged = deepMerge(DEFAULT_CONFIG, userConfig);

  // Deprecation notices for retired keys
  for (const depKey of Object.keys(DEPRECATED_KEYS)) {
    if (getNestedValue(userConfig, depKey) !== undefined) {
      warnings.push(`Config "${depKey}" is deprecated: ${DEPRECATED_KEYS[depKey]}.`);
    }
  }

  const nestedParentKeys = new Set(Object.keys(NESTED_SCHEMA).map((p) => p.split('.')[0]));

  // Recursive unknown-key detection: walk every leaf path in the user config and check it against
  // the top-level schema or the nested schema (audit 08 C2).
  const knownPaths = new Set([
    ...Object.keys(CONFIG_SCHEMA),
    ...Object.keys(NESTED_SCHEMA),
  ]);
  const validTopLevelKeys = new Set([
    ...nestedParentKeys,
    ...Object.keys(CONFIG_SCHEMA),
  ]);
  for (const leafPath of collectLeafPaths(userConfig)) {
    if (knownPaths.has(leafPath)) continue;
    const topLevel = leafPath.split('.')[0];
    if (validTopLevelKeys.has(topLevel)) continue;
    if (DEPRECATED_KEYS[leafPath] || DEPRECATED_KEYS[topLevel]) continue;
    warnings.push(`Unknown config key "${leafPath}" ignored.`);
  }

  for (const key of Object.keys(userConfig)) {
    if (CONFIG_SCHEMA[key]) {
      const result = validateConfigKey(key, userConfig[key]);
      if (!result.valid) {
        merged[key] = DEFAULT_CONFIG[key];
        warnings.push(`${result.error}. Using default: ${DEFAULT_CONFIG[key]}`);
      }
    }
  }

  validateNestedConfig(userConfig, merged, warnings);
  validateCrossField(merged, warnings);
  validateAllowlistEntries(merged, userConfig, warnings);

  applyEnvOverrides(merged, warnings);

  // Normalize fastPathModel: warn if malformed non-empty
  if (merged.fastPathModel && typeof merged.fastPathModel === 'string' && merged.fastPathModel.includes('/') === false && merged.fastPathModel.trim() !== '') {
    warnings.push(`Config "fastPathModel" should be "provider/model" format or empty, got "${merged.fastPathModel}". Ignoring.`);
    merged.fastPathModel = '';
  }
  // Normalize fastPathModel once at buildConfig
  merged.fastPathModelObj = parseFastPathModel(merged.fastPathModel);

  return { config: merged, warnings, source: primarySource ?? null, keySources };
}

export class Config {
  #directory;
  #config;
  #warnings;
  #source;
  #keySources;

  constructor(directory) {
    this.#directory = directory;
    const { config, warnings, source, keySources } = buildConfig(directory);
    this.#config = config;
    this.#warnings = warnings;
    this.#source = source;
    this.#keySources = keySources ?? {};
  }

  get() {
    return this.#config;
  }

  getWarnings() {
    return [...this.#warnings];
  }

  getSource() {
    return this.#source;
  }

  /** File that provided a given leaf config value, or null when defaulted (audit 08 C1). */
  getSourceForKey(key) {
    if (this.#keySources[key]) return this.#keySources[key];
    const topLevel = key.split('.')[0];
    return this.#keySources[topLevel] ?? null;
  }

  getValue(key) {
    return getNestedValue(this.#config, key);
  }
}

const configCache = new Map(); // key -> { config: Config, createdAt: number, mtimeMs: number|null, source: string|null }
const CONFIG_CACHE_TTL_MS = 300000; // 5 minutes
const CONFIG_CACHE_MAX_SIZE = 50;

let defaultDirectory = null;

export function setDefaultConfigDirectory(dir) {
  defaultDirectory = dir;
}

export function getConfigSource() {
  const config = createConfig(defaultDirectory);
  return config.getSource();
}

function getFileMtimeMs(filePath) {
  if (!filePath) return null;
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

export function createConfig(directory) {
  const key = directory || '__global__';
  const cached = configCache.get(key);
  if (cached) {
    const ageOk = (Date.now() - cached.createdAt) < CONFIG_CACHE_TTL_MS;
    const currentMtime = getFileMtimeMs(cached.config.getSource());
    const mtimeOk = currentMtime === cached.mtimeMs;
    // If TTL valid and mtime unchanged, reuse
    if (ageOk && mtimeOk) {
      return cached.config;
    }
    // If file changed, invalidate this entry
    if (!mtimeOk) {
      configCache.delete(key);
    } else if (!ageOk) {
      // TTL expired — fall through to recreate
      configCache.delete(key);
    }
  }
  // Evict oldest entries if cache is too large
  if (configCache.size >= CONFIG_CACHE_MAX_SIZE) {
    const oldestKey = configCache.keys().next().value;
    configCache.delete(oldestKey);
  }
  const config = new Config(directory);
  const entry = {
    config,
    createdAt: Date.now(),
    mtimeMs: getFileMtimeMs(config.getSource()),
    source: config.getSource(),
  };
  configCache.set(key, entry);
  return config;
}

export function getConfig(directory) {
  const dir = directory ?? defaultDirectory;
  const config = createConfig(dir);
  return config.get();
}

export function getConfigInstance(directory) {
  const dir = directory ?? defaultDirectory;
  return createConfig(dir);
}

/**
 * Resolves the agent tool configuration into canonical opencode tool IDs, mapping
 * the legacy snake_case names (web_fetch/web_search) onto their modern equivalents
 * (webfetch/websearch) so old configs keep working.
 * @param {Object} agentToolsConfig
 * @returns {{ webfetch: boolean, websearch: boolean, read: boolean, bash: boolean, glob: boolean, grep: boolean, lsp: boolean }}
 */
export function resolveBuiltInTools(agentToolsConfig) {
  if (!agentToolsConfig?.enabled) return {
    webfetch: false, websearch: false, read: false, bash: false, glob: false, grep: false, lsp: false,
  };
  const builtIn = agentToolsConfig.builtIn ?? {};
  return {
    webfetch: !!builtIn.webfetch || !!builtIn.web_fetch,
    websearch: !!builtIn.websearch || !!builtIn.web_search,
    read: !!builtIn.read,
    bash: builtIn.bash === true || !!(builtIn.bash && builtIn.bash.enabled),
    glob: !!builtIn.glob,
    grep: !!builtIn.grep,
    lsp: !!builtIn.lsp,
  };
}

export function resolveLoomTools(agentToolsConfig) {
  if (!agentToolsConfig?.enabled) return {
    loom_vector_search: false, loom_query: false, loom_evidence: false, loom_vote: false, loom_summon: false, loom_request_next: false, loom_type: false,
  };
  const loom = agentToolsConfig.loom ?? {};
  return {
    loom_vector_search: !!loom.loom_vector_search,
    loom_query: !!loom.loom_query,
    loom_evidence: !!loom.loom_evidence,
    loom_vote: !!loom.loom_vote,
    loom_summon: !!loom.loom_summon,
    loom_request_next: !!loom.loom_request_next,
    loom_type: !!loom.loom_type,
  };
}

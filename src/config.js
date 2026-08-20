import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_CONFIG = {
  agentTimeoutMs: 120000,
  synthesisTimeoutMs: 180000,
  maxTurnRequestWords: 200,
  defaultMaxRounds: 3,
  minRounds: 2,
  fastPathModel: "",
  embeddingModel: "Snowflake/snowflake-arctic-embed-xs",
  embeddingQuant: "onnx/model_int8.onnx",
  turnRequestThresholds: { autoGrant: 9 },
  maxTurnRequestsPerRound: 3,
  maxSummonsPerRound: 2,
  maxSummonsPerAgent: 1,
  moderatorTrigger: { minContributions: 3, recentChallenges: 2, lookbackWindow: 4 },
  maxRetryAttempts: 2,
  retryBaseDelayMs: 1000,
  retryMaxDelayMs: 8000,
  synthesisMaxRetries: 1,
  defaultMeetingTimeoutMs: 900000,
  stallTimeoutMs: 300000,
  modelDiversity: true,
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
    },
    reflection: {
      bash: false,
      glob: false,
      grep: false,
    },
    maxToolCallsPerTurn: 5,
    maxToolOutputTokens: 4000,
  },
};

const CONFIG_SCHEMA = {
  agentTimeoutMs: { type: 'number', min: 10000, max: 600000 },
  synthesisTimeoutMs: { type: 'number', min: 10000, max: 600000 },
  maxTurnRequestWords: { type: 'number', min: 20, max: 1000 },
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
  maxTurnRequestsPerRound: { type: 'number', min: 1, max: 5 },
  maxSummonsPerRound: { type: 'number', min: 0, max: 5 },
  maxSummonsPerAgent: { type: 'number', min: 0, max: 3 },
  modelDiversity: { type: 'boolean' },
  synthesisMaxRetries: { type: 'number', min: 0, max: 5 },
};

const NESTED_SCHEMA = {
  'moderatorTrigger.minContributions': { type: 'number', min: 1, max: 10 },
  'moderatorTrigger.recentChallenges': { type: 'number', min: 1, max: 10 },
  'moderatorTrigger.lookbackWindow': { type: 'number', min: 2, max: 10 },
  'turnRequestThresholds.autoGrant': { type: 'number', min: 1, max: 10 },
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
  'agentTools.reflection.bash': { type: 'boolean' },
  'agentTools.reflection.glob': { type: 'boolean' },
  'agentTools.reflection.grep': { type: 'boolean' },
  'agentTools.maxToolCallsPerTurn': { type: 'number', min: 1, max: 20 },
  'agentTools.maxToolOutputTokens': { type: 'number', min: 1000, max: 20000 },
  'modelFallback.enabled': { type: 'boolean' },
  'modelFallback.maxRetriesPerModel': { type: 'number', min: 0, max: 5 },
  'modelFallback.maxFallbackAttempts': { type: 'number', min: 0, max: 3 },
};

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
    if (schema.enum && !schema.enum.includes(value)) {
      return { valid: false, error: `"${key}" must be one of ${schema.enum.join(', ')}, got "${value}"` };
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

function findConfigFile(directory) {
  if (directory) {
    const projectConfig = join(directory, '.loomrc.json');
    if (existsSync(projectConfig)) return projectConfig;
  }
  const homeLoomConfig = join(process.env.HOME || '/root', '.config', 'opencode', '.loomrc.json');
  if (existsSync(homeLoomConfig)) return homeLoomConfig;

  // Backward compat: check opencode.json with "loom" key
  const candidates = [
    join(process.env.HOME || '/root', '.config', 'opencode', 'opencode.json'),
    join(process.env.HOME || '/root', '.config', 'opencode', 'opencode.jsonc'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const content = readFileSync(candidate, 'utf-8');
        let parsed;
        try {
          parsed = JSON.parse(content);
        } catch (e) {
          // Try jsonc stripping for .jsonc files or files with comments
          if (candidate.endsWith('.jsonc') || content.includes('//') || content.includes('/*')) {
            const stripped = stripJsoncComments(content);
            parsed = JSON.parse(stripped);
          } else {
            throw e;
          }
        }
        if (parsed && typeof parsed === 'object' && parsed.loom) {
          return candidate;
        }
      } catch { /* ignore parse errors */ }
    }
  }

  return null;
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

function buildConfig(directory) {
  let userConfig = {};
  const configFile = findConfigFile(directory);
  const warnings = [];

  if (configFile) {
    try {
      const content = readFileSync(configFile, 'utf-8');
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        if (configFile.endsWith('.jsonc') || content.includes('//') || content.includes('/*')) {
          const stripped = stripJsoncComments(content);
          parsed = JSON.parse(stripped);
        } else {
          throw e;
        }
      }
      if (parsed && typeof parsed === 'object') {
        // .loomrc.json: top-level keys, no wrapper
        // opencode.json (legacy): "loom" key wrapper
        userConfig = parsed.loom && typeof parsed.loom === 'object' ? parsed.loom : parsed;
      }
    } catch (err) {
      warnings.push(`Failed to read config from ${configFile}: ${err.message}`);
    }
  }

  const merged = deepMerge(DEFAULT_CONFIG, userConfig);

  const nestedParentKeys = new Set(Object.keys(NESTED_SCHEMA).map((p) => p.split('.')[0]));

  for (const key of Object.keys(userConfig)) {
    if (CONFIG_SCHEMA[key]) {
      const result = validateConfigKey(key, userConfig[key]);
      if (!result.valid) {
        merged[key] = DEFAULT_CONFIG[key];
        warnings.push(`${result.error}. Using default: ${DEFAULT_CONFIG[key]}`);
      }
    } else if (!nestedParentKeys.has(key)) {
      warnings.push(`Unknown config key "${key}" ignored.`);
    }
  }

  validateNestedConfig(userConfig, merged, warnings);
  validateCrossField(merged, warnings);

  // Dormant autoGrant check: turn order is planTurnOrder, not autoGrant
  const autoGrantVal = getNestedValue(userConfig, 'turnRequestThresholds.autoGrant');
  if (autoGrantVal !== undefined && autoGrantVal !== 9) {
    warnings.push('Config "turnRequestThresholds.autoGrant" is dormant — turn order is planTurnOrder, not autoGrant (see docs).');
  }

  // Normalize fastPathModel: split "provider/model" string to object? Keep as string but validate
  // Normalization is done lazily in orchestrator; here we just warn if malformed non-empty
  if (merged.fastPathModel && typeof merged.fastPathModel === 'string' && merged.fastPathModel.includes('/') === false && merged.fastPathModel.trim() !== '') {
    warnings.push(`Config "fastPathModel" should be "provider/model" format or empty, got "${merged.fastPathModel}". Ignoring.`);
    merged.fastPathModel = '';
  }
  // Normalize fastPathModel once at buildConfig
  merged.fastPathModelObj = parseFastPathModel(merged.fastPathModel);

  return { config: merged, warnings, source: configFile ?? null };
}

export class Config {
  #directory;
  #config;
  #warnings;
  #source;

  constructor(directory) {
    this.#directory = directory;
    const { config, warnings, source } = buildConfig(directory);
    this.#config = config;
    this.#warnings = warnings;
    this.#source = source;
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

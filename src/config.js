import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_CONFIG = {
  agentTimeoutMs: 120000,
  synthesisTimeoutMs: 180000,
  maxContributionWords: 250,
  maxTurnRequestWords: 200,
  defaultMaxRounds: 3,
  minRounds: 2,
  fastPathModel: "",
  turnRequestThresholds: { autoGrant: 9 },
  maxTurnRequestsPerRound: 3,
  moderatorTrigger: { minContributions: 3, recentChallenges: 2, lookbackWindow: 4 },
  maxRetryAttempts: 2,
  retryBaseDelayMs: 1000,
  retryMaxDelayMs: 8000,
  convergence: {
    repetitionWindow: 5,
    lowNoveltyCosineThreshold: 0.45,
    diminishingReturnsWindow: 3,
    semanticConvergenceFromRound: 3,
    staleParticipantRatio: 0.34,
    moderatorForcesMinRound: 2,
    moderatorForcesHalfActiveRound: 3,
    allPassedConfidence: 80,
    stalemateConfidence: 60,
    semanticConfidence: 80,
    llmVerdictConfidence: 90,
  },
  synthesisMaxRetries: 1,
  defaultMeetingTimeoutMs: 900000,
  stallTimeoutMs: 300000,
  modelDiversity: true,
  circuitBreaker: {
    failureThreshold: 3,
    resetTimeoutMs: 300000,
  },
};

const CONFIG_SCHEMA = {
  agentTimeoutMs: { type: 'number', min: 10000, max: 600000 },
  synthesisTimeoutMs: { type: 'number', min: 10000, max: 600000 },
  maxContributionWords: { type: 'number', min: 50, max: 2000 },
  maxInterjectionWords: { type: 'number', min: 20, max: 1000 },
  defaultMaxRounds: { type: 'number', min: 1, max: 10 },
  minRounds: { type: 'number', min: 1, max: 5 },
  fastPathModel: { type: 'string' },
  maxRetryAttempts: { type: 'number', min: 0, max: 5 },
  retryBaseDelayMs: { type: 'number', min: 100, max: 30000 },
  retryMaxDelayMs: { type: 'number', min: 1000, max: 60000 },
  defaultMeetingTimeoutMs: { type: 'number', min: 60000, max: 3600000 },
  stallTimeoutMs: { type: 'number', min: 30000, max: 1800000 },
  maxInterjectionsPerRound: { type: 'number', min: 1, max: 5 },
  modelDiversity: { type: 'boolean' },
  synthesisMaxRetries: { type: 'number', min: 0, max: 5 },
};

const NESTED_SCHEMA = {
  'convergence.lowNoveltyCosineThreshold': { type: 'number', min: 0, max: 1 },
  'convergence.repetitionWindow': { type: 'number', min: 2, max: 10 },
  'convergence.diminishingReturnsWindow': { type: 'number', min: 2, max: 10 },
  'convergence.semanticConvergenceFromRound': { type: 'number', min: 2, max: 10 },
  'convergence.staleParticipantRatio': { type: 'number', min: 0, max: 1 },
  'convergence.moderatorForcesMinRound': { type: 'number', min: 1, max: 5 },
  'convergence.moderatorForcesHalfActiveRound': { type: 'number', min: 2, max: 10 },
  'convergence.allPassedConfidence': { type: 'number', min: 0, max: 100 },
  'convergence.stalemateConfidence': { type: 'number', min: 0, max: 100 },
  'convergence.semanticConfidence': { type: 'number', min: 0, max: 100 },
  'convergence.llmVerdictConfidence': { type: 'number', min: 0, max: 100 },
  'synthesisMaxRetries': { type: 'number', min: 0, max: 5 },
  'moderatorTrigger.minContributions': { type: 'number', min: 1, max: 10 },
  'moderatorTrigger.recentChallenges': { type: 'number', min: 1, max: 10 },
  'moderatorTrigger.lookbackWindow': { type: 'number', min: 2, max: 10 },
  'turnRequestThresholds.autoGrant': { type: 'number', min: 1, max: 10 },
  'circuitBreaker.failureThreshold': { type: 'number', min: 1, max: 10 },
  'circuitBreaker.resetTimeoutMs': { type: 'number', min: 10000, max: 3600000 },
};

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
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
        const parsed = JSON.parse(content);
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

function validateNestedConfig(userConfig, warnings) {
  for (const [path, schema] of Object.entries(NESTED_SCHEMA)) {
    const value = getNestedValue(userConfig, path);
    if (value === undefined) continue;
    if (schema.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        warnings.push(`Config "${path}" must be a number, got ${typeof value}`);
      } else if (schema.min !== undefined && value < schema.min) {
        warnings.push(`Config "${path}" must be >= ${schema.min}, got ${value}`);
      } else if (schema.max !== undefined && value > schema.max) {
        warnings.push(`Config "${path}" must be <= ${schema.max}, got ${value}`);
      }
    }
  }
}

function buildConfig(directory) {
  let userConfig = {};
  const configFile = findConfigFile(directory);
  const warnings = [];

  if (configFile) {
    try {
      const content = readFileSync(configFile, 'utf-8');
      const parsed = JSON.parse(content);
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

  validateNestedConfig(userConfig, warnings);

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

const configCache = new Map();
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

export function createConfig(directory) {
  const key = directory || '__global__';
  const cached = configCache.get(key);
  if (cached && (Date.now() - cached._createdAt) < CONFIG_CACHE_TTL_MS) {
    return cached;
  }
  // Evict oldest entries if cache is too large
  if (configCache.size >= CONFIG_CACHE_MAX_SIZE) {
    const oldestKey = configCache.keys().next().value;
    configCache.delete(oldestKey);
  }
  const config = new Config(directory);
  config._createdAt = Date.now();
  configCache.set(key, config);
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

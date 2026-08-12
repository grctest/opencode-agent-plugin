import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_CONFIG = {
  agentTimeoutMs: 120000,
  synthesisTimeoutMs: 180000,
  maxWarpChars: 12000,
  maxContributionWords: 250,
  maxInterjectionWords: 200,
  defaultMaxRounds: 3,
  minRounds: 2,
  turnMode: "sequential",
  stagedBatchSize: 2,
  interjectionThresholds: { autoGrant: 9, pushback: 7 },
  maxInterjectionsPerRound: 3,
  moderatorTrigger: { minContributions: 3, recentChallenges: 2, lookbackWindow: 4 },
  maxRetryAttempts: 2,
  retryBaseDelayMs: 1000,
  retryMaxDelayMs: 8000,
  maxConcurrentPrompts: 7,
  convergence: {
    repetitionWindow: 5,
    lowNoveltyCosineThreshold: 0.75,
    diminishingReturnsWindow: 3,
    semanticConvergenceFromRound: 3,
    staleParticipantRatio: 0.34,
    moderatorForcesMinRound: 2,
    moderatorForcesHalfActiveRound: 3,
  },
  defaultMeetingTimeoutMs: 900000,
};

const CONFIG_SCHEMA = {
  agentTimeoutMs: { type: 'number', min: 10000, max: 600000 },
  synthesisTimeoutMs: { type: 'number', min: 10000, max: 600000 },
  maxWarpChars: { type: 'number', min: 1000, max: 50000 },
  maxContributionWords: { type: 'number', min: 50, max: 2000 },
  maxInterjectionWords: { type: 'number', min: 20, max: 1000 },
  defaultMaxRounds: { type: 'number', min: 1, max: 10 },
  minRounds: { type: 'number', min: 1, max: 5 },
  turnMode: { type: 'string', enum: ['sequential', 'staged', 'parallel'] },
  stagedBatchSize: { type: 'number', min: 2, max: 7 },
  maxRetryAttempts: { type: 'number', min: 0, max: 5 },
  retryBaseDelayMs: { type: 'number', min: 100, max: 30000 },
  retryMaxDelayMs: { type: 'number', min: 1000, max: 60000 },
  maxConcurrentPrompts: { type: 'number', min: 1, max: 20 },
  defaultMeetingTimeoutMs: { type: 'number', min: 60000, max: 3600000 },
  maxInterjectionsPerRound: { type: 'number', min: 1, max: 5 },
};

const NESTED_SCHEMA = {
  'convergence.lowNoveltyCosineThreshold': { type: 'number', min: 0, max: 1 },
  'convergence.repetitionWindow': { type: 'number', min: 2, max: 10 },
  'convergence.diminishingReturnsWindow': { type: 'number', min: 2, max: 10 },
  'convergence.semanticConvergenceFromRound': { type: 'number', min: 2, max: 10 },
  'convergence.staleParticipantRatio': { type: 'number', min: 0, max: 1 },
  'convergence.moderatorForcesMinRound': { type: 'number', min: 1, max: 5 },
  'convergence.moderatorForcesHalfActiveRound': { type: 'number', min: 2, max: 10 },
  'moderatorTrigger.minContributions': { type: 'number', min: 1, max: 10 },
  'moderatorTrigger.recentChallenges': { type: 'number', min: 1, max: 10 },
  'moderatorTrigger.lookbackWindow': { type: 'number', min: 2, max: 10 },
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
  }
  return { valid: true };
}

function findConfigFile(directory) {
  if (directory) {
    const projectConfig = join(directory, '.loomrc.json');
    if (existsSync(projectConfig)) return projectConfig;
  }
  const candidates = [
    join(process.env.HOME || '/root', '.config', 'opencode', 'opencode.json'),
    join(process.env.HOME || '/root', '.config', 'opencode', 'opencode.jsonc'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const configCache = new Map();
let globalWarnings = [];
let activeConfig = null;
let activeConfigSource = null;

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
        const isLoomRc = configFile.endsWith('.loomrc.json');
        if (parsed.loom && typeof parsed.loom === 'object') {
          userConfig = parsed.loom;
        } else if (isLoomRc) {
          userConfig = parsed;
        }
      }
    } catch (err) {
      warnings.push(`Failed to read config from ${configFile}: ${err.message}`);
    }
  }

  const merged = deepMerge(DEFAULT_CONFIG, userConfig);

  for (const key of Object.keys(userConfig)) {
    if (CONFIG_SCHEMA[key]) {
      const result = validateConfigKey(key, userConfig[key]);
      if (!result.valid) {
        warnings.push(`${result.error}. Using default: ${DEFAULT_CONFIG[key]}`);
      }
    }
  }

  validateNestedConfig(userConfig, warnings);

  return { config: merged, warnings, source: configFile ?? null };
}

export function loadConfig(directory) {
  const key = directory || '__global__';
  if (configCache.has(key)) {
    const cached = configCache.get(key);
    globalWarnings = cached.warnings;
    activeConfig = cached.config;
    activeConfigSource = cached.source;
    return cached.config;
  }

  const { config, warnings, source } = buildConfig(directory);
  configCache.set(key, { config, warnings, source });
  globalWarnings = warnings;
  activeConfig = config;
  activeConfigSource = source;
  return config;
}

export function getConfig(directory) {
  if (directory) {
    return loadConfig(directory);
  }
  if (activeConfig) {
    return activeConfig;
  }
  if (configCache.has('__global__')) {
    const cached = configCache.get('__global__');
    activeConfig = cached.config;
    activeConfigSource = cached.source;
    return cached.config;
  }
  const { config, warnings, source } = buildConfig(null);
  configCache.set('__global__', { config, warnings, source });
  globalWarnings = warnings;
  activeConfig = config;
  activeConfigSource = source;
  return config;
}

/** Returns the path of the config file that was loaded (null = defaults only). */
export function getConfigSource() {
  return activeConfigSource;
}

export function getConfigValidationWarnings() {
  return [...globalWarnings];
}

export function resetConfig() {
  configCache.clear();
  globalWarnings = [];
  activeConfig = null;
  activeConfigSource = null;
}

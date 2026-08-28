import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, CONFIG_SCHEMA, NESTED_SCHEMA, DEPRECATED_KEYS } from "./defaults.js";
import { deepMerge, collectLeafPaths, getNestedValue, setNestedValue, stripJsoncComments, parseFastPathModel, homeOpenCodeDir } from "./utils.js";
import { validateConfigKey, validateNestedConfig, validateCrossField, validateAllowlistEntries, applyEnvOverrides } from "./validation.js";
import { Logger, extractErrorInfo } from "../logger.js";

export { parseFastPathModel };

function parseConfigFileContent(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    // Always try JSONC strip on parse failure (heuristic content.includes('//') misses // inside string)
    try {
      const stripped = stripJsoncComments(content);
      parsed = JSON.parse(stripped);
    } catch {
      throw e;
    }
  }
  return parsed;
}

function collectConfigCandidates(directory) {
  const logger = new Logger();
  const candidates = [];
  const readCandidate = (path) => {
    try {
      if (!existsSync(path)) return;
      const parsed = parseConfigFileContent(path);
      if (parsed && typeof parsed === 'object') {
        const config = parsed.loom && typeof parsed.loom === 'object' ? parsed.loom : parsed;
        candidates.push({ path, config });
      }
    } catch (err) {
      logger.warn("config_candidate_failed", `Skipping unreadable config candidate ${path}`, extractErrorInfo(err));
    }
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

export function buildConfig(directory) {
  let userConfig = {};
  const warnings = [];
  const keySources = {};
  let primarySource = null;

  const candidates = collectConfigCandidates(directory);
  // Candidates are collected home-first via build order in collectConfigCandidates
  // (directory entries pushed first, home pushed after). Reversing makes project win.
  const ordered = [...candidates].reverse();
  for (const { path, config } of ordered) {
    userConfig = deepMerge(userConfig, config);
    primarySource = path;
    for (const leafPath of collectLeafPaths(config)) {
      keySources[leafPath] = path;
    }
  }

  const merged = deepMerge(DEFAULT_CONFIG, userConfig);

  for (const depKey of Object.keys(DEPRECATED_KEYS)) {
    if (getNestedValue(userConfig, depKey) !== undefined) {
      warnings.push(`Config "${depKey}" is deprecated: ${DEPRECATED_KEYS[depKey]}.`);
    }
  }

  const nestedParentKeys = new Set(Object.keys(NESTED_SCHEMA).map((p) => p.split('.')[0]));

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
  // Re-validate after env overrides — env can bypass file validation (e.g. LOOM_AGENT_TIMEOUT_MS=5)
  for (const key of Object.keys(CONFIG_SCHEMA)) {
    if (process.env['LOOM_' + key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()] !== undefined) {
      const result = validateConfigKey(key, merged[key]);
      if (!result.valid) {
        warnings.push(`Env LOOM_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()} invalid: ${result.error}. Using default: ${DEFAULT_CONFIG[key]}`);
        merged[key] = DEFAULT_CONFIG[key];
      }
    }
  }
  // Re-validate nested env overrides (strip prefix for nested keys is not auto; only top-level env handled today)
  validateCrossField(merged, warnings);

  if (merged.fastPathModel && typeof merged.fastPathModel === 'string' && merged.fastPathModel.includes('/') === false && merged.fastPathModel.trim() !== '') {
    warnings.push(`Config "fastPathModel" should be "provider/model" format or empty, got "${merged.fastPathModel}". Ignoring.`);
    merged.fastPathModel = '';
  }
  merged.fastPathModelObj = parseFastPathModel(merged.fastPathModel);

  return { config: merged, warnings, source: primarySource ?? null, keySources };
}

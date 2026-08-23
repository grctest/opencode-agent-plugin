import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, CONFIG_SCHEMA, NESTED_SCHEMA, DEPRECATED_KEYS } from "./defaults.js";
import { deepMerge, collectLeafPaths, getNestedValue, setNestedValue, stripJsoncComments, parseFastPathModel, homeOpenCodeDir } from "./utils.js";
import { validateConfigKey, validateNestedConfig, validateCrossField, validateAllowlistEntries, applyEnvOverrides } from "./validation.js";

export { parseFastPathModel };

function parseConfigFileContent(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    if (filePath.endsWith('.jsonc') || content.includes('//') || content.includes('/*')) {
      const stripped = stripJsoncComments(content);
      parsed = JSON.parse(stripped);
    } else {
      throw e;
    }
  }
  return parsed;
}

function collectConfigCandidates(directory) {
  const candidates = [];
  const readCandidate = (path) => {
    try {
      if (!existsSync(path)) return;
      const parsed = parseConfigFileContent(path);
      if (parsed && typeof parsed === 'object') {
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

export function buildConfig(directory) {
  let userConfig = {};
  const warnings = [];
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

  if (merged.fastPathModel && typeof merged.fastPathModel === 'string' && merged.fastPathModel.includes('/') === false && merged.fastPathModel.trim() !== '') {
    warnings.push(`Config "fastPathModel" should be "provider/model" format or empty, got "${merged.fastPathModel}". Ignoring.`);
    merged.fastPathModel = '';
  }
  merged.fastPathModelObj = parseFastPathModel(merged.fastPathModel);

  return { config: merged, warnings, source: primarySource ?? null, keySources };
}

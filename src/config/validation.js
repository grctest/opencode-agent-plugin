import { CONFIG_SCHEMA, NESTED_SCHEMA, DEFAULT_CONFIG, DEPRECATED_KEYS } from "./defaults.js";
import { getNestedValue, setNestedValue } from "./utils.js";

export function validateConfigKey(key, value) {
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

export function validateNestedConfig(userConfig, merged, warnings) {
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

export function validateCrossField(merged, warnings) {
  if (merged.defaultMaxRounds < merged.minRounds) {
    const prev = merged.minRounds;
    merged.minRounds = merged.defaultMaxRounds;
    warnings.push(`Config "minRounds" (${prev}) clamped to defaultMaxRounds (${merged.defaultMaxRounds}) — minRounds cannot exceed defaultMaxRounds.`);
  }
}

export function validateAllowlistEntries(merged, userConfig, warnings) {
  const raw = getNestedValue(userConfig, 'agentTools.builtIn.bash.allowlist');
  if (raw === undefined) return;
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    warnings.push('Config "agentTools.builtIn.bash.allowlist" must be an array of strings — ignoring non-conforming value.');
    setNestedValue(merged, 'agentTools.builtIn.bash.allowlist', [...DEFAULT_CONFIG.agentTools.builtIn.bash.allowlist]);
  }
}

export function applyEnvOverrides(merged, warnings) {
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
  for (const [path, schema] of Object.entries(NESTED_SCHEMA)) {
    const envName = 'LOOM_' + path.replace(/\./g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
    const raw = process.env[envName];
    if (raw === undefined || raw === '') continue;
    if (schema.type === 'number') {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        warnings.push(`Env ${envName}="${raw}" is not a number — ignored.`);
        continue;
      }
      setNestedValue(merged, path, parsed);
    } else if (schema.type === 'boolean') {
      setNestedValue(merged, path, raw === '1' || raw.toLowerCase() === 'true');
    } else {
      setNestedValue(merged, path, raw);
    }
  }
}

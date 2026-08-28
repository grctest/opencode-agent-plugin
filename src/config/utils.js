import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function applyBooleanToBuiltIn(targetObj, value) {
  const clone = { ...targetObj };
  for (const k of Object.keys(clone)) {
    if (typeof clone[k] === 'boolean') clone[k] = value;
    else if (clone[k] !== null && typeof clone[k] === 'object' && 'enabled' in clone[k]) clone[k] = { ...clone[k], enabled: value };
  }
  return clone;
}

export function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === 'boolean' &&
      target[key] !== null &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      const isAgentToolsFamily = key === 'agentTools' || key === 'builtIn' || key === 'loom' || key === 'reflection' || key === 'bash';
      if (isAgentToolsFamily) {
        if ('enabled' in target[key]) {
          result[key] = { ...target[key], enabled: source[key] };
        } else if (key === 'builtIn' || key === 'loom' || key === 'reflection') {
          // builtIn: true/false shorthand — enable/disable all sub-tools
          result[key] = applyBooleanToBuiltIn(target[key], source[key]);
        } else {
          result[key] = source[key];
        }
        continue;
      }
      result[key] = source[key];
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

export function collectLeafPaths(obj, prefix = '', out = []) {
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

export function getNestedValue(obj, path) {
  if (typeof path !== 'string' || path.length === 0) return undefined;
  let current = obj;
  for (const part of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

export function setNestedValue(obj, path, value) {
  if (typeof path !== 'string' || path.length === 0) return;
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

export function stripJsoncComments(content) {
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
      i++;
      while (i + 1 < content.length && content[i + 1] !== '\n') {
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
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

export function homeOpenCodeDir() {
  return join(homedir(), '.config', 'opencode');
}

export function getFileMtimeMs(filePath) {
  if (!filePath) return null;
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

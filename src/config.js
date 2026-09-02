import { buildConfig } from "./config/loader.js";
import { getNestedValue, getFileMtimeMs, parseFastPathModel } from "./config/utils.js";

export { parseFastPathModel };

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

  /** File that provided a given leaf config value, or null when defaulted. */
  getSourceForKey(key) {
    if (this.#keySources[key]) return this.#keySources[key];
    const topLevel = key.split('.')[0];
    return this.#keySources[topLevel] ?? null;
  }

  getValue(key) {
    return getNestedValue(this.#config, key);
  }
}

const configCache = new Map();
const CONFIG_CACHE_TTL_MS = 300000;
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
  if (cached) {
    const ageOk = (Date.now() - cached.createdAt) < CONFIG_CACHE_TTL_MS;
    const currentMtime = getFileMtimeMs(cached.config.getSource());
    const mtimeOk = currentMtime === cached.mtimeMs;
    if (ageOk && mtimeOk) {
      return cached.config;
    }
    if (!mtimeOk) {
      configCache.delete(key);
    } else if (!ageOk) {
      configCache.delete(key);
    }
  }
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

export function resolveBuiltInTools(agentToolsConfig) {
  if (!agentToolsConfig?.enabled) return {
    webfetch: false, websearch: false, read: false, write: false, edit: false, bash: false, glob: false, grep: false, lsp: false,
  };
  const builtIn = agentToolsConfig.builtIn ?? {};
  return {
    webfetch: !!builtIn.webfetch || !!builtIn.web_fetch,
    websearch: !!builtIn.websearch || !!builtIn.web_search,
    read: !!builtIn.read,
    write: !!builtIn.write,
    edit: !!builtIn.edit,
    bash: builtIn.bash === true || !!(builtIn.bash && builtIn.bash.enabled),
    glob: !!builtIn.glob,
    grep: !!builtIn.grep,
    lsp: !!builtIn.lsp,
  };
}

export function resolveLoomTools(agentToolsConfig) {
  if (!agentToolsConfig?.enabled) return {
    loom_query: false, loom_vote: false, loom_summon: false, loom_request_next: false, loom_pass: false, loom_forum: false,
  };
  const loom = agentToolsConfig.loom ?? {};
  return {
    loom_query: !!loom.loom_query,
    loom_vote: !!loom.loom_vote,
    loom_summon: !!loom.loom_summon,
    loom_request_next: !!loom.loom_request_next,
    loom_pass: !!loom.loom_pass,
    loom_forum: !!loom.loom_forum,
  };
}

function deepFreeze(obj) {
  if (obj && typeof obj === "object" && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}
export function createMeetingConfig(directory, overrides = {}) {
  const base = getConfig(directory);
  const merged = JSON.parse(JSON.stringify(base));
  for (const [k, v] of Object.entries(overrides)) {
    merged[k] = v;
  }
  return deepFreeze(merged);
}

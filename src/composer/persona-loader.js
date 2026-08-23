import { readFileSync, existsSync, readdirSync, watch } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { Logger, extractErrorInfo } from "../logger.js";
import { PersonaIndex } from "../services/persona-index.js";
import { getConfig } from "../config.js";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_QUANT } from "../services/model-manager.js";

const __dirname = dirname(fileURLToPath(new URL(".", import.meta.url)));
const composerLogger = new Logger();

function personasBasePath() {
  const candidates = [
    join(__dirname, "../..", "personas", "loom"),
    join(__dirname, "../..", "personas"),
    join(__dirname, "..", "personas", "loom"),
    join(__dirname, "..", "personas"),
    join(__dirname, "personas", "loom"),
    join(__dirname, "personas"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "junior")) || existsSync(join(candidate, "domains.json"))) {
      return candidate;
    }
  }
  return candidates[0];
}

function userPersonasPath() {
  const configDir = process.env.LOOM_CONFIG_DIR || join(homedir(), ".config", "opencode", "loom");
  const personasDir = join(configDir, "personas");
  const tiers = ["junior", "mid", "senior", "principal", "civilian"];
  for (const tier of tiers) {
    if (existsSync(join(personasDir, tier))) {
      return personasDir;
    }
  }
  return null;
}

// domains.json domain vocabulary (audit 13 PC4/PC5): loaded once, used to boost
// persona scores in the keyword composition fallback.
let domainVocabCache = null;
export function loadDomainVocabulary() {
  if (domainVocabCache !== null) return domainVocabCache;
  domainVocabCache = {};
  try {
    const base = personasBasePath();
    const file = join(base, "domains.json");
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        domainVocabCache = Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.map(String) : []]),
        );
      }
    }
  } catch (err) {
    composerLogger.warn("domain_vocab_load_failed", "Failed to load domains.json — keyword fallback runs without domain boosts", extractErrorInfo(err));
    domainVocabCache = {};
  }
  return domainVocabCache;
}

function validatePersona(persona) {
  const errors = [];
  if (!persona.name || typeof persona.name !== "string") errors.push("name required");
  if (!persona.persona || typeof persona.persona !== "string") errors.push("persona description required");
  else if (persona.persona.length < 50) errors.push("persona description must be >50 chars");
  if (!persona.agenda || typeof persona.agenda !== "string") errors.push("agenda required");
  else if (persona.agenda.length < 20) errors.push("agenda must be >20 chars");
  const hasTags = persona.tags || persona.domains || persona.domain;
  if (!hasTags || (typeof hasTags !== "string" && !Array.isArray(hasTags))) errors.push("tags required");
  return errors;
}

function normalizePersona(persona) {
  if (typeof persona.domain === "string" && !persona.tags) {
    persona.tags = [persona.domain];
    delete persona.domain;
  } else if (Array.isArray(persona.domains) && !persona.tags) {
    persona.tags = persona.domains;
    delete persona.domains;
  } else if (typeof persona.domains === "string" && !persona.tags) {
    persona.tags = [persona.domains];
    delete persona.domains;
  }
  if (typeof persona.tags === "string") {
    persona.tags = [persona.tags];
  }
  persona.version = persona.version || "1.0";
  return persona;
}

function loadPersonasFromPath(base) {
  const tiers = ["junior", "mid", "senior", "principal", "civilian"];
  const result = {};
  let totalLoaded = 0;
  let totalRejected = 0;

  for (const tier of tiers) {
    try {
      const tierDir = join(base, tier);
      if (!existsSync(tierDir)) {
        const legacyPath = join(base, `${tier}.json`);
        if (existsSync(legacyPath)) {
          result[tier] = loadLegacyPersonaFile(legacyPath, tier);
          totalLoaded += result[tier].length;
        } else {
          result[tier] = [];
        }
        continue;
      }

      result[tier] = [];
      const files = readdirSync(tierDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const filePath = join(tierDir, file);
          const data = readFileSync(filePath, "utf-8");
          const p = JSON.parse(data);
          const errors = validatePersona(p);
          if (errors.length > 0) {
            composerLogger.warn("invalid_persona", `Invalid persona at ${tier}/${file} (${p.name ?? "unnamed"})`, { errors });
            totalRejected++;
            continue;
          }
          result[tier].push(normalizePersona(p));
          totalLoaded++;
        } catch (err) {
          composerLogger.warn("persona_load_failed", `Failed to load persona from ${tier}/${file}`, { error: err.message });
          totalRejected++;
        }
      }
    } catch (err) {
      if (!result[tier]) result[tier] = [];
      if (err.code !== "ENOENT") {
        composerLogger.warn("persona_load_failed", `Failed to load personas from ${base}/${tier}/`, { error: err.message });
      }
    }
  }

  if (totalRejected > 0) {
    composerLogger.warn("persona_validation_summary", `Persona validation: ${totalLoaded} loaded, ${totalRejected} rejected from ${base}`);
  }

  return result;
}

function loadLegacyPersonaFile(filePath, tier) {
  try {
    const data = readFileSync(filePath, "utf-8");
    const raw = JSON.parse(data);
    const personas = [];
    for (let i = 0; i < raw.length; i++) {
      const p = raw[i];
      const errors = validatePersona(p);
      if (errors.length > 0) {
        composerLogger.warn("invalid_persona", `Invalid persona at ${tier}[${i}] (${p.name ?? "unnamed"})`, { errors });
        continue;
      }
      personas.push(normalizePersona(p));
    }
    return personas;
  } catch (err) {
    composerLogger.warn("persona_load_failed", `Failed to load legacy persona file ${filePath}`, { error: err.message });
    return [];
  }
}

let personaCache = null;
let personaCachePath = null;
let personaCacheTimestamp = 0;
const PERSONA_CACHE_TTL_MS = 60000;
let personaWatchSetup = false;
function setupPersonaWatch() {
  if (personaWatchSetup) return;
  personaWatchSetup = true;
  try {
    const base = personasBasePath();
    watch(base, { recursive: true }, () => { personaCache = null; });
    const userPath = userPersonasPath();
    if (userPath) {
      try { watch(userPath, { recursive: true }, () => { personaCache = null; }); } catch {}
    }
  } catch {}
}

function loadPersonas() {
  setupPersonaWatch();
  const basePath = personasBasePath();
  const userPath = userPersonasPath();

  const now = Date.now();
  if (personaCache && personaCachePath === basePath && (now - personaCacheTimestamp) < PERSONA_CACHE_TTL_MS) {
    return personaCache;
  }

  const result = loadPersonasFromPath(basePath);

  if (userPath) {
    const userPersonas = loadPersonasFromPath(userPath);
    for (const [tier, personas] of Object.entries(userPersonas)) {
      if (personas.length > 0) {
        if (!result[tier]) result[tier] = [];
        const existingNames = new Set(result[tier].map((p) => p.name));
        for (const p of personas) {
          if (!existingNames.has(p.name)) {
            result[tier].push(p);
          }
        }
      }
    }
  }

  personaCache = result;
  personaCachePath = basePath;
  personaCacheTimestamp = Date.now();
  return result;
}

export function getPersonas() {
  return loadPersonas();
}

export function getPersonaTags(persona) {
  if (Array.isArray(persona.tags)) return persona.tags;
  if (typeof persona.tags === "string") return [persona.tags];
  if (Array.isArray(persona.domains)) return persona.domains;
  if (typeof persona.domains === "string") return [persona.domains];
  if (typeof persona.domain === "string") return [persona.domain];
  return [];
}


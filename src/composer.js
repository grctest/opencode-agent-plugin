import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger, extractErrorInfo } from "./logger.js";
import { PersonaIndex } from "./services/persona-index.js";
import { getConfig } from "./config.js";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_QUANT } from "./services/model-manager.js";

const __dirname = dirname(fileURLToPath(new URL(".", import.meta.url)));
const composerLogger = new Logger();

function personasBasePath() {
  const candidates = [
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
  const configDir = process.env.LOOM_CONFIG_DIR || join(process.env.HOME || "/root", ".config", "opencode", "loom");
  const personasDir = join(configDir, "personas");
  const tiers = ["junior", "mid", "senior", "principal"];
  for (const tier of tiers) {
    if (existsSync(join(personasDir, tier))) {
      return personasDir;
    }
  }
  return null;
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
  const tiers = ["junior", "mid", "senior", "principal"];
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

function loadPersonas() {
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

function getPersonaTags(persona) {
  if (Array.isArray(persona.tags)) return persona.tags;
  if (typeof persona.tags === "string") return [persona.tags];
  if (Array.isArray(persona.domains)) return persona.domains;
  if (typeof persona.domains === "string") return [persona.domains];
  if (typeof persona.domain === "string") return [persona.domain];
  return [];
}

function analyzeQuestionComplexity(question) {
  const wordCount = question.split(/\s+/).length;
  const questionMarks = (question.match(/\?/g) || []).length;
  const hasMultipleDimensions = /and|or|vs|versus|compare|tradeoff|pros.?cons|advantages.?disadvantages/i.test(question);
  const hasConditionals = /if|when|assuming|given that|depending on|considering/i.test(question);
  const hasStakeholders = /team|customer|user|client|stakeholder|executive|leadership|board/i.test(question);

  let score = 0;
  if (wordCount > 30) score += 2; else if (wordCount > 15) score += 1;
  if (questionMarks > 1) score += 1;
  if (hasMultipleDimensions) score += 2;
  if (hasConditionals) score += 1;
  if (hasStakeholders) score += 1;

  if (score >= 5) return "high";
  if (score >= 3) return "medium";
  return "low";
}

function generateRolesFromComplexity(count, complexity) {
  const seniorityBoost = complexity === "high" ? 1 : complexity === "medium" ? 0 : -1;

  if (count <= 3) {
    return applySeniorityBoost(["mid", "junior", "junior"], seniorityBoost);
  } else if (count <= 5) {
    return applySeniorityBoost(["senior", "mid", "junior", "junior", "junior"], seniorityBoost);
  } else {
    return applySeniorityBoost(["senior", "mid", "mid", "junior", "junior", "junior", "junior"], seniorityBoost);
  }
}

function applySeniorityBoost(roles, boost) {
  const tierOrder = ["junior", "mid", "senior", "principal"];
  if (boost === 0) return roles;

  return roles.map((role) => {
    const idx = tierOrder.indexOf(role);
    if (idx === -1) return role;
    const newIdx = Math.max(0, Math.min(tierOrder.length - 1, idx + boost));
    return tierOrder[newIdx];
  });
}

function deriveTags(participants) {
  const tagCounts = {};
  for (const p of participants) {
    for (const t of (p.tags || [])) {
      tagCounts[t] = (tagCounts[t] || 0) + 1;
    }
  }
  return Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([tag]) => tag);
}

function findPersonaByName(personas, tier, name) {
  const pool = personas[tier] ?? [];
  return pool.find((p) => p.name === name) ?? null;
}

function buildParticipant(persona, tier) {
  const tags = getPersonaTags(persona);
  return {
    id: `${tier}_${persona.name.toLowerCase().replace(/\s+/g, "_")}`,
    name: persona.name,
    persona: persona.persona,
    agenda: persona.agenda,
    tier,
    tags,
    expertise: persona.expertise || [],
    known_biases: persona.known_biases,
    communication_style: persona.communication_style,
    preferred_contribution_types: persona.preferred_contribution_types,
    anti_patterns: persona.anti_patterns,
    reflection_guidance: persona.reflection_guidance,
    tier_guidance: persona.tier_guidance,
  };
}

function getDefaultCount(complexity) {
  switch (complexity) {
    case "high": return 5;
    case "medium": return 4;
    default: return 3;
  }
}

export async function composeRoomWithSimilarity(question, seed, database) {
  const used = new Set();
  const participants = [];

  const personas = getPersonas();
  const complexity = analyzeQuestionComplexity(question);
  const count = Math.max(2, Math.min(7, getDefaultCount(complexity)));
  const roles = generateRolesFromComplexity(count, complexity);

  const { isEmbedderInitialized, ensureEmbedderInitialized } = await import("./services/embedding-service.js");
  let embedderReady = isEmbedderInitialized();
  if (!embedderReady) {
    try {
      const modelName = getConfig().embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
      const quant = getConfig().embeddingQuant ?? DEFAULT_EMBEDDING_QUANT;
      await ensureEmbedderInitialized(modelName, quant);
      embedderReady = isEmbedderInitialized();
    } catch {
      embedderReady = false;
    }
  }
  if (!embedderReady) {
    composerLogger.warn(
      "embedder_unavailable",
      "Embedding model not initialized — using keyword-based persona selection for room composition",
    );
    return composeRoomByKeyword(question, personas, roles, complexity, count, used, participants);
  }

  const personaIndex = new PersonaIndex(database);
  await personaIndex.indexAll(personas);

  for (const tier of roles) {
    const results = await personaIndex.search(question, tier, 5);
    const candidate = results.find((r) => !used.has(r.persona_name));
    if (candidate) {
      const persona = findPersonaByName(personas, tier, candidate.persona_name);
      if (persona) {
        used.add(persona.name);
        participants.push(buildParticipant(persona, tier));
      }
    }
  }

  const estimatedRounds = complexity === "high" ? 4 : complexity === "medium" ? 3 : 2;
  const derivedTags = deriveTags(participants);

  return {
    participants,
    estimated_rounds: estimatedRounds,
    reasoning: `${count}-person deliberation for [${derivedTags.join(", ")}] topic (${complexity} complexity): ${roles.join(", ")}.`,
    tags: derivedTags,
    complexity,
  };
}

/**
 * Deterministic composition fallback used when no embedding model is
 * initialized. Selects personas by keyword overlap with the question, so room
 * composition still works without the embedder (degraded but functional).
 */
function composeRoomByKeyword(question, personas, roles, complexity, count, used, participants) {
  const tokens = question.toLowerCase().split(/\W+/).filter((t) => t.length > 3);

  for (const tier of roles) {
    const tierPool = personas[tier] ?? [];
    const scored = tierPool
      .map((persona) => ({
        persona,
        score: scorePersonaForQuestion(persona, tokens),
      }))
      .sort((a, b) => b.score - a.score || a.persona.name.localeCompare(b.persona.name));

    const candidate = scored.find(({ persona }) => !used.has(persona.name));
    if (candidate) {
      used.add(candidate.persona.name);
      participants.push(buildParticipant(candidate.persona, tier));
    }
  }

  const estimatedRounds = complexity === "high" ? 4 : complexity === "medium" ? 3 : 2;
  const derivedTags = deriveTags(participants);
  const reason = "keyword-based (embedding model unavailable)";

  return {
    participants,
    estimated_rounds: estimatedRounds,
    reasoning: `${count}-person deliberation via ${reason} for [${derivedTags.join(", ")}] topic (${complexity} complexity): ${roles.join(", ")}.`,
    tags: derivedTags,
    complexity,
  };
}

function scorePersonaForQuestion(persona, tokens) {
  const tags = getPersonaTags(persona);
  const expertise = Array.isArray(persona.expertise) ? persona.expertise : [];
  const haystack = [...tags, ...expertise].join(" ").toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score++;
    // title/agenda matches count double
    const personaText = `${persona.persona ?? ""} ${persona.agenda ?? ""}`.toLowerCase();
    if (personaText.includes(token)) score += 2;
  }
  return score;
}

export function formatRoomPreview(room) {
  const lines = [
    "## Proposed Deliberation Room",
    "",
    room.reasoning,
    "",
    "| # | Name | Tier | Tags | Agenda |",
    "|---|------|------|------|--------|",
  ];
  room.participants.forEach((p, i) => {
    const tags = (p.tags || []).join(", ") || "general";
    lines.push(`| ${i + 1} | ${p.name} | ${p.tier} | ${tags} | ${p.agenda} |`);
  });
  lines.push("");
  lines.push(`Estimated rounds: ${room.estimated_rounds}`);
  lines.push("");
  lines.push("To start, confirm this room or specify changes (e.g. 'add a security expert', 'use 6 participants').");
  return lines.join("\n");
}

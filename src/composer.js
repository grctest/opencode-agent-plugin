import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger, extractErrorInfo } from "./logger.js";
import { tokenize, computeIdf, cosineSimilarity } from "./utils/nlp.js";

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
    if (existsSync(join(candidate, "domains.json"))) {
      return candidate;
    }
  }
  return candidates[0];
}

function userPersonasPath() {
  const configDir = process.env.LOOM_CONFIG_DIR || join(process.env.HOME || "/root", ".config", "opencode", "loom");
  const personasDir = join(configDir, "personas");
  if (existsSync(join(personasDir, "domains.json"))) {
    return personasDir;
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
  const hasDomains = persona.domains || persona.domain;
  if (!hasDomains || (typeof hasDomains !== "string" && !Array.isArray(hasDomains))) errors.push("domain(s) required");
  return errors;
}

function normalizePersona(persona) {
  if (typeof persona.domain === "string") {
    persona.domains = [persona.domain];
    delete persona.domain;
  } else if (typeof persona.domains === "string") {
    persona.domains = [persona.domains];
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
      const path = join(base, `${tier}.json`);
      const data = readFileSync(path, "utf-8");
      const raw = JSON.parse(data);
      if (!result[tier]) result[tier] = [];
      for (let i = 0; i < raw.length; i++) {
        const p = raw[i];
        const errors = validatePersona(p);
        if (errors.length > 0) {
          composerLogger.warn("invalid_persona", `Invalid persona at ${tier}[${i}] (${p.name ?? "unnamed"})`, { errors });
          totalRejected++;
          continue;
        }
        result[tier].push(normalizePersona(p));
        totalLoaded++;
      }
    } catch (err) {
      if (!result[tier]) result[tier] = [];
      if (err.code !== "ENOENT") {
          composerLogger.warn("persona_load_failed", `Failed to load personas from ${base}/${tier}.json`, { error: err.message });
        }
    }
  }

  if (totalRejected > 0) {
    composerLogger.warn("persona_validation_summary", `Persona validation: ${totalLoaded} loaded, ${totalRejected} rejected from ${base}`);
  }

  return result;
}

let personaCache = null;
let personaCachePath = null;
let personaCacheTimestamp = 0;
const PERSONA_CACHE_TTL_MS = 60000; // 1 minute

function loadPersonas() {
  const basePath = personasBasePath();
  const userPath = userPersonasPath();

  // Cache invalidation: re-load if path changes, TTL expired, or no cache exists
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

let domainKeywordsCache = null;
let domainKeywordsCacheTimestamp = 0;
const DOMAIN_KEYWORDS_CACHE_TTL_MS = 60000;

function loadDomainKeywords() {
  const now = Date.now();
  if (domainKeywordsCache && (now - domainKeywordsCacheTimestamp) < DOMAIN_KEYWORDS_CACHE_TTL_MS) return domainKeywordsCache;
  try {
    const path = join(personasBasePath(), "domains.json");
    const data = readFileSync(path, "utf-8");
    domainKeywordsCache = JSON.parse(data);
    domainKeywordsCacheTimestamp = Date.now();
    return domainKeywordsCache;
  } catch {
    return {};
  }
}

export function getPersonas() {
  return loadPersonas();
}

export function getDomainKeywords() {
  return loadDomainKeywords();
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash);
}

function createSeededRng(seed) {
  let state = seed;
  return function next() {
    state = (state * 1664525 + 1013904223) & 0xffffffff;
    return (state >>> 0) / 0xffffffff;
  };
}

function personaSimilarity(a, b, idf) {
  const textA = `${a.persona} ${a.agenda}`;
  const textB = `${b.persona} ${b.agenda}`;
  const termsA = tokenize(textA);
  const termsB = tokenize(textB);
  const vecA = {};
  const vecB = {};
  for (const t of termsA) vecA[t] = (vecA[t] || 0) + (idf[t] || 1);
  for (const t of termsB) vecB[t] = (vecB[t] || 0) + (idf[t] || 1);
  return cosineSimilarity(vecA, vecB);
}

function getPersonaDomains(persona) {
  if (Array.isArray(persona.domains)) return persona.domains;
  if (typeof persona.domains === "string") return [persona.domains];
  if (typeof persona.domain === "string") return [persona.domain];
  return ["general"];
}

function pickPersona(tier, used, domains, rng, existingPersonas, idf) {
  const pool = getPersonas()[tier] ?? [];
  if (pool.length === 0) return null;

  let candidates = pool.filter((p) => !used.has(p.name));
  if (candidates.length === 0) {
    candidates = pool;
  }

  const weighted = candidates.map((p) => {
    let weight = 1;
    const personaDomains = getPersonaDomains(p);
    for (const pd of personaDomains) {
      if (domains.includes(pd)) {
        weight += 10;
        break;
      }
    }
    if (personaDomains.includes("general")) {
      weight += 2;
    }
    return { persona: p, weight };
  });

  const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0);
  let random = rng() * totalWeight;

  for (const { persona, weight } of weighted) {
    random -= weight;
    if (random <= 0) {
      if (existingPersonas && existingPersonas.length > 0 && idf) {
        const maxSim = Math.max(...existingPersonas.map((ep) => personaSimilarity(ep, persona, idf)));
        if (maxSim > 0.5) {
          continue;
        }
      }
      used.add(persona.name);
      const pDomains = getPersonaDomains(persona);
      return {
        id: `${tier}_${persona.name.toLowerCase().replace(/\s+/g, "_")}`,
        name: persona.name,
        persona: persona.persona,
        agenda: persona.agenda,
        tier,
        domain: pDomains.join(", "),
        domains: pDomains,
        known_biases: persona.known_biases,
        communication_style: persona.communication_style,
        preferred_contribution_types: persona.preferred_contribution_types,
      };
    }
  }

  const fallback = weighted[weighted.length - 1].persona;
  used.add(fallback.name);
  const pDomains = getPersonaDomains(fallback);
  return {
    id: `${tier}_${fallback.name.toLowerCase().replace(/\s+/g, "_")}`,
    name: fallback.name,
    persona: fallback.persona,
    agenda: fallback.agenda,
    tier,
    domain: pDomains.join(", "),
    domains: pDomains,
    known_biases: fallback.known_biases,
    communication_style: fallback.communication_style,
    preferred_contribution_types: fallback.preferred_contribution_types,
  };
}

function analyzeQuestionComplexity(question) {
  const wordCount = question.split(/\s+/).length;
  const questionMarks = (question.match(/\?/g) || []).length;
  const hasMultipleDimensions = /and|or|vs|versus|compare|tradeoff|pros.?cons|advantages.?disadvantages/i.test(question);
  const hasConditionals = /if|when|assuming|given that|depending on|considering/i.test(question);
  const hasStakeholders = /team|customer|user|client|stakeholder|executive|leadership|board/i.test(question);
  const domainKeywordCount = Object.values(getDomainKeywords()).flat().filter((kw) => {
    if (kw.length < 4) return false;
    return new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(question);
  }).length;

  let score = 0;
  if (wordCount > 30) score += 2; else if (wordCount > 15) score += 1;
  if (questionMarks > 1) score += 1;
  if (hasMultipleDimensions) score += 2;
  if (hasConditionals) score += 1;
  if (hasStakeholders) score += 1;
  if (domainKeywordCount >= 5) score += 2; else if (domainKeywordCount >= 2) score += 1;

  if (score >= 5) return "high";
  if (score >= 3) return "medium";
  return "low";
}

function generateRoles(count, domains, complexity) {
  const isFinancial = domains.includes("finance");
  const isTechnical = domains.includes("engineering");
  const isCreative = domains.includes("creative");
  const isBusiness = domains.includes("business") || domains.includes("executive");

  const seniorityBoost = complexity === "high" ? 1 : complexity === "medium" ? 0 : -1;

  if (count <= 3) {
    if (isFinancial || isBusiness) {
      return applySeniorityBoost(["mid", "mid", "junior"], seniorityBoost);
    } else if (isTechnical) {
      return applySeniorityBoost(["mid", "junior", "junior"], seniorityBoost);
    } else if (isCreative) {
      return applySeniorityBoost(["mid", "mid", "junior"], seniorityBoost);
    } else {
      return applySeniorityBoost(["mid", "junior", "junior"], seniorityBoost);
    }
  } else if (count <= 5) {
    if (isFinancial) {
      return applySeniorityBoost(["principal", "senior", "mid", "mid", "junior"], seniorityBoost);
    } else if (isTechnical) {
      return applySeniorityBoost(["senior", "mid", "mid", "junior", "junior"], seniorityBoost);
    } else if (isBusiness) {
      return applySeniorityBoost(["senior", "mid", "mid", "junior", "junior"], seniorityBoost);
    } else {
      return applySeniorityBoost(["senior", "mid", "junior", "junior", "junior"], seniorityBoost);
    }
  } else {
    if (isFinancial) {
      return applySeniorityBoost(["principal", "senior", "senior", "mid", "mid", "junior", "junior"], seniorityBoost);
    } else if (isTechnical) {
      return applySeniorityBoost(["senior", "senior", "mid", "mid", "junior", "junior", "junior"], seniorityBoost);
    } else {
      return applySeniorityBoost(["senior", "mid", "mid", "junior", "junior", "junior", "junior"], seniorityBoost);
    }
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

export async function detectDomainsWithLLM(question, promptFn, getModel) {
  const keywords = getDomainKeywords();
  const domainDescriptions = Object.entries(keywords)
    .map(([domain, kws]) => `- ${domain}: ${kws.slice(0, 5).join(", ")}...`)
    .join("\n");

  const prompt = `Analyze the following question and determine which domains it touches on.

Question: "${question}"

Available domains with example keywords:
${domainDescriptions}

Respond with ONLY a JSON array of domain names that apply. Include a domain if the question relates to any of its concepts. If none clearly apply, respond with [].

Examples:
- "How should we price our SaaS product?" → ["business", "finance"]
- "Design a new API for user authentication" → ["engineering"]
- "Plan our Q4 marketing campaign" → ["creative", "business"]
- "Should I buy GameStop stock?" → ["finance"]
- "How do we improve team culture?" → ["executive"]

JSON array:`;

  const model = getModel();
  if (!model) {
    composerLogger.warn("no_model_for_domain_detection", "No model available for LLM domain detection — defaulting to general");
    return [];
  }

  const result = await promptFn(
    "You are a domain classification expert. Analyze questions and return relevant domains as JSON.",
    model,
    prompt,
  );

  const jsonMatch = result.match(/\[.*?\]/s);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        const validDomains = parsed.filter((d) => Object.keys(keywords).includes(d));
        if (validDomains.length > 0) return validDomains;
      }
    } catch {
      composerLogger.warn("domain_parse_failed", "Failed to parse LLM domain detection response as JSON");
    }
  }

  return [];
}

export function composeRoomWithDomains(question, desiredCount, domains, seed) {
  const used = new Set();
  const participants = [];
  const selectedPersonas = [];

  const defaultCount = desiredCount ?? (domains.length > 0 ? 4 : 3);
  const count = Math.max(2, Math.min(7, defaultCount));

  const complexity = analyzeQuestionComplexity(question);
  const roles = generateRoles(count, domains, complexity);
  const effectiveSeed = seed ?? simpleHash(question);
  const rng = createSeededRng(effectiveSeed);

  const allPersonaTexts = Object.values(getPersonas()).flat().map((p) => `${p.persona} ${p.agenda}`);
  const idf = computeIdf(allPersonaTexts);

  for (const role of roles) {
    const p = pickPersona(role, used, domains, rng, selectedPersonas, idf);
    if (p) {
      participants.push(p);
      selectedPersonas.push(p);
    }
  }

  const estimatedRounds = complexity === "high" ? 4 : complexity === "medium" ? 3 : 2;

  const domainStr = domains.length > 0 ? domains.join(", ") : "general";
  return {
    participants,
    estimated_rounds: estimatedRounds,
    reasoning: `${count}-person deliberation for ${domainStr} topic (${complexity} complexity): ${roles.join(", ")}.`,
    domains,
    complexity,
  };
}

export function formatRoomPreview(room) {
  const lines = [
    "## Proposed Deliberation Room",
    "",
    room.reasoning,
    "",
    "| # | Name | Tier | Domain | Agenda |",
    "|---|------|------|--------|--------|",
  ];
  room.participants.forEach((p, i) => {
    lines.push(`| ${i + 1} | ${p.name} | ${p.tier} | ${p.domain ?? "general"} | ${p.agenda} |`);
  });
  lines.push("");
  lines.push(`Estimated rounds: ${room.estimated_rounds}`);
  lines.push("");
  lines.push("To start, confirm this room or specify changes (e.g. 'add a security expert', 'use 6 participants').");
  return lines.join("\n");
}

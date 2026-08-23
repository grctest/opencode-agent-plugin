import { readFileSync, existsSync, readdirSync, watch } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
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
function loadDomainVocabulary() {
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

function getPersonaTags(persona) {
  if (Array.isArray(persona.tags)) return persona.tags;
  if (typeof persona.tags === "string") return [persona.tags];
  if (Array.isArray(persona.domains)) return persona.domains;
  if (typeof persona.domains === "string") return [persona.domains];
  if (typeof persona.domain === "string") return [persona.domain];
  return [];
}

function analyzeQuestionComplexity(question) {
  if (typeof question !== 'string' || question.trim().length === 0) return { score: 0, level: 'simple' };
  const wordCount = question.trim().split(/\s+/).filter(Boolean).length;
  const questionMarks = (question.match(/\?/g) || []).length;
  const hasMultipleDimensions = /\b(and|or|vs|versus|compare|tradeoff|pros\.?cons|advantages\.?disadvantages)\b/i.test(question);
  const hasConditionals = /\b(if|when|assuming|given that|depending on|considering)\b/i.test(question);
  const hasStakeholders = /\b(team|customer|user|client|stakeholder|executive|leadership|board)\b/i.test(question);

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

  // Civilian inclusion (audit 03 PC1): low/medium-complexity rooms get one
  // generalist civilian seat so the 40-persona civilian tier is auto-reachable.
  // utils/tier.js already ranks civilian as mid-equivalent.
  if (count <= 3) {
    return applySeniorityBoost(["mid", "civilian", "junior"], seniorityBoost);
  } else if (count <= 5) {
    return applySeniorityBoost(["senior", "mid", "civilian", "junior", "junior"], seniorityBoost);
  } else {
    return applySeniorityBoost(["senior", "mid", "mid", "civilian", "junior", "junior", "junior"], seniorityBoost);
  }
}

function applySeniorityBoost(roles, boost) {
  const tierOrder = ["junior", "mid", "civilian", "senior", "principal"];
  if (boost === 0) return roles;

  return roles.map((role) => {
    const idx = tierOrder.indexOf(role);
    if (idx === -1 || role === "civilian") return role; // civilians keep their seat (PC1)
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

function buildParticipant(persona, tier, indexSuffix = "") {
  const tags = getPersonaTags(persona);
  const slug = persona.name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  const suffix = indexSuffix ? `_${indexSuffix}` : "";
  return {
    id: `${tier}_${slug}${suffix}`,
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

export async function composeRoomWithSimilarity(question, database) {
  const used = new Set();
  const participants = [];

  const personas = getPersonas();
  const complexity = analyzeQuestionComplexity(question);
  const count = Math.max(2, Math.min(7, getDefaultCount(complexity)));
  let roles = generateRolesFromComplexity(count, complexity);
  // Tier availability guard — degrade principals if not enough personas of that tier
  try {
    const tierCounts = Object.fromEntries(Object.entries(personas).map(([t, arr]) => [t, arr.length]));
    const need = {};
    for (const r of roles) need[r] = (need[r] || 0) + 1;
    for (const tier of Object.keys(need)) {
      if ((tierCounts[tier] ?? 0) < need[tier]) {
        const deficit = need[tier] - (tierCounts[tier] ?? 0);
        composerLogger.warn("tier_starved", `Not enough ${tier} personas (${tierCounts[tier] ?? 0} < ${need[tier]}) — degrading ${deficit} to senior/mid`);
        // Replace deficit occurrences of this tier with fallback tier that has capacity
        let replaced = 0;
        for (let i = 0; i < roles.length && replaced < deficit; i++) {
          if (roles[i] === tier) {
            const fallbacks = ["principal", "senior", "mid", "junior"];
            // Find highest tier with remaining capacity not equal to original tier
            let fallback = tier === "principal" ? "senior" : tier === "senior" ? "mid" : "junior";
            // Ensure fallback has free slots
            const fallbackUsed = roles.filter((r) => r === fallback).length;
            if ((tierCounts[fallback] ?? 0) > fallbackUsed) {
              roles[i] = fallback;
              replaced++;
            }
          }
        }
      }
    }
  } catch {}

  const { isEmbedderInitialized, ensureEmbedderInitialized, embedText } = await import("./services/embedding-service.js");
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

  // Reuse question embedding across tier searches
  let questionEmbedding = null;
  try { questionEmbedding = await embedText(question, { isQuery: true }); } catch (err) {
    composerLogger.warnThrottled("compose.embed_failed", "Room composition", "Question embedding failed — composition falls back to keyword matching", extractErrorInfo(err));
  }
  // Relevance floor (audit 03 PC2): candidates beyond this cosine distance are
  // treated as off-topic; the seat then goes to a deliberate generalist instead.
  let maxDistance = 0.85;
  try {
    const configured = getConfig()?.composition?.maxCosineDistance;
    if (Number.isFinite(configured) && configured > 0 && configured < 2) maxDistance = configured;
  } catch {}
  const selectedDistances = [];
  for (const tier of roles) {
    let results = [];
    if (questionEmbedding) {
      try {
        results = await personaIndex.searchWithEmbedding(questionEmbedding, tier, 5);
      } catch (err) {
        composerLogger.warnThrottled("compose.vector_search_failed", "Room composition", `Vector persona search failed for tier ${tier} — stepping down to keyword search`, extractErrorInfo(err));
        database?.setSemanticDegraded?.(true);
        results = await personaIndex.search(question, tier, 5);
      }
    } else {
      database?.setSemanticDegraded?.(true);
      results = await personaIndex.search(question, tier, 5);
    }
    // Threshold filter over vector results (keyword-fallback rows have no distance and pass through)
    const onTopic = results.filter((r) => r.distance == null || r.distance <= maxDistance);
    if (results.length > 0 && onTopic.length === 0) {
      composerLogger.info("compose_no_on_topic", `No ${tier} candidate within distance ${maxDistance} of the question — leaving seat to deliberate generalist fallback`);
    }
    const candidate = onTopic.find((r) => !used.has(r.persona_name));
    if (candidate) {
      selectedDistances.push({ tier, persona: candidate.persona_name, distance: candidate.distance ?? null });
      const persona = findPersonaByName(personas, tier, candidate.persona_name);
      if (persona) {
        used.add(persona.name);
        participants.push(buildParticipant(persona, tier, String(participants.length)));
      }
    } else if (questionEmbedding) {
      // Deliberate generalist pick: nearest civilian-tier persona not yet used
      const generalistPool = personas.civilian ?? [];
      const generalist = generalistPool.find((p) => !used.has(p.name));
      if (generalist) {
        composerLogger.info("compose_generalist_fallback", `Seated civilian generalist "${generalist.name}" for ${tier} seat (no on-topic candidate)`);
        used.add(generalist.name);
        participants.push(buildParticipant(generalist, "civilian", String(participants.length)));
      }
    }
  }
  if (selectedDistances.length > 0) {
    composerLogger.info("compose_selection_distances", "Persona selection distances", { distances: selectedDistances, maxDistance });
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
  if (typeof question !== 'string' || question.length === 0) return participants;
  const tokens = question.toLowerCase().split(/\W+/).filter((t) => t.length > 3);

  for (const tier of roles) {
    const tierPool = personas[tier] ?? [];
    const scored = tierPool
      .map((persona) => ({
        persona,
        score: scorePersonaForQuestion(persona, tokens, question),
      }))
      .sort((a, b) => b.score - a.score || a.persona.name.localeCompare(b.persona.name));

    const candidate = scored.find(({ persona }) => !used.has(persona.name));
    if (candidate) {
      used.add(candidate.persona.name);
      participants.push(buildParticipant(candidate.persona, tier, String(participants.length)));
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

function scorePersonaForQuestion(persona, tokens, questionText = "") {
  const tags = getPersonaTags(persona);
  const expertise = Array.isArray(persona.expertise) ? persona.expertise : [];
  const haystack = [...tags, ...expertise].join(" ").toLowerCase();
  let score = 0;
  // Word-boundary matching (audit 13 PC5): a raw `includes(token)` matched
  // inside unrelated words ("art" in "particle"), inflating weak scores.
  for (const token of tokens) {
    const re = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (re.test(haystack)) score++;
    // title/agenda matches count double
    const personaText = `${persona.persona ?? ""} ${persona.agenda ?? ""}`.toLowerCase();
    if (re.test(personaText)) score += 2;
  }
  // Domain vocabulary boost (audit 13 PC4): domains.json is now wired into the
  // keyword fallback — personas tagged for a domain whose keywords appear in
  // the question get a relevance bump instead of the file being dead weight.
  const vocab = loadDomainVocabulary();
  if (questionText) {
    const lowerQ = questionText.toLowerCase();
    for (const tag of tags) {
      const keywords = vocab[String(tag).toLowerCase()];
      if (!Array.isArray(keywords)) continue;
      let hits = 0;
      for (const kw of keywords) {
        if (lowerQ.includes(kw)) hits++;
        if (hits >= 2) break;
      }
      if (hits >= 2) score += 3;
    }
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

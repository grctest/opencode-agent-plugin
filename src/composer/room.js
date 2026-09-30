import { getConfig } from "../config.js";
import { getPersonas, getPersonaTags, loadDomainVocabulary } from "./persona-loader.js";
import { PersonaIndex } from "../services/persona-index.js";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_QUANT } from "../services/model-manager.js";
import { Logger, extractErrorInfo } from "../logger.js";

const composerLogger = new Logger();

function analyzeQuestionComplexity(question) {
  if (typeof question !== 'string' || question.trim().length === 0) return "low";
  const wordCount = question.trim().split(/\s+/).filter(Boolean).length;
  const questionMarks = (question.match(/\?/g) || []).length;
  const andCount = (question.match(/\band\b/gi) || []).length;
  const hasMultipleDimensions = andCount > 2 || /\b(or|vs|versus|compare|tradeoff|pros\.?cons|advantages\.?disadvantages)\b/i.test(question);
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
  if (count <= 3) {
    const base = ["mid", "civilian", "junior"];
    const boosted = applySeniorityBoost(base, seniorityBoost);
    if (boosted[0] === boosted[2]) boosted[0] = "mid";
    return boosted;
  } else if (count === 4) {
    return applySeniorityBoost(["senior", "mid", "civilian", "junior"], seniorityBoost);
  } else if (count === 5) {
    return applySeniorityBoost(["senior", "mid", "civilian", "junior", "junior"], seniorityBoost);
  } else {
    return applySeniorityBoost(["senior", "mid", "mid", "civilian", "junior", "junior", "junior"], seniorityBoost);
  }
}

function applySeniorityBoost(roles, boost) {
  const tierOrder = ["junior", "mid", "senior", "principal"];
  if (boost === 0) return roles;

  return roles.map((role) => {
    if (role === "civilian") return role; // civilians keep their seat (PC1) — handled separately
    const idx = tierOrder.indexOf(role);
    if (idx === -1) return role;
    const newIdx = Math.max(0, Math.min(tierOrder.length - 1, idx + boost));
    return tierOrder[newIdx];
  });
}

function deriveTags(participants) {
  const tagCounts = {};
  for (const p of participants) {
    for (const raw of (p.tags || [])) {
      const t = String(raw).trim().toLowerCase();
      if (!t) continue;
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

// P15/N11 — default relative cut: keep the top-3 personas per tier by rank.
const DEFAULT_TOP_N_PER_TIER = 3;

/**
 * N11 — the distance at which a tier has nothing on-topic to offer. Above it
 * the seat is filled from the best candidate in ANY tier rather than from the
 * best off-topic persona in the nominal one. The old absolute floor admitted
 * 181/181 personas and never bound; the relative cut alone still returns three
 * candidates per tier however far away they are, which is how a mechanical
 * keyboard enthusiast ranked #2 for a car-manufacturer question. This is the
 * only absolute distance left in composition, and it is a *cross-tier* switch
 * rather than an exclusion — the floor binds on a minority of questions by
 * construction, because it only fires when a tier has nothing relevant.
 */
const DEFAULT_MAX_TIER_DISTANCE = 1.25;

/** Quantitative questions must be able to seat a quantitative persona. */
const QUANTITATIVE_TAGS = new Set([
  "data", "quantitative", "statistics", "statistical", "actuarial", "financial",
  "finance", "modeling", "modelling", "analytics", "forecasting", "risk",
]);

const QUANTITATIVE_QUESTION_RE = /\b(probability|probabilit\w+|forecast\w*|estimat\w+|quantif\w+|rate|ratio|share|percent\w*|expected value|mean|median|distribution|variance|statistic\w+|model\w*|number|numbers|margin|band|threshold|calibrat\w+|how (often|many|likely)|what percent|how much)\b/i;

function getTopNPerTier() {
  try {
    const configured = getConfig()?.composition?.topNPerTier;
    if (Number.isFinite(configured) && configured >= 1) return Math.floor(configured);
  } catch {}
  return DEFAULT_TOP_N_PER_TIER;
}

function getMaxTierDistance() {
  try {
    const configured = getConfig()?.composition?.maxTierDistance;
    if (Number.isFinite(configured) && configured > 0 && configured < 3) return configured;
  } catch {}
  return DEFAULT_MAX_TIER_DISTANCE;
}

/** N11 — is this a question whose answer is a number? */
export function isQuantitativeQuestion(question) {
  return QUANTITATIVE_QUESTION_RE.test(String(question ?? ""));
}

/** N11 — does this persona carry quantitative tags or expertise? */
export function isQuantitativePersona(persona) {
  const tags = (getPersonaTags(persona) ?? []).map((t) => String(t).toLowerCase());
  if (tags.some((t) => QUANTITATIVE_TAGS.has(t))) return true;
  const expertise = Array.isArray(persona?.expertise) ? persona.expertise.map((e) => String(e).toLowerCase()) : [];
  return expertise.some((e) => QUANTITATIVE_TAGS.has(e) || /statistic|probabil|forecast|quantit|actuar|model/.test(e));
}

/**
 * N11 — orders candidates for a seat whose nominal tier has nothing on-topic.
 * On-topic beats in-tier; on a quantitative question a quantitative persona
 * beats a merely-adjacent one. A small tie-break, not a classifier: this only
 * runs when the cross-tier floor has already fired.
 * @param {Array<{persona_name: string, distance: number|null, persona?: object}>} candidates
 * @param {{quantitative?: boolean}} [opts]
 */
export function rankCrossTierCandidates(candidates, { quantitative = false } = {}) {
  return [...candidates].sort((a, b) => {
    const da = Number.isFinite(a?.distance) ? a.distance : Number.POSITIVE_INFINITY;
    const db = Number.isFinite(b?.distance) ? b.distance : Number.POSITIVE_INFINITY;
    // Within a small band of distance, a quantitative seat is a tie-break.
    if (Math.abs(da - db) <= 0.05) {
      const qa = isQuantitativePersona(a?.persona) ? 0 : 1;
      const qb = isQuantitativePersona(b?.persona) ? 0 : 1;
      if (quantitative && qa !== qb) return qa - qb;
    }
    return da - db;
  });
}

/**
 * N11 — finds the best candidate for a seat across ALL tiers, when the nominal
 * tier has nothing on-topic. Searches every tier, ranks by distance with a
 * quantitative tie-break, and returns the first candidate not already seated.
 * @returns {Promise<{persona_name: string, distance: number|null, tier: string}|null>}
 */
async function pickCrossTierCandidate(personaIndex, questionEmbedding, compositionText, personas, used, { exclude = [], quantitative = false } = {}) {
  const rows = [];
  for (const [tier, pool] of Object.entries(personas ?? {})) {
    if (exclude.includes(tier) || !Array.isArray(pool) || pool.length === 0) continue;
    let results = [];
    try {
      results = questionEmbedding
        ? await personaIndex.searchWithEmbedding(questionEmbedding, tier, 5)
        : await personaIndex.search(compositionText, tier, 5);
    } catch {
      results = [];
    }
    for (const r of results) {
      rows.push({ persona_name: r.persona_name, distance: r.distance ?? null, tier });
    }
  }
  const free = rows.filter((r) => !used.has(r.persona_name));
  if (free.length === 0) return null;
  const ordered = rankCrossTierCandidates(free, { quantitative });
  const best = ordered[0];
  return best ? { persona_name: best.persona_name, distance: best.distance, tier: best.tier } : null;
}

/**
 * N11 — the keyword-path cross-tier floor: when a tier's best candidate
 * shares no vocabulary with the question, rank every other tier and take the
 * best on-topic persona instead. A quantitative question breaks ties toward a
 * quantitative persona.
 * @returns {{persona: object, tier: string, score: number}|null}
 */
function pickCrossTierCandidateByScore(personas, question, tokens, used, { exclude = [], quantitative = false } = {}) {
  const rows = [];
  for (const [tier, pool] of Object.entries(personas ?? {})) {
    if (exclude.includes(tier) || !Array.isArray(pool) || pool.length === 0) continue;
    for (const { persona, score } of rankPersonasForQuestion(pool, question, tokens)) {
      if (score > 0 && !used.has(persona.name)) rows.push({ persona, tier, score });
    }
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => {
    if (Math.abs(a.score - b.score) <= 1 && quantitative) {
      const qa = isQuantitativePersona(a.persona) ? 0 : 1;
      const qb = isQuantitativePersona(b.persona) ? 0 : 1;
      if (qa !== qb) return qa - qb;
    }
    return b.score - a.score;
  });
  return rows[0];
}

/**
 * P15 — relative cut: rank within a tier and keep the top-N regardless of
 * absolute similarity. The old absolute floor (maxCosineDistance → maxL2
 * ≈ 1.304) admitted 181/181 personas and never bound, so it contributed
 * nothing; the relative cut makes the floor meaningful again. Unscored rows
 * (distance null — keyword fallback hits) sort last.
 * @param {Array<{persona_name: string, distance: number|null}>} results
 * @param {number} [n=3]
 * @returns {Array} the top-N results by ascending distance
 */
export function selectTopNPerTier(results, n = DEFAULT_TOP_N_PER_TIER) {
  const limit = Math.max(1, Math.floor(Number.isFinite(n) && n > 0 ? n : DEFAULT_TOP_N_PER_TIER));
  return [...results]
    .sort((a, b) => {
      const da = Number.isFinite(a?.distance) ? a.distance : Infinity;
      const db = Number.isFinite(b?.distance) ? b.distance : Infinity;
      return da - db;
    })
    .slice(0, limit);
}

/**
 * Ranks a tier's personas by keyword overlap with the question (shared by the
 * keyword composition path and its tests). Deterministic: score desc, then
 * name asc.
 */
export function rankPersonasForQuestion(tierPool, questionText, tokens = null) {
  const q = String(questionText ?? "");
  const toks = tokens ?? q.toLowerCase().split(/\W+/).filter((t) => t.length > 1);
  return tierPool
    .map((persona) => ({ persona, score: scorePersonaForQuestion(persona, toks, q) }))
    .sort((a, b) => b.score - a.score || a.persona.name.localeCompare(b.persona.name));
}

export async function composeRoomWithSimilarity(question, context = "", opts = {}) {
  const used = new Set();
  const participants = [];
  const compositionText = [question, context].map((value) => String(value ?? "").trim()).filter(Boolean).join("\n");

  const personas = getPersonas();
  const complexity = analyzeQuestionComplexity(question);
  const count = Math.max(2, Math.min(7, getDefaultCount(complexity)));
  let roles = generateRolesFromComplexity(count, complexity);
  // Tier availability guard — cascade through fallback chain
  const originalRoles = [...roles];
  try {
    const tierCounts = Object.fromEntries(Object.entries(personas).map(([t, arr]) => [t, arr.length]));
    const chain = ["principal", "senior", "mid", "junior", "civilian"];
    const originalNeed = {};
    for (const r of roles) originalNeed[r] = (originalNeed[r] ?? 0) + 1;
    for (const tier of Object.keys(originalNeed)) {
      const need = originalNeed[tier];
      if ((tierCounts[tier] ?? 0) >= need) continue;
      let deficit = need - (tierCounts[tier] ?? 0);
      composerLogger.warn("tier_starved", `Not enough ${tier} personas (${tierCounts[tier] ?? 0} < ${need}) — cascading ${deficit} to fallback chain`);
      // Walk roles and replace one at a time, picking best available fallback with capacity
      // Count against current roles snapshot, not mutated need
      for (let i = 0; i < roles.length && deficit > 0; i++) {
        if (roles[i] !== tier) continue;
        let picked = null;
        for (const fb of chain) {
          if (fb === tier) continue;
          const used = roles.filter(r=>r===fb).length;
          if ((tierCounts[fb] ?? 0) > used) { picked = fb; break; }
        }
        if (picked) { roles[i] = picked; deficit--; }
      }
    }
    if (roles.some((r,i)=>r!==originalRoles[i])) {
      composerLogger.info("tier_starved_resolved", `Roles degraded ${originalRoles.join(",")} → ${roles.join(",")}`);
    }
  } catch {}

  // Explicit keyword request (e.g. dashboard fallback) — skip vectors entirely
  if (opts?.keywordOnly === true) {
    composerLogger.info("compose_keyword_only", "Keyword-only composition requested — skipping vector search");
    return composeRoomByKeyword(compositionText, personas, roles, complexity, count, used, participants, "keyword-based (explicit keyword-only request)");
  }

  const { isEmbedderInitialized, ensureEmbedderInitialized, embedText } = await import("../services/embedding-service.js");
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
    return composeRoomByKeyword(compositionText, personas, roles, complexity, count, used, participants);
  }

  const personaIndex = new PersonaIndex();
  await personaIndex.indexAll(personas);

  // Reuse question embedding across tier searches
  let questionEmbedding = null;
  try { questionEmbedding = await embedText(compositionText, { isQuery: true }); } catch (err) {
    composerLogger.warnThrottled("compose.embed_failed", "Room composition", "Question embedding failed — composition falls back to keyword matching", extractErrorInfo(err));
  }
  // Relevance floor: maxCosineDistance (cosine distance) converted to the
  // L2-equivalent distance returned by the in-memory store
  let maxCosineDistance = 0.85;
  try {
    const configured = getConfig()?.composition?.maxCosineDistance;
    if (Number.isFinite(configured) && configured > 0 && configured < 2) maxCosineDistance = configured;
  } catch {}
  // In-memory store returns L2-equivalent distance for normalized vectors:
  // L2 = sqrt(2 * cosineDistance)
  const maxL2 = Math.sqrt(Math.max(0, 2 * maxCosineDistance));
  // P15 — relative cut: rank within the tier and keep the top-N regardless of
  // absolute similarity. The absolute floor (maxL2) admitted 181/181 personas
  // and never bound, so it contributed nothing; the relative cut makes the
  // floor meaningful. maxL2 is retained for diagnostics only.
  const topNPerTier = getTopNPerTier();
  const maxTierDistance = getMaxTierDistance();
  const selectedDistances = [];
  let vectorDegraded = false;
  for (const tier of roles) {
    let results = [];
    if (questionEmbedding) {
      try {
        results = await personaIndex.searchWithEmbedding(questionEmbedding, tier, 5);
      } catch (err) {
          composerLogger.warnThrottled("compose.vector_search_failed", "Room composition", `Vector persona search failed for tier ${tier} — stepping down to keyword search`, extractErrorInfo(err));
          vectorDegraded = true;
          results = await personaIndex.search(compositionText, tier, 5);
        }
      } else {
        results = await personaIndex.search(compositionText, tier, 5);
      }
    // P15 — relative cut replaces the absolute L2 floor: keep the top-N of the
    // tier by rank. Keyword rows (distance null) sort last.
    const ranked = selectTopNPerTier(results, topNPerTier);
      if (questionEmbedding && results.length === 0) {
        vectorDegraded = true;
        break;
      }
      if (results.length > 0) {
       composerLogger.info("compose_relative_cut", `${tier}: kept top-${ranked.length} of ${results.length} by rank (relative cut N=${topNPerTier}; old absolute floor L2 ${maxL2.toFixed(3)} no longer applies)`, { kept: ranked.map((r) => ({ persona: r.persona_name, distance: r.distance })) });
     }
    const candidate = ranked.find((r) => !used.has(r.persona_name));
    let seated = candidate;
    // N11 — cross-tier floor. If the best in-tier candidate is further from the
    // question than the floor, this tier has nothing on-topic to say; an
    // on-topic persona from another tier beats an off-topic one from the
    // nominal tier. This is the behaviour change P15 never made: a mechanical
    // keyboard enthusiast ranked #2 for a car-manufacturer question because
    // the relative cut always returns three candidates, however far away.
    let crossTier = null;
    if (candidate && Number.isFinite(candidate.distance) && candidate.distance > maxTierDistance) {
      crossTier = await pickCrossTierCandidate(personaIndex, questionEmbedding, compositionText, personas, used, {
        exclude: [tier],
        quantitative: isQuantitativeQuestion(compositionText),
      });
      if (crossTier && crossTier.persona_name !== candidate.persona_name) {
        composerLogger.info("compose_cross_tier_floor", `${tier}: best in-tier "${candidate.persona_name}" is ${candidate.distance.toFixed(3)} away (floor ${maxTierDistance}) — seating cross-tier "${crossTier.persona_name}" at ${Number.isFinite(crossTier.distance) ? crossTier.distance.toFixed(3) : "n/a"} instead`, { tier, inTier: candidate.persona_name, inTierDistance: candidate.distance, crossTier: crossTier.persona_name, crossTierDistance: crossTier.distance ?? null, floor: maxTierDistance });
        seated = crossTier;
      } else {
        crossTier = null;
      }
    }
    if (seated) {
      const seatTier = findPersonaByName(personas, tier, seated.persona_name) ? tier : crossTier?.tier ?? tier;
      const persona = findPersonaByName(personas, seatTier, seated.persona_name) ?? findPersonaByName(personas, tier, seated.persona_name);
      if (persona) {
        selectedDistances.push({ tier: seatTier, persona: persona.name, distance: seated.distance ?? null, cross_tier: seatTier !== tier });
        used.add(persona.name);
        participants.push(buildParticipant(persona, seatTier, String(participants.length)));
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
  if (vectorDegraded) {
    composerLogger.warn("compose_keyword_fallback", "Vector composition unavailable — rebuilding room with keyword matching");
    return composeRoomByKeyword(compositionText, personas, roles, complexity, count, used, participants);
  }
  if (selectedDistances.length > 0) {
    composerLogger.info("compose_selection_distances", "Persona selection distances (L2)", { distances: selectedDistances, maxCosineDistance, maxL2 });
  }

  const cfgRounds = getConfig()?.defaultMaxRounds;
  const baseRounds = complexity === "high" ? 4 : complexity === "medium" ? 3 : 2;
  const estimatedRounds = Number.isFinite(cfgRounds) ? Math.max(baseRounds - 1, Math.min(baseRounds + 1, cfgRounds)) : baseRounds;
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
function composeRoomByKeyword(question, personas, roles, complexity, count, used, participants, reasonOverride = null) {
  if (typeof question !== 'string' || question.length === 0) {
    const cfgRounds = getConfig()?.defaultMaxRounds;
  const baseRounds = complexity === "high" ? 4 : complexity === "medium" ? 3 : 2;
  const estimatedRounds = Number.isFinite(cfgRounds) ? Math.max(baseRounds - 1, Math.min(baseRounds + 1, cfgRounds)) : baseRounds;
    const derivedTags = deriveTags(participants);
    return {
      participants,
      estimated_rounds: estimatedRounds,
      reasoning: `${count}-person deliberation via keyword-based (embedding model unavailable) for [${derivedTags.join(", ")}] topic (${complexity} complexity): ${roles.join(", ")}.`,
      tags: derivedTags,
      complexity,
    };
  }
  const tokens = question.toLowerCase().split(/\W+/).filter((t) => t.length > 1);
  let maxDistance = 0.85;
  try {
    const configured = getConfig()?.composition?.maxCosineDistance;
    if (Number.isFinite(configured) && configured > 0 && configured < 2) maxDistance = configured;
  } catch {}
  // P15 — relative cut: rank within the tier and keep the top-N regardless of
  // the absolute floor. The old minScore floor (derived from maxCosineDistance)
  // never bound — it admitted any persona with a single keyword hit — so it
  // contributed nothing. minScore is retained as a logged diagnostic only.
  const minScore = Math.max(1, Math.floor(2 * (1 - maxDistance + 0.15)));
  const topN = getTopNPerTier();
  const quantitative = isQuantitativeQuestion(question);

  for (const tier of roles) {
    const tierPool = personas[tier] ?? [];
    const ranked = rankPersonasForQuestion(tierPool, question, tokens);
    const topNPool = ranked.slice(0, topN);
    const candidate = topNPool.find(({ persona }) => !used.has(persona.name))
      ?? ranked.find(({ persona }) => !used.has(persona.name));
    if (candidate) {
      if (candidate.score < minScore) {
        composerLogger.info("compose_relative_cut_below_floor", `${tier}: seated "${candidate.persona.name}" (score ${candidate.score}) below the old floor ${minScore} — relative cut keeps the best available`);
      }
      // N11 — the keyword-path form of the cross-tier floor: a tier whose best
      // candidate shares no vocabulary with the question has nothing to say,
      // and an on-topic persona from another tier outranks an off-topic one
      // from the nominal tier. A score of 0 is the same statement as a distance
      // past the floor.
      let seat = candidate.persona;
      let seatTier = tier;
      if (candidate.score <= 0) {
        const crossTier = pickCrossTierCandidateByScore(personas, question, tokens, used, { exclude: [tier], quantitative });
        if (crossTier && crossTier.persona.name !== candidate.persona.name) {
          composerLogger.info("compose_cross_tier_floor", `${tier}: no keyword overlap with the question — seating cross-tier "${crossTier.persona.name}" (${crossTier.tier}) instead`, { tier, inTier: candidate.persona.name, crossTier: crossTier.persona.name, crossTierTier: crossTier.tier });
          seat = crossTier.persona;
          seatTier = crossTier.tier;
        }
      }
      used.add(seat.name);
      participants.push(buildParticipant(seat, seatTier, String(participants.length)));
    } else if (tier !== "civilian") {
      composerLogger.info("compose_keyword_no_relevant", `No ${tier} candidate left — skipping seat`);
    } else {
      composerLogger.info("compose_keyword_no_relevant", `No civilian candidate left — skipping seat`);
    }
  }

  const cfgRounds = getConfig()?.defaultMaxRounds;
  const baseRounds = complexity === "high" ? 4 : complexity === "medium" ? 3 : 2;
  const estimatedRounds = Number.isFinite(cfgRounds) ? Math.max(baseRounds - 1, Math.min(baseRounds + 1, cfgRounds)) : baseRounds;
  const derivedTags = deriveTags(participants);
  const reason = reasonOverride ?? "keyword-based (embedding model unavailable)";

  return {
    participants,
    estimated_rounds: estimatedRounds,
    reasoning: `${count}-person deliberation via ${reason} for [${derivedTags.join(", ")}] topic (${complexity} complexity): ${roles.join(", ")}.`,
    tags: derivedTags,
    complexity,
  };
}

let _vocabCache = null;
function getVocab() {
  if (_vocabCache) return _vocabCache;
  _vocabCache = loadDomainVocabulary();
  return _vocabCache;
}

function scorePersonaForQuestion(persona, tokens, questionText = "") {
  const tags = getPersonaTags(persona);
  const expertise = Array.isArray(persona.expertise) ? persona.expertise : [];
  const haystack = [...tags, ...expertise].join(" ").toLowerCase();
  const personaText = `${persona.persona ?? ""} ${persona.agenda ?? ""}`.toLowerCase();
  // Cap tokens and cap alternation size to prevent ReDoS: use Set lookups instead of giant regex when >50 tokens
  const cappedTokens = tokens.length > 50 ? tokens.slice(0, 50) : tokens;
  const escTokens = [];
  for (const t of cappedTokens) {
    if (t.length < 2) continue;
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (esc.length > 30) continue;
    escTokens.push(esc.toLowerCase());
  }
  let score = 0;
  if (escTokens.length > 0) {
    if (escTokens.length > 30) {
      // Use word-set lookup for large alternations to avoid ReDoS
      const hayWords = new Set(haystack.split(/\W+/));
      const personaWords = new Set(personaText.split(/\W+/));
      const uniqueTokens = new Set(escTokens);
      for (const tok of uniqueTokens) {
        if (hayWords.has(tok)) score++;
        if (personaWords.has(tok)) score += 2;
      }
    } else {
      const re = new RegExp(`\\b(?:${escTokens.join("|")})\\b`, "gi");
      const haystackHits = new Set((haystack.match(re) ?? []).map(s => s.toLowerCase()));
      const personaHits = new Set((personaText.match(re) ?? []).map(s => s.toLowerCase()));
      for (const tok of escTokens) {
        if (haystackHits.has(tok)) score++;
        if (personaHits.has(tok)) score += 2;
      }
    }
  }
  if (questionText) {
    const vocab = getVocab();
    for (const tag of tags) {
      const keywords = vocab[String(tag).toLowerCase()];
      if (!Array.isArray(keywords)) continue;
      let hits = 0;
      for (const kw of keywords) {
        const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`\\b${esc}\\b`, "i");
        if (re.test(questionText)) hits++;
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

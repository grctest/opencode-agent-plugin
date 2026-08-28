import { getPersonas, getPersonaTags, loadDomainVocabulary } from "./persona-loader.js";
import { PersonaIndex } from "../services/persona-index.js";
import { getConfig } from "../config.js";
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
    // Avoid duplicate junior after downgrade
    if (boosted[0] === boosted[2]) boosted[0] = "mid";
    return boosted;
  } else if (count <= 5) {
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

export async function composeRoomWithSimilarity(question, database) {
  const used = new Set();
  const participants = [];

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

  // Dry-run or no DB — skip vector indexing entirely (keyword fallback)
  if (!database) {
    composerLogger.info("compose_no_db", "No database provided (dry-run) — using keyword-based composition");
    return composeRoomByKeyword(question, personas, roles, complexity, count, used, participants);
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
    return composeRoomByKeyword(question, personas, roles, complexity, count, used, participants);
  }

  const personaIndex = new PersonaIndex(database);
  await personaIndex.indexAll(personas);

  // Reuse question embedding across tier searches
  let questionEmbedding = null;
  try { questionEmbedding = await embedText(question, { isQuery: true }); } catch (err) {
    composerLogger.warnThrottled("compose.embed_failed", "Room composition", "Question embedding failed — composition falls back to keyword matching", extractErrorInfo(err));
  }
  // Relevance floor: maxCosineDistance (cosine distance) converted to L2 for vec0 which returns L2
  let maxCosineDistance = 0.85;
  try {
    const configured = getConfig()?.composition?.maxCosineDistance;
    if (Number.isFinite(configured) && configured > 0 && configured < 2) maxCosineDistance = configured;
  } catch {}
  // vec0 returns L2 for normalized vectors: L2 = sqrt(2 * cosineDistance)
  const maxL2 = Math.sqrt(Math.max(0, 2 * maxCosineDistance));
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
    // Threshold filter: vec0 L2 distance vs maxL2; keyword rows have no distance and pass through
    const onTopic = results.filter((r) => r.distance == null || r.distance <= maxL2);
    if (results.length > 0 && onTopic.length === 0) {
      composerLogger.info("compose_no_on_topic", `No ${tier} candidate within L2 ${maxL2.toFixed(3)} (cosine distance ${maxCosineDistance}) of the question — leaving seat to deliberate generalist fallback`);
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
    composerLogger.info("compose_selection_distances", "Persona selection distances (L2)", { distances: selectedDistances, maxCosineDistance, maxL2 });
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
  if (typeof question !== 'string' || question.length === 0) {
    const estimatedRounds = complexity === "high" ? 4 : complexity === "medium" ? 3 : 2;
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
  // Keyword relevance floor: low-score candidates are off-topic — skip seat (threshold scales with maxDistance)
  const minScore = Math.max(1, Math.floor(2 * (1 - maxDistance + 0.15)));

  for (const tier of roles) {
    const tierPool = personas[tier] ?? [];
    const scored = tierPool
      .map((persona) => ({
        persona,
        score: scorePersonaForQuestion(persona, tokens, question),
      }))
      .sort((a, b) => b.score - a.score || a.persona.name.localeCompare(b.persona.name));

    const candidate = scored.find(({ persona, score }) => !used.has(persona.name) && score >= minScore);
    if (candidate) {
      used.add(candidate.persona.name);
      participants.push(buildParticipant(candidate.persona, tier, String(participants.length)));
    } else {
      const fallback = scored.find(({ persona }) => !used.has(persona.name));
      if (fallback && tier !== "civilian") {
        composerLogger.info("compose_keyword_no_relevant", `No ${tier} candidate with score ≥${minScore} — skipping seat (relevance floor)`);
      } else if (fallback) {
        used.add(fallback.persona.name);
        participants.push(buildParticipant(fallback.persona, tier, String(participants.length)));
      }
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

/**
 * PersonaIndex: in-memory store of persona embeddings for similarity-based
 * persona selection at meeting start.
 *
 * Previously backed by sqlite-vec (vec_persona_embeddings_* tables written
 * per meeting DB); now process-scoped memory. The catalog is ~181 × 384
 * floats (~280KB) and brute-force cosine over it is microseconds, so an
 * index structure is pure overhead. Per-item inference results are still
 * cached (embeddingCache) so repeat meetings in one process skip ONNX
 * inference; a store-level fingerprint skips re-indexing entirely when the
 * model and catalog are unchanged.
 */

import { embedText, getEmbeddingDim, getEmbeddingMaxTokens, getEmbedderMeta } from "./embedding-service.js";
import { cosineSimilarity } from "../utils/vector.js";
import { Logger, extractErrorInfo } from "../logger.js";
import { createHash } from "node:crypto";
import { TUNING } from "../config/defaults.js";
import { getConfig } from "../config.js";

const personaIndexLogger = new Logger();

const embeddingCache = new Map();
function getCacheMax() { try { return getConfig()?.tuning?.EMBEDDING_CACHE_MAX ?? TUNING.EMBEDDING_CACHE_MAX; } catch { return TUNING.EMBEDDING_CACHE_MAX; } }

export function clearEmbeddingCache() { embeddingCache.clear(); }

// Process-scoped vector store: `${tier}|${personaName}` ->
// { tier, personaName, tags, embeddingText, embedding }
const vectorStore = new Map();
let storeFingerprint = null;

export function clearPersonaStore() {
  vectorStore.clear();
  storeFingerprint = null;
}

function cacheKey(personaName, tier, embeddingText) {
  const fingerprint = createHash("sha256").update(embeddingText).digest("hex").slice(0, 16);
  const meta = getEmbedderMeta();
  const modelName = meta?.name ?? getConfig()?.embeddingModel ?? "unknown";
  const quant = meta?.quant ?? getConfig()?.embeddingQuant ?? "unknown";
  return `${modelName}|${quant}|${personaName}|${tier}|${getEmbeddingDim()}|${fingerprint}`;
}

function cachedEmbeddingFor(key) {
  const hit = embeddingCache.get(key);
  if (hit !== undefined) {
    // LRU-ish refresh
    embeddingCache.delete(key);
    embeddingCache.set(key, hit);
  }
  return hit;
}

function storeEmbeddingInCache(key, embedding) {
  const cap = getCacheMax();
  if (embeddingCache.size >= cap) {
    const oldest = embeddingCache.keys().next().value;
    if (oldest !== undefined) embeddingCache.delete(oldest);
  }
  embeddingCache.set(key, embedding);
}

export class PersonaIndex {
  /**
   * Index all personas by embedding their text into the process-scoped store.
   * Skips inference entirely when the model and catalog are unchanged since
   * the last call. Safe to call once per meeting.
   * @param {Object} personas - output of getPersonas(): { junior: [...], mid: [...], senior: [...], principal: [...] }
   */
  async indexAll(personas) {
    const dim = getEmbeddingDim();
    const all = [];
    for (const [tier, tierPersonas] of Object.entries(personas)) {
      for (const persona of tierPersonas) {
        all.push({ tier, persona, embeddingText: this.#buildEmbeddingText(persona) });
      }
    }
    const fingerprint = this.#storeFingerprint(all, dim);
    if (storeFingerprint !== null && storeFingerprint === fingerprint && vectorStore.size > 0) {
      personaIndexLogger.info("personas_already_indexed", `Persona embeddings already indexed in memory (${vectorStore.size})`);
      return vectorStore.size;
    }

    let indexed = 0;
    let failed = 0;
    let cacheHits = 0;
    // Fingerprint changed (or first run) — drop stale entries before refilling.
    vectorStore.clear();
    // Batch with concurrency 4 to avoid sequential 7s stall
    const concurrency = 4;
    for (let i = 0; i < all.length; i += concurrency) {
      const batch = all.slice(i, i + concurrency);
      const results = await Promise.all(batch.map(async ({ tier, persona, embeddingText }) => {
        try {
          const key = cacheKey(persona.name, tier, embeddingText);
          const cached = cachedEmbeddingFor(key);
          if (cached) {
            cacheHits++;
            return { tier, persona, embeddingText, embedding: cached, err: null };
          }
          const embedding = await embedText(embeddingText);
          storeEmbeddingInCache(key, embedding);
          return { tier, persona, embeddingText, embedding, err: null };
        } catch (err) {
          return { tier, persona, embeddingText, err };
        }
      }));
      for (const r of results) {
        if (r.err) {
          failed++;
          personaIndexLogger.warn("persona_index_failed", `Failed to index persona: ${r.persona.name}`, extractErrorInfo(r.err));
          continue;
        }
        const tags = r.persona.tags || r.persona.expertise || [];
        vectorStore.set(`${r.tier}|${r.persona.name}`, {
          tier: r.tier,
          personaName: r.persona.name,
          tags,
          embeddingText: r.embeddingText,
          embedding: r.embedding,
        });
        indexed++;
      }
    }

    if (indexed > 0) storeFingerprint = fingerprint;
    personaIndexLogger.info("personas_indexed", `Indexed ${indexed} personas in memory (${dim}d)${cacheHits > 0 ? `, ${cacheHits} cache hits` : ""}${failed > 0 ? ` (${failed} failed)` : ""}`);
    return indexed;
  }

  /**
   * Search for the most similar personas in a given tier.
   * @param {string} queryText - the user's question
   * @param {string} tier - "junior" | "mid" | "senior" | "principal"
   * @param {number} topK - max results
   * @returns {Promise<Array<{persona_name: string, tier: string, tags: string, distance: number}>>}
   */
  async search(queryText, tier, topK = 5) {
    const queryEmbedding = await embedText(queryText, { isQuery: true });
    return this.searchWithEmbedding(queryEmbedding, tier, topK);
  }

  async searchWithEmbedding(queryEmbedding, tier, topK = 5) {
    const limit = Math.max(1, Math.floor(Number(topK) || 5));
    if (!queryEmbedding || vectorStore.size === 0) return [];
    const scored = [];
    for (const entry of vectorStore.values()) {
      if (entry.tier !== tier) continue;
      const sim = cosineSimilarity(queryEmbedding, entry.embedding);
      if (!Number.isFinite(sim)) continue;
      // L2-equivalent distance for normalized vectors (matches previous
      // vec0 semantics: L2 = sqrt(2 * cosineDistance)).
      scored.push({
        persona_name: entry.personaName,
        tier: entry.tier,
        tags: entry.tags,
        embedding_text: entry.embeddingText,
        distance: Math.sqrt(Math.max(0, 2 * (1 - sim))),
      });
    }
    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, limit);
  }

  #storeFingerprint(entries, dim) {
    const meta = getEmbedderMeta();
    const modelName = meta?.name ?? getConfig()?.embeddingModel ?? "unknown";
    const quant = meta?.quant ?? getConfig()?.embeddingQuant ?? "unknown";
    const h = createHash("sha256");
    h.update(`${modelName}|${quant}|${dim}|`);
    for (const { tier, persona, embeddingText } of entries) {
      h.update(`${tier}|${persona.name}|`);
      h.update(createHash("sha256").update(embeddingText).digest("hex").slice(0, 16));
      h.update("|");
    }
    return h.digest("hex");
  }

  /**
   * Build the text to embed for a persona.
   * Combines persona description, agenda, tags, and expertise into a single text blob.
   */
  #buildEmbeddingText(persona) {
    const parts = [
      persona.persona,
      persona.agenda,
      ...(persona.tags || []),
      ...(persona.expertise || []),
    ];
    const text = parts.filter(Boolean).join(" ");
    let maxTokens = 512;
    try { maxTokens = getEmbeddingMaxTokens(); } catch {}
    const maxChars = maxTokens * 4;
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  }
}

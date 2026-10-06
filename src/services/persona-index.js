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
import { availableParallelism } from "node:os";
import { TUNING } from "../config/defaults.js";
import { getConfig } from "../config.js";

const personaIndexLogger = new Logger();

const embeddingCache = new Map();
function getCacheMax() { try { return getConfig()?.tuning?.EMBEDDING_CACHE_MAX ?? TUNING.EMBEDDING_CACHE_MAX; } catch { return TUNING.EMBEDDING_CACHE_MAX; } }

/**
 * How many persona embeddings to run at once.
 *
 * One less than the available parallelism, clamped: leaving a core free keeps
 * the dashboard responsive and, more importantly, keeps an ONNX session that is
 * already serving a live deliberation from being starved during the background
 * warm. The gain over the old fixed 4 is modest (measured: 2.6ms/persona at
 * concurrency 1, 1.2ms at 8) because ONNX threads internally and the JS batch
 * loop is not the bottleneck — indexing all 349 costs ~6s cold either way.
 */
function getIndexConcurrency() {
  const cpus = Math.max(1, availableParallelism());
  return Math.max(2, Math.min(16, cpus - 1));
}

export function clearEmbeddingCache() { embeddingCache.clear(); }

// Process-scoped vector store: `${category}|${personaName}` ->
// { category, personaName, tags, embeddingText, embedding }
const vectorStore = new Map();
let storeFingerprint = null;

/**
 * Index state, surfaced to the dashboard so the auto-select button can wait for
 * a usable store instead of hiding with no explanation.
 *
 *   empty     — nothing indexed yet (or the store was cleared)
 *   indexing  — a run is in flight
 *   ready     — the store matches the current model + catalog fingerprint
 *   error     — the last run failed; `rankAllPersonas` will retry inline
 *
 * `ready` is deliberately not a promise of accuracy for a given question — it
 * means the vectors exist. Ranking still happens per query.
 */
let indexStatus = { state: "empty", count: 0, message: null };
/** In-flight index run, so concurrent callers share one pass. @type {Promise<number>|null} */
let indexInFlight = null;

export function getPersonaIndexStatus() {
  return { ...indexStatus, count: indexStatus.count || vectorStore.size };
}

export function clearPersonaStore() {
  vectorStore.clear();
  storeFingerprint = null;
  indexStatus = { state: "empty", count: 0, message: null };
  indexInFlight = null;
}

function cacheKey(personaName, category, embeddingText) {
  const fingerprint = createHash("sha256").update(embeddingText).digest("hex").slice(0, 16);
  const meta = getEmbedderMeta();
  const modelName = meta?.name ?? getConfig()?.embeddingModel ?? "unknown";
  const quant = meta?.quant ?? getConfig()?.embeddingQuant ?? "unknown";
  return `${modelName}|${quant}|${personaName}|${category}|${getEmbeddingDim()}|${fingerprint}`;
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
   * @param {Object} personas - output of getPersonas(): { [category]: [...] }
   */
  async indexAll(personas) {
    const dim = getEmbeddingDim();
    const all = [];
    for (const [category, categoryPersonas] of Object.entries(personas)) {
      for (const persona of categoryPersonas) {
        all.push({ category, persona, embeddingText: this.#buildEmbeddingText(persona) });
      }
    }
    const fingerprint = this.#storeFingerprint(all, dim);
    if (storeFingerprint !== null && storeFingerprint === fingerprint && vectorStore.size > 0) {
      personaIndexLogger.info("personas_already_indexed", `Persona embeddings already indexed in memory (${vectorStore.size})`);
      indexStatus = { state: "ready", count: vectorStore.size, message: null };
      return vectorStore.size;
    }

    let indexed = 0;
    let failed = 0;
    let cacheHits = 0;
    // Fingerprint changed (or first run) — drop stale entries before refilling.
    vectorStore.clear();
    indexStatus = { state: "indexing", count: 0, message: null };
    const concurrency = getIndexConcurrency();
    try {
      for (let i = 0; i < all.length; i += concurrency) {
        const batch = all.slice(i, i + concurrency);
        const results = await Promise.all(batch.map(async ({ category, persona, embeddingText }) => {
          try {
            const key = cacheKey(persona.name, category, embeddingText);
            const cached = cachedEmbeddingFor(key);
            if (cached) {
              cacheHits++;
              return { category, persona, embeddingText, embedding: cached, err: null };
            }
            const embedding = await embedText(embeddingText);
            storeEmbeddingInCache(key, embedding);
            return { category, persona, embeddingText, embedding, err: null };
          } catch (err) {
            return { category, persona, embeddingText, err };
          }
        }));
        for (const r of results) {
          if (r.err) {
            failed++;
            personaIndexLogger.warn("persona_index_failed", `Failed to index persona: ${r.persona.name}`, extractErrorInfo(r.err));
            continue;
          }
          const tags = r.persona.tags || r.persona.expertise || [];
          vectorStore.set(`${r.category}|${r.persona.name}`, {
            category: r.category,
            personaName: r.persona.name,
            tags,
            embeddingText: r.embeddingText,
            embedding: r.embedding,
          });
          indexed++;
        }
        // Progress is reported so the dashboard's "Preparing N personas…" line
        // moves instead of sitting on an unknown total.
        indexStatus = { state: "indexing", count: vectorStore.size, message: null };
      }

      if (indexed > 0) storeFingerprint = fingerprint;
      // A run that embedded nothing is a failure even though nothing threw —
      // the store is empty, so `ready` would be a lie the UI acts on.
      indexStatus = indexed > 0
        ? { state: "ready", count: indexed, message: null }
        : { state: "error", count: 0, message: `indexed 0 of ${all.length} personas` };
      personaIndexLogger.info("personas_indexed", `Indexed ${indexed} personas in memory (${dim}d, concurrency ${concurrency})${cacheHits > 0 ? `, ${cacheHits} cache hits` : ""}${failed > 0 ? ` (${failed} failed)` : ""}`);
      return indexed;
    } catch (err) {
      indexStatus = { state: "error", count: vectorStore.size, message: extractErrorInfo(err).message };
      throw err;
    }
  }

  /**
   * Rank EVERY indexed persona against the query, across all categories.
   *
   * Room composition treats the catalog as one flat pool: categories are an
   * organizational detail, not a search partition. There is no quota to
   * fill and nothing to partition on.
   *
   * No topK: the consumer needs the whole ordering, because it shows the full
   * list to the user rather than a shortlist. Brute-force cosine over the
   * whole catalog is microseconds (see the class docblock), so slicing here
   * would save nothing and cost the ability to render every row.
   *
   * Ordering is ascending by distance, ties broken by name so the same
   * question always yields the same list.
   * @param {number[]} queryEmbedding
   * @returns {Promise<Array<{persona_name: string, category: string, tags: string[], embedding_text: string, distance: number}>>}
   */
  async searchAll(queryEmbedding) {
    if (!queryEmbedding || vectorStore.size === 0) return [];
    const scored = [];
    for (const entry of vectorStore.values()) {
      const sim = cosineSimilarity(queryEmbedding, entry.embedding);
      if (!Number.isFinite(sim)) continue;
      // L2-equivalent distance for normalized vectors (matches previous
      // vec0 semantics: L2 = sqrt(2 * cosineDistance)).
      scored.push({
        persona_name: entry.personaName,
        category: entry.category,
        tags: entry.tags,
        embedding_text: entry.embeddingText,
        distance: Math.sqrt(Math.max(0, 2 * (1 - sim))),
      });
    }
    scored.sort((a, b) => {
      if (a.distance === b.distance) return a.persona_name.localeCompare(b.persona_name);
      return a.distance - b.distance;
    });
    return scored;
  }

  #storeFingerprint(entries, dim) {
    const meta = getEmbedderMeta();
    const modelName = meta?.name ?? getConfig()?.embeddingModel ?? "unknown";
    const quant = meta?.quant ?? getConfig()?.embeddingQuant ?? "unknown";
    const h = createHash("sha256");
    h.update(`${modelName}|${quant}|${dim}|`);
    for (const { category, persona, embeddingText } of entries) {
      h.update(`${category}|${persona.name}|`);
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

/**
 * Builds the persona vector store in the background.
 *
 * Called when the embedder becomes ready so the user's first auto-select does
 * not pay for indexing. Embedding the whole catalog is ~6s once per process
 * (measured on an 8-core box), and after that `indexAll` is a ~4ms fingerprint
 * no-op — so this is paid once, in the background, instead of once on a click.
 *
 * Three properties matter:
 *
 * - **Never rejects.** A failed warm is recorded in `indexStatus` and swallowed.
 *   The embedder's own readiness must not depend on the persona catalog
 *   embedding cleanly, and an unhandled rejection here would crash the process.
 * - **Idempotent and shared.** A second call while one is in flight returns the
 *   same promise rather than starting a competing pass over the same 349 items.
 * - **Safe to call with no embedder.** `embedText` throws per persona, the run
 *   completes with zero indexed, and the status lands on `error`.
 *
 * Note this does not skip work it doesn't need to: `indexAll` already no-ops on
 * an unchanged model+catalog fingerprint, so calling this unconditionally on
 * every embedder-ready event is correct and cheap.
 *
 * @param {object} [opts]
 * @param {object} [opts.personas] defaults to `getPersonas()`
 * @returns {Promise<number>} personas indexed (0 on failure)
 */
export async function warmPersonaIndex(opts = {}) {
  if (indexInFlight) return indexInFlight;
  if (indexStatus.state === "ready" && vectorStore.size > 0) return vectorStore.size;

  // Short-circuit before touching the catalog. Without this, a deployment with
  // no model attempts all ~349 embeddings, each throwing with a stack trace —
  // hundreds of log lines to report the one fact the status already carries.
  try {
    const { isEmbedderInitialized } = await import("./embedding-service.js");
    if (!isEmbedderInitialized()) {
      indexStatus = { state: "error", count: 0, message: "no embedding model loaded" };
      personaIndexLogger.warn("persona_index_warm_skipped", "No embedding model loaded — skipping persona index warm");
      return 0;
    }
  } catch {
    // Can't determine readiness; fall through and let indexAll report.
  }

  const run = (async () => {
    try {
      const personas = opts.personas ?? (await import("../composer/persona-loader.js")).getPersonas();
      return await new PersonaIndex().indexAll(personas);
    } catch (err) {
      personaIndexLogger.warn("persona_index_warm_failed", "Background persona index failed — auto-select will retry on demand", extractErrorInfo(err));
      return 0;
    }
  })();

  indexInFlight = run;
  try {
    return await run;
  } finally {
    if (indexInFlight === run) indexInFlight = null;
  }
}

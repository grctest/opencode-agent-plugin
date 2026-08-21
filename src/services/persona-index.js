/**
 * PersonaIndex: Embeds all personas and stores them in a dedicated vector table.
 * Used for similarity-based persona selection at meeting start.
 */

import { embedText, getEmbeddingDim } from "./embedding-service.js";
import { Logger, extractErrorInfo } from "../logger.js";

const personaIndexLogger = new Logger();

export class PersonaIndex {
  #database;

  constructor(database) {
    this.#database = database;
  }

  /**
   * Index all personas by embedding their text and storing in the vector DB.
   * Called once at meeting start after the embedding model is initialized.
   * @param {Object} personas - output of getPersonas(): { junior: [...], mid: [...], senior: [...], principal: [...] }
   */
  async indexAll(personas) {
    const dim = getEmbeddingDim();
    this.#database.clearPersonaEmbeddings();

    let indexed = 0;
    let failed = 0;
    // Batch with concurrency 4 to avoid sequential 7s stall
    const all = [];
    for (const [tier, tierPersonas] of Object.entries(personas)) {
      for (const persona of tierPersonas) {
        all.push({ tier, persona });
      }
    }
    const concurrency = 4;
    for (let i = 0; i < all.length; i += concurrency) {
      const batch = all.slice(i, i + concurrency);
      const results = await Promise.all(batch.map(async ({ tier, persona }) => {
        try {
          const embeddingText = this.#buildEmbeddingText(persona);
          const embedding = await embedText(embeddingText);
          return { tier, persona, embeddingText, embedding, err: null };
        } catch (err) {
          return { tier, persona, err };
        }
      }));
      for (const r of results) {
        if (r.err) {
          failed++;
          personaIndexLogger.warn("persona_index_failed", `Failed to index persona: ${r.persona.name}`, extractErrorInfo(r.err));
          continue;
        }
        try {
          const tags = r.persona.tags || r.persona.expertise || [];
          const rowId = this.#database.storePersonaEmbedding(
            r.persona.name,
            r.tier,
            tags,
            r.embeddingText,
            r.embedding,
            dim,
          );
          if (rowId != null) indexed++; else { failed++; personaIndexLogger.warn("persona_store_returned_null", `storePersonaEmbedding returned null for persona: ${r.persona.name}`); }
        } catch (err) {
          failed++;
          personaIndexLogger.warn("persona_index_failed", `Failed to index persona: ${r.persona.name}`, extractErrorInfo(err));
        }
      }
    }

    personaIndexLogger.info("personas_indexed", `Indexed ${indexed} personas (${dim}d)${failed > 0 ? ` (${failed} failed)` : ""}`);
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
    const dim = getEmbeddingDim();
    const queryEmbedding = await embedText(queryText, { isQuery: true });
    return this.#database.searchPersonaEmbeddings(queryEmbedding, tier, topK, dim);
  }

  async searchWithEmbedding(queryEmbedding, tier, topK = 5) {
    const dim = getEmbeddingDim();
    return this.#database.searchPersonaEmbeddings(queryEmbedding, tier, topK, dim);
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
    return parts.filter(Boolean).join(" ");
  }
}

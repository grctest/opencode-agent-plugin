import { Logger, extractErrorInfo } from "../logger.js";
import { embedText, getEmbeddingDim, getEmbeddingMaxTokens } from "./embedding-service.js";

const vectorLogger = new Logger();

/**
 * Manages vector-indexed fabric context.
 * Chunks round summaries and contributions, embeds them, and stores in sqlite-vec.
 * Provides RAG-based retrieval for agent prompts.
 */
export class VectorIndex {
  #database;

  constructor(database) {
    this.#database = database;
  }

  /**
   * Indexes a completed round's summary and contributions into the vector store.
   * @param {number} roundNumber
   * @param {string} roundSummary
   * @param {Array} contributions - contribution objects from this round
   * @returns {Promise<number>} number of chunks indexed
   */
  async indexRound(roundNumber, roundSummary, contributions = []) {
    let indexed = 0;
    const dim = getEmbeddingDim();

    if (roundSummary && roundSummary.trim()) {
      const chunks = this.#chunkText(roundSummary, `Round ${roundNumber} summary`);
      for (const chunk of chunks) {
        const chunkId = this.#database.storeFabricChunk(chunk, roundNumber, "round_summary");
        if (chunkId != null) {
          const embedding = await embedText(chunk);
          this.#database.storeFabricEmbedding(chunkId, embedding, dim);
          indexed++;
        }
      }
    }

    for (const contrib of contributions) {
      if (!contrib.content) continue;
      const text = `[${contrib.participant_id}] (${contrib.type}): ${contrib.content}`;
      const chunks = this.#chunkText(text, `Round ${roundNumber} contribution`);
      for (const chunk of chunks) {
        const chunkId = this.#database.storeFabricChunk(chunk, roundNumber, "contribution");
        if (chunkId != null) {
          const embedding = await embedText(chunk);
          this.#database.storeFabricEmbedding(chunkId, embedding, dim);
          indexed++;
        }
      }
    }

    vectorLogger.debug("round_indexed", `Indexed ${indexed} chunks for round ${roundNumber}`);
    return indexed;
  }

  /**
   * Indexes the initial user context into the vector store.
   * @param {string} context - user-provided context string
   * @returns {Promise<number>} number of chunks indexed
   */
  async indexContext(context) {
    if (!context || !context.trim()) return 0;
    let indexed = 0;
    const dim = getEmbeddingDim();
    const chunks = this.#chunkText(context, "User context");
    for (const chunk of chunks) {
      const chunkId = this.#database.storeFabricChunk(chunk, 0, "context");
      if (chunkId != null) {
        const embedding = await embedText(chunk);
        this.#database.storeFabricEmbedding(chunkId, embedding, dim);
        indexed++;
      }
    }
    return indexed;
  }

  /**
   * Retrieves the most semantically relevant prior context for the current round.
   * @param {string} queryText - text to embed and search against (e.g. current round contributions)
   * @param {number} topK - max chunks to retrieve
   * @param {number} excludeRound - round to exclude (current round)
   * @returns {Promise<Array<{content: string, round: number, distance: number}>>}
   */
  async retrieveRelevant(queryText, topK = 5, excludeRound = -1) {
    if (!queryText || !queryText.trim()) return [];
    try {
      const dim = getEmbeddingDim();
      const queryEmbedding = await embedText(queryText);
      const results = this.#database.searchFabricVectors(queryEmbedding, topK + 5, dim);
      return results
        .filter((r) => r.round !== excludeRound)
        .slice(0, topK)
        .map((r) => ({
          content: r.content,
          round: r.round,
          distance: r.distance,
          source: r.source,
        }));
    } catch (err) {
      vectorLogger.debug("retrieve_failed", "Vector retrieval failed", extractErrorInfo(err));
      return [];
    }
  }

  /**
   * Splits text into chunks suitable for embedding.
   * Strategy: split on paragraph boundaries, respect token limit.
   */
  #chunkText(text, sourceLabel = "") {
    const maxTokens = getEmbeddingMaxTokens();
    // Approximate: 1 token ≈ 4 characters for English text
    const maxChunkSize = maxTokens * 4;
    const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0);
    const chunks = [];
    let current = "";

    for (const para of paragraphs) {
      if (current.length + para.length + 2 > maxChunkSize && current.length > 0) {
        chunks.push(current.trim());
        current = para;
      } else {
        current = current ? `${current}\n\n${para}` : para;
      }
    }
    if (current.trim().length > 0) {
      chunks.push(current.trim());
    }

    return chunks.length > 0 ? chunks : [text.slice(0, maxChunkSize)];
  }
}

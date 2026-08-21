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
    const pending = [];

    if (roundSummary && roundSummary.trim()) {
      const chunks = this.#chunkText(roundSummary, `Round ${roundNumber} summary`);
      for (const chunk of chunks) {
        const chunkId = this.#database.storeFabricChunk(chunk, roundNumber, "round_summary");
        if (chunkId != null) pending.push({ chunkId, text: chunk });
      }
    }

    for (const contrib of contributions) {
      if (!contrib.content) continue;
      const text = `[${contrib.participant_id}] (${contrib.type}): ${contrib.content}`;
      const chunks = this.#chunkText(text, `Round ${roundNumber} contribution`);
      for (const chunk of chunks) {
        const chunkId = this.#database.storeFabricChunk(chunk, roundNumber, "contribution");
        if (chunkId != null) pending.push({ chunkId, text: chunk });
      }
    }

    // Batch embed with concurrency 4
    const concurrency = 4;
    for (let i = 0; i < pending.length; i += concurrency) {
      const batch = pending.slice(i, i + concurrency);
      const embeddings = await Promise.all(batch.map((p) => embedText(p.text).catch((e) => { vectorLogger.warn("embed_failed", `Failed to embed chunk for round ${roundNumber}`, extractErrorInfo(e)); return null; })));
      for (let j = 0; j < batch.length; j++) {
        const emb = embeddings[j];
        if (emb) {
          this.#database.storeFabricEmbedding(batch[j].chunkId, emb, dim);
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
      const queryEmbedding = await embedText(queryText, { isQuery: true });
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
   * Strategy: split on paragraph boundaries; hard-split oversized paragraphs by
   * sentence boundaries so no content is ever silently truncated (audit 06 V2).
   * Chunk budget is measured in REAL tokens via the bundled tokenizer when
   * available, falling back to the ×4 char heuristic only if tokenization fails.
   */
  #chunkText(text, sourceLabel = "") {
    const maxTokens = getEmbeddingMaxTokens();
    // Reserve headroom for the tokenizer's special tokens and estimation error.
    const maxChunkChars = Math.max(64, (maxTokens - 8) * 4);
    const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0);
    const chunks = [];
    let current = "";

    for (const para of paragraphs) {
      if (para.length > maxChunkChars) {
        // Oversized paragraph: flush current, then hard-split the paragraph by
        // sentence boundaries — never emit a chunk that will be token-truncated.
        if (current.trim().length > 0) {
          chunks.push(current.trim());
          current = "";
        }
        chunks.push(...VectorIndex.#splitOversizedParagraph(para, maxChunkChars));
        continue;
      }
      if (current.length + para.length + 2 > maxChunkChars && current.length > 0) {
        chunks.push(current.trim());
        current = para;
      } else {
        current = current ? `${current}\n\n${para}` : para;
      }
    }
    if (current.trim().length > 0) {
      chunks.push(current.trim());
    }

    return chunks.length > 0 ? chunks : [text.slice(0, maxChunkChars)];
  }

  /** Sentence-boundary hard-split of an oversized paragraph. */
  static #splitOversizedParagraph(para, maxChunkChars) {
    const sentences = para.split(/(?<=[.!?])\s+/);
    const pieces = [];
    let buf = "";
    const pushBuf = () => {
      if (buf.trim().length > 0) pieces.push(buf.trim());
      buf = "";
    };
    for (const sentence of sentences) {
      // A single sentence longer than the budget is split on word boundaries
      if (sentence.length > maxChunkChars) {
        pushBuf();
        let words = sentence.split(/\s+/);
        let line = "";
        for (const word of words) {
          if (line.length + word.length + 1 > maxChunkChars && line.length > 0) {
            pieces.push(line.trim());
            line = "";
          }
          line += (line ? " " : "") + word;
        }
        pushBuf();
        continue;
      }
      if (buf.length + sentence.length + 1 > maxChunkChars && buf.length > 0) {
        pushBuf();
      }
      buf += (buf ? " " : "") + sentence;
    }
    pushBuf();
    return pieces;
  }
}

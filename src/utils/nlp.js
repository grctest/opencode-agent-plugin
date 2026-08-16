/**
 * Shared NLP utilities: tokenization, TF-IDF, cosine similarity.
 * Used by composer (persona matching) and vector search (similarity).
 */

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "both",
  "each", "few", "more", "most", "other", "some", "such", "no", "nor",
  "not", "only", "own", "same", "so", "than", "too", "very", "just",
  "because", "but", "and", "or", "if", "while", "about", "up", "that",
  "this", "these", "those", "it", "its", "i", "we", "you", "they", "he",
  "she", "my", "your", "their", "our", "his", "her", "me", "them", "us",
]);

export function tokenize(text) {
  return text.toLowerCase().split(/\W+/).filter((w) => w.length >= 2);
}

export function tokenizeMeaningful(text) {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/);
  return words.filter((w) => w.length >= 2 && !STOPWORDS.has(w));
}

/**
 * Computes IDF over a corpus. Accepts either:
 * - Array of strings (uses basic tokenization)
 * - Array of objects with a `.content` property (uses meaningful tokenization with stopwords removed)
 */
export function computeIdf(corpus) {
  if (!corpus || corpus.length === 0) return {};
  const docCount = corpus.length;
  const docFreq = {};
  for (const doc of corpus) {
    const text = typeof doc === "string" ? doc : doc.content;
    const terms = new Set(tokenizeMeaningful(text));
    for (const term of terms) {
      docFreq[term] = (docFreq[term] || 0) + 1;
    }
  }
  const idf = {};
  for (const [term, freq] of Object.entries(docFreq)) {
    idf[term] = Math.log((docCount + 1) / (freq + 1)) + 1;
  }
  return idf;
}

export function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  const allTerms = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);
  for (const term of allTerms) {
    const a = vecA[term] || 0;
    const b = vecB[term] || 0;
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function computeTfidfVector(text, idf) {
  const meaningful = tokenizeMeaningful(text);
  const termFreq = {};
  for (const w of meaningful) {
    termFreq[w] = (termFreq[w] || 0) + 1;
  }
  const vec = {};
  for (const [term, freq] of Object.entries(termFreq)) {
    const idfVal = idf[term] || 1;
    vec[term] = freq * idfVal;
  }
  return vec;
}

// Alias for backward compatibility
export const buildIdf = computeIdf;

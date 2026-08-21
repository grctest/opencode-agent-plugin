/**
 * Input sanitization utilities for prompt injection prevention.
 * All user-provided content that goes into LLM prompts should pass through these.
 */

// Known directive patterns that must be preserved through sanitization
const DIRECTIVE_PATTERN = /\[(PASS|PROPOSE|CHALLENGE|REFINE|SUPPORT|DISSENT|SYNTHESIZE|QUESTION|REFUSE|YIELD|CONTEST[^\]]*|#\d+|NEXT:[^\]]*|CALL_VOTE|REQUEST_NEXT:[^\]]*)\]/gi;

/**
 * Sanitizes text for safe inclusion in LLM prompts.
 * Preserves known directive patterns, strips unknown bracket content and HTML/XML tags.
 * @param {string} text - Input text to sanitize
 * @param {number} [maxLen=10000] - Maximum allowed length
 * @returns {string} Sanitized text
 */
export function sanitizeForPrompt(text, maxLen = 10000) {
  if (!text || typeof text !== 'string') return '';
  // Extract and protect known directives before stripping brackets
  const directives = [];
  let sanitized = text.replace(DIRECTIVE_PATTERN, (match) => {
    directives.push(match);
    return `\x00${directives.length - 1}\x00`;
  });
  // Strip remaining brackets and HTML
  sanitized = sanitized
    .replace(/[\[\]{}]/g, '')
    .replace(/<[^>]*>/g, '');
  // Restore directives
  sanitized = sanitized.replace(/\x00(\d+)\x00/g, (_, idx) => directives[parseInt(idx)]);
  return sanitized.slice(0, maxLen).trim();
}

/**
 * Sanitizes text for safe display in UI/logs and for prompt display (preserves citations).
 * Strips HTML/XML tags but preserves directive patterns like [#12], [PROPOSE], etc.
 * Unlike sanitizeForPrompt, it keeps brackets for citation visibility.
 * @param {string} text - Input text to sanitize
 * @param {number} [maxLen=5000] - Maximum allowed length
 * @returns {string} Sanitized text
 */
export function sanitizeForDisplay(text, maxLen = 5000) {
  if (!text || typeof text !== 'string') return '';
  const directives = [];
  let sanitized = text.replace(DIRECTIVE_PATTERN, (match) => {
    directives.push(match);
    return `\x00${directives.length - 1}\x00`;
  });
  // Strip HTML/XML tags but keep brackets for citations
  sanitized = sanitized.replace(/<[^>]*>/g, '');
  sanitized = sanitized.replace(/\x00(\d+)\x00/g, (_, idx) => directives[parseInt(idx)]);
  return sanitized.slice(0, maxLen).trim();
}
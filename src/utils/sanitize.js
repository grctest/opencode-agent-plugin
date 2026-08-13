/**
 * Input sanitization utilities for prompt injection prevention.
 * All user-provided content that goes into LLM prompts should pass through these.
 */

/**
 * Sanitizes text for safe inclusion in LLM prompts.
 * Strips directive brackets, HTML/XML tags, and truncates to max length.
 * @param {string} text - Input text to sanitize
 * @param {number} [maxLen=10000] - Maximum allowed length
 * @returns {string} Sanitized text
 */
export function sanitizeForPrompt(text, maxLen = 10000) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/[\[\]{}]/g, '')           // Strip directive brackets
    .replace(/<[^>]*>/g, '')            // Strip HTML/XML tags
    .slice(0, maxLen)
    .trim();
}

/**
 * Sanitizes text for safe display in UI/logs.
 * Truncates to max length without stripping brackets (preserves directive visibility).
 * @param {string} text - Input text to sanitize
 * @param {number} [maxLen=5000] - Maximum allowed length
 * @returns {string} Sanitized text
 */
export function sanitizeForDisplay(text, maxLen = 5000) {
  if (!text || typeof text !== 'string') return '';
  return text.slice(0, maxLen).trim();
}

/**
 * Sanitizes a contribution object for safe storage and display.
 * @param {Object} contribution - Contribution object
 * @returns {Object} Sanitized contribution
 */
export function sanitizeContribution(contribution) {
  if (!contribution || typeof contribution !== 'object') return contribution;
  return {
    ...contribution,
    content: sanitizeForPrompt(contribution.content),
    targets_which: contribution.targets_which ? sanitizeForDisplay(contribution.targets_which) : null
  };
}

/**
 * Sanitizes warp context entry.
 * @param {string} warp - Warp context string
 * @returns {string} Sanitized warp
 */
export function sanitizeWarp(warp) {
  return sanitizeForPrompt(warp, 12000);
}

/**
 * Sanitzes user question and context for prompt injection.
 * @param {Object} params - { question, context }
 * @returns {Object} Sanitized params
 */
export function sanitizeUserInput({ question, context }) {
  return {
    question: sanitizeForPrompt(question, 5000),
    context: sanitizeForPrompt(context ?? '', 8000)
  };
}
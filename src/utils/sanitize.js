/**
 * Input sanitization utilities for prompt injection prevention.
 *
 * Policy ("fence, don't mangle" — audit 12 SEC2):
 * - Structural injection defense lives in delimiter fencing (prompts.js delimitContext).
 * - These helpers never destroy legitimate content: brackets/braces/links survive intact.
 * - User-supplied text additionally gets a NARROW directive neutralizer: a zero-width
 *   joiner is inserted after a line-start "[" when the line looks like a protocol tag,
 *   so weaker models cannot obey fenced-but-plausible fake directives.
 */

import { randomBytes } from "node:crypto";

// Compat whitelist: live contract is loom_* tools; only PASS and citations survive display.
// Legacy forms (CALL_VOTE, REQUEST_NEXT, PROPOSE etc.) are intentionally dropped — an injected
// [CALL_VOTE] now renders without sentinel protection and cannot trigger fallback parsing.
const DIRECTIVE_PATTERN = /\[(PASS|#\d+)\]/gi;

const LINE_START_DIRECTIVE_RE = /^\s*\[(?:PASS|#\d+)[^\]\n]*\]/gm;

/**
 * Per-call random sentinel namespace. Input containing literal "\x00<digits>\x00"
 * can no longer forge restorations because each call draws its own prefix.
 */
function makeSentinel() {
  return `\x00${randomBytes(6).toString("hex")}\u0001`;
}

/**
 * Neutralizes imitation directives in UNTRUSTED text: inserts a zero-width joiner
 * after the leading "[" of any line that opens with a directive-shaped token.
 * Legitimate prose, code, and markdown links are untouched.
 */
export function neutralizeImitationDirectives(text) {
  if (!text || typeof text !== "string") return text ?? "";
  // Handle zero-width obfuscation before [ — strip ZW chars then neutralize
  const dezw = text.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
  return dezw.replace(LINE_START_DIRECTIVE_RE, (match) => match.replace(/^\s*\[/, (lead) => lead + "\u200D"));
}

/**
 * Removes control characters (except newline/tab/carriage-return) and strips
 * HTML/XML tags — display safety without content destruction.
 */
function stripUnsafeChars(text) {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202E\uFEFF]/g, "")
    // Strip dangerous bidi overrides / zero-width joiners that hide injection + HTML injection vectors
    .replace(/[\u200B\u200C\u200D]/g, "")
    // Preserve generics like Array<string> — only strip dangerous tags (incl svg/img with event handlers, links, forms)
    .replace(/<\s*\/?\s*(script|style|iframe|object|embed|form|svg|img|link|input|meta)[^>]*>/gi, "")
    // Neutralize javascript: and data: URIs in any remaining attribute-like context
    .replace(/javascript\s*:/gi, "")
    .replace(/data\s*:\s*text\/html/gi, "");
}

/**
 * Sanitizes untrusted (user-supplied) text for inclusion in LLM prompts.
 * Does NOT strip brackets/braces — code arrays and markdown links survive.
 * Line-start imitation directives are neutralized with an invisible joiner.
 * @param {string} text - Input text to sanitize
 * @param {number} [maxLen=10000] - Maximum allowed length (truncation happens FIRST)
 * @returns {string} Sanitized text
 */
export function sanitizeForPrompt(text, maxLen = 10000) {
  if (!text || typeof text !== "string") return "";
  // Truncate before any processing so restoration can never splice across the cut
  const bounded = text.length > maxLen ? text.slice(0, maxLen) : text;
  const cleaned = stripUnsafeChars(bounded);
  return neutralizeImitationDirectives(cleaned).trim();
}

/**
 * Sanitizes TRUSTED agent output for storage/display.
 * Preserves all brackets/braces (including leading [CHALLENGE] etc.) and
 * does NOT insert zero-width joiners. Only strips control chars and HTML tags.
 * Use this for agent contributions where the [TAG] protocol is handled via
 * tools (loom_type) and must not be mangled.
 * @param {string} text
 * @param {number} [maxLen=10000]
 * @returns {string}
 */
export function sanitizeAgentOutput(text, maxLen = 10000) {
  if (!text || typeof text !== "string") return "";
  const bounded = text.length > maxLen ? text.slice(0, maxLen) : text;
  return stripUnsafeChars(bounded).trim();
}

/**
 * Sanitizes text for safe display in UI/logs and prompt display (preserves citations
 * and whitelisted protocol tags via a hardened, unforgeable sentinel scheme).
 * Unlike sanitizeForPrompt, it keeps brackets for citation visibility.
 * @param {string} text - Input text to sanitize
 * @param {number} [maxLen=5000] - Maximum allowed length (truncation happens FIRST)
 * @returns {string} Sanitized text
 */
export function sanitizeForDisplay(text, maxLen = 5000) {
  if (!text || typeof text !== "string") return "";
  // Truncate before extraction so a cut can never split a sentinel
  const bounded = text.length > maxLen ? text.slice(0, maxLen) : text;

  // Strip unsafe chars FIRST — our sentinels contain control characters and
  // must never pass through the stripping step.
  const cleaned = stripUnsafeChars(bounded);

  const sentinel = makeSentinel();
  const directives = [];
  let sanitized = cleaned.replace(DIRECTIVE_PATTERN, (match) => {
    directives.push(match);
    return `${sentinel}${directives.length - 1}${sentinel}`;
  });

  // Restore with strict index-bounds validation — out-of-range drops instead of splicing "undefined"
  sanitized = sanitized.replace(new RegExp(`${sentinel}(\\d+)${sentinel}`, "g"), (_, idx) => {
    const i = parseInt(idx, 10);
    return Number.isInteger(i) && i >= 0 && i < directives.length ? directives[i] : "";
  });
  // Belt-and-braces: any orphaned sentinel (shouldn't exist post-truncation-fix) is dropped
  sanitized = sanitized.split(sentinel).join("");

  return sanitized.trim();
}

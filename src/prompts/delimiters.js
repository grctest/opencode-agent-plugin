function makeDelimiter(label) {
  return `<<<LOOM_${label}>>>`;
}

function escapeDelimiters(text) {
  if (!text) return text;
  return text.replace(/<<</g, '\uFF3C\uFF3C\uFF3C').replace(/>>>/g, '\uFF3E\uFF3E\uFF3E').replace(/<</g, '\uFF3C\uFF3C').replace(/>>/g, '\uFF3E\uFF3E');
}

/**
 * Wraps context in delimiter-protected sections to prevent prompt injection.
 * Uses stable delimiters for reproducibility and debugging.
 */
export function delimitContext(context, label) {
  if (!context || !context.trim()) return '';
  const delim = makeDelimiter(label);
  const safe = escapeDelimiters(context);
  return `${delim}_BEGIN_\n${safe}\n${delim}_END_`;
}

export { escapeDelimiters };

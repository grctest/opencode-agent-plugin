// These matches are review candidates only; they never alter or classify an artifact.
export const READER_BAR_JARGON = Object.freeze([
  "modal",
  "estimand",
  "multinomial",
  "falsifiable",
  "heteroskedastic",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Finds exact-token candidates in a section without judging their meaning. */
export function findJargon(sectionText, jargonList = READER_BAR_JARGON) {
  if (typeof sectionText !== "string" || !Array.isArray(jargonList)) return [];
  const terms = [...new Set(jargonList.filter((term) => typeof term === "string" && term.length > 0))];
  const matches = [];
  const lines = sectionText.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    for (const term of terms) {
      const token = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(term)}(?![A-Za-z0-9_])`);
      if (token.test(line)) {
        matches.push({ term, line: index + 1, excerpt: line.trim() });
      }
    }
  }

  return matches;
}

export function findReaderBarCandidates(synthesisText) {
  const source = String(synthesisText ?? "");
  const lines = source.split(/\r?\n/);
  const candidates = [];
  for (const section of ["Executive Summary", "Decision"]) {
    const heading = new RegExp(`^#{2,}\\s*${escapeRegExp(section)}(?:\\s*[:—–-].*)?$`, "i");
    const start = lines.findIndex((line) => heading.test(line.trim()));
    if (start < 0) continue;
    const nextHeading = lines.findIndex((line, index) => index > start && /^#{2,}\s/.test(line.trim()));
    const end = nextHeading < 0 ? lines.length : nextHeading;
    const sectionText = lines.slice(start + 1, end).join("\n");
    for (const match of findJargon(sectionText)) {
      candidates.push({ section, line: start + 1 + match.line, term: match.term, excerpt: match.excerpt });
    }
  }
  return candidates;
}

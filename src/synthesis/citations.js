/**
 * P11 — citation support check: every [#id] must resolve to a contribution
 * whose content shares a significant keyword with the citing sentence.
 */
const CITATION_STOPWORDS = new Set(
  "the a an is are was were be been being have has had do does did will would could should may might must shall can need dare ought used to of in for on with at by from as into through during before after above below between under again further then once here there when where why how all each every both few more most other some such no nor not only own same so than too very just and but if or because until while that those am it its i me my we our you your he him his she her they them their what which who whom".split(" ")
);

export const CITATION_MIN_TARGET_CHARS = 400;

const SYNTHESIZED_FROM_RE = /\bsynthesi[sz]ed\s+from\b/i;

function significantKeywords(text) {
  const words = String(text).toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [];
  return new Set(words.filter((w) => w.length > 4 && !CITATION_STOPWORDS.has(w)));
}

export function checkCitationSupport(text, weave, { minTargetChars = CITATION_MIN_TARGET_CHARS } = {}) {
  const byId = new Map(weave.map((c) => [String(c.id), c]));
  const unsupported = [];
  const sentences = String(text).split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    if (SYNTHESIZED_FROM_RE.test(sentence)) continue;
    const sentenceWords = significantKeywords(sentence);
    for (const m of sentence.matchAll(/\[#(\d+)\]/g)) {
      const contrib = byId.get(m[1]);
      if (!contrib) continue;
      if (String(contrib.content ?? "").trim().length < minTargetChars) continue;
      const citedWords = significantKeywords(contrib.content);
      const supported = [...sentenceWords].some((w) => citedWords.has(w));
      if (!supported) unsupported.push({ id: m[1], sentence: sentence.trim().slice(0, 120) });
    }
  }
  return unsupported;
}

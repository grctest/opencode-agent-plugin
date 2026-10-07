/**
 * Synthesis section contract + markdown section helpers + system prompt.
 *
 * Single source of truth for required sections (audit D10): the draft
 * prompt, repair feedback, and validator must enumerate the same sections.
 */
import { LENGTH_LIMITS } from "../prompts/constants.js";

export function supplementMissingSections(text, missingSections) {
  const note = `> **Note:** The synthesizer did not generate the following sections: ${missingSections.join(", ")}. Consider reviewing the raw deliberation transcript for additional context.`;
  return `${text}\n\n${note}`;
}

export const SYNTHESIS_SECTION_CONTRACT = Object.freeze({
  core: ["Executive Summary", "Reasoning", "Confidence"],
  decisionFallback: "Decision",
  always: ["Open Questions"],
  actionGroup: ["Action Items", "Proposed Fix"],
  deferredGroup: ["Decision", "Decision Rule"],
});

export function validateSynthesisSections(text, style = null) {
  const C = SYNTHESIS_SECTION_CONTRACT;
  const hasExecutive = (() => {
    const esc = "Executive Summary".replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^#{2,}\\s*${esc}\\b`, "im").test(text);
  })();
  const coreRequired = hasExecutive ? ["Reasoning", "Confidence"] : [C.decisionFallback, "Reasoning", "Confidence"];
  const warnings = [];
  function hasSection(section) {
    const esc = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^#{2,}\\s*${esc}\\b`, "im");
    return re.test(text);
  }
  for (const section of coreRequired) {
    if (!hasSection(section)) warnings.push(section);
  }
  for (const section of C.always) {
    if (!hasSection(section)) warnings.push(section);
  }
  if (!C.actionGroup.some((s) => hasSection(s))) {
    warnings.push(C.actionGroup[0]);
  }
  if (style === "decision_oriented" && !hasSection(C.deferredGroup[1])) {
    const lines = String(text).split("\n");
    const start = lines.findIndex((l) => /^#{2,}\s*decision\s*$/i.test(l.trim()));
    if (start >= 0) {
      const body = [];
      for (const l of lines.slice(start + 1)) {
        if (/^#{2,}\s/.test(l.trim())) break;
        body.push(l);
      }
      if (/no single decision\s*[—–-]\s*spectrum below/i.test(body.join("\n"))) {
        warnings.push(C.deferredGroup[1]);
      }
    }
  }
  return warnings.filter((w) => !(hasExecutive && w === C.decisionFallback));
}

/** Extracts list items from a named section — accepts ## or ###. */
export function extractSection(text, sectionName) {
  const lines = text.split("\n");
  const results = [];
  let inSection = false;
  let paragraph = "";
  const isHeading = (l) => /^#{2,}\s/.test(l);

  const flushParagraph = () => {
    const trimmed = paragraph.trim();
    if (trimmed && !isHeading(trimmed)) results.push(trimmed);
    paragraph = "";
  };

  const headerMatches = (line, name) => {
    if (!isHeading(line)) return false;
    return line.replace(/^#{2,}\s*/, "").toLowerCase().includes(name.toLowerCase());
  };

  for (const line of lines) {
    if (headerMatches(line, sectionName)) {
      inSection = true;
      continue;
    }
    if (inSection && isHeading(line)) {
      flushParagraph();
      inSection = false;
      continue;
    }
    if (!inSection) continue;

    if (line.trim().startsWith("- ")) {
      flushParagraph();
      results.push(line.trim().slice(2));
    } else if (/^\d+\./.test(line.trim())) {
      flushParagraph();
      results.push(line.trim().replace(/^\d+\.\s*/, ""));
    } else if (line.trim() === "") {
      flushParagraph();
    } else {
      paragraph += (paragraph ? " " : "") + line.trim();
    }
  }
  flushParagraph();
  return results;
}

export const NEUTRAL_SYNTHESIZER_SYSTEM = `You are a synthesis auditor, not a participant. You are neutral to all agendas — including the synthesizer persona you may have borrowed. Human-readable first, then auditable detail. Concise but thorough.

Rules:
1. Lead with Executive Summary — plain narrative, no citations, human-first (${LENGTH_LIMITS.synthesisExecutive}w). Then group citations per block for Decision/Action/Proposed Fix — cite once per block as [#id] or State-of-Play or Source: https://…, never vec: / vec round. If you synthesize a novel fix/code not present verbatim, mark it “Proposed — synthesized from [#id]”. Do not invent file contents not read via tool; if no file read, qualify “Proposed (unverified — no tool read)”. For open-ended, mapping the spectrum is correct — don’t force a single Decision. Decision table cells concise: Evidence 30-35w + one grouped cite, Tradeoff 30-35w.
2. Do not invent numbers, dates, costs, tool results, or participant positions not in transcript/State-of-Play. If evidence conflicts, state both and set Confidence accordingly. For code, do not invent file contents not read via tool. Deduplicate: Decision maps positions, Reasoning explains why — don’t repeat same numbers thrice.
3. Never emit <<< or >>> delimiters. Be concise but thorough — 1500-3500w welcome; use the 200k window. Preserve code and numbers verbatim. Never emit vec: / vec round traces.`;

/** Normalizes internal vec: traces before final checks. */
export function normalizeVecTraces(text) {
  return text
    .replace(/\bvec:\s*round#?\s*\d+\b/gi, "State-of-Play")
    .replace(/\bvec\s+round\s*\d+\b/gi, "State-of-Play")
    .replace(/\[Round\s+\d+\s+vec[^\]]*\]/gi, "State-of-Play");
}

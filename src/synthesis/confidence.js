/**
 * Confidence derivation for synthesis artifacts.
 *
 * Name (qualitative) vs number (quantitative) layers live here.
 * Dissent is deliberately NOT penalized — see deriveConfidence docs.
 */

function hasNumericClaim(text) {
  return /\d+(?:\.\d+)?\s*(?:%|percent|ms|seconds?|minutes?|hours?|days?|weeks?|x\b|k\b|m\b|\$|€|£)/i.test(text)
    || /\b\d+(?:\.\d+)?\s*(?:–|-|to)\s*\d+(?:\.\d+)?\b/.test(text);
}

function isGroundedContribution(c) {
  const s = String(c.content || "");
  return /\[#\d+\]|Source:\s*https?:\/\/|file=src\//i.test(s) || (c.tool_calls && c.tool_calls.length > 0);
}

function hasConflictingFigures(contribs) {
  const byContext = new Map();
  const re = /(\b[A-Za-z]{3,}(?:\s+\b[A-Za-z]{3,}){0,1})\s+(\d+(?:\.\d+)?)\s*(?:%|percent|ms|seconds?|minutes?|hours?|days?|weeks?|x|k|m|\$|€|£)?/gi;
  for (const c of contribs) {
    for (const m of String(c.content || "").matchAll(re)) {
      const ctx = m[1].toLowerCase().trim();
      if (!byContext.has(ctx)) byContext.set(ctx, new Set());
      byContext.get(ctx).add(m[2]);
    }
  }
  for (const vals of byContext.values()) if (vals.size > 1) return true;
  return false;
}

/**
 * Derives a confidence level.
 *
 * Dissent is valuable and is NOT penalized: there is deliberately no dissent
 * term here. Grounding, participation and thoroughness are the signals, and
 * all three are countable from the weave.
 */
export function deriveConfidence(weave, totalParticipants = 0, activeParticipants = 0) {
  const totalContribs = weave.length;
  if (totalContribs === 0) return "low";

  const hasGroundedClaim = weave.some((c) => isGroundedContribution(c));
  const participationRate = totalParticipants > 0 ? activeParticipants / totalParticipants : 1;
  const challengeRatio = weave.filter((c) => c.type === "critique_response").length / Math.max(totalContribs, 1);

  if (hasGroundedClaim && participationRate >= 0.6 && totalContribs >= 4) {
    if (challengeRatio < 0.5) return "high";
  }
  if (hasGroundedClaim && participationRate >= 0.4 && totalContribs >= 2) return "medium";
  if (participationRate >= 0.5 && totalContribs >= 3) return "medium";
  return "low";
}

/** Parses the Confidence section — anchors to the Confidence heading block. */
export function parseConfidence(text) {
  const sectionRe = /^#{2,}\s*Confidence\b([\s\S]*?)(?=^#{2,}\s|(?![\s\S]))/im;
  const secMatch = text.match(sectionRe);
  const searchScope = secMatch ? secMatch[1] : text;
  const lineMatch = searchScope.match(/^\s*(High|Medium|Low)\s*$/im);
  if (lineMatch) return lineMatch[1].toLowerCase();
  const anyMatch = searchScope.match(/\b(High|Medium|Low)\b/i);
  return anyMatch ? anyMatch[1].toLowerCase() : null;
}

/**
 * Confidence in the quantitative layer. Numbers earn high confidence only
 * when (nearly) every numeric claim is grounded and no two contributions
 * assert conflicting figures for the same quantity.
 */
export function deriveConfidenceNumber(weave) {
  const numeric = weave.filter((c) => hasNumericClaim(c.content));
  if (numeric.length === 0) return "medium";
  const grounded = numeric.filter(isGroundedContribution);
  const groundingRatio = grounded.length / numeric.length;
  if (groundingRatio < 0.5) return "low";
  if (hasConflictingFigures(grounded)) return "medium";
  return groundingRatio >= 0.8 ? "high" : "medium";
}

/** Splits overall confidence into name (qualitative) + number (quantitative). */
export function deriveSplitConfidence(weave, totalParticipants = 0, activeParticipants = 0) {
  return {
    confidence_name: deriveConfidence(weave, totalParticipants, activeParticipants),
    confidence_number: deriveConfidenceNumber(weave),
  };
}

/**
 * Detects a numeric band that straddles a stated decision threshold.
 * @returns {Array<{band: [number, number], threshold: number}>}
 */
export function findStraddlingBands(text) {
  const t = String(text || "");
  const bands = [...t.matchAll(/(\d+(?:\.\d+)?)\s*(?:–|-|to)\s*(\d+(?:\.\d+)?)/g)];
  const thresholds = [...t.matchAll(/(?:threshold|bar|floor|gate|cutoff)\s*(?:of|at|is|:)?\s*(\d+(?:\.\d+)?)/gi)];
  const straddling = [];
  for (const b of bands) {
    const lo = parseFloat(b[1]);
    const hi = parseFloat(b[2]);
    for (const th of thresholds) {
      const v = parseFloat(th[1]);
      if (v >= lo && v <= hi) straddling.push({ band: [lo, hi], threshold: v });
    }
  }
  return straddling;
}

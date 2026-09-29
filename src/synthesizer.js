import { LENGTH_LIMITS } from "./prompts/constants.js";

function supplementMissingSections(text, missingSections) {
  const note = `> **Note:** The synthesizer did not generate the following sections: ${missingSections.join(", ")}. Consider reviewing the raw deliberation transcript for additional context.`;
  return `${text}\n\n${note}`;
}

/** Derives a confidence level — dissent is valuable, not penalized; thoroughness matters. */
export function deriveConfidence(weave, dissentCount, totalParticipants = 0, activeParticipants = 0) {
  const totalContribs = weave.length;
  if (totalContribs === 0) return "low";

  const hasGroundedClaim = weave.some(c => {
    const s = String(c.content || "");
    // vec: is internal retrieval trace, not a grounded cite — require [#id] / Source / file=
    return /\[#\d+\]|Source:\s*https?:\/\/|file=src\//i.test(s) || (c.tool_calls && c.tool_calls.length > 0);
  });
  const participationRate = totalParticipants > 0 ? activeParticipants / totalParticipants : 1;
  const challengeRatio = weave.filter((c) => c.type === "critique_response").length / Math.max(totalContribs, 1);

  // High: thorough + grounded, even with dissent if well-bounded
  if (hasGroundedClaim && participationRate >= 0.6 && totalContribs >= 4) {
    // Allow dissent to remain high if exploration was thorough
    if (dissentCount <= 2 || (dissentCount > 2 && challengeRatio < 0.5)) return "high";
  }
  if (hasGroundedClaim && participationRate >= 0.4 && totalContribs >= 2) return "medium";
  // Still medium if exploration thorough but many passes
  if (participationRate >= 0.5 && totalContribs >= 3) return "medium";
  return "low";
}

/** Parses the Confidence section — anchors to the Confidence heading block to avoid picking a stray High in body. */
export function parseConfidence(text) {
  // Find the Confidence section block, then search for the confidence word inside it
  const sectionRe = /^#{2,}\s*Confidence\b([\s\S]*?)(?=^#{2,}\s|\z)/im;
  const secMatch = text.match(sectionRe);
  const searchScope = secMatch ? secMatch[1] : text;
  // Look for the confidence word on its own line or as a label (avoid matching "High risk" in body unless it's the answer)
  const lineMatch = searchScope.match(/^\s*(High|Medium|Low)\s*$/im);
  if (lineMatch) return lineMatch[1].toLowerCase();
  // Fallback: first occurrence inside the Confidence block
  const anyMatch = searchScope.match(/\b(High|Medium|Low)\b/i);
  return anyMatch ? anyMatch[1].toLowerCase() : null;
}

/**
 * Single source of truth for the synthesis section contract (audit D10): the
 * draft prompt, the repair feedback, and the validator below must enumerate
 * the same sections. Import this table instead of hardcoding lists.
 */
export const SYNTHESIS_SECTION_CONTRACT = Object.freeze({
  core: ["Executive Summary", "Reasoning", "Confidence"],
  // Required only when no Executive Summary is present (open-ended spectrum).
  decisionFallback: "Decision",
  always: ["Open Questions"],
  // At least one of the group must be present.
  actionGroup: ["Action Items", "Proposed Fix"],
  // Deferred decision (commit device): when no single Decision is reached, the
  // Decision Rule section carries the resolution instead.
  deferredGroup: ["Decision", "Decision Rule"],
});

/** Validates that all required sections exist — flexible for open-ended (Decision optional if Executive Summary present).
 * Core: Executive Summary + Reasoning + Confidence always required. Decision OR synthesis table satisfies decision requirement.
 * Action Items / Proposed Fix: at least one must be present. Dissenting Views and Open Questions remain required.
 * Commit device: in decision_oriented style, a spectrum without a Decision must carry a Decision Rule instead.
 */
export function validateSynthesisSections(text, style = null) {
  const C = SYNTHESIS_SECTION_CONTRACT;
  const hasExecutive = (() => {
    const esc = "Executive Summary".replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^#{2,}\\s*${esc}\\b`, "im").test(text);
  })();
  const coreRequired = hasExecutive ? ["Reasoning", "Confidence"] : [C.decisionFallback, "Reasoning", "Confidence"];
  // Still require Decision if no Executive Summary; if Executive present, Decision is optional (open-ended spectrum)
  if (hasExecutive && !new RegExp(`^#{2,}\\s*Decision\\b`, "im").test(text)) {
    // No warning — open-ended map is allowed when Executive Summary exists
  } else if (!hasExecutive) {
    // coreRequired already includes Decision
  }
  const warnings = [];
  function hasSection(section) {
    const esc = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^#{2,}\\s*${esc}\\b`, "im");
    return re.test(text);
  }
  for (const section of coreRequired) {
    if (!hasSection(section)) {
      warnings.push(section);
    }
  }
  // If Executive Summary missing, still require Decision via coreRequired; no extra check needed
  for (const section of C.always) {
    if (!hasSection(section)) {
      warnings.push(section);
    }
  }
  if (!C.actionGroup.some(s => hasSection(s))) {
    warnings.push(C.actionGroup[0]);
  }
  // Commit device: decision_oriented syntheses whose ## Decision section
  // declares a spectrum ("No single decision — spectrum below", the exact
  // phrase the synthesis prompt mandates) without a Decision Rule section must
  // add one. Section-absence alone is not the trigger — the spectrum case
  // still carries a ## Decision heading. Other styles (and style-less legacy
  // callers) keep prior behavior.
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
  // If Executive Summary present but no Decision, don't warn — open-ended valid
  return warnings.filter(w => !(hasExecutive && w === C.decisionFallback));
}

/** Extracts list items from a named section of a markdown document — accepts ## or ###. */
export function extractSection(text, sectionName) {
  const lines = text.split("\n");
  const results = [];
  let inSection = false;
  let paragraph = "";
  const isHeading = (l) => /^#{2,}\s/.test(l);

  const flushParagraph = () => {
    const trimmed = paragraph.trim();
    if (trimmed && !isHeading(trimmed)) {
      results.push(trimmed);
    }
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

// ---------------------------------------------------------------------------
// P13 — Retract-and-propagate
// A retraction is a graph operation, not a local edit: when a participant
// retracts a figure, every downstream contribution that cites it (directly
// or transitively) inherits the taint. The synthesis output annotates —
// never silently drops — claims that depend on retracted figures, so no
// retracted figure survives as a live dispute in the artifact.
// ---------------------------------------------------------------------------

/** Explicit retraction phrasings — English words, not contribution types. */
const RETRACTION_PATTERNS = [
  /\bi retract\b/i,
  /\bi withdraw\b/i,
  /\bi take back\b/i,
  /\bi was wrong\b/i,
  /\bi'?m wrong\b/i,
  /\bcorrecting my earlier\b/i,
  /\bretract (?:my|the|that)\b/i,
  /\bwithdraw (?:my|the|that)\b/i,
  /\bi no longer stand by\b/i,
  /\bscratch that\b/i,
  /\bdisregard (?:my|that|the above)\b/i,
];

/** Extracts [#id] citation targets from a text block. */
function extractCitations(text) {
  const ids = new Set();
  for (const m of String(text || "").matchAll(/\[#(\d+)\]/g)) ids.add(m[1]);
  return ids;
}

/** Count of shared significant words between two texts — binds a retraction to its original. */
function keywordOverlap(a, b) {
  const words = (t) => String(t || "").toLowerCase().split(/\W+/).filter((w) => w.length > 4);
  const setB = new Set(words(b));
  return words(a).filter((w) => setB.has(w)).length;
}

/**
 * Scans the weave for explicit retractions and resolves, for each, the
 * original contribution being retracted. Binding order:
 *   1. explicit [#id] citations inside the retraction text;
 *   2. fallback — the same participant's earlier contribution with the
 *      strongest keyword overlap (minimum bar avoids binding a retraction
 *      to an unrelated earlier claim).
 * @returns {Array<{retraction: object, retracted: object|null, retractedIds: string[]}>}
 */
export function findRetractions(weave) {
  const retractions = [];
  for (const c of weave) {
    const content = String(c.content || "");
    if (!RETRACTION_PATTERNS.some((re) => re.test(content))) continue;
    const cited = [...extractCitations(content)];
    let retracted = null;
    if (cited.length > 0) {
      retracted = weave.find((w) => String(w.id) === cited[0]) ?? null;
    }
    if (!retracted) {
      let best = null;
      let bestScore = 0;
      for (const earlier of weave) {
        if (earlier === c) break; // only earlier contributions are retractable
        if (earlier.participant_id !== c.participant_id) continue;
        const score = keywordOverlap(content, earlier.content);
        if (score > bestScore) { best = earlier; bestScore = score; }
      }
      if (best && bestScore >= 3) retracted = best;
    }
    retractions.push({
      retraction: c,
      retracted,
      retractedIds: retracted ? [String(retracted.id)] : [],
    });
  }
  return retractions;
}

/**
 * Computes the full taint set: retracted contributions plus every downstream
 * contribution that cites a tainted one (transitive closure over the [#id]
 * citation graph). A vote whose reasoning cites a retracted figure is itself
 * tainted — retraction propagates through the reasoning text of later votes.
 * @returns {{retractedIds: Set<string>, taintedIds: Set<string>, retractions: Array}}
 */
export function propagateRetractions(weave) {
  const retractions = findRetractions(weave);
  const retractedIds = new Set();
  for (const r of retractions) for (const id of r.retractedIds) retractedIds.add(id);

  // citation graph: contributor id -> set of ids it cites
  const cites = new Map();
  for (const c of weave) cites.set(String(c.id), extractCitations(c.content));

  // BFS from each retracted id: anything citing a tainted contribution is tainted
  const taintedIds = new Set(retractedIds);
  const queue = [...retractedIds];
  while (queue.length > 0) {
    const id = queue.shift();
    for (const c of weave) {
      const cid = String(c.id);
      if (taintedIds.has(cid)) continue;
      if (cites.get(cid)?.has(id)) {
        taintedIds.add(cid);
        queue.push(cid);
      }
    }
  }
  return { retractedIds, taintedIds, retractions };
}

/**
 * Annotates claims in the synthesis output that depend on retracted figures.
 * Every line citing a retracted or tainted contribution gets an inline marker;
 * open-question items built on retracted figures are flagged so they do not
 * survive as live disputes. Annotations are additive — the underlying claim
 * stays readable for audit.
 * @returns {{text: string, annotations: number}}
 */
export function annotateRetractedClaims(text, retractionInfo) {
  const { retractedIds, taintedIds, retractions } = retractionInfo;
  if (retractedIds.size === 0) return { text, annotations: 0 };
  const retractionById = new Map();
  for (const r of retractions) for (const id of r.retractedIds) retractionById.set(id, r.retraction);

  let annotations = 0;
  const out = text.split("\n").map((line) => {
    const cited = [...line.matchAll(/\[#(\d+)\]/g)].map((m) => m[1]);
    const retractedCites = cited.filter((id) => retractedIds.has(id));
    const taintedCites = cited.filter((id) => taintedIds.has(id) && !retractedIds.has(id));
    if (retractedCites.length === 0 && taintedCites.length === 0) return line;
    const parts = [];
    for (const id of retractedCites) {
      const r = retractionById.get(id);
      parts.push(`⚠ retracted claim [#${id}]${r ? ` — retracted by [#${r.id}]` : ""}`);
    }
    for (const id of taintedCites) parts.push(`⚠ contains retracted claim [#${id}]`);
    annotations += parts.length;
    return `${line} ${parts.join(" ")}`;
  });
  return { text: out.join("\n"), annotations };
}

// ---------------------------------------------------------------------------
// P9 — Split name/number confidence
// The artifact separates confidence in the qualitative layer (the NAME: what
// we are deciding) from confidence in the quantitative layer (the NUMBER:
// any estimate the decision rests on). When the layers diverge the artifact
// carries both; when a numeric band straddles the decision threshold the
// deliverable degrades to threshold analysis instead of a point estimate.
// ---------------------------------------------------------------------------

/** Detects numeric claims with decision weight — figures, rates, and bands. */
function hasNumericClaim(text) {
  return /\d+(?:\.\d+)?\s*(?:%|percent|ms|seconds?|minutes?|hours?|days?|weeks?|x\b|k\b|m\b|\$|€|£)/i.test(text)
    || /\b\d+(?:\.\d+)?\s*(?:–|-|to)\s*\d+(?:\.\d+)?\b/.test(text);
}

/** A contribution is grounded when it carries a cite, a Source, or tool output. */
function isGroundedContribution(c) {
  const s = String(c.content || "");
  return /\[#\d+\]|Source:\s*https?:\/\/|file=src\//i.test(s) || (c.tool_calls && c.tool_calls.length > 0);
}

/** True when two grounded contributions assert different values for the same quantity context. */
function hasConflictingFigures(contribs) {
  const byContext = new Map(); // quantity context -> set of asserted values
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
 * Confidence in the quantitative layer. Numbers earn high confidence only
 * when (nearly) every numeric claim is grounded and no two contributions
 * assert conflicting figures for the same quantity. No numeric layer means
 * nothing to doubt — medium, not high, since the split is untested.
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

/**
 * Splits overall confidence into the name (qualitative conclusion) and the
 * number (quantitative estimate). When the layers agree the single overall
 * level stands; when they diverge the artifact carries both.
 */
export function deriveSplitConfidence(weave, dissentCount, totalParticipants = 0, activeParticipants = 0) {
  return {
    confidence_name: deriveConfidence(weave, dissentCount, totalParticipants, activeParticipants),
    confidence_number: deriveConfidenceNumber(weave),
  };
}

/**
 * Detects a numeric band that straddles a stated decision threshold
 * (e.g. band 8–11 vs threshold 10.8). A straddling band means the point
 * estimate is not decision-grade — the synthesis must degrade to threshold
 * analysis instead of publishing the point estimate.
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

// ---------------------------------------------------------------------------
// P10 — Pre-synthesis reconciliation pass
// One pass resolves-or-versions every numerical conflict and RUNS (not merely
// states) the cheapest falsifier for each. A conflict is two or more values
// for the same quantity (normalized phrase or count unit) asserted by
// different contributions. Each conflict is either resolved (retraction,
// rounding, rate×count, or denominator basis) or versioned (v1/v2 with a
// reconciliation rule) — never silently stacked in the artifact.
// ---------------------------------------------------------------------------

const QUANTITY_STOPWORDS = new Set(
  "the a an of in for to at by with is are was were be been being have has had do does did will would could should may might must shall can need dare ought about around roughly approximately nearly almost over under above below between among within without across through throughout per each every both some any no nor not only own same so than too very just and but if or because until while this that these those am it its i me my we our you your he him his she her they them their what which who whom shows states says said see seen say go went gone going make made making take took taken taking know knew known think thought look looked looking feel felt feeling seem seemed seeming become became leave left mean meant begin began help helped talk talked turn turned start started show showed hear heard play played move moved live lived hold held bring brought happen happened write wrote written provide provided sit sat stand stood lose lost meet met include included continue continued learn learned change changed lead led understand understood watch watched follow followed stop stopped create created speak spoke read allow allowed spend spent grow grew open opened walk walked offer offered remember remembered love loved consider considered appear appeared buy bought wait waited serve served die died send sent build built stay stayed fall fell cut reach reached kill killed remain remained suggest suggested raise raised pass passed sell sold require required report reported decide decided pull pulled run ran come came give gave get got".split(" ")
);

// Structural words that are never quantities when they precede a number
// ("round 3", "line 42", "version 2", "table 5") — filtered before grouping.
const QUANTITY_NOISE_WORDS = new Set(
  "line lines row rows col cols column columns page pages chapter chapters step steps part parts item items id ids version v round fig figure figures table tables eq equation no nos number numbers ref refs section sections para paragraph paragraphs slide slides eqn".split(" ")
);

const UNIT_NORMALIZE = {
  percent: "%", win: "win", wins: "win", won: "win", race: "race", races: "race",
  round: "round", rounds: "round", point: "point", points: "point",
  event: "event", events: "event", podium: "podium", podiums: "podium",
  pole: "pole", poles: "pole", game: "game", games: "game",
  match: "match", matches: "match", season: "season", seasons: "season",
  dollar: "$", dollars: "$", ms: "ms", second: "s", seconds: "s",
  minute: "min", minutes: "min", hour: "h", hours: "h",
  day: "d", days: "d", week: "w", weeks: "w", x: "x", k: "k", m: "m",
};

const COUNT_UNITS = new Set(["win", "race", "round", "point", "event", "podium", "pole", "game", "match", "season"]);

// A numeric claim: optional preceding quantity phrase, a number, optional unit.
const CLAIM_RE = /(?:\b([A-Za-z][\w'’-]*(?:\s+(?:[A-Za-z][\w'’-]*|of|in|for|to|at|by|with|the|a|an|per)){0,4})\s+)?(\d+(?:\.\d+)?)\s*(%|percent|wins?|races?|rounds?|points?|events?|podiums?|poles?|games?|matches?|seasons?|dollars?|ms|seconds?|minutes?|hours?|days?|weeks?|x|k|m)?/gi;

/**
 * Extracts numeric claims ({ quantity, unit, value, raw }) from text. The
 * quantity phrase is normalized (lowercased, stopwords and structural noise
 * stripped, count units singularized) so "Antonelli wins", "wins" and
 * "antonelli win" group together. Claims with neither a surviving quantity
 * phrase nor a unit ("in 2027", "round 3") are structural noise — dropped.
 */
export function extractNumericClaims(text) {
  const claims = [];
  for (const m of String(text ?? "").matchAll(CLAIM_RE)) {
    const value = Number(m[2]);
    if (!Number.isFinite(value)) continue;
    const unitRaw = (m[3] ?? "").trim().toLowerCase();
    const unit = UNIT_NORMALIZE[unitRaw] ?? (unitRaw || null);
    const words = (m[1] ?? "").toLowerCase().split(/\s+/).filter(Boolean)
      .map((w) => UNIT_NORMALIZE[w] ?? w)
      .filter((w) => !QUANTITY_STOPWORDS.has(w) && !QUANTITY_NOISE_WORDS.has(w));
    const quantity = words.join(" ");
    if (!quantity && !unit) continue;
    // "Antonelli will win 8 races" — the 8 counts WINS; the trailing "races"
    // is the object of "win", not the unit of 8. When the phrase ends in a
    // count unit, that unit wins over the trailing one.
    const lastWord = words[words.length - 1];
    const effectiveUnit = lastWord && COUNT_UNITS.has(lastWord) ? lastWord : unit;
    claims.push({ quantity, unit: effectiveUnit, value, raw: m[0] });
  }
  return claims;
}

/**
 * Scans the weave for numerical conflicts: the same quantity (normalized
 * phrase, or count unit as a coarse net) asserted at two or more distinct
 * values by different contributions.
 * @returns {Array<{quantity, unit, values: number[], claims: Array}>}
 */
export function findNumericalConflicts(weave) {
  const claims = [];
  for (const c of weave) {
    for (const claim of extractNumericClaims(c.content)) {
      claims.push({
        ...claim,
        contributionId: c.id,
        participantId: c.participant_id,
        round: c.round ?? null,
        order: claims.length,
      });
    }
  }
  const conflicts = [];
  const seen = new Set();
  const addConflict = (key, unit, conflictClaims, granularity) => {
    const byValue = new Map();
    for (const cl of conflictClaims) {
      if (!byValue.has(cl.value)) byValue.set(cl.value, []);
      byValue.get(cl.value).push(cl);
    }
    if (byValue.size < 2) return;
    if (new Set(conflictClaims.map((c) => c.contributionId)).size < 2) return;
    const sig = `${key}|${[...byValue.keys()].sort((a, b) => a - b).join(",")}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    conflicts.push({
      quantity: key,
      unit,
      granularity,
      values: [...byValue.keys()].sort((a, b) => a - b),
      claims: conflictClaims,
    });
  };
  // Primary grouping: normalized quantity phrase (or bare unit).
  const byPhrase = new Map();
  for (const cl of claims) {
    const key = cl.quantity || cl.unit || "%";
    if (!byPhrase.has(key)) byPhrase.set(key, []);
    byPhrase.get(key).push(cl);
  }
  for (const [key, group] of byPhrase) addConflict(key, group[0].unit, group, "phrase");
  // Secondary grouping: count-unit net — catches "6 wins" vs "8 wins" even
  // when the surrounding phrasing differs ("Antonelli wins" vs "wins").
  const byUnit = new Map();
  for (const cl of claims) {
    if (!cl.unit || !COUNT_UNITS.has(cl.unit)) continue;
    if (!byUnit.has(cl.unit)) byUnit.set(cl.unit, []);
    byUnit.get(cl.unit).push(cl);
  }
  for (const [unit, group] of byUnit) addConflict(unit, unit, group, "unit");
  return conflicts;
}

/**
 * Falsifier 1 — cheapest (set lookup): is one side of the conflict dead by
 * retraction? A value whose every asserting contribution is retracted or
 * tainted cannot stand against a live side.
 */
function runRetractionFalsifier(conflict, retractions) {
  const { retractedIds, taintedIds } = retractions;
  const isDead = (c) => retractedIds.has(String(c.contributionId)) || taintedIds.has(String(c.contributionId));
  const dead = conflict.claims.filter(isDead);
  const live = conflict.claims.filter((c) => !isDead(c));
  if (dead.length > 0 && live.length > 0) {
    const liveValues = [...new Set(live.map((c) => c.value))];
    return { ran: true, reconciled: true, method: "retraction-lookup", detail: `${dead.length} value(s) retracted/tainted; live side stands: ${liveValues.join(", ")}` };
  }
  return { ran: true, reconciled: false, method: "retraction-lookup", detail: "no retracted/tainted side" };
}

/**
 * Falsifier 2 — cheap (a few divisions): can arithmetic reconcile the values?
 * (a) rounding-level agreement, (b) rate × count against a stated denominator,
 * (c) the same rate restated on a different denominator.
 */
function runArithmeticFalsifier(conflict, { denominators, percentClaims }) {
  const values = conflict.values;
  const max = Math.max(...values);
  const tol = Math.max(0.5, Math.abs(max) * 0.01);
  if (values.every((v) => Math.abs(v - max) <= tol)) {
    return { ran: true, reconciled: true, method: "arithmetic", pick: "precise", detail: `values agree within rounding tolerance (±${tol.toFixed(2)})` };
  }
  const counts = conflict.claims.filter((c) => c.unit && COUNT_UNITS.has(c.unit));
  if (percentClaims.length > 0 && counts.length > 0) {
    let best = null;
    for (const p of percentClaims) {
      for (const c of counts) {
        for (const d of denominators) {
          if (d === 0 || d <= c.value) continue;
          const err = Math.abs(c.value / d - p.value / 100);
          if (err <= 0.02 && (!best || err < best.err)) best = { err, p: p.value, c: c.value, d };
        }
      }
    }
    if (best) {
      return { ran: true, reconciled: true, method: "arithmetic", pickValue: best.c, detail: `${best.c} / ${best.d} = ${((best.c / best.d) * 100).toFixed(1)}% ≈ stated ${best.p}%` };
    }
  }
  if (values.length === 2 && conflict.unit && COUNT_UNITS.has(conflict.unit)) {
    const [v1, v2] = values;
    for (const d1 of denominators) {
      for (const d2 of denominators) {
        // a denominator must exceed the count it divides — otherwise 6/6 ≈ 8/8
        // "reconciles" any two values
        if (d1 <= v1 || d2 <= v2 || d1 === d2) continue;
        const r1 = v1 / d1;
        const r2 = v2 / d2;
        if (Math.abs(r1 - r2) <= 0.05 * Math.max(Math.abs(r1), Math.abs(r2), 1e-9)) {
          return { ran: true, reconciled: true, method: "arithmetic", pick: "latest", detail: `same rate on different denominators: ${v1}/${d1} ≈ ${v2}/${d2}` };
        }
      }
    }
  }
  return { ran: true, reconciled: false, method: "arithmetic", detail: "no rounding, rate×count, or denominator reconciliation" };
}

/**
 * Falsifier 3 — last resort: the values form a reportable band. This falsifier
 * never reconciles; its negative result is what justifies versioning.
 */
function runBandFalsifier(conflict) {
  const lo = Math.min(...conflict.values);
  const hi = Math.max(...conflict.values);
  return { ran: true, reconciled: false, method: "band", detail: `values form a band [${lo}, ${hi}] — version instead of stacking` };
}

/** Collects denominator candidates: every count-unit value stated in the weave. */
function collectDenominatorCandidates(weave) {
  const out = new Set();
  for (const c of weave) {
    for (const claim of extractNumericClaims(c.content)) {
      if (claim.unit && COUNT_UNITS.has(claim.unit) && claim.value > 0) out.add(claim.value);
    }
  }
  return out;
}

/** Collects every percent claim in the weave (rate×count falsifier input). */
function collectPercentClaims(weave) {
  const out = [];
  for (const c of weave) {
    for (const claim of extractNumericClaims(c.content)) {
      if (claim.unit === "%") out.push(claim);
    }
  }
  return out;
}

function latestClaim(conflict) {
  return [...conflict.claims].sort((a, b) => (a.round ?? 0) - (b.round ?? 0) || a.order - b.order).pop();
}

function mostPreciseClaim(conflict) {
  const decimals = (v) => (String(v).split(".")[1] ?? "").length;
  return [...conflict.claims].sort((a, b) => decimals(b.value) - decimals(a.value) || (b.round ?? 0) - (a.round ?? 0) || b.order - a.order)[0];
}

/**
 * Resolves-or-versions one conflict: runs the cheapest falsifier first
 * (retraction lookup → arithmetic → band) and stops at the first
 * reconciliation. Unreconcilable conflicts are versioned v1 (earliest) /
 * v2 (latest) with a reconciliation rule.
 */
function resolveConflict(conflict, { retractions, denominators, percentClaims }) {
  const retraction = runRetractionFalsifier(conflict, retractions);
  if (retraction.reconciled) {
    const live = conflict.claims.filter((c) => !retractions.retractedIds.has(String(c.contributionId)) && !retractions.taintedIds.has(String(c.contributionId)));
    return {
      ...conflict,
      status: "resolved",
      resolution: { basis: "retraction", value: live[0]?.value ?? conflict.values[0], detail: retraction.detail },
      versions: null,
      reconciliationRule: null,
      falsifier: retraction,
    };
  }
  const arithmetic = runArithmeticFalsifier(conflict, { denominators, percentClaims });
  if (arithmetic.reconciled) {
    // rate×count resolves to the count itself; rounding resolves to the most
    // precise statement; denominator shift to the later value
    const value = arithmetic.pickValue
      ?? (arithmetic.pick === "precise" ? mostPreciseClaim(conflict).value : latestClaim(conflict).value);
    return {
      ...conflict,
      status: "resolved",
      resolution: { basis: "arithmetic", value, detail: arithmetic.detail },
      versions: null,
      reconciliationRule: null,
      falsifier: arithmetic,
    };
  }
  const band = runBandFalsifier(conflict);
  // v1 = earliest claim (first stated), v2 = latest claim (the revision) —
  // chronological, not value-ordered
  const sorted = [...conflict.claims].sort((a, b) => (a.round ?? 0) - (b.round ?? 0) || a.order - b.order);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    ...conflict,
    status: "versioned",
    resolution: null,
    versions: [
      { version: 1, value: first.value, contributionId: first.contributionId, round: first.round },
      { version: 2, value: last.value, contributionId: last.contributionId, round: last.round },
    ],
    reconciliationRule: "later value supersedes unless retracted; report as a band while they diverge",
    falsifier: band,
  };
}

/**
 * P10 — pre-synthesis reconciliation pass. Scans the weave for numerical
 * conflicts, resolves-or-versions each, and runs the cheapest falsifier per
 * conflict. Also computes the round-headroom signal: when the final round
 * yields a new dataset that conflicts with earlier rounds and stays
 * versioned, the meeting needs another round to reconcile.
 * @param {Array} weave - all contributions
 * @param {{retractionInfo?: Object}} [options] - precomputed propagateRetractions result
 * @returns {Object} reconciliation report
 */
export function reconcileNumericalConflicts(weave, { retractionInfo } = {}) {
  const conflicts = findNumericalConflicts(weave);
  const retractions = retractionInfo ?? propagateRetractions(weave);
  const denominators = collectDenominatorCandidates(weave);
  const percentClaims = collectPercentClaims(weave);
  const report = {
    conflicts: [],
    resolvedCount: 0,
    versionedCount: 0,
    unresolvedCount: 0,
    reserveRoundRecommended: false,
    reserveRoundReason: null,
  };
  for (const conflict of conflicts) {
    const result = resolveConflict(conflict, { retractions, denominators, percentClaims });
    report.conflicts.push(result);
    if (result.status === "resolved") report.resolvedCount++;
    else report.versionedCount++;
  }
  report.reserveRoundRecommended = shouldReserveReconciliationRound(weave, report);
  if (report.reserveRoundRecommended) {
    report.reserveRoundReason = "the final round introduced a new dataset that conflicts with earlier rounds and could not be reconciled by the cheapest falsifier — reserve a reconciliation round";
  }
  return report;
}

/**
 * Round-headroom signal for the weaving loop: true when a versioned conflict
 * has its v2 (latest value) from the final round — R-final yielded a new
 * dataset that needs a round to reconcile.
 */
export function shouldReserveReconciliationRound(weave, report) {
  if (!report || !Array.isArray(report.conflicts) || report.versionedCount === 0) return false;
  const rounds = (weave ?? []).map((c) => c.round ?? 0);
  const finalRound = rounds.length > 0 ? Math.max(...rounds) : 0;
  if (finalRound <= 1) return false;
  return report.conflicts.some((c) => c.status === "versioned"
    && Array.isArray(c.versions) && c.versions.length === 2
    && (c.versions[1].round ?? 0) >= finalRound);
}

const NEUTRAL_SYNTHESIZER_SYSTEM = `You are a synthesis auditor, not a participant. You are neutral to all agendas — including the synthesizer persona you may have borrowed. Human-readable first, then auditable detail. Concise but thorough.

Rules:
1. Lead with Executive Summary — plain narrative, no citations, human-first (${LENGTH_LIMITS.synthesisExecutive}w). Then group citations per block for Decision/Action/Proposed Fix — cite once per block as [#id] or State-of-Play or Source: https://…, never vec: / vec round. If you synthesize a novel fix/code not present verbatim, mark it “Proposed — synthesized from [#id]”. Do not invent file contents not read via tool; if no file read, qualify “Proposed (unverified — no tool read)”. For open-ended, mapping the spectrum is correct — don’t force a single Decision. Decision table cells concise: Evidence 30-35w + one grouped cite, Tradeoff 30-35w.
2. Do not invent numbers, dates, costs, tool results, or participant positions not in transcript/State-of-Play. If evidence conflicts, state both and set Confidence accordingly. For code, do not invent file contents not read via tool. Deduplicate: Decision maps positions, Reasoning explains why — don’t repeat same numbers thrice.
3. Never emit <<< or >>> delimiters. Be concise but thorough — 1500-3500w welcome; use the 200k window. Preserve code and numbers verbatim. Never emit vec: / vec round traces.`;

/** Normalizes internal vec: traces before final checks — replaces vec leak with State-of-Play reference. */
function normalizeVecTraces(text) {
  // Replace vec: round#X / vec round X / [Round X vec ...] with State-of-Play
  return text
    .replace(/\bvec:\s*round#?\s*\d+\b/gi, "State-of-Play")
    .replace(/\bvec\s+round\s*\d+\b/gi, "State-of-Play")
    .replace(/\[Round\s+\d+\s+vec[^\]]*\]/gi, "State-of-Play");
}

/** Summarizes a long objection to one line — preserves holder + core claim, caps to 200 chars. */

// P11 — function words excluded from citation keyword-overlap matching.
const CITATION_STOPWORDS = new Set(
  "the a an is are was were be been being have has had do does did will would could should may might must shall can need dare ought used to of in for on with at by from as into through during before after above below between under again further then once here there when where why how all each every both few more most other some such no nor not only own same so than too very just and but if or because until while this that these those am it its i me my we our you your he him his she her they them their what which who whom".split(" ")
);

/** Extracts significant keywords (len > 4, not a stopword) from text. */
function significantKeywords(text) {
  const words = String(text).toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [];
  return new Set(words.filter((w) => w.length > 4 && !CITATION_STOPWORDS.has(w)));
}

/**
 * P11 — citation resolution check: every [#id] must resolve to a contribution
 * whose content shares at least one significant keyword with the citing
 * sentence (word-boundary matching via whole-word set intersection).
 * Returns unsupported citations with their locations. Unresolved ids are out
 * of scope — sectionHasValidCite already flags those.
 */
export function checkCitationSupport(text, weave) {
  const byId = new Map(weave.map((c) => [String(c.id), c]));
  const unsupported = [];
  const sentences = String(text).split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    const sentenceWords = significantKeywords(sentence);
    for (const m of sentence.matchAll(/\[#(\d+)\]/g)) {
      const contrib = byId.get(m[1]);
      if (!contrib) continue;
      const citedWords = significantKeywords(contrib.content);
      const supported = [...sentenceWords].some((w) => citedWords.has(w));
      if (!supported) unsupported.push({ id: m[1], sentence: sentence.trim().slice(0, 120) });
    }
  }
  return unsupported;
}

/** Post-processes raw synthesis text into the final artifact: objections, missing-section notes, confidence, structured fields. */
export function finalizeSynthesis(artifactText, transcriptData, participants, objections) {
  // Normalize vec traces in the draft before any validation — auto-fix per user Q4
  artifactText = normalizeVecTraces(artifactText);
  const unresolvedObjections = (objections ?? []).filter((o) => o.unresolved);
  const weave = transcriptData.rounds.flatMap((r) => r.contributions);
  const refusals = weave.filter((c) => c.type === "refuse");
  const refusalsText = refusals.map((r) => {
    const p = participants.find((pp) => pp.config.id === r.participant_id);
    return `${p?.config.name ?? r.participant_id}: ${r.content}`;
  }).join("\n");
  
  let finalOutput = artifactText;

  if (refusalsText) {
    finalOutput = `${finalOutput}\n\n## Refusals\n${refusalsText}`;
  }

  const missingSections = validateSynthesisSections(finalOutput);
  if (missingSections.length > 0) {
    finalOutput = supplementMissingSections(finalOutput, missingSections);
  }

  // Grounded synthesis check: Decision section should cite at least one [#id] per block (not per line spam).
  // Grouped citations are valid — only flag if the entire Decision section lacks any valid weave citation.
  const weaveIds = new Set(weave.map((c) => String(c.id)));
  const sectionHasValidCite = (lines) => {
    let inFence = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^```/.test(trimmed)) { inFence = !inFence; continue; }
      if (inFence) continue;
      const cites = [...line.matchAll(/\[#(\d+)\]/g)].map((m) => m[1]);
      if (cites.some((id) => weaveIds.has(id))) return true;
    }
    return false;
  };
  const ungroundedLines = (lines) => lines.filter((line) => {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) return false;
    const cites = [...trimmed.matchAll(/\[#(\d+)\]/g)].map((m) => m[1]);
    return cites.length === 0 || cites.every((id) => !weaveIds.has(id));
  });
  const decisions = extractSection(finalOutput, "Decision");
  const hasExecutive = new RegExp(`^#{2,}\\s*Executive Summary\\b`, "im").test(finalOutput);
  const decisionHasValidCite = sectionHasValidCite(decisions);
  // Also consider citations in Reasoning as grounding if Decision is a spectrum table (open-ended)
  const reasoning = extractSection(finalOutput, "Reasoning");
  const reasoningHasValidCite = sectionHasValidCite(reasoning);
  const overallGrounded = decisionHasValidCite || (hasExecutive && reasoningHasValidCite);
  if (!overallGrounded && decisions.length > 0) {
    const ungrounded = ungroundedLines(decisions);
    if (ungrounded.length === decisions.length) {
      finalOutput += `\n\n## Needs Verification\nThe Decision section lacks a valid [#id] citation to the transcript and should be verified before acting. Consider checking State of Play or transcript.\n${ungrounded.slice(0, 5).map((l) => `- ${l.slice(0, 200)}`).join("\n")}`;
    }
  }
  // Action Items are executable — an ungrounded action item is the highest-cost
  // failure mode, so it gets its own check even when the Decision is grounded
  // (audit D8/5.6).
  const actionItems = extractSection(finalOutput, "Action Items");
  if (overallGrounded && actionItems.length > 0 && !sectionHasValidCite(actionItems)) {
    const ungroundedActions = ungroundedLines(actionItems);
    if (ungroundedActions.length === actionItems.length) {
      finalOutput += `\n\n## Needs Verification\nThe Action Items below cite no valid [#id] from the transcript — they assign work, so verify ownership and basis before acting.\n${ungroundedActions.slice(0, 5).map((l) => `- ${l.slice(0, 200)}`).join("\n")}`;
    }
  }
  // P11 — citation support: every [#id] must resolve to a contribution that
  // actually contains the attributed claim (keyword overlap with the citing
  // sentence). Mismatch annotates with a warning section.
  const unsupportedCitations = checkCitationSupport(finalOutput, weave);
  if (unsupportedCitations.length > 0) {
    finalOutput += `\n\n## Citation Warnings\nThe following [#id] citations do not resolve to a contribution that supports the cited claim — verify before acting:\n${unsupportedCitations.slice(0, 5).map((u) => `- [#${u.id}] — ${u.sentence}`).join("\n")}`;
  }

  // P13 — retract-and-propagate: annotate claims that depend on retracted
  // figures so no retracted figure survives as a live dispute.
  const retractionInfo = propagateRetractions(weave);
  if (retractionInfo.retractedIds.size > 0) {
    finalOutput = annotateRetractedClaims(finalOutput, retractionInfo).text;
  }

  // P10 — pre-synthesis reconciliation pass: resolve-or-version every
  // numerical conflict and run the cheapest falsifier BEFORE the final output
  // is produced, so contradictions are versioned (v1/v2 + rule) in the
  // artifact instead of stacked.
  const reconciliation = reconcileNumericalConflicts(weave, { retractionInfo });
  if (reconciliation.versionedCount > 0) {
    const lines = reconciliation.conflicts
      .filter((c) => c.status === "versioned")
      .map((c) => {
        const v1 = c.versions[0];
        const v2 = c.versions[1];
        const unit = c.unit ? ` ${c.unit}` : "";
        return `- ${c.quantity}: v1 = ${v1.value}${unit} [#${v1.contributionId}] vs v2 = ${v2.value}${unit} [#${v2.contributionId}] — ${c.reconciliationRule} (falsifier: ${c.falsifier.method} — ${c.falsifier.detail})`;
      });
    finalOutput += `\n\n## Needs Verification\n${reconciliation.versionedCount} numerical conflict(s) are stated with competing values — versioned here with reconciliation rules; cite the latest version unless retracted:\n${lines.join("\n")}\n`;
  }

  // P9 — a band straddling the decision threshold is not decision-grade:
  // flag it so the deliverable degrades to threshold analysis.
  const straddlingBands = findStraddlingBands(finalOutput);
  if (straddlingBands.length > 0) {
    const bandList = straddlingBands.map((s) => `${s.band[0]}–${s.band[1]} vs threshold ${s.threshold}`).join(", ");
    finalOutput += `\n\n## Needs Verification\nThe numeric band(s) ${bandList} straddle the decision threshold — degrade to threshold analysis (state the band and what evidence would move it) instead of a point estimate.\n`;
  }

  const parsedConfidence = parseConfidence(finalOutput);
  const activeParticipants = participants.filter((p) => p.status !== "failed").length;
  const heuristicConfidence = deriveConfidence(weave, unresolvedObjections.length, participants.length, activeParticipants);
  // The model's word is prose; the derived check — which inspects actual
  // grounding — is authoritative. Downgrade on >1 level disagreement, and
  // record both so the dashboard can show the gap (audit D7/5.2).
  const rankConfidence = (c) => ({ high: 2, medium: 1, low: 0 })[String(c ?? "").toLowerCase()] ?? -1;
  let confidence = heuristicConfidence;
  if (parsedConfidence && rankConfidence(parsedConfidence) >= 0 && rankConfidence(heuristicConfidence) >= 0) {
    confidence = rankConfidence(parsedConfidence) - rankConfidence(heuristicConfidence) > 1
      ? heuristicConfidence
      : parsedConfidence;
  }

  // P9 — split name/number confidence: derive both layers; the artifact
  // carries the split only when the layers diverge.
  const { confidence_name, confidence_number } = deriveSplitConfidence(weave, unresolvedObjections.length, participants.length, activeParticipants);

  const artifact = {
    content: finalOutput,
    format: "markdown",
    decisions: extractSection(finalOutput, "Decision"),
    action_items: extractSection(finalOutput, "Action Items"),
    proposed_fix: extractSection(finalOutput, "Proposed Fix"),
    files_involved: extractSection(finalOutput, "Files Involved"),
    dissent: [],
    refusals: refusals.map(r => ({
      participant_id: r.participant_id,
      content: r.content,
    })),
    open_questions: extractSection(finalOutput, "Open Questions"),
    confidence,
    confidence_reported: parsedConfidence,
    confidence_derived: heuristicConfidence,
    // P9 — split confidence surfaces only when the layers diverge
    ...(confidence_name !== confidence_number ? { confidence_name, confidence_number } : {}),
    // P13 — retraction record: what was retracted, by whom, and what it tainted
    retractions: retractionInfo.retractions.map((r) => ({
      retraction_id: r.retraction.id,
      retracted_id: r.retracted ? Number(r.retracted.id) : null,
      tainted_ids: [...retractionInfo.taintedIds].map(Number),
    })),
    // P10 — reconciliation report: every numerical conflict, its status, and
    // the falsifier that ran on it
    reconciliation: {
      resolvedCount: reconciliation.resolvedCount,
      versionedCount: reconciliation.versionedCount,
      reserveRoundRecommended: reconciliation.reserveRoundRecommended,
      reserveRoundReason: reconciliation.reserveRoundReason,
      conflicts: reconciliation.conflicts.map((c) => ({
        quantity: c.quantity,
        unit: c.unit,
        values: c.values,
        status: c.status,
        resolution: c.resolution,
        versions: c.versions,
        reconciliationRule: c.reconciliationRule,
        falsifier: c.falsifier,
      })),
    },
  };

  return { artifact, output: finalOutput };
}

export { NEUTRAL_SYNTHESIZER_SYSTEM };

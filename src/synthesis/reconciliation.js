/**
 * P10 — pre-synthesis reconciliation: resolve-or-version every numerical
 * conflict and RUN (not merely state) the cheapest falsifier for each.
 */

const QUANTITY_STOPWORDS = new Set(
  "the a an of in for to at by with is are was were be been being have has had do does did will would could should may might must shall can need dare ought about around roughly approximately nearly almost over under above below between among within without across through throughout per each every both some any no nor not only own same so than too very just and but if or because until while this that these those am it its i me my we our you your he him his she her they them their what which who whom shows states says said see seen say go went gone going make made making take took taken taking know knew known think thought look looked looking feel felt feeling seem seemed seeming become became leave left mean meant begin began help helped talk talked turn turned start started show showed hear heard play played move moved live lived hold held bring brought happen happened write wrote written provide provided sit sat stand stood lose lost meet met include included continue continued learn learned change changed lead led understand understood watch watched follow followed stop stopped create created speak spoke read allow allowed spend spent grow grew open opened walk walked offer offered remember remembered love loved consider considered appear appeared buy bought wait waited serve served die died send sent build built stay stayed fall fell cut reach reached kill killed remain remained suggest suggested raise raised pass passed sell sold require required report reported decide decided pull pulled run ran come came give gave get got".split(" ")
);

const QUANTITY_NOISE_WORDS = new Set(
  "line lines row rows col cols column columns page pages chapter chapters step steps part parts item items id ids version v round fig figure figures table tables eq equation no nos number numbers ref refs section sections para paragraph paragraphs slide slides eqn".split(" ")
);

const QUANTITY_CONNECTOR_WORDS = new Set(
  "vs versus v per pro con versus cf versus than then about roughly approx approximately around near over under plus minus and or but so if when while because since although though yet nor also both either neither each every any all some no not only own same such as at by for from into onto with without within without across through during before after above below between among plus minus equal equals roughly about".split(" ")
);

/**
 * Unit vocabulary. Domain-general by construction: the F1 set (win / race /
 * podium / pole / season) stays because it is still real vocabulary, and the
 * engineering + product set that was missing joins it (tests, rows, requests,
 * endpoints, failures, MB, p95, rps …).
 *
 * A unit listed here is a COUNTABLE unit: when it is the last word of a
 * quantity label ("requests failed: 3") it becomes the claim's unit, so two
 * contributors who state the same count in different words reconcile instead
 * of sailing past each other.
 */
const UNIT_NORMALIZE = {
  percent: "%", win: "win", wins: "win", won: "win", race: "race", races: "race",
  round: "round", rounds: "round", point: "point", points: "point",
  event: "event", events: "event", podium: "podium", podiums: "podium",
  pole: "pole", poles: "pole", game: "game", games: "game",
  match: "match", matches: "match", season: "season", seasons: "season",
  dollar: "$", dollars: "$", ms: "ms", second: "s", seconds: "s",
  minute: "min", minutes: "min", hour: "h", hours: "h",
  day: "d", days: "d", week: "w", weeks: "w", x: "x", k: "k", m: "m",
  pp: "pp", ppt: "pp", "percentage point": "pp", "percentage points": "pp",
  bps: "bps", "basis point": "bps", "basis points": "bps",
  usd: "$",
  // Engineering / product counts.
  test: "test", tests: "test", row: "row", rows: "row",
  request: "request", requests: "request", query: "query", queries: "query",
  endpoint: "endpoint", endpoints: "endpoint", field: "field", fields: "field",
  bug: "bug", bugs: "bug", error: "error", errors: "error",
  failure: "failure", failures: "failure", user: "user", users: "user",
  session: "session", sessions: "session", ticket: "ticket", tickets: "ticket",
  task: "task", tasks: "task", commit: "commit", commits: "commit",
  branch: "branch", branches: "branch", file: "file", files: "file",
  module: "module", modules: "module", service: "service", services: "service",
  deploy: "deploy", deploys: "deploy", incident: "incident", incidents: "incident",
  vote: "vote", votes: "vote", agent: "agent", agents: "agent",
  seat: "seat", seats: "seat", option: "option", options: "option",
  risk: "risk", risks: "risk", concern: "concern", concerns: "concern",
  hypothesis: "hypothesis", hypotheses: "hypothesis",
  assumption: "assumption", assumptions: "assumption",
  idea: "idea", ideas: "idea", fix: "fix", fixes: "fix",
  regression: "regression", regressions: "regression",
  migration: "migration", migrations: "migration",
  retry: "retry", retries: "retry", timeout: "timeout", timeouts: "timeout",
  // Magnitudes.
  kb: "kb", mb: "mb", gb: "gb", tb: "tb", kib: "kib", mib: "mib", gib: "gib",
  p50: "p50", p95: "p95", p99: "p99", rps: "rps", qps: "qps",
  ns: "ns", "µs": "µs", eur: "eur", gbp: "gbp",
};

const COUNT_UNITS = new Set([
  "win", "race", "round", "point", "event", "podium", "pole", "game", "match", "season",
  "test", "row", "request", "query", "endpoint", "field", "bug", "error", "failure",
  "user", "session", "ticket", "task", "commit", "branch", "file", "module", "service",
  "deploy", "incident", "vote", "agent", "seat", "option", "risk", "concern",
  "hypothesis", "assumption", "idea", "fix", "regression", "migration", "retry", "timeout",
]);

// Modifiers are not metrics. "Mercedes expected 0.5 wins" and "Mercedes 9 wins"
// share the words "mercedes" and "expected", but they answer different
// questions. A label made only of modifiers cannot identify a quantity, so it
// must not license a conflict.
const QUANTITY_MODIFIER_WORDS = new Set(
  "expected estimated projected implied total average avg mean median approx approximately roughly about around recent current latest prior previous next final initial new old reported stated official unofficial annual monthly weekly daily".split(" ")
);

// A calendar year is a date qualifier, not a count of anything. "expected 2027
// wins" contains the number 2027, but the quantity is wins — treating 2027 as a
// competing win count produced the worst false conflicts in the F1 meeting
// (band [0.5, 2027]). Years are skipped in conflict detection; the number stays
// in the transcript and the artifact untouched.
function isYearLikeValue(value) {
  return Number.isInteger(value) && value >= 1900 && value <= 2100;
}

// Groups: 1 = quantity label, 2 = currency prefix, 3 = number, 4 = unit.
// Longer unit words come first so "mb" is not read as "m" and "matches" is not
// read as "matche".
const CLAIM_RE = /(?:\b([A-Za-z][\w'’-]*(?:\s+(?:[A-Za-z][\w'’-]*|of|in|for|to|at|by|with|the|a|an|per)){0,4})\s+)?(\$)?(\d+(?:\.\d+)?)\s*(%|percentage\s+points?|percent|pp|ppt|basis\s+points?|bps|wins?|races?|rounds?|points?|events?|podiums?|poles?|games?|matches?|seasons?|tests?|rows?|requests?|queries|endpoints?|fields?|bugs?|errors?|failures?|users?|sessions?|tickets?|tasks?|commits?|branches|files?|modules?|services?|deploys?|incidents?|votes?|agents?|seats?|options?|risks?|concerns?|hypotheses|assumptions?|ideas?|fixes|regressions?|migrations?|retries?|timeouts?|dollars?|ms|seconds?|minutes?|hours?|days?|weeks?|kb|mb|gb|tb|kib|mib|gib|p50|p95|p99|rps|qps|ns|µs|usd|eur|gbp|x|k|m)?/gi;

/**
 * A digit run that belongs to an identifier or an expression is not a claim:
 * "v2", "utf8", "sha256", "base64", "N+1", "3-2" ranges. Without this guard,
 * widening the unit vocabulary would turn "N+1 queries" into a claim of one
 * query — a false conflict waiting to be reported to the room.
 */
function isEmbeddedNumber(text, match) {
  const raw = match[0] ?? "";
  const num = match[3] ?? "";
  if (!raw || !num) return false;
  // The number is the LAST occurrence of its digits in the match (the unit
  // group holds no digits), so a label like "gpt 8 wins 8" cannot shift the
  // offset onto the label's own digits.
  const numIdx = raw.lastIndexOf(num);
  if (numIdx < 0) return false;
  const abs = (match.index ?? 0) + numIdx;
  const before = abs > 0 ? text[abs - 1] : "";
  if (/[A-Za-z0-9_+]/.test(before)) return true;
  // A range ("3-2") is not a second quantity.
  if (before === "-" && abs > 1 && /[0-9]/.test(text[abs - 2])) return true;
  return false;
}

/**
 * A unit can sit one or two adjectives away from its number ("3 stale
 * requests", "12 large endpoints"). The claim regex only sees a unit that
 * directly follows the number, so the gap is closed here — strictly: the
 * trailing word must be a KNOWN unit alias, and at most two lowercase words
 * may sit between. "3 of the 12 endpoints" and "3 in 2027" find no unit and
 * stay unclaimed.
 */
const UNIT_ALIASES = new Set(Object.keys(UNIT_NORMALIZE));

function findDeferredUnit(text, afterIndex) {
  const rest = text.slice(afterIndex);
  // Up to three intervening words, then the candidate unit.
  const m = /^\s*([a-z][a-z-]*(?:\s+[a-z][a-z-]*){0,3})/i.exec(rest);
  if (!m) return null;
  const words = (m[1] ?? "").trim().split(/\s+/).filter(Boolean);
  // Closest unit wins: "3 stale requests per second" is a count of requests,
  // not a count of seconds.
  for (let i = 0; i < words.length; i++) {
    const unitWord = words[i].toLowerCase();
    if (!UNIT_ALIASES.has(unitWord)) continue;
    return { adjectives: words.slice(0, i), unit: UNIT_NORMALIZE[unitWord] ?? unitWord };
  }
  return null;
}

export function extractNumericClaims(text) {
  const claims = [];
  const src = String(text ?? "");
  for (const m of src.matchAll(CLAIM_RE)) {
    const value = Number(m[3]);
    if (!Number.isFinite(value)) continue;
    if (isEmbeddedNumber(src, m)) continue;
    const currency = (m[2] ?? "").trim();
    let unitRaw = (m[4] ?? "").trim().toLowerCase();
    let adjectives = [];
    if (!unitRaw && !currency) {
      const numIdx = (m[0] ?? "").lastIndexOf(m[3] ?? "");
      const numEnd = (m.index ?? 0) + (numIdx < 0 ? 0 : numIdx) + (m[3] ?? "").length;
      const deferred = findDeferredUnit(src, numEnd);
      if (deferred) { unitRaw = deferred.unit; adjectives = deferred.adjectives; }
    }
    const unit = currency ? "$" : (UNIT_NORMALIZE[unitRaw] ?? (unitRaw || null));
    const words = (m[1] ?? "").toLowerCase().split(/\s+/).filter(Boolean)
      .map((w) => UNIT_NORMALIZE[w] ?? w)
      .filter((w) => !QUANTITY_STOPWORDS.has(w) && !QUANTITY_NOISE_WORDS.has(w) && !QUANTITY_CONNECTOR_WORDS.has(w));
    for (const adj of adjectives) {
      const w = UNIT_NORMALIZE[adj] ?? adj;
      if (QUANTITY_STOPWORDS.has(w) || QUANTITY_NOISE_WORDS.has(w) || QUANTITY_CONNECTOR_WORDS.has(w)) continue;
      words.push(w);
    }
    const quantity = words.join(" ");
    if (!quantity && !unit) continue;
    const lastWord = words[words.length - 1];
    const effectiveUnit = lastWord && COUNT_UNITS.has(lastWord) ? lastWord : unit;
    claims.push({ quantity, unit: effectiveUnit, value, raw: m[0] });
  }
  return claims;
}

function labelWordsOf(claim) {
  return (claim.quantity ?? "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !COUNT_UNITS.has(w) && !QUANTITY_CONNECTOR_WORDS.has(w));
}

export function isRealQuantityLabel(key) {
  const words = String(key ?? "").split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;
  return words.some((w) => w.length > 2
    && !COUNT_UNITS.has(w)
    && !QUANTITY_CONNECTOR_WORDS.has(w)
    && !QUANTITY_MODIFIER_WORDS.has(w));
}

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
  const addConflict = (key, unit, conflictClaims, granularity, label = null) => {
    const labelKey = label ?? key;
    if (!isRealQuantityLabel(labelKey)) return;
    const byValue = new Map();
    for (const cl of conflictClaims) {
      if (!byValue.has(cl.value)) byValue.set(cl.value, []);
      byValue.get(cl.value).push(cl);
    }
    if (byValue.size < 2) return;
    if (new Set(conflictClaims.map((c) => c.contributionId)).size < 2) return;
    const ordered = [...conflictClaims].sort((a, b) => (a.round ?? 0) - (b.round ?? 0) || a.order - b.order);
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    if (first === last) return;
    if ((first.round ?? 0) === (last.round ?? 0) && first.contributionId === last.contributionId) return;
    const sig = `${granularity}|${key}|${label ?? ""}|${[...byValue.keys()].sort((a, b) => a - b).join(",")}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    conflicts.push({
      quantity: key,
      label: label ?? null,
      unit,
      granularity,
      values: [...byValue.keys()].sort((a, b) => a - b),
      claims: conflictClaims,
    });
  };
  const byPhrase = new Map();
  for (const cl of claims) {
    // A bare number is not a comparable quantity. Grouping every "Mercedes 9"
    // into one bucket turned unrelated sentences (a count, a year, a model
    // name) into a single conflict. Conflicts need a unit or a recognized
    // metric unit to be falsifiable.
    if (!cl.unit || isYearLikeValue(cl.value)) continue;
    const key = cl.quantity || cl.unit || "%";
    if (!byPhrase.has(key)) byPhrase.set(key, []);
    byPhrase.get(key).push(cl);
  }
  for (const [key, group] of byPhrase) {
    const byUnit = new Map();
    for (const cl of group) {
      const u = cl.unit ?? null;
      if (!byUnit.has(u)) byUnit.set(u, []);
      byUnit.get(u).push(cl);
    }
    for (const [unit, sub] of byUnit) addConflict(key, unit, sub, "phrase");
  }
  const byUnit = new Map();
  for (const cl of claims) {
    if (!cl.unit || !COUNT_UNITS.has(cl.unit) || isYearLikeValue(cl.value)) continue;
    if (!byUnit.has(cl.unit)) byUnit.set(cl.unit, []);
    byUnit.get(cl.unit).push(cl);
  }
  for (const [unit, group] of byUnit) {
    const clusters = new Map();
    for (const cl of group) {
      for (const label of labelWordsOf(cl)) {
        if (label === unit) continue;
        if (!clusters.has(label)) clusters.set(label, []);
        clusters.get(label).push(cl);
      }
    }
    for (const [label, cluster] of clusters) addConflict(unit, unit, cluster, "unit", label);
  }
  return conflicts;
}

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

function runBandFalsifier(conflict) {
  const lo = Math.min(...conflict.values);
  const hi = Math.max(...conflict.values);
  return { ran: true, reconciled: false, method: "band", detail: `values form a band [${lo}, ${hi}] — version instead of stacking` };
}

// A band is only meaningful when the endpoints plausibly measure the same
// quantity on the same scale. Values that differ by more than 20x are almost
// always different quantities (a count vs. a calendar year, a model name vs. a
// rate) or a parsing error. Publishing [0.5, 2027] as a "band" destroys trust,
// so dismiss the candidate instead.
function isComparableScale(values) {
  const magnitudes = (values ?? []).filter((v) => Number.isFinite(v)).map((v) => Math.abs(v));
  if (magnitudes.length < 2) return false;
  const lo = Math.min(...magnitudes);
  const hi = Math.max(...magnitudes);
  if (hi === 0) return true;
  if (lo === 0) return hi <= 10;
  return hi / lo <= 20;
}

function collectDenominatorCandidates(weave) {
  const out = new Set();
  for (const c of weave) {
    for (const claim of extractNumericClaims(c.content)) {
      if (claim.unit && COUNT_UNITS.has(claim.unit) && claim.value > 0) out.add(claim.value);
    }
  }
  return out;
}

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

function resolveConflict(conflict, { denominators, percentClaims }) {
  const arithmetic = runArithmeticFalsifier(conflict, { denominators, percentClaims });
  if (arithmetic.reconciled) {
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
  if (!isComparableScale(conflict.values)) {
    return {
      ...conflict,
      status: "dismissed",
      resolution: null,
      versions: null,
      reconciliationRule: null,
      falsifier: {
        ran: true,
        reconciled: false,
        method: "scale",
        detail: `values ${JSON.stringify(conflict.values)} span more than 20x — likely different quantities; no band published`,
      },
    };
  }
  const band = runBandFalsifier(conflict);
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
    reconciliationRule: "later value supersedes; report as a band while they diverge",
    falsifier: band,
  };
}

export function reconcileNumericalConflicts(weave) {
  const conflicts = findNumericalConflicts(weave);
  const denominators = collectDenominatorCandidates(weave);
  const percentClaims = collectPercentClaims(weave);
  const report = {
    conflicts: [],
    resolvedCount: 0,
    versionedCount: 0,
    dismissedCount: 0,
    unresolvedCount: 0,
    reserveRoundRecommended: false,
    reserveRoundReason: null,
  };
  for (const conflict of conflicts) {
    const result = resolveConflict(conflict, { denominators, percentClaims });
    report.conflicts.push(result);
    if (result.status === "resolved") report.resolvedCount++;
    else if (result.status === "dismissed") report.dismissedCount++;
    else report.versionedCount++;
  }
  report.reserveRoundRecommended = shouldReserveReconciliationRound(weave, report);
  if (report.reserveRoundRecommended) {
    report.reserveRoundReason = "the final round introduced a new dataset that conflicts with earlier rounds and could not be reconciled by the cheapest falsifier — reserve a reconciliation round";
  }
  return report;
}

export function shouldReserveReconciliationRound(weave, report) {
  if (!report || !Array.isArray(report.conflicts) || report.versionedCount === 0) return false;
  const rounds = (weave ?? []).map((c) => c.round ?? 0);
  const finalRound = rounds.length > 0 ? Math.max(...rounds) : 0;
  if (finalRound <= 1) return false;
  return report.conflicts.some((c) => c.status === "versioned"
    && Array.isArray(c.versions) && c.versions.length === 2
    && (c.versions[1].round ?? 0) >= finalRound);
}

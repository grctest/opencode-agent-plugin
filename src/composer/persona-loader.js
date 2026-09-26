import { readFileSync, existsSync, readdirSync, watch, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger, extractErrorInfo } from "../logger.js";
import { PersonaIndex } from "../services/persona-index.js";
import { getConfig } from "../config.js";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_QUANT } from "../services/model-manager.js";
import { resolveOpencodeConfigDir } from "../paths.js";

const __dirname = dirname(fileURLToPath(new URL(".", import.meta.url)));
const composerLogger = new Logger();

function personasBasePath() {
  const candidates = [
    join(__dirname, "../..", "personas", "loom"),
    join(__dirname, "../..", "personas"),
    join(__dirname, "..", "personas", "loom"),
    join(__dirname, "..", "personas"),
    join(__dirname, "personas", "loom"),
    join(__dirname, "personas"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "junior")) || existsSync(join(candidate, "domains.json"))) {
      return candidate;
    }
  }
  return candidates[0];
}

function userPersonasPath() {
  const configDir = process.env.LOOM_CONFIG_DIR || join(resolveOpencodeConfigDir(), "loom");
  const personasDir = join(configDir, "personas");
  const tiers = ["junior", "mid", "senior", "principal", "civilian"];
  for (const tier of tiers) {
    if (existsSync(join(personasDir, tier))) {
      return personasDir;
    }
  }
  return null;
}

let domainVocabCache = null;
let domainVocabMtime = 0;
export function loadDomainVocabulary() {
  try {
    const base = personasBasePath();
    const file = join(base, "domains.json");
    if (existsSync(file)) {
      let mtime = 0;
      try { mtime = statSync(file).mtimeMs; } catch {}
      if (domainVocabCache !== null && mtime !== 0 && mtime === domainVocabMtime) return domainVocabCache;
      const parsed = JSON.parse(readFileSync(file, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        domainVocabCache = Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.map(String) : []]),
        );
      } else domainVocabCache = {};
      domainVocabMtime = mtime;
      return domainVocabCache;
    }
  } catch (err) {
    composerLogger.warn("domain_vocab_load_failed", "Failed to load domains.json — keyword fallback runs without domain boosts", extractErrorInfo(err));
    domainVocabCache = {};
  }
  if (domainVocabCache !== null) return domainVocabCache;
  domainVocabCache = {};
  return domainVocabCache;
}

const VALID_TIERS = new Set(["junior", "mid", "senior", "principal", "civilian"]);
function validatePersona(persona) {
  const errors = [];
  if (!persona.name || typeof persona.name !== "string") errors.push("name required");
  else if (persona.name.length > 80) errors.push("name must be ≤80 chars");
  if (!persona.persona || typeof persona.persona !== "string") errors.push("persona description required");
  else if (persona.persona.length < 50) errors.push("persona description must be >50 chars");
  else if (persona.persona.length > 4000) errors.push("persona description must be ≤4000 chars");
  if (!persona.agenda || typeof persona.agenda !== "string") errors.push("agenda required");
  else if (persona.agenda.length < 20) errors.push("agenda must be >20 chars");
  else if (persona.agenda.length > 2000) errors.push("agenda must be ≤2000 chars");
  const hasTags = persona.tags || persona.domains || persona.domain;
  if (!hasTags || (typeof hasTags !== "string" && !Array.isArray(hasTags))) errors.push("tags required");
  if (persona.tier && !VALID_TIERS.has(persona.tier)) errors.push(`tier must be one of ${[...VALID_TIERS].join(",")}`);
  if (persona.expertise && !Array.isArray(persona.expertise) && typeof persona.expertise !== "string") errors.push("expertise must be string or array");
  return errors;
}

// Style lint for persona authoring (audit N9/P0-I): biases render verbatim in
// the system prompt after "watch for these tendencies in your own reasoning:",
// so they must read as continuations — lowercase verb phrases ("assumes X",
// "may over-weight Y"). A CAPITALIZED third-person verb is the legacy style
// that once rendered as the broken "you tend to Assumes X"; flag it.
const THIRD_PERSON_VERB_RE = /^(Assumes|May\s|Resists|Over-?weights?|Over-?relies|Under-?weights?|Defaults?\s|Tends?\s|Prefers?|Discounts?|Ignores?|Focuses?|Prioritizes?)\b/;
// Injected budgets in prompts/agent.js (truncateAtSentence/sanitize caps).
// Validation ceilings are higher, so over-budget text is silently truncated
// with an ellipsis and no warning (audit N12). Warn at load instead.
const INJECTED_BUDGETS = { persona: 2000, agenda: 1000, tier_guidance: 1500, communication_style: 800 };
// Embodiment lint (corpus audit §12): these personas are text agents whose
// only instruments are read/glob/grep, websearch/webfetch, allowlisted bash,
// and the loom peer tools. An instruction that tells one to use a body, a
// device, a sensor, or an external system is unactionable — the lens must be
// expressible as a question asked of evidence it can actually reach.
const EMBODIED_DEVICE = /\b(keyboard-only|screen reader running|smartphone|badge data|microphone|haptic|gyroscope|with a keyboard alone|test every flow with)\b/i;
const EMBODIED_ACTION = /\b(run the proposal on|run the procedure|replicate the procedure|measure the (yield|latency|weight|temperature)|produce live|transcribe hours|hold the switch|navigate with a keyboard|by feel|you watch (thirty|people|a team|a class))\b/i;
const EMBODIED_EXTERNAL = /\b(call the customer|email the|interview the user|watch a user session|shadow the developer)\b/i;
const INSTRUCTION_FIELDS = ["agenda", "tier_guidance", "reflection_guidance", "anti_patterns"];
const IDENTITY_FIELDS = ["persona", "communication_style"];
export function lintEmbodiment(persona) {
  const warnings = [];
  for (const f of INSTRUCTION_FIELDS) {
    const v = persona?.[f];
    if (!v) continue;
    const text = Array.isArray(v) ? v.join(" | ") : String(v);
    for (const [label, re] of [["device", EMBODIED_DEVICE], ["action", EMBODIED_ACTION], ["external system", EMBODIED_EXTERNAL]]) {
      const m = text.match(re);
      if (m) warnings.push(`${f} instructs a ${label} the agent lacks ("${m[0]}") — restate as evidence-seeking`);
    }
  }
  for (const f of IDENTITY_FIELDS) {
    const v = persona?.[f];
    if (typeof v !== "string") continue;
    const m = v.match(EMBODIED_DEVICE);
    if (m) warnings.push(`${f} claims a ${m[0]} the agent does not have — describe the lens instead`);
  }
  return warnings;
}

// Run-on lint (corpus audit F2): template concatenation without terminal
// punctuation ("failure modes You ask…") renders as a typo in ## Identity.
const RUNON_RE = /[a-z] (You|Your)( [a-z])/;
const RUNON_FIELDS = ["persona", "agenda", "tier_guidance", "reflection_guidance", "communication_style"];
export function lintRunons(persona) {
  const warnings = [];
  for (const f of RUNON_FIELDS) {
    const v = persona?.[f];
    if (typeof v === "string" && RUNON_RE.test(v)) warnings.push(`${f} has a run-on join (lowercase → “You/Your” without terminal punctuation)`);
  }
  return warnings;
}

// Circularity lint (corpus audit F1): tier_guidance that IS the agenda's first
// sentence verbatim carries no new information — extend it with an operational
// clause instead. Shared domain vocabulary alone is fine (same lens, two jobs:
// assignment in ## Agenda, instruction in ## Tier Doctrine).
export function lintCircularity(persona) {
  const norm = (s) => String(s ?? "").trim().replace(/\.$/, "").toLowerCase();
  const head = norm(String(persona?.agenda ?? "").split(".")[0]);
  if (head.length > 10 && norm(persona?.tier_guidance) === head) {
    return ["tier_guidance duplicates the agenda verbatim — extend with an operational clause"];
  }
  return [];
}

// Range-rule lint (corpus audit §6.1): every civilian lens needs its exit
// clause, or the hobby-trap returns the next time someone edits the file.
export function lintRangeRule(persona, tier) {
  if (tier === "civilian" && typeof persona?.tier_guidance === "string" && !/at most (one|once)/.test(persona.tier_guidance)) {
    return ["civilian tier_guidance lacks the range rule (at most one analogy + off-ramp)"];
  }
  return [];
}

// Depth lint (audit P2-E): senior/principal voices carry the hardest judgments
// but every bundled senior/principal persona description is <200 chars, so the
// model fills the gap with stereotype. Non-blocking: warn the author.
export function lintDepth(persona, tier) {
  if ((tier === "senior" || tier === "principal") && typeof persona?.persona === "string" && persona.persona.length < 200) {
    return [`${tier} persona description is only ${persona.persona.length} chars — under 200 risks stereotype fill; expand with domain specifics`];
  }
  return [];
}

export function lintTruncation(persona) {
  const warnings = [];
  for (const [field, budget] of Object.entries(INJECTED_BUDGETS)) {
    const v = persona?.[field];
    if (typeof v === "string" && v.length > budget) {
      warnings.push(`${field} is ${v.length} chars but only ${budget} are injected into prompts — excess is truncated`);
    }
  }
  return warnings;
}

export function lintPersonaStyle(persona) {
  const warnings = [];
  for (const b of (Array.isArray(persona?.known_biases) ? persona.known_biases : [])) {
    if (typeof b === "string" && THIRD_PERSON_VERB_RE.test(b.trim())) {
      warnings.push(`known_bias "${b.slice(0, 60)}" uses a capitalized third-person verb — use lowercase continuation form`);
    }
  }
  return warnings;
}

function normalizePersona(persona) {
  const out = { ...persona };
  if (typeof out.domain === "string" && !out.tags) {
    out.tags = [out.domain];
    delete out.domain;
  } else if (Array.isArray(out.domains) && !out.tags) {
    out.tags = out.domains;
    delete out.domains;
  } else if (typeof out.domains === "string" && !out.tags) {
    out.tags = [out.domains];
    delete out.domains;
  }
  if (typeof out.tags === "string") {
    out.tags = [out.tags];
  }
  if (Array.isArray(out.tags)) {
    const seen = new Set();
    out.tags = out.tags.map(t => String(t).trim().toLowerCase()).filter(t => t && !seen.has(t) && seen.add(t));
  }
  out.version = out.version || "1.0";
  return out;
}

function loadPersonasFromPath(base) {
  const tiers = ["junior", "mid", "senior", "principal", "civilian"];
  const result = {};
  let totalLoaded = 0;
  let totalRejected = 0;

  for (const tier of tiers) {
    try {
      const tierDir = join(base, tier);
      if (!existsSync(tierDir)) {
        const legacyPath = join(base, `${tier}.json`);
        if (existsSync(legacyPath)) {
          result[tier] = loadLegacyPersonaFile(legacyPath, tier);
          totalLoaded += result[tier].length;
        } else {
          result[tier] = [];
        }
        continue;
      }

      result[tier] = [];
      const files = readdirSync(tierDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const filePath = join(tierDir, file);
          const data = readFileSync(filePath, "utf-8");
          const p = JSON.parse(data);
          const errors = validatePersona(p);
          if (errors.length > 0) {
            composerLogger.warn("invalid_persona", `Invalid persona at ${tier}/${file} (${p.name ?? "unnamed"})`, { errors });
            totalRejected++;
            continue;
          }
          result[tier].push(normalizePersona(p));
          totalLoaded++;
          for (const w of lintPersonaStyle(p)) {
            composerLogger.warn("persona_style", `Style: ${tier}/${file} (${p.name ?? "unnamed"}) — ${w}`);
          }
          for (const w of lintTruncation(p)) {
            composerLogger.warn("persona_truncated", `Truncation: ${tier}/${file} (${p.name ?? "unnamed"}) — ${w}`);
          }
          for (const w of lintDepth(p, tier)) {
            composerLogger.warn("persona_thin", `Depth: ${tier}/${file} (${p.name ?? "unnamed"}) — ${w}`);
          }
          for (const w of [...lintRunons(p), ...lintCircularity(p), ...lintRangeRule(p, tier), ...lintEmbodiment(p)]) {
            composerLogger.warn("persona_lint", `Lint: ${tier}/${file} (${p.name ?? "unnamed"}) — ${w}`);
          }
        } catch (err) {
          composerLogger.warn("persona_load_failed", `Failed to load persona from ${tier}/${file}`, { error: err.message });
          totalRejected++;
        }
      }
    } catch (err) {
      if (!result[tier]) result[tier] = [];
      if (err.code !== "ENOENT") {
        composerLogger.warn("persona_load_failed", `Failed to load personas from ${base}/${tier}/`, { error: err.message });
      }
    }
  }

  if (totalRejected > 0) {
    composerLogger.warn("persona_validation_summary", `Persona validation: ${totalLoaded} loaded, ${totalRejected} rejected from ${base}`);
  }

  return result;
}

function loadLegacyPersonaFile(filePath, tier) {
  try {
    const data = readFileSync(filePath, "utf-8");
    const raw = JSON.parse(data);
    const personas = [];
    for (let i = 0; i < raw.length; i++) {
      const p = raw[i];
      const errors = validatePersona(p);
      if (errors.length > 0) {
        composerLogger.warn("invalid_persona", `Invalid persona at ${tier}[${i}] (${p.name ?? "unnamed"})`, { errors });
        continue;
      }
      personas.push(normalizePersona(p));
    }
    return personas;
  } catch (err) {
    composerLogger.warn("persona_load_failed", `Failed to load legacy persona file ${filePath}`, { error: err.message });
    return [];
  }
}

let personaCache = null;
let personaCachePath = null;
let personaCacheTimestamp = 0;
const PERSONA_CACHE_TTL_MS = 60000;
let personaWatchSetup = false;
function setupPersonaWatch() {
  if (personaWatchSetup) return;
  personaWatchSetup = true;
  const watchers = [];
  try {
    const base = personasBasePath();
    const w = watch(base, { recursive: true }, () => { personaCache = null; });
    if (w && w.unref) w.unref();
    watchers.push(w);
    const userPath = userPersonasPath();
    if (userPath) {
      try {
        const uw = watch(userPath, { recursive: true }, () => { personaCache = null; });
        if (uw && uw.unref) uw.unref();
        watchers.push(uw);
      } catch {}
    }
  } catch {}
  // Watchers are unref'd so they don't keep process alive; leak bounded to 2 handles
}

function loadPersonas() {
  setupPersonaWatch();
  const basePath = personasBasePath();
  const userPath = userPersonasPath();

  const now = Date.now();
  if (personaCache && personaCachePath === basePath && (now - personaCacheTimestamp) < PERSONA_CACHE_TTL_MS) {
    return personaCache;
  }

  const result = loadPersonasFromPath(basePath);

  if (userPath) {
    const userPersonas = loadPersonasFromPath(userPath);
    for (const [tier, personas] of Object.entries(userPersonas)) {
      if (personas.length > 0) {
        if (!result[tier]) result[tier] = [];
        const existingNames = new Set(result[tier].map((p) => p.name));
        for (const p of personas) {
          if (!existingNames.has(p.name)) {
            result[tier].push(p);
          }
        }
      }
    }
  }

  personaCache = result;
  personaCachePath = basePath;
  personaCacheTimestamp = Date.now();
  return result;
}

export function getPersonas() {
  return loadPersonas();
}

export function getPersonaTags(persona) {
  if (Array.isArray(persona.tags)) return persona.tags;
  if (typeof persona.tags === "string") return [persona.tags];
  if (Array.isArray(persona.domains)) return persona.domains;
  if (typeof persona.domains === "string") return [persona.domains];
  if (typeof persona.domain === "string") return [persona.domain];
  return [];
}


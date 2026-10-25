/**
 * Post-processing for LLM-generated personas: extract → clamp → validate →
 * dedupe → truncate.
 *
 * A generated persona must satisfy the exact same schema the disk loader
 * enforces (composer/persona-loader validatePersona/normalizePersona) before
 * it is allowed into a room or written to the custom personas folder — an LLM
 * that rambles past a budget gets clamped, an LLM that omits a core field
 * gets dropped with a recorded reason, never silently repaired.
 */

import { extractBalancedJsonArray } from "./persona-proposals.js";
import { validatePersona, normalizePersona } from "./composer/persona-loader.js";
import { clampGenerateCount } from "./prompts/persona-generation.js";

const CATEGORY_RE = /^[a-z0-9][a-z0-9-]*$/;
const DEFAULT_CATEGORY = "civilian";

const BUDGETS = {
  name: 80,
  persona: 4000,
  agenda: 2000,
  angle: 180,
  communication_style: 1200,
  category_guidance: 1500,
  reflection_guidance: 1500,
};

const ARRAY_BUDGETS = {
  tags: { max: 8, item: 60 },
  expertise: { max: 8, item: 80 },
  known_biases: { max: 6, item: 240 },
  preferred_contribution_types: { max: 4, item: 40 },
  anti_patterns: { max: 6, item: 400 },
};

function clampString(value, max) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function toStringArray(value, max, itemMax) {
  const source = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const out = [];
  const seen = new Set();
  for (const entry of source) {
    if (out.length >= max) break;
    if (typeof entry !== "string") continue;
    const item = entry.trim().slice(0, itemMax);
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * Clamp one raw model object into shape. Returns {ok:true, persona} or
 * {ok:false, name, reason}. Never throws.
 */
export function sanitizeGeneratedPersona(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, name: "", reason: "not an object" };
  }
  const name = clampString(raw.name, BUDGETS.name);
  if (!name) return { ok: false, name: "", reason: "missing name" };

  const tags = toStringArray(raw.tags, ARRAY_BUDGETS.tags.max, ARRAY_BUDGETS.tags.item);
  if (tags.length === 0) return { ok: false, name, reason: "tags required" };

  const category = typeof raw.category === "string" && CATEGORY_RE.test(raw.category.trim())
    ? raw.category.trim()
    : DEFAULT_CATEGORY;

  const candidate = {
    name,
    persona: clampString(raw.persona, BUDGETS.persona),
    agenda: clampString(raw.agenda, BUDGETS.agenda),
    category,
    angle: clampString(raw.angle, BUDGETS.angle),
    tags,
    expertise: toStringArray(raw.expertise, ARRAY_BUDGETS.expertise.max, ARRAY_BUDGETS.expertise.item),
    known_biases: toStringArray(raw.known_biases, ARRAY_BUDGETS.known_biases.max, ARRAY_BUDGETS.known_biases.item),
    communication_style: clampString(raw.communication_style, BUDGETS.communication_style),
    preferred_contribution_types: toStringArray(
      raw.preferred_contribution_types,
      ARRAY_BUDGETS.preferred_contribution_types.max,
      ARRAY_BUDGETS.preferred_contribution_types.item,
    ),
    anti_patterns: toStringArray(raw.anti_patterns, ARRAY_BUDGETS.anti_patterns.max, ARRAY_BUDGETS.anti_patterns.item),
    category_guidance: clampString(raw.category_guidance, BUDGETS.category_guidance),
    reflection_guidance: clampString(raw.reflection_guidance, BUDGETS.reflection_guidance),
  };

  const errors = validatePersona(candidate);
  if (errors.length > 0) {
    return { ok: false, name, reason: errors.join("; ") };
  }
  return { ok: true, persona: normalizePersona(candidate) };
}

/**
 * @param {string} text - raw LLM response
 * @param {Object} [opts]
 * @param {number} [opts.count] - desired persona count (clamped 1..8)
 * @param {string[]} [opts.existingNames] - catalog names that must not be reused
 * @returns {{personas: Object[], rejected: {name:string, reason:string}[], parseError: string|null}}
 */
export function parseGeneratedPersonas(text, { count = 3, existingNames = [] } = {}) {
  const limit = clampGenerateCount(count);
  const personas = [];
  const rejected = [];

  let rawArray;
  try {
    const extracted = extractBalancedJsonArray(String(text ?? ""));
    if (!extracted) {
      return { personas, rejected, parseError: "no JSON array found in model response" };
    }
    rawArray = JSON.parse(extracted);
  } catch (err) {
    return { personas, rejected, parseError: `invalid JSON: ${err?.message ?? err}` };
  }
  if (!Array.isArray(rawArray)) {
    return { personas, rejected, parseError: "model response was not a JSON array" };
  }

  const existing = new Set(
    (Array.isArray(existingNames) ? existingNames : []).map((n) => String(n).trim().toLowerCase()),
  );
  const seen = new Set();

  for (const raw of rawArray) {
    const result = sanitizeGeneratedPersona(raw);
    if (!result.ok) {
      rejected.push({ name: result.name || "(unnamed)", reason: result.reason });
      continue;
    }
    const key = result.persona.name.toLowerCase();
    if (existing.has(key) || seen.has(key)) {
      rejected.push({ name: result.persona.name, reason: "name already exists" });
      continue;
    }
    seen.add(key);
    personas.push(result.persona);
    if (personas.length >= limit) break;
  }

  return { personas, rejected, parseError: null };
}

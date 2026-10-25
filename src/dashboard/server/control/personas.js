/**
 * Persona catalog + embedding-ranked room preview routes, plus bespoke
 * persona generation (LLM) and saving to the user's custom folder.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, openSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import { rankAllPersonas, EMBEDDER_UNAVAILABLE } from "../../../composer.js";
import {
  getPersonas,
  getPersonaTags,
  userPersonasDir,
  CUSTOM_PERSONA_SUBDIR,
  invalidatePersonaCache,
} from "../../../composer/persona-loader.js";
import { buildPersonaGenerationPrompt, clampGenerateCount } from "../../../prompts/persona-generation.js";
import { parseGeneratedPersonas, sanitizeGeneratedPersona } from "../../../persona-generation.js";
import { SessionManager } from "../../../session-manager.js";
import { resolveContextLimit } from "../../../utils/context-budget.js";
import { extractAgentResponse } from "../../../utils/text.js";
import { sanitizeForPrompt } from "../../../utils/sanitize.js";
import { extractErrorInfo } from "../../../logger.js";
import { isControlReady, logger, readJsonBody, runtime, getDirectory } from "./runtime.js";
import { discoverFiltered } from "./discovery.js";
import { buildOrchestratorPromptPreview } from "../orchestrator-preview.js";

export { EMBEDDER_UNAVAILABLE };

/** Generation is one LLM call over a ~16KB prompt — 120s matches persona-proposals. */
export const GENERATION_TIMEOUT_MS = 120000;
export const MAX_SAVE_BATCH = 8;

let generationInFlight = false;
export function isGenerationInFlight() {
  return generationInFlight;
}

function personaDto(p, category) {
  const legacyCategory = p.tier;
  const legacyGuidance = p.tier_guidance;
  // A persona file's own `category` (its lens) wins over the folder it lives
  // in — bundled files never set one (folder = lens), while saved generated
  // personas keep their lens even though they all live under `custom/`.
  const resolvedCategory = p.category ?? category ?? legacyCategory;
  return {
    name: p.name,
    persona: p.persona,
    agenda: p.agenda,
    category: resolvedCategory,
    tags: getPersonaTags(p),
    expertise: Array.isArray(p.expertise) ? p.expertise : [],
    known_biases: Array.isArray(p.known_biases) ? p.known_biases : [],
    communication_style: p.communication_style ?? "",
    preferred_contribution_types: Array.isArray(p.preferred_contribution_types) ? p.preferred_contribution_types : [],
    anti_patterns: Array.isArray(p.anti_patterns) ? p.anti_patterns : [],
    category_guidance: p.category_guidance ?? legacyGuidance ?? "",
    reflection_guidance: p.reflection_guidance ?? "",
    custom: p.custom === true,
    angle: typeof p.angle === "string" ? p.angle : "",
  };
}

export function handleListPersonas() {
  const grouped = getPersonas();
  const categories = {};
  for (const [category, arr] of Object.entries(grouped)) {
    categories[category] = (arr ?? []).map((p) => personaDto(p, category));
  }
  return Response.json({ categories });
}

async function rankPreviewPersonas(question, context = "") {
  return rankAllPersonas(question, context);
}

export async function handleRoomPreview(req) {
  if (!isControlReady()) {
    return Response.json({ error: "dashboard control plane not ready (plugin client unavailable)" }, { status: 503 });
  }
  let body;
  try {
    body = await readJsonBody(req, 64 * 1024);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  const question = sanitizeForPrompt(String(body?.question ?? ""), 5000);
  if (!question || question.trim().length < 3) {
    return Response.json({ error: "question required (≥3 chars)" }, { status: 400 });
  }
  let ranking;
  try {
    ranking = await rankPreviewPersonas(question, String(body?.context ?? ""));
  } catch (err) {
    if (err?.code === EMBEDDER_UNAVAILABLE) {
      logger.warn("dashboard_rank_no_embedder", "Persona ranking requested without an embedder — auto-select unavailable", extractErrorInfo(err));
      return Response.json({
        error: "Auto-select needs an embedding model. Add personas manually instead.",
        code: EMBEDDER_UNAVAILABLE,
        detail: err.message,
      }, { status: 503 });
    }
    const info = extractErrorInfo(err);
    return Response.json({
      error: `Persona ranking failed (${info.message}). [rank_failed]`,
      code: "rank_failed",
      detail: info.message,
    }, { status: 500 });
  }
  let suggestedModels = [];
  let suggestedOrchestrator = null;
  try {
    const { available } = await discoverFiltered();
    const pool = available.length > 0 ? available : [];
    if (pool.length > 0) {
      const selectedRows = ranking.selected ?? [];
      const pick = () => pool[Math.floor(Math.random() * pool.length)];
      suggestedModels = selectedRows.map(() => {
        const m = pick();
        return {
          provider_id: m.providerID ?? m.provider_id,
          model_id: m.modelID ?? m.model_id,
        };
      });
      const orch = pick();
      if (orch?.providerID && orch?.modelID) {
        suggestedOrchestrator = {
          provider_id: orch.providerID,
          model_id: orch.modelID,
          key: `${orch.providerID}/${orch.modelID}`,
        };
      }
    }
  } catch {}
  const normalizeRankRow = (row) => ({
    name: row.name,
    category: row.category ?? row.tier ?? "mid",
    distance: row.distance,
  });
  return Response.json({
    ranked: (ranking.ranked ?? []).map(normalizeRankRow),
    selected: (ranking.selected ?? []).map(normalizeRankRow),
    auto_select_count: ranking.autoSelectCount ?? 0,
    suggested_models: suggestedModels,
    suggested_orchestrator: suggestedOrchestrator,
  });
}

export async function handleOrchestratorPreview(req) {
  let body;
  try {
    body = await readJsonBody(req, 64 * 1024);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  try {
    return Response.json(buildOrchestratorPromptPreview({
      orchestrator: body?.orchestrator,
      question: body?.question,
      context: body?.context,
      participants: body?.participants,
      features: body?.features,
    }));
  } catch (err) {
    return Response.json({ error: extractErrorInfo(err).message }, { status: 400 });
  }
}

function catalogNames() {
  const grouped = getPersonas();
  const names = [];
  for (const arr of Object.values(grouped)) {
    for (const p of arr ?? []) {
      if (typeof p?.name === "string" && p.name) names.push(p.name);
    }
  }
  return names;
}

/**
 * POST /api/personas/generate — one LLM call that designs N distinct personas
 * for the user's query. Reads question/context from the request (the setup
 * form lives in browser localStorage, not on the server).
 */
export async function handleGeneratePersonas(req) {
  if (!isControlReady()) {
    return Response.json({ error: "dashboard control plane not ready (plugin client unavailable)" }, { status: 503 });
  }
  if (generationInFlight) {
    return Response.json({ error: "a persona generation is already running", code: "generation_in_flight" }, { status: 409 });
  }
  let body;
  try {
    body = await readJsonBody(req, 64 * 1024);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  const question = sanitizeForPrompt(String(body?.question ?? ""), 5000);
  if (!question || question.trim().length < 3) {
    return Response.json({ error: "question required (≥3 chars) — describe the deliberation in Setup step 1 first" }, { status: 400 });
  }
  const context = sanitizeForPrompt(String(body?.context ?? ""), 5000);
  const count = clampGenerateCount(body?.count);

  let available = [];
  try {
    ({ available } = await discoverFiltered());
  } catch (err) {
    return Response.json({ error: `model discovery failed: ${extractErrorInfo(err).message}` }, { status: 500 });
  }
  if (!Array.isArray(available) || available.length === 0) {
    return Response.json({ error: "no enabled models — enable at least one model in Setup step 2" }, { status: 400 });
  }
  const requestedKey = typeof body?.model === "string"
    ? body.model
    : body?.model?.providerID
      ? `${body.model.providerID}/${body.model.modelID}`
      : "";
  const chosen = available.find((m) => `${m.providerID}/${m.modelID}` === requestedKey) ?? available[0];
  const model = { providerID: chosen.providerID, modelID: chosen.modelID };

  // Lens avoidance: catalog personas nearest this query (best effort — the
  // embedder is optional for generation, so failures degrade to no hints).
  let nearby = [];
  try {
    const ranking = await rankAllPersonas(question, context);
    nearby = (ranking?.ranked ?? []).slice(0, 6);
  } catch {}

  const { system, text } = buildPersonaGenerationPrompt({
    question,
    context,
    count,
    avoidNames: catalogNames(),
    nearby,
  });

  generationInFlight = true;
  try {
    const sessionManager = new SessionManager(runtime.client, getDirectory(), runtime.ownerSessionId, logger, {
      resolveContextLimit: (m) => resolveContextLimit(m, available),
    });
    const res = await sessionManager.runEphemeralPrompt(
      { config: { id: "persona_designer", name: "Persona Designer" } },
      { system, model, parts: [{ type: "text", text }], tools: {}, timeoutMs: GENERATION_TIMEOUT_MS },
      null,
    );
    if (!res?.ok) {
      const info = extractErrorInfo(res?.error ?? new Error("unknown failure"));
      logger.warn("persona_generation_failed", "Bespoke persona generation call failed", info);
      return Response.json({ error: `generation failed: ${info.message}`, code: "generation_failed" }, { status: 502 });
    }
    const { text: responseText } = extractAgentResponse(res.data);
    const { personas, rejected, parseError } = parseGeneratedPersonas(responseText ?? "", {
      count,
      existingNames: catalogNames(),
    });
    if (personas.length === 0) {
      return Response.json({
        error: "the model did not return usable personas — try again or pick a different model",
        code: "generation_unusable",
        detail: parseError ?? `${rejected.length} personas were rejected`,
        rejected,
      }, { status: 422 });
    }
    logger.info("persona_generation_ok", `Generated ${personas.length} bespoke persona(s)`, { rejected: rejected.length });
    return Response.json({
      personas: personas.map((p) => personaDto(p)),
      rejected,
      model: `${model.providerID}/${model.modelID}`,
      requested: count,
    });
  } catch (err) {
    const info = extractErrorInfo(err);
    logger.warn("persona_generation_error", "Bespoke persona generation errored", info);
    return Response.json({ error: `generation failed: ${info.message}`, code: "generation_failed" }, { status: 500 });
  } finally {
    generationInFlight = false;
  }
}

function slugifyPersonaName(name) {
  const slug = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "persona";
}

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
}

function readPersonaName(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8"));
    return typeof parsed?.name === "string" ? parsed.name : "";
  } catch {
    return "";
  }
}

/**
 * POST /api/personas/save — persist generated personas to
 * `<config>/loom/personas/custom/` in the exact bundled JSON format. Names
 * that already exist anywhere in the catalog are skipped, never overwritten.
 */
export async function handleSavePersonas(req) {
  if (!isControlReady()) {
    return Response.json({ error: "dashboard control plane not ready (plugin client unavailable)" }, { status: 503 });
  }
  let body;
  try {
    body = await readJsonBody(req, 64 * 1024);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 400 });
  }
  const raw = Array.isArray(body?.personas) ? body.personas : null;
  if (!raw || raw.length === 0) {
    return Response.json({ error: "personas array required" }, { status: 400 });
  }
  if (raw.length > MAX_SAVE_BATCH) {
    return Response.json({ error: `at most ${MAX_SAVE_BATCH} personas per save` }, { status: 400 });
  }
  try {
    return Response.json(persistGeneratedPersonas(raw));
  } catch (err) {
    return Response.json({ error: `could not create custom personas folder: ${extractErrorInfo(err).message}` }, { status: 500 });
  }
}

/**
 * Write sanitized personas to `<config>/loom/personas/custom/`. Split out of
 * the HTTP handler so tests can drive it directly against a temp
 * `LOOM_CONFIG_DIR`. Returns `{saved, skipped}`; throws only when the custom
 * folder itself cannot be created.
 */
export function persistGeneratedPersonas(raw) {
  const existing = new Set(catalogNames().map((n) => n.toLowerCase()));
  const dir = join(userPersonasDir(), CUSTOM_PERSONA_SUBDIR);
  const saved = [];
  const skipped = [];
  const batchNames = new Set();

  mkdirSync(dir, { recursive: true });

  for (const rawPersona of raw) {
    const result = sanitizeGeneratedPersona(rawPersona);
    if (!result.ok) {
      skipped.push({ name: rawPersona?.name ?? "(unnamed)", reason: result.reason });
      continue;
    }
    const persona = result.persona;
    const key = persona.name.toLowerCase();
    if (existing.has(key) || batchNames.has(key)) {
      skipped.push({ name: persona.name, reason: "name already exists" });
      continue;
    }
    const base = slugifyPersonaName(persona.name);
    let filePath = join(dir, `${base}.json`);
    let suffix = 2;
    while (existsSync(filePath)) {
      if (readPersonaName(filePath).toLowerCase() === key) {
        skipped.push({ name: persona.name, reason: "already saved" });
        filePath = null;
        break;
      }
      filePath = join(dir, `${base}-${suffix}.json`);
      suffix += 1;
      if (suffix > 50) {
        filePath = null;
        break;
      }
    }
    if (!filePath) continue;
    try {
      // The file stores no `custom` flag — origin is derived from living under
      // the user dir (persona-loader marks those on load).
      writeJsonAtomic(filePath, persona);
    } catch (err) {
      skipped.push({ name: persona.name, reason: `write failed: ${extractErrorInfo(err).message}` });
      continue;
    }
    batchNames.add(key);
    saved.push(persona.name);
  }

  if (saved.length > 0) {
    invalidatePersonaCache();
  }
  return { saved, skipped };
}

/**
 * Persona catalog + embedding-ranked room preview routes.
 */
import { rankAllPersonas, EMBEDDER_UNAVAILABLE } from "../../../composer.js";
import { getPersonas, getPersonaTags } from "../../../composer/persona-loader.js";
import { sanitizeForPrompt } from "../../../utils/sanitize.js";
import { extractErrorInfo } from "../../../logger.js";
import { isControlReady, logger, readJsonBody } from "./runtime.js";
import { discoverFiltered } from "./discovery.js";
import { buildOrchestratorPromptPreview } from "../orchestrator-preview.js";

export { EMBEDDER_UNAVAILABLE };

function personaDto(p, category) {
  const legacyCategory = p.tier;
  const legacyGuidance = p.tier_guidance;
  const resolvedCategory = category ?? p.category ?? legacyCategory;
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
    }));
  } catch (err) {
    return Response.json({ error: extractErrorInfo(err).message }, { status: 400 });
  }
}

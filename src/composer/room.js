import { getConfig } from "../config.js";
import { getPersonas, getPersonaTags } from "./persona-loader.js";
import { similarityPercent } from "./similarity.js";
import { PersonaIndex } from "../services/persona-index.js";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_EMBEDDING_QUANT } from "../services/model-manager.js";
import { Logger, extractErrorInfo } from "../logger.js";

const composerLogger = new Logger();

/**
 * Thrown when room ranking is requested without a loaded embedding model.
 *
 * There is deliberately no keyword path behind this. Ranking personas is the
 * one operation that cannot be degraded: a keyword-overlap score is not a
 * weaker version of a vector ranking, it is a different answer to a different
 * question, and it fails worst exactly where it matters — a question whose
 * vocabulary does not overlap any persona's prose would rank everyone at zero
 * and hand the user an arbitrary order presented as if it were relevance.
 * Without an embedder the dashboard offers manual selection, which is honest.
 */
export const EMBEDDER_UNAVAILABLE = "embedder_unavailable";

export function embedderUnavailableError(reason = "embedding model not initialized") {
  const err = new Error(reason);
  err.code = EMBEDDER_UNAVAILABLE;
  return err;
}

/** Finds a persona by name in any category — the flat pool has no nominal category. */
export function findPersonaAnyCategory(personas, name) {
  for (const pool of Object.values(personas ?? {})) {
    const hit = (pool ?? []).find((p) => p.name === name);
    if (hit) return hit;
  }
  return null;
}

export function buildParticipant(persona, category, indexSuffix = "") {
  const tags = getPersonaTags(persona);
  const slug = persona.name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
  const suffix = indexSuffix ? `_${indexSuffix}` : "";
  return {
    id: `${category}_${slug}${suffix}`,
    name: persona.name,
    persona: persona.persona,
    agenda: persona.agenda,
    category,
    tags,
    expertise: persona.expertise || [],
    known_biases: persona.known_biases,
    communication_style: persona.communication_style,
    preferred_contribution_types: persona.preferred_contribution_types,
    anti_patterns: persona.anti_patterns,
    reflection_guidance: persona.reflection_guidance,
    category_guidance: persona.category_guidance ?? persona.tier_guidance,
  };
}

const DEFAULT_AUTO_SELECT_SEATS = 3;
const MAX_AUTO_SELECT_SEATS = 7;

/**
 * How many of the ranked personas are pre-selected when the dialog opens.
 * This is a presentation default only — it has no bearing on which personas
 * rank highly. Selection is the user's call once they see the list.
 */
export function getAutoSelectSeats() {
  try {
    const configured = getConfig()?.composition?.autoSelectSeats;
    if (Number.isFinite(configured) && configured >= 1) {
      return Math.min(MAX_AUTO_SELECT_SEATS, Math.floor(configured));
    }
  } catch {}
  return DEFAULT_AUTO_SELECT_SEATS;
}

/**
 * Ranks the ENTIRE persona catalog by vector similarity to the question.
 *
 * The catalog is one flat pool. There are no categories to fill, no per-category quota,
 * no top-N-per-category cut and no cross-category floor: every persona is scored
 * against the same embedding and the ordering is what it is. `nonhuman` is a
 * category like any other here, so a non-human persona can reach rank #1 on a
 * question about reefs and reach rank #180 on a question about auth
 * migrations, on the same measurement, with no special-casing in between.
 *
 * Returns the full ordered list so the caller can show every persona and let
 * the user choose, plus the top slice pre-selected.
 *
 * @param {string} question
 * @param {string} [context] appended to the question before embedding
 * @param {{autoSelectSeats?: number}} [opts]
 * @returns {Promise<{ranked: Array<{name: string, category: string, distance: number}>,
 *                    selected: Array<{name: string, category: string, distance: number}>,
 *                    autoSelectCount: number}>}
 * @throws {Error} with `code === EMBEDDER_UNAVAILABLE` when no embedder is loaded.
 */
export async function rankAllPersonas(question, context = "", opts = {}) {
  const compositionText = [question, context]
    .map((value) => String(value ?? "").trim())
    .filter(Boolean)
    .join("\n");
  if (!compositionText) {
    throw new Error("question required for persona ranking");
  }

  const { isEmbedderInitialized, ensureEmbedderInitialized, embedText } = await import("../services/embedding-service.js");
  let embedderReady = isEmbedderInitialized();
  if (!embedderReady) {
    try {
      const modelName = getConfig().embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
      const quant = getConfig().embeddingQuant ?? DEFAULT_EMBEDDING_QUANT;
      await ensureEmbedderInitialized(modelName, quant);
      embedderReady = isEmbedderInitialized();
    } catch (err) {
      composerLogger.warn("embedder_unavailable", "Persona ranking requires an embedding model — auto-select is unavailable", extractErrorInfo(err));
      embedderReady = false;
    }
  }
  if (!embedderReady) {
    throw embedderUnavailableError();
  }

  const personas = getPersonas();
  const personaIndex = new PersonaIndex();
  await personaIndex.indexAll(personas);

  let queryEmbedding;
  try {
    queryEmbedding = await embedText(compositionText, { isQuery: true });
  } catch (err) {
    throw embedderUnavailableError(`question embedding failed: ${extractErrorInfo(err).message}`);
  }

  const rows = await personaIndex.searchAll(queryEmbedding);
  if (rows.length === 0) {
    throw embedderUnavailableError("persona index is empty — nothing to rank");
  }

  const requested = Number.isFinite(opts?.autoSelectSeats) && opts.autoSelectSeats >= 1
    ? Math.min(MAX_AUTO_SELECT_SEATS, Math.floor(opts.autoSelectSeats))
    : getAutoSelectSeats();
  const result = buildRankingResult(rows, requested);

  composerLogger.info("compose_ranked", `Ranked ${result.ranked.length} personas, pre-selecting top-${result.autoSelectCount}`, {
    question_chars: compositionText.length,
    top: result.selected.map((r) => ({ persona: r.name, category: r.category, distance: Number(r.distance.toFixed(3)) })),
  });

  return result;
}

/**
 * Turns raw scored rows into the flat, ordered result the dialog consumes.
 *
 * Pure, and separated from the vector plumbing so the ordering rule can be
 * tested without an embedding model in the process. The rule itself is
 * deliberately almost nothing: sort ascending, slice the top N. What it must
 * NOT do is re-introduce category awareness — grouping by category, capping per category,
 * or promoting a distant persona over a near one all belong to the design
 * that was removed.
 *
 * `selected` is a strict prefix of `ranked` so a client can render "the top 3"
 * as a contiguous highlight rather than a scattered set.
 *
 * @param {Array<{persona_name: string, category: string, distance: number}>} rows
 * @param {number} requestedSeats
 */
export function buildRankingResult(rows, requestedSeats) {
  const ranked = [...(rows ?? [])]
    .sort((a, b) => {
      const da = Number.isFinite(a?.distance) ? a.distance : Number.POSITIVE_INFINITY;
      const db = Number.isFinite(b?.distance) ? b.distance : Number.POSITIVE_INFINITY;
      if (da === db) return String(a.persona_name).localeCompare(String(b.persona_name));
      return da - db;
    })
    .map((r) => ({ name: r.persona_name, category: r.category ?? r.tier, distance: r.distance }));

  const requested = Number.isFinite(requestedSeats) && requestedSeats >= 1
    ? Math.min(MAX_AUTO_SELECT_SEATS, Math.floor(requestedSeats))
    : getAutoSelectSeats();
  const autoSelectCount = Math.min(requested, ranked.length);

  return { ranked, selected: ranked.slice(0, autoSelectCount), autoSelectCount };
}

/**
 * Renders a ranked result as the Markdown room summary the plugin has always
 * exposed via `src/index.js`. Takes the shape `rankAllPersonas` returns.
 */
export function formatRoomPreview(ranking) {
  const ranked = ranking?.ranked ?? [];
  const selected = ranking?.selected ?? ranked.slice(0, ranking?.autoSelectCount ?? DEFAULT_AUTO_SELECT_SEATS);
  const lines = [
    "## Proposed Deliberation Room",
    "",
    `${selected.length} of ${ranked.length} personas selected, closest to the question first.`,
    "",
    "| # | Name | Category | Similarity |",
    "|---|------|------|------------|",
  ];
  for (const row of selected) {
    lines.push(`| ${row.name} | ${row.category} | ${similarityPercent(row.distance)}% |`);
  }
  lines.push("");
  lines.push("To start, confirm this room or specify changes (e.g. 'add a security expert', 'use 6 participants').");
  return lines.join("\n");
}
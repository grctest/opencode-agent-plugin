/**
 * Capability gate for Loom features whose correctness depends on the
 * embedding model.
 *
 * loom_summon answers "who is the right guest for this issue?" by semantic
 * similarity over the indexed persona catalog. That catalog is built purely
 * from the ONNX encoder (PersonaIndex.indexAll), so with no model loaded there
 * is nothing to rank the issue against and guest selection collapses to an
 * arbitrary lexical match — a confidently wrong guest, which is worse than no
 * guest. The tool therefore hides itself instead of degrading.
 *
 * Config intent is not enough: `agentTools.loom.loom_summon: true` is the
 * user's *permission*, not a guarantee that a model exists. Every enforcement
 * point (tool offer map, prompt tool list, in-execute guard) consults this
 * gate so the three layers can never disagree about whether the tool exists.
 */

import { isEmbedderInitialized } from "./embedding-service.js";

/** Shown to the agent/user when summon is refused. Names the fix, not just the state. */
export const SUMMON_UNAVAILABLE_REASON =
  "loom_summon is disabled: no embedding model is loaded, and guest persona selection is semantic. " +
  "Run `npm run model:download` in the loom plugin directory, or point `embeddingModel` at a " +
  "downloaded model, then start a new meeting.";

/**
 * Whether the ONNX encoder is live in this process. The embedder is warmed at
 * plugin startup and awaited (5s guard) during meeting init, so by the time a
 * turn runs this is settled — not a race that flaps mid-meeting.
 */
export function isEmbeddingAvailable() {
  try {
    return isEmbedderInitialized();
  } catch {
    return false;
  }
}

/** True when loom_summon may be offered to an agent this turn. */
export function isSummonAvailable() {
  return isEmbeddingAvailable();
}

/**
 * Synthesizer facade — preserves the historic `src/synthesizer.js` import
 * path. Implementation lives in `src/synthesis/` stages:
 * confidence, sections, reconciliation, citations, finalize.
 */
export {
  deriveConfidence,
  parseConfidence,
  deriveConfidenceNumber,
  deriveSplitConfidence,
  findStraddlingBands,
} from "./synthesis/confidence.js";
export {
  supplementMissingSections,
  SYNTHESIS_SECTION_CONTRACT,
  validateSynthesisSections,
  extractSection,
  NEUTRAL_SYNTHESIZER_SYSTEM,
  normalizeVecTraces,
} from "./synthesis/sections.js";
export {
  extractNumericClaims,
  isRealQuantityLabel,
  findNumericalConflicts,
  reconcileNumericalConflicts,
  shouldReserveReconciliationRound,
} from "./synthesis/reconciliation.js";
export {
  CITATION_MIN_TARGET_CHARS,
  checkCitationSupport,
} from "./synthesis/citations.js";
export { resolveDetectorPolicy, finalizeSynthesis } from "./synthesis/finalize.js";

import { LoomError, extractErrorInfo } from "../logger.js";
import { Logger } from "../logger.js";
import { sanitizeForPrompt } from "../utils/sanitize.js";
import { getConfig } from "../config.js";

const FALLBACK_EXTRA_ROUNDS = 4;

/**
 * Handles meeting extension logic: fabric update, round limit bump.
 * Extracted from MeetingOrchestrator for single responsibility.
 */
export class MeetingExtender {
  /** @type {import("../logger.js").Logger} */
  #logger;

  constructor() {
    this.#logger = new Logger();
  }

  /**
   * Derive extra rounds from the user's max-rounds intent rather than a constant
   * (audit 05 LS7): grant half the configured default, clamped to [2,6].
   * Consumers that hardcode `extensions.length * 4` (TimelineTab) must be updated
   * in the same change if this derivation changes — see audit coupling note.
   */
  #deriveExtraRounds() {
    let base = FALLBACK_EXTRA_ROUNDS;
    try {
      const configured = getConfig()?.defaultMaxRounds;
      if (Number.isFinite(configured) && configured > 0) {
        base = Math.max(2, Math.min(6, Math.ceil(configured / 2)));
      }
    } catch {
      // config unavailable — keep fallback constant
    }
    return base;
  }

  /**
   * Extends the meeting with new prompt and additional rounds.
   * @returns {Promise<void>}
   */
  async extend(params) {
    const {
      database,
      stateManager,
      sessionManager,
      newPrompt,
    } = params;

    if (!database) {
      throw new LoomError("Cannot extend: database not available", { phase: "extension", recoverable: false });
    }

    // Sanitize through the non-destructive prompt sanitizer; the literal
    // `**User Input:**` marker MUST survive — the dashboard's ExtensionBanner
    // parses extensions back out of fabric with a regex keyed on it (audit 05 LS7).
    const safePrompt = sanitizeForPrompt(newPrompt ?? "", 8000);
    const extraRounds = this.#deriveExtraRounds();

    // Fabric + max-rounds + round marker must apply atomically or not at all
    // (audit 05 LS7): half-applied extensions leave inconsistent state.
    // Snapshot in-memory state before DB transaction so we can revert on rollback.
    const prevMaxRounds = stateManager.getMaxRounds();
    const prevFabric = (() => { try { return database.getFabric(); } catch { return stateManager.getFabric(); } })();
    let txSucceeded = false;
    if (typeof database.transaction === "function") {
      try {
        await database.transaction(() => {
          database.setFabric(`${prevFabric}\n\n**User Input:** ${safePrompt}`);
          database.setRound(stateManager.getCurrentRound());
          database.setMaxRounds(prevMaxRounds + extraRounds);
        });
        txSucceeded = true;
      } catch (err) {
        // Transaction rolled back — do not mutate in-memory state
        this.#logger.warn("extend_tx_failed", "Extension transaction failed, state not mutated", extractErrorInfo(err));
        throw err;
      }
    } else {
      // No transaction support — sequential best-effort (legacy path)
      database.setFabric(`${prevFabric}\n\n**User Input:** ${safePrompt}`);
      database.setRound(stateManager.getCurrentRound());
      database.setMaxRounds(prevMaxRounds + extraRounds);
      txSucceeded = true;
    }

    if (txSucceeded) {
      stateManager.setMaxRounds(prevMaxRounds + extraRounds);
      const newFabric = database.getFabric();
      stateManager.setFabric(newFabric);
      // Make extension visible via context (agents read getContext())
      try {
        if (typeof stateManager.getContext === "function" && typeof stateManager.setContext === "function") {
          stateManager.setContext(newFabric);
        }
      } catch {}
    }
    stateManager.forceTransitionTo("weaving");

    for (const p of stateManager.getParticipants()) {
      stateManager.setParticipantStatus(p.config.id, "listening");
      database.setParticipantStatus(p.config.id, "listening");
    }

    await sessionManager.postProgress(
      `🧵 Extending loom — adding ${extraRounds} more rounds (now ${stateManager.getMaxRounds()} total)`
    );
    this.#logger.info("extended", "Meeting extended", { newMaxRounds: stateManager.getMaxRounds(), extraRounds });
  }
}

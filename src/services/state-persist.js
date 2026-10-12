import { extractErrorInfo } from "../logger.js";

/**
 * Write-through persist of one participant's Σⁱ.
 *
 * In-memory state is the truth for this process; the DB row is the durable
 * copy. Never throws: a refused store degrades (flagged + logged) instead of
 * breaking the turn — the paper's rule that a failed write cannot corrupt
 * persistent Σ, applied to the storage layer.
 *
 * @param {object} db MeetingDatabase (or null when unavailable)
 * @param {object} stateManager StateManager
 * @param {string} participantId
 * @param {object|null} [logger]
 * @returns {true|null|false} true = durable; null = unavailable/pre-state DB
 *   (in-memory-only is legitimate); false = real write failure (degraded).
 */
export function persistParticipantState(db, stateManager, participantId, logger = null) {
  let state = null;
  try {
    state = stateManager.getParticipantState?.(participantId);
  } catch {
    return false;
  }
  if (!state) return false;
  const flagDegraded = () => {
    try {
      if (typeof db?.setPersistenceDegraded === "function") db.setPersistenceDegraded(true);
    } catch {}
  };
  try {
    if (typeof db?.setParticipantState !== "function") return null;
    const result = db.setParticipantState(participantId, state);
    if (result === false) {
      flagDegraded();
      try { logger?.warn?.("state_persist_degraded", `State persist degraded for ${participantId} — continuing in-memory`); } catch {}
    }
    return result;
  } catch (err) {
    flagDegraded();
    try { logger?.warn?.("state_persist_degraded", `State persist degraded for ${participantId} — continuing in-memory`, extractErrorInfo(err)); } catch {}
    return false;
  }
}

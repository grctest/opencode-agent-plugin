/**
 * Turn order resolver — collects [REQUEST_NEXT] tags from the round
 * and returns them for moderator planning.
 */

/**
 * Collects all turn order requests from a round's contributions.
 * @param {Object} round - The round object with turn_requests array
 * @returns {Array} Array of turn request objects
 */
export function collectTurnRequests(round) {
  return round.turn_requests || [];
}

/**
 * Formats turn order notes for the fabric context (State of Play).
 * @param {Object} round - The round object
 * @param {Array} orderedParticipants - The planned turn order for next round
 * @returns {string} Formatted notes
 */
export function formatTurnOrderNotes(round, orderedParticipants) {
  const requests = collectTurnRequests(round);
  if (requests.length === 0 && (!orderedParticipants || orderedParticipants.length === 0)) return "";

  let notes = "\n\n### Turn Order";
  
  if (requests.length > 0) {
    notes += "\nRequests:";
    for (const req of requests) {
      notes += `\n- ${req.participant_id}: Priority ${req.priority} — "${req.reason}"`;
    }
  }

  if (orderedParticipants && orderedParticipants.length > 0) {
    notes += "\nNext round order:";
    for (let i = 0; i < orderedParticipants.length; i++) {
      notes += `\n  ${i + 1}. ${orderedParticipants[i]}`;
    }
  }

  return notes;
}

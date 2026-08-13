/**
 * Collects and deduplicates objections (challenges/dissents) across all rounds.
 * An objection re-raised in a later round stays unresolved;
 * one raised only in earlier rounds is treated as addressed once the final round shows activity.
 *
 * @param {Object} params
 * @param {Array} params.rounds - All rounds from state
 * @param {Array} params.participants - All participants
 * @returns {Array} Objection objects with resolution status
 */
export function collectObjections({ rounds, participants }) {
  if (rounds.length === 0) return [];

  const objections = [];
  for (const round of rounds) {
    const challenges = round.contributions.filter((c) => c.type === "challenge" || c.type === "dissent");
    for (const c of challenges) {
      const p = participants.find((pp) => pp.config.id === c.participant_id);
      const key = `${c.participant_id}:${round.number}`;
      const existing = objections.find((o) => `${o.participant_id}:${o.round}` === key);
      if (existing) {
        existing.content = `${p?.config.name ?? c.participant_id}: ${c.content}`;
        existing.unresolved = true;
      } else {
        objections.push({
          participant_id: c.participant_id,
          content: `${p?.config.name ?? c.participant_id}: ${c.content}`,
          round: round.number,
          unresolved: true,
        });
      }
    }
  }

  const lastRound = rounds[rounds.length - 1];
  const finalRoundHasActivity = lastRound.contributions.length > 0;
  for (const o of objections) {
    if (o.round < lastRound.number && finalRoundHasActivity) {
      o.unresolved = false;
    }
  }
  return objections;
}

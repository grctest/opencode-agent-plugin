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
    const challenges = round.contributions.filter((c) => c.type === "critique_response" || c.type === "perspective_response" || c.type === "challenge" || c.type === "dissent" || c.type === "reflection");
    for (const c of challenges) {
      const p = participants.find((pp) => pp.config.id === c.participant_id);
      const key = `${c.id}`;
      const existing = objections.find((o) => o.id === c.id);
      if (existing) {
        existing.content = `${p?.config.name ?? c.participant_id}: ${c.content}`;
        existing.unresolved = true;
      } else {
        objections.push({
          id: c.id,
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
  // Only resolve if final round actually addresses the dissent (keyword overlap), not just any activity
  const finalTexts = lastRound.contributions.map((c) => (c.content || "").toLowerCase()).join(" ");
  for (const o of objections) {
    if (o.round < lastRound.number && finalRoundHasActivity) {
      const kw = o.content.toLowerCase().split(/\W+/).filter((w) => w.length > 4).slice(0, 5);
      const addressed = kw.length === 0 || kw.some((k) => finalTexts.includes(k));
      if (addressed) o.unresolved = false;
    }
  }
  return objections;
}

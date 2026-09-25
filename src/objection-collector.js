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
    const challenges = round.contributions.filter((c) => {
      if (c.type === "critique_response" || c.type === "dissent" || c.type === "challenge") return true;
      return /\b(challenge|dissent|disagree|concern|oppose|dispute|contradict|risk|flaw|weakness)\b/i.test(String(c.content ?? ""));
    });
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
  // Resolution requires explicit evidence: a final-round contribution quoting or
  // [#id]-citing the objection. Bare keyword overlap only marks the objection
  // *stale* (raised earlier, not re-raised) — never resolved — because shared
  // vocabulary produces false resolutions and paraphrase produces false
  // live-dissent (audit D12). Callers must render stale distinctly from both
  // live dissent and genuinely resolved concerns.
  const finalTexts = lastRound.contributions.map((c) => (c.content || "").toLowerCase()).join(" ");
  for (const o of objections) {
    if (o.round < lastRound.number && finalRoundHasActivity) {
      if (finalTexts.includes(`[#${o.id}]`)) {
        o.unresolved = false;
        o.resolution = "cited";
        continue;
      }
      const kw = o.content.toLowerCase().split(/\W+/).filter((w) => w.length > 4).slice(0, 5);
      const addressed = kw.length === 0 || kw.some((k) => finalTexts.includes(k));
      if (addressed) {
        o.unresolved = false;
        o.stale = true;
        o.resolution = "stale";
      }
    }
  }
  return objections;
}

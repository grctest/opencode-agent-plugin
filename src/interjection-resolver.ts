import type { Interjection, Round } from "./types.js";

/**
 * Resolves all pending interjections for a round.
 * Priority >= 9: auto-granted. Priority >= 7: granted unless contested (moderator decides).
 * Priority < 7: denied.
 */
export async function resolveInterjections(
  round: Round,
  moderate: (ij: Interjection) => Promise<boolean>,
): Promise<void> {
  round.interjections.sort((a, b) => b.priority - a.priority);

  const pending = round.interjections.filter((ij) => ij.resolved === "pending");

  for (const ij of pending) {
    if (ij.priority >= 9) {
      ij.granted = true;
      ij.resolved = "granted";
    } else if (ij.priority >= 7) {
      const contested = pending.some(
        (other) =>
          other.participant_id !== ij.participant_id
          && other.priority === ij.priority,
      );

      if (contested) {
        const granted = await moderate(ij);
        ij.granted = granted;
        ij.resolved = granted ? "granted" : "contested";
        if (!granted) {
          ij.pushback = "Moderator ruled against interjection";
        }
      } else {
        ij.granted = true;
        ij.resolved = "granted";
      }
    } else {
      ij.resolved = "denied";
    }
  }
}

/** Returns only the interjections that were granted in a round. */
export function getGrantedInterjections(round: Round): Interjection[] {
  return round.interjections.filter((ij) => ij.granted);
}

/** Formats granted interjection notes for inclusion in the warp context. Returns empty string if none. */
export function formatInterjectionNotes(round: Round): string {
  const granted = getGrantedInterjections(round);
  if (granted.length === 0) return "";

  const notes = granted
    .map((ij) => `- ${ij.participant_id}: "${ij.reason}"`)
    .join("\n");

  return `\n\n### Interjections (Granted)\n${notes}`;
}

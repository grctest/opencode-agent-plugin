/** Formats interjection resolution notes for the fabric context. */
export function formatInterjectionNotes(round) {
  const granted = round.interjections.filter((ij) => ij.resolved === "granted");
  const denied = round.interjections.filter((ij) => ij.resolved === "denied" || ij.resolved === "contested");

  if (granted.length === 0 && denied.length === 0) return "";

  let notes = "\n\n### Interjection Results";
  if (granted.length > 0) {
    notes += "\nGranted:";
    for (const ij of granted) {
      notes += `\n- ${ij.participant_id}: "${ij.reason}"`;
    }
  }
  if (denied.length > 0) {
    notes += "\nDenied:";
    for (const ij of denied) {
      notes += `\n- ${ij.participant_id}: "${ij.reason}"${ij.pushback ? ` (${ij.pushback})` : ""}`;
    }
  }

  return notes;
}

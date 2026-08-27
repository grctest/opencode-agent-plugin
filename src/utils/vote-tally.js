/**
 * Single source of truth for vote-letter extraction and tally construction
 * (audit 16 MA2). Both the RoundExecutor path and the inline loom_vote tool
 * previously carried verbatim copies that could drift.
 */

/**
 * Extracts a vote choice (A, B, C, etc. or 1,2,3) from a vote response string.
 * Supports both lettered [Vote: A] and numbered [Vote: 2] formats for backward compat.
 */
export function extractVoteLetter(text) {
  if (!text) return null;
  const tagMatch = text.match(/\[Vote:\s*([A-Za-z0-9])\]/i);
  if (tagMatch) return tagMatch[1].toUpperCase();
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[A-Za-z0-9]$/.test(trimmed)) return trimmed.toUpperCase();
  }
  return null;
}

/**
 * Builds tally lines from a source vote plus voter responses.
 * @param {Object} params
 * @param {string} params.question - The vote question (headline of the tally)
 * @param {string|null} params.sourceLetter - Pre-extracted letter from the source/caller
 * @param {string} params.sourceLabel - Display name for the source voter
 * @param {Array<{voter: string, content: string}>} params.responses - Voter name + raw response text
 * @returns {{ lines: string[], counts: Record<string, number>, totalVoters: number }}
 */
export function buildTally({ question, sourceLetter = null, sourceLabel = "source", responses = [] }) {
  const lines = [`[Vote Tally] ${question}`];
  const counts = {};

  if (sourceLetter) {
    counts[sourceLetter] = (counts[sourceLetter] || 0) + 1;
    lines.push(`${sourceLetter}: 1 vote (${sourceLabel} — source)`);
  }

  for (const vr of responses) {
    const letter = extractVoteLetter(vr.content);
    if (!letter) continue;
    counts[letter] = (counts[letter] || 0) + 1;
    const existing = lines.find((l) => l.startsWith(`${letter}:`));
    if (existing) {
      const idx = lines.indexOf(existing);
      lines[idx] = `${letter}: ${counts[letter]} votes (${existing.match(/\((.+)\)/)?.[1] ?? ""}, ${vr.voter})`;
    } else {
      lines.push(`${letter}: 1 vote (${vr.voter})`);
    }
  }

  const totalVoters = (sourceLetter ? 1 : 0) + responses.length;
  lines.push(`Total voters: ${totalVoters}`);

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (sorted.length > 0) {
    const [winner, count] = sorted[0];
    lines.push(`Leading option: ${winner} (${count} votes)`);
  }

  return { lines, counts, totalVoters };
}

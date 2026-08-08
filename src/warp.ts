import type { Round } from "./types.js";

export const MAX_WARP_TOKENS = 3000;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function evolveWarp(warp: string, round: Round): string {
  if (!round.summary) return warp;

  const summaryText = `\n\n### Round ${round.number} Summary\n${round.summary}`;
  const projectedTokens = estimateTokens(warp + summaryText);

  if (projectedTokens > MAX_WARP_TOKENS) {
    return compactWarp(warp, summaryText);
  }

  return warp + summaryText;
}

function compactWarp(currentWarp: string, newSummary: string): string {
  let compacted = `(Context compacted)

## Established Facts
[Earlier deliberation summary compressed — key decisions and agreements are preserved]

${newSummary}`;

  if (estimateTokens(compacted) > MAX_WARP_TOKENS) {
    compacted = newSummary;
  }

  return compacted;
}

export function formatTranscript(
  rounds: Round[],
  participants: Array<{ config: { id: string; name: string; tier: string } }>,
): string {
  const lines: string[] = [];

  for (const round of rounds) {
    lines.push(`### Round ${round.number}`);

    for (const c of round.contributions) {
      const participant = participants.find((p) => p.config.id === c.participant_id);
      const name = participant?.config.name ?? c.participant_id;
      const tier = participant?.config.tier ?? "mid";
      lines.push(`**[${name}]** (${tier}, ${c.type}): ${c.content}`);
    }

    if (round.interjections.length > 0) {
      lines.push(`  **Interjections:**`);
      for (const ij of round.interjections) {
        const name = participants.find((p) => p.config.id === ij.participant_id)?.config.name;
        lines.push(`  - [${name}] P${ij.priority}: ${ij.reason} → ${ij.resolved}`);
        if (ij.pushback) {
          lines.push(`    Pushback: ${ij.pushback}`);
        }
      }
    }

    if (round.summary) {
      lines.push(`  *Summary:* ${round.summary}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

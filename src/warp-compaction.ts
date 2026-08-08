import type { Round, Contribution } from "./types.js";

const MAX_WARP_CHARS = 12000;

export function estimateChars(text: string): number {
  return text.length;
}

export function evolveWarp(warp: string, round: Round): string {
  if (!round.summary) return warp;

  const summaryText = `\n\n### Round ${round.number}\n${round.summary}`;
  const projectedLength = warp.length + summaryText.length;

  if (projectedLength > MAX_WARP_CHARS) {
    return compactWarp(warp, summaryText, round.contributions);
  }

  return warp + summaryText;
}

function compactWarp(currentWarp: string, newSummary: string, contributions: Contribution[]): string {
  const keyPoints = contributions
    .filter((c) => c.type === "propose" || c.type === "refine" || c.type === "support")
    .slice(0, 3)
    .map((c) => c.content.slice(0, 100))
    .join("; ");

  const compacted = `(Context compacted — earlier rounds summarized)

## Established Facts
${keyPoints || "Key decisions and agreements from previous rounds preserved."}

${newSummary}`;

  if (compacted.length > MAX_WARP_CHARS) {
    return newSummary;
  }

  return compacted;
}

export async function compactWarpWithLLM(
  warp: string,
  round: Round,
  promptFn: (system: string, model: { providerID: string; modelID: string }, message: string) => Promise<string>,
  model: { providerID: string; modelID: string },
): Promise<string> {
  if (!round.summary) return warp;

  const summaryText = `\n\n### Round ${round.number}\n${round.summary}`;
  const projectedLength = warp.length + summaryText.length;

  if (projectedLength <= MAX_WARP_CHARS) {
    return warp + summaryText;
  }

  try {
    const prompt = `Compress the following deliberation context into a concise summary (max 500 words). Preserve all key decisions, agreements, and open questions. Remove redundancy.

Current context:
${warp.slice(0, 8000)}

New round summary:
${round.summary}

Compressed context:`;

    const compressed = await promptFn("You are a deliberation context compressor.", model, prompt);
    if (compressed.trim().length > 50) {
      return compressed.trim() + "\n\n" + summaryText;
    }
  } catch {
  }

  return compactWarp(warp, summaryText, round.contributions);
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

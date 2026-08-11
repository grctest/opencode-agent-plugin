const MAX_WARP_CHARS = 12000;

/** Appends a round summary to the warp context, compacting if it exceeds MAX_WARP_CHARS. */
export function evolveWarp(warp, round) {
  if (!round.summary) return warp;

  const summaryText = `\n\n### Round ${round.number}\n${round.summary}`;
  const projectedLength = warp.length + summaryText.length;

  if (projectedLength > MAX_WARP_CHARS) {
    return compactWarp(warp, summaryText, round);
  }

  return warp + summaryText;
}

/** Rule-based fallback compaction: extracts key points from contributions. */
function compactWarp(currentWarp, newSummary, round) {
  const keyPoints = round.contributions
    .filter((c) => c.type === "propose" || c.type === "refine" || c.type === "support")
    .slice(0, 3)
    .map((c) => c.content.slice(0, 100))
    .join("; ");

  let compacted = `(Context compacted — earlier rounds summarized)

## Established Facts
${keyPoints || "Key decisions and agreements from previous rounds preserved."}

${newSummary}`;

  if (compacted.length > MAX_WARP_CHARS) {
    compacted = newSummary;
  }

  return compacted;
}

/** LLM-based compaction: compresses warp context into key facts, falling back to rule-based. */
export async function compactWarpWithLLM(warp, round, promptFn, model) {
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

  return compactWarp(warp, summaryText, round);
}

/** Estimates character count (proxy for token count). */
export function estimateChars(text) {
  return text.length;
}

/** Formats the full deliberation transcript for synthesis. */
export function formatTranscript(rounds, participants) {
  const lines = [];

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

/** Formats transcript data from the database into a string for the synthesizer. */
export function formatTranscriptFromData(data, participants) {
  const lines = [];

  for (const round of data.rounds) {
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

export { MAX_WARP_CHARS };

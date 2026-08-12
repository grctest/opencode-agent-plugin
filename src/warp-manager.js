import { getConfig } from "./config.js";

const MAX_WARP_CHARS = () => getConfig().maxWarpChars;

/** Appends a round summary to the warp context, compacting if it exceeds MAX_WARP_CHARS. */
export async function evolveWarp(warp, round, compactFn) {
  if (!round.summary) return warp ?? "";

  let currentWarp = warp ?? "";
  const newEntry = `### Round ${round.number}\n${round.summary}`;
  currentWarp = currentWarp ? `${currentWarp}\n\n${newEntry}` : newEntry;

  if (currentWarp.length > MAX_WARP_CHARS()) {
    if (compactFn) {
      try {
        const compactedStr = await compactFn(currentWarp, round);
        if (compactedStr && compactedStr.length < currentWarp.length) {
          return compactedStr;
        }
      } catch (err) {
        console.warn(`[Loom] LLM warp compaction failed: ${err instanceof Error ? err.message : String(err)}. Using rule-based compaction.`);
      }
    }
    return compactWarpRuleBased(currentWarp);
  }

  return currentWarp;
}

function compactWarpRuleBased(warp) {
  const roundSections = warp.split(/(?=### Round \d+)/g).filter(Boolean);
  if (roundSections.length <= 3) return warp;

  const recentRounds = roundSections.slice(-3);
  const olderRounds = roundSections.slice(0, -3);

  const olderText = olderRounds.join("\n\n");
  const condensed = `[Earlier rounds condensed: ${olderRounds.length} rounds covering ${olderText.length} characters]`;

  return `${condensed}\n\n${recentRounds.join("\n\n")}`;
}

/** LLM-based compaction: compresses warp context into key facts. */
export async function compactWarpWithLLM(warp, round, promptFn, model) {
  if (!round.summary) return warp ?? "";

  const currentWarp = warp ?? "";
  if (currentWarp.length + round.summary.length + 100 <= MAX_WARP_CHARS()) {
    return evolveWarp(currentWarp, round, null);
  }

  try {
    const prompt = `Compress the following deliberation context into a concise summary (max 400 words). Preserve all key decisions, agreements, disagreements, and open questions. Remove redundancy.

Current context:
${currentWarp.slice(0, 8000)}

New round summary:
${round.summary}

Compressed context:`;

    const compressed = await promptFn("You are a deliberation context compressor.", model, prompt);
    if (compressed && compressed.trim().length > 50) {
      return compressed.trim();
    }
  } catch { /* fall through */ }

  return compactWarpRuleBased(currentWarp);
}

/** Generates a structured brief of prior rounds for agent context. */
export function generateRoundBriefs(warp, currentRound) {
  if (currentRound <= 1) return "";
  if (!warp) return "";

  const roundSections = warp.split(/(?=### Round \d+)/g).filter(Boolean);
  if (roundSections.length === 0) return "";

  return `## Prior Deliberation Summary\n\n${roundSections.join("\n\n")}`;
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

import { getConfig } from "./config.js";
import { Logger, extractErrorInfo } from "./logger.js";

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
        const info = extractErrorInfo(err);
        new Logger().warn("warp_compaction_failed", "LLM warp compaction failed — using rule-based compaction", info);
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

  const keyFacts = extractKeyFacts(olderRounds);

  return `## Compressed Context (from ${olderRounds.length} earlier rounds)\n${keyFacts}\n\n${recentRounds.join("\n\n")}`;
}

function extractKeyFacts(roundSections) {
  const facts = [];

  for (const section of roundSections) {
    const lines = section.split("\n").filter(Boolean);
    const roundMatch = lines[0]?.match(/### Round (\d+)/);
    if (!roundMatch) continue;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim().toLowerCase();
      if (
        line.includes("agreed") ||
        line.includes("consensus") ||
        line.includes("decision") ||
        line.includes("disagree") ||
        line.includes("concern") ||
        line.includes("action item") ||
        line.includes("key finding") ||
        line.includes("important")
      ) {
        facts.push(lines[i].trim());
      }
    }
  }

  if (facts.length === 0) {
    const allLines = roundSections.join("\n").split("\n").filter(Boolean);
    return allLines.slice(0, 10).join("\n");
  }

  return facts.slice(0, 15).join("\n");
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
  } catch (err) {
    const info = extractErrorInfo(err);
    new Logger().debug("warp_llm_compress_failed", "LLM compression returned unusable output — falling back to rule-based", info);
  }

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
        const name = participants.find((p) => p.config.id === ij.participant_id)?.config.name ?? ij.participant_id;
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

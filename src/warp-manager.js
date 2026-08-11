import { CONFIG } from "./config.js";

const MAX_WARP_CHARS = CONFIG.maxWarpChars;

const WARP_SECTIONS = {
  PROPOSALS: "## Proposals & Contributions",
  QUESTIONS: "## Open Questions",
  DISAGREEMENTS: "## Disagreements",
  DECISIONS: "## Decisions",
  HISTORY: "## Round History",
};

function createEmptyWarp() {
  return `${WARP_SECTIONS.PROPOSALS}\n(none yet)\n\n${WARP_SECTIONS.QUESTIONS}\n(none yet)\n\n${WARP_SECTIONS.DISAGREEMENTS}\n(none yet)\n\n${WARP_SECTIONS.DECISIONS}\n(none yet)\n\n${WARP_SECTIONS.HISTORY}\n`;
}

function ensureSectionStructure(warp) {
  let result = warp;
  for (const [key, header] of Object.entries(WARP_SECTIONS)) {
    if (!result.includes(header)) {
      result += `\n${header}\n`;
    }
  }
  return result;
}

function getSection(warp, sectionHeader) {
  const startIdx = warp.indexOf(sectionHeader);
  if (startIdx === -1) return "";
  const contentStart = startIdx + sectionHeader.length;
  const nextSectionIdx = warp.indexOf("\n## ", contentStart);
  if (nextSectionIdx === -1) return warp.slice(contentStart).trim();
  return warp.slice(contentStart, nextSectionIdx).trim();
}

function replaceSection(warp, sectionHeader, newContent) {
  const startIdx = warp.indexOf(sectionHeader);
  if (startIdx === -1) {
    return warp + `\n${sectionHeader}\n${newContent}\n`;
  }
  const contentStart = startIdx + sectionHeader.length;
  const nextSectionIdx = warp.indexOf("\n## ", contentStart);
  if (nextSectionIdx === -1) {
    return warp.slice(0, contentStart) + "\n" + newContent + "\n";
  }
  return warp.slice(0, contentStart) + "\n" + newContent + "\n" + warp.slice(nextSectionIdx + 1);
}

function extractKeyPoints(round) {
  const proposals = round.contributions.filter((c) => c.type === "propose" || c.type === "refine");
  const supports = round.contributions.filter((c) => c.type === "support");
  const challenges = round.contributions.filter((c) => c.type === "challenge" || c.type === "dissent");

  const points = [];
  if (proposals.length > 0) {
    points.push(`New proposals: ${proposals.length}`);
  }
  if (supports.length > 0) {
    points.push(`Supports: ${supports.length}`);
  }
  if (challenges.length > 0) {
    points.push(`Challenges: ${challenges.length}`);
  }
  return points.join(", ");
}

/** Appends a round summary to the warp context, compacting if it exceeds MAX_WARP_CHARS. */
export async function evolveWarp(warp, round, compactFn) {
  if (!round.summary) return warp;

  let currentWarp = warp || createEmptyWarp();
  currentWarp = ensureSectionStructure(currentWarp);

  const summaryText = `\n### Round ${round.number}\n${round.summary}`;
  const historySection = getSection(currentWarp, WARP_SECTIONS.HISTORY);
  const newHistory = historySection + summaryText;
  currentWarp = replaceSection(currentWarp, WARP_SECTIONS.HISTORY, newHistory);

  const proposals = round.contributions.filter((c) => c.type === "propose" || c.type === "refine");
  if (proposals.length > 0) {
    const proposalsContent = getSection(currentWarp, WARP_SECTIONS.PROPOSALS);
    const newProposals = proposalsContent === "(none yet)"
      ? proposals.map((p) => `- ${p.content.slice(0, 150)}`).join("\n")
      : proposalsContent + "\n" + proposals.map((p) => `- ${p.content.slice(0, 150)}`).join("\n");
    currentWarp = replaceSection(currentWarp, WARP_SECTIONS.PROPOSALS, newProposals);
  }

  const questions = round.contributions.filter((c) => c.type === "question");
  if (questions.length > 0) {
    const questionsContent = getSection(currentWarp, WARP_SECTIONS.QUESTIONS);
    const newQuestions = questionsContent === "(none yet)"
      ? questions.map((q) => `- ${q.content.slice(0, 150)}`).join("\n")
      : questionsContent + "\n" + questions.map((q) => `- ${q.content.slice(0, 150)}`).join("\n");
    currentWarp = replaceSection(currentWarp, WARP_SECTIONS.QUESTIONS, newQuestions);
  }

  const disagreements = round.contributions.filter((c) => c.type === "challenge" || c.type === "dissent");
  if (disagreements.length > 0) {
    const disagreementsContent = getSection(currentWarp, WARP_SECTIONS.DISAGREEMENTS);
    const newDisagreements = disagreementsContent === "(none yet)"
      ? disagreements.map((d) => `- ${d.content.slice(0, 150)}`).join("\n")
      : disagreementsContent + "\n" + disagreements.map((d) => `- ${d.content.slice(0, 150)}`).join("\n");
    currentWarp = replaceSection(currentWarp, WARP_SECTIONS.DISAGREEMENTS, newDisagreements);
  }

  const projectedLength = currentWarp.length;
  if (projectedLength > MAX_WARP_CHARS) {
    if (compactFn) {
      try {
        const compacted = await compactFn(currentWarp, round);
        if (compacted) return compacted;
      } catch {
      }
    }
    return compactWarp(currentWarp, round);
  }

  return currentWarp;
}

function compactWarp(warp, round) {
  const proposals = getSection(warp, WARP_SECTIONS.PROPOSALS);
  const recentProposals = proposals.split("\n").slice(-5).join("\n");

  const disagreements = getSection(warp, WARP_SECTIONS.DISAGREEMENTS);
  const recentDisagreements = disagreements.split("\n").slice(-5).join("\n");

  const questions = getSection(warp, WARP_SECTIONS.QUESTIONS);
  const recentQuestions = questions.split("\n").slice(-3).join("\n");

  const compacted = `${WARP_SECTIONS.PROPOSALS}
${recentProposals || "(compacted)"}

${WARP_SECTIONS.QUESTIONS}
${recentQuestions || "(compacted)"}

${WARP_SECTIONS.DISAGREEMENTS}
${recentDisagreements || "(compacted)"}

${WARP_SECTIONS.DECISIONS}
${getSection(warp, WARP_SECTIONS.DECISIONS)}

${WARP_SECTIONS.HISTORY}
### Round ${round.number}
${round.summary}
(Context compacted — earlier history summarized)`;

  if (compacted.length > MAX_WARP_CHARS) {
    return `${WARP_SECTIONS.PROPOSALS}
${recentProposals.split("\n").slice(-3).join("\n") || "(compacted)"}

${WARP_SECTIONS.DISAGREEMENTS}
${recentDisagreements.split("\n").slice(-3).join("\n") || "(compacted)"}

${WARP_SECTIONS.HISTORY}
### Round ${round.number}
${round.summary}
(Context compacted)`;
  }

  return compacted;
}

/** LLM-based compaction: compresses warp context into key facts, falling back to rule-based. */
export async function compactWarpWithLLM(warp, round, promptFn, model) {
  if (!round.summary) return warp;

  if (warp.length + round.summary.length + 100 <= MAX_WARP_CHARS) {
    return evolveWarp(warp, round);
  }

  try {
    const prompt = `Compress the following deliberation context into a concise summary (max 400 words). Preserve all key decisions, agreements, disagreements, and open questions. Remove redundancy.

Current context:
${warp.slice(0, 8000)}

New round summary:
${round.summary}

Compressed context:`;

    const compressed = await promptFn("You are a deliberation context compressor.", model, prompt);
    if (compressed.trim().length > 50) {
      return compressed.trim() + "\n\n" + `### Round ${round.number}\n${round.summary}`;
    }
  } catch {
  }

  return compactWarp(warp, round);
}

/** Estimates character count (proxy for token count). */
export function estimateChars(text) {
  return text.length;
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

/** Generates a structured brief of prior rounds for agent context. */
export function generateRoundBriefs(warp, currentRound) {
  if (currentRound <= 1) return "";

  const proposalsSection = getSection(warp, WARP_SECTIONS.PROPOSALS);
  const disagreementsSection = getSection(warp, WARP_SECTIONS.DISAGREEMENTS);
  const questionsSection = getSection(warp, WARP_SECTIONS.QUESTIONS);

  const parts = [];

  if (proposalsSection && proposalsSection !== "(none yet)") {
    parts.push(`## Proposals So Far\n${proposalsSection}`);
  }

  if (disagreementsSection && disagreementsSection !== "(none yet)") {
    parts.push(`## Points of Disagreement\n${disagreementsSection}`);
  }

  if (questionsSection && questionsSection !== "(none yet)") {
    parts.push(`## Open Questions\n${questionsSection}`);
  }

  return parts.join("\n\n");
}

export { MAX_WARP_CHARS, WARP_SECTIONS };
